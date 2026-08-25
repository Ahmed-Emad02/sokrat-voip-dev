const express = require('express');
const mysql = require('mysql2/promise');
const moment = require('moment');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { exec, execFile } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const execFileAsync = (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout || '');
    });
});
const session = require('express-session');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const crypto = require('crypto');

const createCrmRouter = require('./routes/crm-integration');
const registerCrmLiveSocket = require('./socket/crm-live');
const { getPhoneVariants, cleanPhoneString } = require('./lib/phone-normalization');
const {
    initCrmTables,
    createPairingCode,
    consumeEmbedTicket,
    hashSecret
} = require('./lib/integration-auth');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

let rawEncryptionKey = process.env.ENCRYPTION_KEY;
if (!rawEncryptionKey || rawEncryptionKey.length < 32 || rawEncryptionKey.includes('change-me')) {
    rawEncryptionKey = crypto.randomBytes(32).toString('hex');
}
const key = crypto.createHash('sha256').update(String(rawEncryptionKey)).digest();

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        console.error('Decryption failed:', err.message);
        return null;
    }
}

const app = express();
const TRUST_PROXY = process.env.TRUST_PROXY || false;
app.set('trust proxy', TRUST_PROXY === 'true' ? 1 : (TRUST_PROXY || false));
const SSL_CERT = process.env.SSL_CERT || '/etc/asterisk/keys/asterisk.pem';
const SSL_KEY = process.env.SSL_KEY || '/etc/asterisk/keys/asterisk.pem';
let server;
if ((process.env.USE_HTTPS === 'true' || process.env.SSL_PORT) && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY)) {
    try {
        const sslOptions = {
            key: fs.readFileSync(SSL_KEY),
            cert: fs.readFileSync(SSL_CERT)
        };
        server = https.createServer(sslOptions, app);
        console.log('HTTPS server active using SSL certificate:', SSL_CERT);
    } catch (e) {
        console.error('HTTPS setup error, falling back to HTTP:', e.message);
        server = http.createServer(app);
    }
} else {
    server = http.createServer(app);
}
const io = new Server(server);
ffmpeg.setFfmpegPath('/usr/local/bin/ffmpeg');
const PORT = (process.env.USE_HTTPS === 'true' && process.env.SSL_PORT) ? parseInt(process.env.SSL_PORT, 10) : (parseInt(process.env.PORT, 10) || 3000);
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET === 'issabel-dashboard-secret-change-me') {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
}

const ROOT_USER = 'root';
const ROOT_PASSWORD_HASH = process.env.ROOT_PASSWORD_HASH;

function safeIdentifier(name, value) {
    if (!/^[A-Za-z0-9_]+$/.test(value)) {
        throw new Error(`${name} must contain only letters, numbers, and underscores`);
    }
    return value;
}

const ASTERISK_DB = safeIdentifier('ASTERISK_DB', process.env.ASTERISK_DB || 'asterisk');
const CDR_DB = safeIdentifier('CDR_DB', process.env.CDR_DB || process.env.DB_NAME || 'asteriskcdrdb');
const ASTERISK_BIN = process.env.ASTERISK_BIN || '/usr/sbin/asterisk';
const RECORDING_ROOT = process.env.RECORDING_ROOT || '/var/spool/asterisk/monitor';
const AMI_HOST = process.env.AMI_HOST || '127.0.0.1';
const UPLOAD_TMP = '/tmp/dashboard-uploads';
if (!fs.existsSync(UPLOAD_TMP)) fs.mkdirSync(UPLOAD_TMP, { recursive: true });

function tableName(dbName, table) {
    return `\`${dbName}\`.\`${table}\``;
}

const tables = {
    cdr: tableName(CDR_DB, 'cdr'),
    users: tableName(ASTERISK_DB, 'users'),
    devices: tableName(ASTERISK_DB, 'devices'),
    sip: tableName(ASTERISK_DB, 'sip'),
    sipfriends: tableName(ASTERISK_DB, 'sipfriends'),
    sippeers: tableName(ASTERISK_DB, 'sippeers'),
    psEndpoints: tableName(ASTERISK_DB, 'ps_endpoints'),
    employeeExtras: tableName(ASTERISK_DB, 'employee_extras'),
    employeeGroups: tableName(ASTERISK_DB, 'employee_groups'),
    dashboardUsers: tableName(ASTERISK_DB, 'dashboard_users'),
    dashboardGroupPermissions: tableName(ASTERISK_DB, 'dashboard_group_permissions')
};

function isInternalChannel(channel) {
    const value = String(channel || '').toUpperCase();
    return value.startsWith('SIP/') || value.startsWith('PJSIP/') || value.startsWith('IAX2/');
}

function isTrunkChannel(channel) {
    const value = String(channel || '').toUpperCase();
    return value.startsWith('DONGLE/') || value.startsWith('DAHDI/');
}

function isExternalPhoneNumber(dst) {
    const clean = String(dst || '').trim();
    if (!clean) return false;
    if (clean.startsWith('*')) return false; // Feature codes like *80, *97, *43
    return (clean.startsWith('0') || clean.startsWith('+')) && clean.replace(/\D/g, '').length >= 7;
}

function classifyCdr(row) {
    const ch = String(row.channel || '');
    const dstCh = String(row.dstchannel || '');
    const lastData = String(row.lastdata || '');
    const dcontext = String(row.dcontext || '');
    const did = String(row.did || '').trim();
    const dst = String(row.dst || '').trim();

    // 1. Inbound calls: from trunk / dongle / DID
    if (isTrunkChannel(ch) || dcontext.startsWith('from-dongle') || dcontext.startsWith('from-trunk') || dcontext.startsWith('from-pstn') || did) {
        return { direction: 'INBOUND', call_scope: 'EXTERNAL' };
    }

    // 2. Outbound calls: internal caller dialing external number via trunk
    if (isTrunkChannel(dstCh) || lastData.toLowerCase().startsWith('dongle/') || lastData.toLowerCase().startsWith('dahdi/') || isExternalPhoneNumber(dst)) {
        return { direction: 'OUTBOUND', call_scope: 'EXTERNAL' };
    }

    // 3. Otherwise, Internal
    return { direction: 'INTERNAL', call_scope: 'INTERNAL' };
}

function isOutboundCdr(row) {
    return classifyCdr(row).direction === 'OUTBOUND';
}

function isInboundCdr(row) {
    return classifyCdr(row).direction === 'INBOUND';
}

function isInternalCdr(row) {
    return classifyCdr(row).direction === 'INTERNAL';
}

// External destination test: any numeric/+ number of 7+ digits.
// Covers 0-prefixed local dials, E.164 (+…) and normalized numbers stored without
// their trunk prefix (e.g. Egyptian mobiles without the leading 0, service codes).
const CDR_EXTERNAL_DST_SQL = `(c.dst REGEXP '^[0-9+]+$' AND CHAR_LENGTH(c.dst) >= 7)`;

const CDR_DIRECTION_CASE = `
    CASE
        WHEN c.channel LIKE 'Dongle/%' OR c.channel LIKE 'DAHDI/%'
             OR c.dcontext LIKE 'from-dongle%' OR c.dcontext LIKE 'from-trunk%' OR c.dcontext LIKE 'from-pstn%'
             OR (c.did != '' AND c.did IS NOT NULL)
        THEN 'INBOUND'

        WHEN (c.channel LIKE 'SIP/%' OR c.channel LIKE 'PJSIP/%' OR c.channel LIKE 'IAX2/%' OR c.dcontext = 'from-internal' OR c.dcontext LIKE 'from-internal%')
             AND (c.dstchannel LIKE 'Dongle/%' OR c.dstchannel LIKE 'DAHDI/%' OR c.lastdata LIKE 'dongle/%' OR c.lastdata LIKE 'DAHDI/%'
                  OR ${CDR_EXTERNAL_DST_SQL})
        THEN 'OUTBOUND'

        ELSE 'INTERNAL'
    END
`;

const CDR_CALL_SCOPE_CASE = `
    CASE
        WHEN (c.channel LIKE 'SIP/%' OR c.channel LIKE 'PJSIP/%' OR c.channel LIKE 'IAX2/%' OR c.dcontext = 'from-internal' OR c.dcontext LIKE 'from-internal%' OR c.dcontext LIKE 'from-intercom%')
             AND (c.dstchannel NOT LIKE 'Dongle/%' AND c.dstchannel NOT LIKE 'DAHDI/%' AND c.lastdata NOT LIKE 'dongle/%' AND c.lastdata NOT LIKE 'DAHDI/%')
             AND (NOT ${CDR_EXTERNAL_DST_SQL} OR c.dst IN ('101','102','111','200','600','300'))
             AND c.channel NOT LIKE 'Dongle/%' AND c.channel NOT LIKE 'DAHDI/%'
             AND (c.did = '' OR c.did IS NULL)
             AND c.dcontext NOT LIKE 'from-dongle%' AND c.dcontext NOT LIKE 'from-trunk%' AND c.dcontext NOT LIKE 'from-pstn%'
        THEN 'INTERNAL'

        ELSE 'EXTERNAL'
    END
`;

// Disposition resolution order for unanswered calls:
//   1. Persisted Q.850 hangup cause (userfield, captured by the cdr-cause-capture
//      hangup handler) — authoritative when the driver reports a specific cause:
//      17/21 user busy or rejected => BUSY, 18/19 no reply/user busy on routing => NO ANSWER,
//      34/38/41/42/44 congestion family => CONGESTION.
//   2. Heuristic fallback for legacy rows (no userfield): a call that rang >=5s and was
//      released without answer over GSM reports CONGESTION/BUSY — report NO ANSWER.
const CDR_DISPOSITION_SQL = `
    CASE
        WHEN c.billsec > 0 THEN c.disposition
        WHEN c.userfield = '17' OR c.userfield = '21' THEN 'BUSY'
        WHEN c.userfield IN ('18', '19') THEN 'NO ANSWER'
        WHEN c.userfield IN ('34', '38', '41', '42', '44') THEN 'CONGESTION'
        WHEN c.disposition IN ('CONGESTION', 'BUSY') AND c.duration >= 5 THEN 'NO ANSWER'
        ELSE c.disposition
    END
`;

// Call History hygiene:
//  - hide synthetic harness calls (test contexts, echo tests)
//  - one entry per call: Asterisk writes multiple channel segments sharing a
//    uniqueid (the post-fail "Congestion()" continuation used to surface as a
//    phantom FAILED row seconds after the real attempt) — keep the primary
//    segment (longest duration, latest sequence as tiebreaker).
const CDR_HISTORY_FILTERS_SQL = `
    AND c.dst NOT IN ('ussd','sms','report','s','*87','*88','*89')
    AND c.dcontext NOT LIKE 'test-%'
    AND c.dcontext NOT LIKE '%benchmark%'
    AND c.dcontext <> 'play_audio'
    AND NOT EXISTS (
        SELECT 1 FROM ${tables.cdr} cx
        WHERE cx.uniqueid = c.uniqueid
          AND (cx.duration > c.duration OR (cx.duration = c.duration AND cx.sequence > c.sequence))
    )
`;
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/photos', express.static(path.join(__dirname, 'public', 'photos')));
app.get('/favicon.ico', (req, res) => {
    res.setHeader('Content-Type', 'image/x-icon');
    res.sendFile(path.join(__dirname, 'public', 'favicon.ico'), (err) => {
        if (err) res.status(204).end();
    });
});
app.get('/favicon.png', (req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.sendFile(path.join(__dirname, 'public', 'favicon.png'), (err) => {
        if (err) res.status(204).end();
    });
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, () => {
        const sess = socket.request.session;
        if (sess && (sess.userId || sess.isRoot)) {
            return next();
        }
        next(new Error('Unauthorized Socket.io connection'));
    });
});

// --- DATABASE INIT & AUTO-PROVISION ---
const ALL_TABS = [
    'dashboard', 'cdr', 'voicemails', 'ext-stats', 'operator', 'gsm-dongles', 'softphone', 'contacts', 'users', 'config', 'storage',
    'config-extensions', 'config-ringgroups', 'config-queues', 'config-recordings', 'config-trunks', 'config-inbound', 'config-outbound', 'config-voicemail', 'config-diagram',
    'config-timegroups', 'config-timeconditions', 'config-announcements', 'config-modem', 'config-dongles', 'config-terminal',
    'operator-listen', 'operator-whisper', 'operator-barge', 'operator-hangup', 'operator-hijack'
];

async function initAuthDb() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'admin',
        password: process.env.DB_PASS || 'admin',
        database: ASTERISK_DB
    });
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dashboard_users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(100) NOT NULL UNIQUE,
            email VARCHAR(255) DEFAULT NULL,
            password_hash VARCHAR(255) NOT NULL,
            reset_token VARCHAR(255) DEFAULT NULL,
            reset_expires DATETIME DEFAULT NULL,
            group_id INT DEFAULT NULL,
            extension VARCHAR(20) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Add group_id and extension columns if they don't exist (for existing installs)
    try { await conn.execute('ALTER TABLE dashboard_users ADD COLUMN group_id INT DEFAULT NULL'); } catch (_) {}
    try { await conn.execute('ALTER TABLE dashboard_users ADD COLUMN reset_token_expires DATETIME DEFAULT NULL'); } catch (_) {}
    try { await conn.execute('ALTER TABLE dashboard_users ADD COLUMN extension VARCHAR(20) DEFAULT NULL'); } catch (_) {}
    try { await conn.execute('ALTER TABLE dashboard_users ADD UNIQUE KEY idx_unique_email (email)'); } catch (_) {}
    try { await conn.execute('ALTER TABLE dashboard_users ADD KEY idx_dash_users_extension (extension)'); } catch (_) {}
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dashboard_settings (
            setting_key VARCHAR(100) PRIMARY KEY,
            setting_value TEXT DEFAULT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dashboard_groups (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dashboard_group_permissions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            group_id INT NOT NULL,
            tab VARCHAR(50) NOT NULL,
            UNIQUE KEY idx_group_tab (group_id, tab)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS gsm_dongles (
            dongle_name VARCHAR(50) NOT NULL PRIMARY KEY,
            imsi VARCHAR(30) DEFAULT NULL,
            imei VARCHAR(30) DEFAULT NULL,
            phone_number VARCHAR(30) DEFAULT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            dynamic_enabled TINYINT(1) NOT NULL DEFAULT 0,
            KEY idx_imsi (imsi),
            KEY idx_imei (imei)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dongle_state_logs (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            dongle_name VARCHAR(50) NOT NULL,
            sim_number VARCHAR(50) DEFAULT NULL,
            imsi VARCHAR(30) DEFAULT NULL,
            imei VARCHAR(30) DEFAULT NULL,
            state VARCHAR(50) NOT NULL,
            started_at DATETIME NOT NULL,
            ended_at DATETIME DEFAULT NULL,
            duration_sec INT DEFAULT 0,
            KEY idx_dongle_start (dongle_name, started_at),
            KEY idx_sim_start (sim_number, started_at),
            KEY idx_state (state)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try { await conn.execute('ALTER TABLE gsm_dongles ADD COLUMN dynamic_enabled TINYINT(1) NOT NULL DEFAULT 0'); } catch (_) {}
    try { await conn.execute('UPDATE gsm_dongles SET dynamic_enabled = 0 WHERE dynamic_enabled IS NULL'); } catch (_) {}
    try { await conn.execute('ALTER TABLE gsm_dongles MODIFY dynamic_enabled TINYINT(1) NOT NULL DEFAULT 0'); } catch (_) {}
    try {
        const [dRows] = await conn.execute('SELECT dongle_name, dynamic_enabled FROM gsm_dongles');
        const { execFile: execFileCb } = require('child_process');
        dRows.forEach(row => {
            if (row.dongle_name) {
                const val = Number(row.dynamic_enabled) === 1 ? '1' : '0';
                execFileCb(ASTERISK_BIN, ['-rx', `database put DONGLE_SETTINGS ${row.dongle_name} ${val}`], () => {});
            }
        });
    } catch (_) {}
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS ${tables.employeeExtras} (
            extension VARCHAR(50) NOT NULL PRIMARY KEY,
            photo VARCHAR(255) DEFAULT NULL,
            title VARCHAR(255) DEFAULT NULL,
            emp_group VARCHAR(100) DEFAULT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS ${tables.employeeGroups} (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE,
            description TEXT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Auto-Dialer Schema Initialization
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dialer_campaigns (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            mode ENUM('progressive', 'predictive') DEFAULT 'progressive',
            status ENUM('draft', 'running', 'paused', 'completed') DEFAULT 'draft',
            outbound_route_id INT DEFAULT NULL,
            origination_caller_id VARCHAR(50) DEFAULT '101',
            queue_name VARCHAR(50) DEFAULT 'autodialer-queue',
            fallback_destination VARCHAR(100) DEFAULT 'app-blackhole,hangup,1',
            pacing_ratio DECIMAL(3,1) DEFAULT 1.0,
            max_concurrent_dials INT DEFAULT 5,
            amd_enabled TINYINT(1) DEFAULT 1,
            wrapup_time_sec INT DEFAULT 15,
            max_queue_wait_sec INT DEFAULT 5,
            auto_answer TINYINT(1) DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dialer_leads (
            id INT AUTO_INCREMENT PRIMARY KEY,
            campaign_id INT NOT NULL,
            phone_number VARCHAR(50) NOT NULL,
            first_name VARCHAR(100) DEFAULT NULL,
            last_name VARCHAR(100) DEFAULT NULL,
            company VARCHAR(100) DEFAULT NULL,
            custom_data JSON DEFAULT NULL,
            status ENUM('pending', 'dialing', 'connected', 'no_answer', 'busy', 'failed', 'machine', 'dnc') DEFAULT 'pending',
            attempts INT DEFAULT 0,
            last_called_at DATETIME DEFAULT NULL,
            agent_extension VARCHAR(20) DEFAULT NULL,
            disposition VARCHAR(50) DEFAULT NULL,
            call_duration_sec INT DEFAULT 0,
            KEY idx_camp_status_id (campaign_id, status, id),
            KEY idx_phone (phone_number)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dialer_call_attempts (
            attempt_uuid VARCHAR(64) PRIMARY KEY,
            action_id VARCHAR(64) UNIQUE,
            campaign_id INT NOT NULL,
            lead_id INT NOT NULL,
            active_flag TINYINT(1) DEFAULT NULL,
            uniqueid VARCHAR(64) DEFAULT NULL,
            linkedid VARCHAR(64) DEFAULT NULL,
            channel VARCHAR(100) DEFAULT NULL,
            dongle_id VARCHAR(50) DEFAULT NULL,
            agent_extension VARCHAR(20) DEFAULT NULL,
            status ENUM('originated', 'ringing', 'lead_answered', 'amd_passed', 'queued', 'agent_bridged', 'completed', 'abandoned', 'machine', 'busy', 'no_answer', 'failed', 'stale') NOT NULL DEFAULT 'originated',
            cause_code INT DEFAULT NULL,
            lease_expires_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY idx_active_lead (lead_id, active_flag),
            KEY idx_action_id (action_id),
            KEY idx_uniqueid (uniqueid),
            KEY idx_linkedid (linkedid),
            KEY idx_camp_status (campaign_id, status),
            KEY idx_lease (status, lease_expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dialer_agent_states (
            extension VARCHAR(20) PRIMARY KEY,
            state ENUM('idle', 'reserved', 'in_call', 'wrapup', 'paused') DEFAULT 'idle',
            current_lead_id INT DEFAULT NULL,
            current_attempt_uuid VARCHAR(64) DEFAULT NULL,
            wrapup_until DATETIME DEFAULT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dialer_dispositions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(50) NOT NULL UNIQUE,
            category ENUM('interested', 'not_interested', 'callback', 'sale', 'wrong_number') DEFAULT 'not_interested'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dialer_dnc (
            phone_number VARCHAR(50) PRIMARY KEY,
            reason VARCHAR(255) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dashboard_inbound_blacklist (
            id INT AUTO_INCREMENT PRIMARY KEY,
            phone_number VARCHAR(50) NOT NULL UNIQUE,
            description VARCHAR(255) DEFAULT NULL,
            action VARCHAR(30) DEFAULT 'zapateller',
            enabled TINYINT(1) DEFAULT 1,
            blocked_count INT DEFAULT 0,
            last_blocked_at DATETIME DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_phone (phone_number),
            KEY idx_enabled (enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS storage_settings (
            id INT PRIMARY KEY DEFAULT 1,
            auto_purge_days INT DEFAULT 90,
            gdrive_enabled TINYINT(1) DEFAULT 0,
            gdrive_folder_name VARCHAR(255) DEFAULT 'Sokrat-VoIP-Backups',
            gdrive_credentials TEXT DEFAULT NULL,
            auto_backup_schedule VARCHAR(50) DEFAULT 'daily',
            last_backup_at DATETIME DEFAULT NULL,
            last_backup_status VARCHAR(50) DEFAULT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Migrate columns for existing partial tables
    try { await conn.execute('ALTER TABLE storage_settings ADD COLUMN auto_purge_days INT DEFAULT 90'); } catch (_) {}
    try { await conn.execute('ALTER TABLE storage_settings ADD COLUMN gdrive_enabled TINYINT(1) DEFAULT 0'); } catch (_) {}
    try { await conn.execute('ALTER TABLE storage_settings ADD COLUMN gdrive_folder_name VARCHAR(255) DEFAULT \'Sokrat-VoIP-Backups\''); } catch (_) {}
    try { await conn.execute('ALTER TABLE storage_settings ADD COLUMN gdrive_credentials TEXT DEFAULT NULL'); } catch (_) {}
    try { await conn.execute('ALTER TABLE storage_settings ADD COLUMN auto_backup_schedule VARCHAR(50) DEFAULT \'daily\''); } catch (_) {}
    try { await conn.execute('ALTER TABLE storage_settings ADD COLUMN last_backup_at DATETIME DEFAULT NULL'); } catch (_) {}
    try { await conn.execute('ALTER TABLE storage_settings ADD COLUMN last_backup_status VARCHAR(50) DEFAULT NULL'); } catch (_) {}
    try { await conn.execute('ALTER TABLE storage_settings ADD COLUMN queue_provisioned TINYINT(1) DEFAULT 0'); } catch (_) {}
    await conn.execute('INSERT IGNORE INTO storage_settings (id) VALUES (1)');
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS voicemail_storage_settings (
            id INT PRIMARY KEY DEFAULT 1,
            max_messages INT DEFAULT 1000,
            max_duration_sec INT DEFAULT 300,
            retention_days INT DEFAULT 90,
            auto_purge_enabled TINYINT(1) DEFAULT 0,
            last_purged_at DATETIME DEFAULT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute('INSERT IGNORE INTO voicemail_storage_settings (id, max_messages, max_duration_sec, retention_days, auto_purge_enabled) VALUES (1, 1000, 300, 90, 0)');


    // Default dispositions
    const defaultDispositions = [
        ['Interested', 'interested'],
        ['Sale', 'sale'],
        ['Callback', 'callback'],
        ['Not Interested', 'not_interested'],
        ['Wrong Number', 'wrong_number']
    ];
    for (const [dName, dCat] of defaultDispositions) {
        try {
            await conn.execute('INSERT IGNORE INTO dialer_dispositions (name, category) VALUES (?, ?)', [dName, dCat]);
        } catch (_) {}
    }
    // Auto-provision HD Voice / Wideband codec priorities (G.722 / Opus > G.711) for high-quality extension calls
    try {
        await conn.execute("UPDATE `asterisk`.`sipsettings` SET `data` = '1', `seq` = 0 WHERE `keyword` = 'g722'");
        await conn.execute("UPDATE `asterisk`.`sipsettings` SET `data` = '2', `seq` = 1 WHERE `keyword` = 'opus'");
        await conn.execute("UPDATE `asterisk`.`sipsettings` SET `data` = '3', `seq` = 2 WHERE `keyword` = 'ulaw'");
        await conn.execute("UPDATE `asterisk`.`sipsettings` SET `data` = '4', `seq` = 3 WHERE `keyword` = 'alaw'");
        await conn.execute("UPDATE `asterisk`.`sipsettings` SET `data` = '5', `seq` = 4 WHERE `keyword` = 'gsm'");

        await conn.execute("UPDATE `asterisk`.`pjsipsettings` SET `data` = '1', `seq` = 0 WHERE `keyword` = 'g722'");
        await conn.execute("UPDATE `asterisk`.`pjsipsettings` SET `data` = '2', `seq` = 1 WHERE `keyword` = 'opus'");
        await conn.execute("UPDATE `asterisk`.`pjsipsettings` SET `data` = '3', `seq` = 2 WHERE `keyword` = 'ulaw'");
        await conn.execute("UPDATE `asterisk`.`pjsipsettings` SET `data` = '4', `seq` = 3 WHERE `keyword` = 'alaw'");
        await conn.execute("UPDATE `asterisk`.`pjsipsettings` SET `data` = '5', `seq` = 4 WHERE `keyword` = 'gsm'");
    } catch (_) {}

    // Migrate metadata written by the short-lived dual-database implementation.
    // INSERT IGNORE makes ASTERISK_DB canonical without overwriting newer canonical rows.
    if (CDR_DB !== ASTERISK_DB) {
        try {
            await conn.execute(`
                INSERT IGNORE INTO ${tables.employeeGroups} (name, description, created_at)
                SELECT name, description, created_at
                FROM ${tableName(CDR_DB, 'employee_groups')}
            `);
            await conn.execute(`
                INSERT IGNORE INTO ${tables.employeeExtras} (extension, photo, title, emp_group, updated_at)
                SELECT extension, photo, title, emp_group, updated_at
                FROM ${tableName(CDR_DB, 'employee_extras')}
            `);
        } catch (error) {
            if (error.code !== 'ER_NO_SUCH_TABLE') {
                console.warn('Employee metadata migration warning:', error.message);
            }
        }
    }

    // Ensure "super admins" group exists
    const [existingGroups] = await conn.execute('SELECT id FROM dashboard_groups WHERE name = ?', ['super admins']);
    let superAdminGroupId;
    if (existingGroups.length === 0) {
        const [r] = await conn.execute('INSERT INTO dashboard_groups (name) VALUES (?)', ['super admins']);
        superAdminGroupId = r.insertId;
        for (const tab of ALL_TABS) {
            await conn.execute('INSERT INTO dashboard_group_permissions (group_id, tab) VALUES (?, ?)', [superAdminGroupId, tab]);
        }
        console.log('AUTH: Created "super admins" group with all permissions');
    } else {
        superAdminGroupId = existingGroups[0].id;
    }

    // Ensure super admins group has all permissions (including newly added tabs on upgrades)
    for (const tab of ALL_TABS) {
        try {
            await conn.execute('INSERT IGNORE INTO dashboard_group_permissions (group_id, tab) VALUES (?, ?)', [superAdminGroupId, tab]);
        } catch (_) {}
    }

    // User accounts setup: auto-provision default "admin" account with password "admin"
    const [adminCheck] = await conn.execute('SELECT id FROM dashboard_users WHERE username = ?', ['admin']);
    if (adminCheck.length === 0) {
        const adminPassHash = await bcrypt.hash('admin', 10);
        await conn.execute('INSERT INTO dashboard_users (username, password_hash, group_id) VALUES (?, ?, ?)', ['admin', adminPassHash, superAdminGroupId]);
        console.log('AUTH: Auto-provisioned default "admin" user with password "admin" in super admins group');
    }

    // Assign any existing users without a group to the super admins group
    const [orphans] = await conn.execute('SELECT COUNT(*) AS cnt FROM dashboard_users WHERE group_id IS NULL');
    if (orphans[0].cnt > 0) {
        await conn.execute('UPDATE dashboard_users SET group_id = ? WHERE group_id IS NULL', [superAdminGroupId]);
        console.log('AUTH: Assigned ' + orphans[0].cnt + ' existing user(s) to super admins group');
    }
    console.log('AUTH: Dashboard users table ready');

    // Auto-provision default ACD queue 300 (autodialer-queue) ONLY once on initial setup if no queues exist
    try {
        const [sRows] = await conn.execute('SELECT queue_provisioned FROM storage_settings WHERE id = 1');
        const isProvisioned = sRows.length > 0 && sRows[0].queue_provisioned === 1;

        if (!isProvisioned) {
            const [qCount] = await conn.execute('SELECT COUNT(*) AS cnt FROM `asterisk`.`queues_config`');
            if (qCount[0].cnt === 0) {
                const queueExtension = '300';
                const queueName = 'autodialer-queue';
                const failDestination = 'app-blackhole,hangup,1';

                await conn.beginTransaction();
                try {
                    await conn.execute(`
                        INSERT INTO \`asterisk\`.\`queues_config\`
                        (extension, descr, grppre, alertinfo, joinannounce_id, ringing, agentannounce_id, maxwait, password, ivr_id, callback_id, dest, destcontinue, cwignore, qregex, queuewait, use_queue_context, togglehint, qnoanswer, callconfirm, callconfirm_id, monitor_type, monitor_heard, monitor_spoken)
                        VALUES (?, ?, '', '', 0, 0, 0, '0', '', 'none', 'none', ?, ?, 0, '', 0, 0, 0, 0, 0, 0, '', 0, 0)
                    `, [queueExtension, queueName, failDestination, failDestination]);

                    const [deviceRows] = await conn.execute(
                        'SELECT dial FROM `asterisk`.`devices` WHERE id = ?',
                        ['101']
                    );
                    const memberInterface = deviceRows[0]?.dial || 'SIP/101';
                    const queueDetails = [
                        ['strategy', 'ringall'],
                        ['autofill', 'yes'],
                        ['ringinuse', 'yes'],
                        ['musicclass', 'default'],
                        ['music', 'default'],
                        ['timeout', '15'],
                        ['retry', '5'],
                        ['maxwait', '0'],
                        ['goto', failDestination],
                        ['servicelevel', '30'],
                        ['joinempty', 'yes'],
                        ['leavewhenempty', 'no'],
                        ['monitor-join', 'yes'],
                        ['wrapuptime', '0'],
                        ['maxlen', '0'],
                        ['member', memberInterface]
                    ];

                    for (const [keyword, data] of queueDetails) {
                        await conn.execute(
                            'INSERT INTO `asterisk`.`queues_details` (id, keyword, data, flags) VALUES (?, ?, ?, 0)',
                            [queueExtension, keyword, data]
                        );
                    }

                    await conn.commit();
                    reloadPbxConfig();
                    console.log(`QUEUE: Auto-provisioned default ACD queue ${queueExtension} (${queueName}) with member ${memberInterface}`);
                } catch (error) {
                    await conn.rollback();
                    throw error;
                }
            }
            await conn.execute('UPDATE storage_settings SET queue_provisioned = 1 WHERE id = 1');
        }
    } catch (qErr) {
        console.error('QUEUE auto-provision error:', qErr.message);
    }
    try {
        await initCrmTables(conn);
    } catch (crmErr) {
        console.error('CRM DB init error:', crmErr.message);
    }
    await conn.end();
    await syncAllExtensionsAstdb();
    await acquireDialerLeaderLock();
    try {
        const [vmRows] = await pool.query('SELECT * FROM `asterisk`.`voicemail_storage_settings` WHERE id = 1');
        if (vmRows && vmRows.length > 0) {
            syncVoicemailLimits(vmRows[0].max_messages || 1000, vmRows[0].max_duration_sec || 300);
        } else {
            syncVoicemailLimits(1000, 300);
        }
    } catch (vmErr) {
        console.error('Voicemail limits boot sync error:', vmErr.message);
    }
}
initAuthDb().catch(err => console.error('AUTH DB init error:', err));

// --- SESSION HELPERS ---
function isSuperAdmin(req) {
    if (!req || !req.session) return false;
    if (req.session.isRoot || req.session.username === ROOT_USER) return true;
    const g = String(req.session.userGroup || '').toLowerCase().trim();
    return g === 'super admins' || g === 'super admin' || g === 'administrator' || g === 'administrators';
}

function getUserScopedExtension(req) {
    if (!req || !req.session) return null;
    if (isSuperAdmin(req)) return null;
    const ext = req.session.extension;
    if (!ext || typeof ext !== 'string' || ext.trim() === '' || ext === 'ALL' || ext === 'none') return null;
    return ext.trim();
}

async function getUserPermissions(userId) {
    try {
        const [rows] = await pool.query(`
            SELECT p.tab FROM ${tables.dashboardGroupPermissions} p
            JOIN ${tables.dashboardUsers} u ON u.group_id = p.group_id
            WHERE u.id = ?
        `, [userId]);
        return rows.map(r => r.tab);
    } catch (err) {
        console.error('getUserPermissions error:', err.message);
        return [];
    }
}

function normalizeDongleMappingKey(value) {
    const key = String(value || '').trim();
    return /^[a-zA-Z0-9_-]+$/.test(key) ? key : '';
}

function normalizeDongleIdentity(value) {
    const identity = String(value || '').trim();
    return /^\d{5,30}$/.test(identity) ? identity : '';
}

function normalizeConfiguredDid(value) {
    const did = String(value || '').trim();
    return /^\+?\d{3,30}$/.test(did) ? did : '';
}

async function deleteAstDbKey(family, key) {
    const safeKey = normalizeDongleMappingKey(key);
    if (!safeKey) return;
    await execFileAsync(ASTERISK_BIN, ['-rx', `database del ${family} ${safeKey}`]);
}

async function clearDongleMappingAliases(dongleName, imsi, imei) {
    const aliases = [
        ['dongle_map', normalizeDongleMappingKey(dongleName)],
        ['sim_map', normalizeDongleIdentity(imsi)],
        ['DONGLE_NUMBERS', normalizeDongleIdentity(imsi)],
        ['DONGLE_NUMBERS', normalizeDongleIdentity(imei)]
    ];
    const seen = new Set();
    for (const [family, key] of aliases) {
        if (!key || seen.has(`${family}/${key}`)) continue;
        seen.add(`${family}/${key}`);
        await deleteAstDbKey(family, key);
    }
}

async function syncDongleMappingAliases({ dongleName, imsi, imei, phoneNumber }) {
    const safeDongleName = normalizeDongleMappingKey(dongleName);
    const safeImsi = normalizeDongleIdentity(imsi);
    const safeImei = normalizeDongleIdentity(imei);
    const safeDid = normalizeConfiguredDid(phoneNumber);
    if (!safeDid || (!safeDongleName && !safeImsi && !safeImei)) return false;

    if (safeDongleName) {
        await execFileAsync(ASTERISK_BIN, ['-rx', `database put dongle_map ${safeDongleName} ${safeDid}`]);
    }
    if (safeImsi) {
        await execFileAsync(ASTERISK_BIN, ['-rx', `database put sim_map ${safeImsi} ${safeDid}`]);
        await execFileAsync(ASTERISK_BIN, ['-rx', `database put DONGLE_NUMBERS ${safeImsi} ${safeDid}`]);
    }
    if (safeImei) {
        await execFileAsync(ASTERISK_BIN, ['-rx', `database put DONGLE_NUMBERS ${safeImei} ${safeDid}`]);
    }
    return true;
}

async function syncDongleDynamicSetting(dongleName, enabled) {
    const safeDongleName = normalizeDongleMappingKey(dongleName);
    if (!safeDongleName) return;
    await execFileAsync(ASTERISK_BIN, ['-rx', `database put DONGLE_SETTINGS ${safeDongleName} ${enabled ? '1' : '0'}`]);
}

async function reconcileDongleMappings() {
    try {
        const devicesOutput = await execFileAsync(ASTERISK_BIN, ['-rx', 'dongle show devices']);
        const parsed = parseDevicesOutput(devicesOutput || '', true);
        const observedDongles = new Map();

        for (const device of parsed) {
            const name = normalizeDongleMappingKey(device.ID);
            if (!name || !name.startsWith('dongle')) continue;
            observedDongles.set(name, {
                name,
                imsi: normalizeDongleIdentity(device.IMSI),
                imei: normalizeDongleIdentity(device.IMEI)
            });
        }

        const [dbRows] = await pool.query(
            'SELECT dongle_name, imsi, imei, phone_number, dynamic_enabled FROM `asterisk`.`gsm_dongles`'
        );
        const confDongles = parseDongleConfGain().dongles;
        const validSlotNames = new Set([...Object.keys(confDongles), ...observedDongles.keys()]);

        for (const row of [...dbRows]) {
            if (validSlotNames.has(row.dongle_name)) continue;
            console.log(`DONGLE-RECONCILE: Removing stale dongle slot '${row.dongle_name}'`);
            await clearDongleMappingAliases(row.dongle_name, row.imsi, row.imei);
            await deleteAstDbKey('DONGLE_SETTINGS', row.dongle_name);
            await pool.query('DELETE FROM `asterisk`.`gsm_dongles` WHERE dongle_name = ?', [row.dongle_name]);
            dbRows.splice(dbRows.indexOf(row), 1);
        }

        for (const dongleName of [...validSlotNames].sort()) {
            if (!dongleName.startsWith('dongle')) continue;

            const observed = observedDongles.get(dongleName) || { imsi: '', imei: '' };
            let slotRow = dbRows.find(row => row.dongle_name === dongleName);
            const storedImsi = normalizeDongleIdentity(slotRow?.imsi);
            const storedImei = normalizeDongleIdentity(slotRow?.imei);
            const liveImsi = observed.imsi;
            const liveImei = observed.imei;
            const hadStoredIdentity = Boolean(storedImsi || storedImei);
            const hasObservedIdentity = Boolean(liveImsi || liveImei);
            const firstIdentity = hasObservedIdentity && !hadStoredIdentity;
            const sameImsi = Boolean(storedImsi && liveImsi && storedImsi === liveImsi);
            const imsiChanged = Boolean(storedImsi && liveImsi && storedImsi !== liveImsi);
            const imeiChanged = Boolean(storedImei && liveImei && storedImei !== liveImei);
            const identityChanged = imsiChanged || imeiChanged;
            // If hardware identity moved to another active slot, release stale identity from this slot
            const identityClaimedElsewhere = !hasObservedIdentity && [...observedDongles.entries()].some(([otherSlot, otherObs]) => {
                if (otherSlot === dongleName) return false;
                return (storedImsi && otherObs.imsi && otherObs.imsi === storedImsi) ||
                       (storedImei && otherObs.imei && otherObs.imei === storedImei);
            });

            if (identityClaimedElsewhere) {
                console.log(`DONGLE-RECONCILE: Hardware from ${dongleName} moved to another slot; releasing stale identity`);
                await clearDongleMappingAliases(dongleName, storedImsi, storedImei);
                await deleteAstDbKey('DONGLE_SETTINGS', dongleName);
                await pool.query(`
                    UPDATE \`asterisk\`.\`gsm_dongles\`
                    SET imsi = NULL, imei = NULL, phone_number = NULL, dynamic_enabled = 0
                    WHERE dongle_name = ?
                `, [dongleName]);
                if (slotRow) {
                    Object.assign(slotRow, { imsi: null, imei: null, phone_number: null, dynamic_enabled: 0 });
                }
                continue;
            }

            const identityOwners = dbRows.filter(row => {
                if (row.dongle_name === dongleName) return false;
                const rowImsi = normalizeDongleIdentity(row.imsi);
                const rowImei = normalizeDongleIdentity(row.imei);
                return (liveImsi && rowImsi === liveImsi) || (liveImei && rowImei === liveImei);
            });
            const ownerNumbers = [...new Set(identityOwners
                .map(row => normalizeConfiguredDid(row.phone_number))
                .filter(Boolean))];
            if (ownerNumbers.length > 1) {
                console.error(`DONGLE-RECONCILE: Conflicting DIDs for hardware in ${dongleName}; refusing to copy an ambiguous number`);
            }
            const ownerNumber = ownerNumbers.length === 1 ? ownerNumbers[0] : '';
            const slotNumber = normalizeConfiguredDid(slotRow?.phone_number);
            const preserveSlotNumber = !identityChanged || firstIdentity || sameImsi;
            const configuredNumber = (preserveSlotNumber ? slotNumber : '') || ownerNumber;
            const newHardware = firstIdentity || identityChanged;
            const dynamicEnabled = newHardware
                ? false
                : Boolean(slotRow && Number(slotRow.dynamic_enabled) === 1);
            const nextImsi = liveImsi || storedImsi;
            const nextImei = liveImei || storedImei;

            if (identityChanged) {
                await clearDongleMappingAliases(dongleName, storedImsi, storedImei);
                console.log(`DONGLE-RECONCILE: Hardware identity changed in ${dongleName}; dynamic mapping reset to off`);
            } else if (firstIdentity) {
                console.log(`DONGLE-RECONCILE: New hardware detected in ${dongleName}; dynamic mapping defaults to off`);
            }

            await pool.query(`
                INSERT INTO \`asterisk\`.\`gsm_dongles\`
                    (dongle_name, imsi, imei, phone_number, dynamic_enabled)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    imsi = VALUES(imsi),
                    imei = VALUES(imei),
                    phone_number = VALUES(phone_number),
                    dynamic_enabled = VALUES(dynamic_enabled)
            `, [dongleName, nextImsi || null, nextImei || null, configuredNumber || null, dynamicEnabled ? 1 : 0]);

            const persistedRow = {
                dongle_name: dongleName,
                imsi: nextImsi,
                imei: nextImei,
                phone_number: configuredNumber,
                dynamic_enabled: dynamicEnabled ? 1 : 0
            };
            if (slotRow) {
                Object.assign(slotRow, persistedRow);
            } else {
                slotRow = persistedRow;
                dbRows.push(slotRow);
            }

            await syncDongleDynamicSetting(dongleName, dynamicEnabled);
            if (configuredNumber) {
                await syncDongleMappingAliases({
                    dongleName,
                    imsi: nextImsi,
                    imei: nextImei,
                    phoneNumber: configuredNumber
                });
            } else {
                await clearDongleMappingAliases(dongleName, nextImsi, nextImei);
            }
        }
    } catch (error) {
        console.error('DONGLE-RECONCILE: Error syncing GSM mappings:', error.message);
    }
}
const TAB_ROUTE_MAP = {
    '/': 'dashboard',
    '/cdr': 'cdr',
    '/voicemails': 'voicemails',
    '/ext-stats': 'ext-stats',
    '/operator': 'operator',
    '/gsm-dongles': 'gsm-dongles',
    '/softphone': 'softphone',
    '/contacts': 'contacts',
    '/users': 'users',
    '/config': 'config',
    '/dialer': 'dialer',
    '/storage': 'storage'
};

// --- AUTH MIDDLEWARE ---
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        res.locals.currentUser = req.session.username;
        return next();
    }
    if (req.path.startsWith('/api/') || req.path.startsWith('/integrations/') || req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });
    }
    const loginUrl = '/login' + (req.originalUrl !== '/' ? '?redirect=' + encodeURIComponent(req.originalUrl) : '');
    res.redirect(loginUrl);
}
function requireActionPermission(actionPermission) {
    return (req, res, next) => {
        if (isSuperAdmin(req)) return next();
        const perms = req.session.userPermissions || [];
        if (perms.includes(actionPermission) || perms.includes('operator')) {
            return next();
        }
        return res.status(403).json({ success: false, error: `Forbidden. Missing permission: ${actionPermission}` });
    };
}

function requireConfigPermission(subTab) {
    return (req, res, next) => {
        if (isSuperAdmin(req)) return next();
        const perms = req.session.userPermissions || [];
        if (perms.includes('config') || perms.includes('config-' + subTab)) {
            return next();
        }
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    };
}

// --- PROTECT ALL OPERATIONAL ROUTES ---
app.use((req, res, next) => {
    const publicPaths = [
        '/login', '/logout', '/forgot-password', '/reset-password',
        '/api/auth/forgot-password', '/api/auth/reset-password', '/api/network-info',
        '/favicon.ico', '/favicon.png', '/robots.txt', '/embed/crm/live'
    ];
    if (publicPaths.includes(req.path) || req.path.startsWith('/public/') || req.path.startsWith('/api/integrations/crm/v1/')) {
        return next();
    }
    requireAuth(req, res, next);
});

// --- TAB PERMISSION MIDDLEWARE ---
app.use(async (req, res, next) => {
    res.locals.isSuperAdmin = isSuperAdmin(req);
    res.locals.userExtension = (req.session && req.session.extension) ? req.session.extension : null;
    const tab = TAB_ROUTE_MAP[req.path];
    if (!tab) return next();
    // Load permissions if not cached
    if (!res.locals.isSuperAdmin && !req.session.userPermissions) {
        try {
            req.session.userPermissions = await getUserPermissions(req.session.userId);
        } catch (_) {
            req.session.userPermissions = [];
        }
    }
    // Dashboard and Contacts are accessible to everyone
    if (tab === 'dashboard' || tab === 'contacts') {
        res.locals.allowedTabs = res.locals.isSuperAdmin ? ALL_TABS : req.session.userPermissions;
        return next();
    }
    // Users tab is super admin only
    if (tab === 'users') {
        if (!res.locals.isSuperAdmin) return res.redirect('/');
        res.locals.allowedTabs = ALL_TABS;
        return next();
    }
    if (res.locals.isSuperAdmin) {
        res.locals.allowedTabs = ALL_TABS;
        return next();
    }
    res.locals.allowedTabs = req.session.userPermissions;
    if (req.session.userPermissions.includes(tab)) return next();
    if (tab === 'config' && req.session.userPermissions.some(p => p.startsWith('config-'))) {
        return next();
    }
    // Denied — redirect to the first tab they *can* access, or /login
    const tabToRoute = { dashboard: '/', cdr: '/cdr', voicemails: '/voicemails', 'ext-stats': '/ext-stats', operator: '/operator', 'gsm-dongles': '/gsm-dongles', softphone: '/softphone', contacts: '/contacts', users: '/users', config: '/config', dialer: '/dialer', storage: '/storage' };
    const firstAllowed = req.session.userPermissions.find(p => tabToRoute[p] || (p.startsWith('config-') && tabToRoute['config']));
    res.redirect(firstAllowed ? (tabToRoute[firstAllowed] || '/config') : '/login');
});

// --- CONFIG SUB-TAB API PERMISSIONS MIDDLEWARE ---
app.use('/api/config', (req, res, next) => {
    if (isSuperAdmin(req)) return next();
    
    let subTab = null;
    if (req.path.startsWith('/extensions')) {
        subTab = 'extensions';
    } else if (req.path.startsWith('/ringgroups')) {
        subTab = 'ringgroups';
    } else if (req.path.startsWith('/queues')) {
        subTab = 'queues';
    } else if (req.path.startsWith('/recordings')) {
        subTab = 'recordings';
    } else if (req.path.startsWith('/trunks')) {
        subTab = 'trunks';
    } else if (req.path.startsWith('/routes/inbound')) {
        subTab = 'inbound';
    } else if (req.path.startsWith('/routes/outbound')) {
        subTab = 'outbound';
    } else if (req.path.startsWith('/voicemail')) {
        subTab = 'voicemail';
    } else if (req.path.startsWith('/diagram')) {
        subTab = 'diagram';
    } else if (req.path.startsWith('/timegroups')) {
        subTab = 'timegroups';
    } else if (req.path.startsWith('/timeconditions')) {
        subTab = 'timeconditions';
    } else if (req.path.startsWith('/announcements')) {
        subTab = 'announcements';
    } else if (req.path.startsWith('/modem')) {
        subTab = 'modem';
    } else if (req.path === '/reload') {
        const perms = req.session.userPermissions || [];
        const hasAnyConfig = perms.includes('config') || perms.some(p => p.startsWith('config-'));
        if (hasAnyConfig) return next();
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    
    if (!subTab) return next();

    const perms = req.session.userPermissions || [];
    if (perms.includes('config') || perms.includes('config-' + subTab)) {
        return next();
    }
    
    return res.status(403).json({ success: false, error: 'Unauthorized: Permission denied for ' + subTab });
});

function sanitizeLogPayload(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const sensitiveKeys = new Set(['password', 'password_confirmation', 'secret', 'token', 'authorization', 'pairing_code', 'client_secret', 'reset_token', 'sip_secret', 'secret_hash', 'credentials']);
    const copy = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
        if (sensitiveKeys.has(k.toLowerCase())) {
            copy[k] = '[REDACTED]';
        } else if (v && typeof v === 'object') {
            copy[k] = sanitizeLogPayload(v);
        } else {
            copy[k] = v;
        }
    }
    return copy;
}

app.use((req, res, next) => {
    const sensitiveEndpoints = ['/pair', '/token', '/login', '/reset-password', '/embed-tickets'];
    const isSensitive = sensitiveEndpoints.some(p => req.path.includes(p));

    if (req.path.startsWith('/api/') || req.path === '/gsm-dongles') {
        if (isSensitive) {
            console.log(`HTTP [${new Date().toISOString()}] ${req.method} ${req.url} - Body: [REDACTED SENSITIVE ENDPOINT]`);
        } else {
            console.log(`HTTP [${new Date().toISOString()}] ${req.method} ${req.url} - Body: ${JSON.stringify(sanitizeLogPayload(req.body))}`);
        }
    }
    next();
});

// --- DATABASE CONNECTION POOL SETUP ---
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'admin',
    password: process.env.DB_PASS || 'admin',
    database: CDR_DB,
    waitForConnections: true,
    connectionLimit: 10
});

let activeCalls = {};
let sipPresence = {};
let pjsipPresence = {};
let iaxPresence = {};
let peerStatus = {};
let peerIPs = {};
let pjsipContactState = {};
let sipSnapshotStartTime = 0;
// Mount CRM Integration REST API Router
app.use('/api/integrations/crm/v1', createCrmRouter(pool, { getPeerStatus: () => peerStatus }));

// Register /crm-live Socket.io namespace

function notifyCrmLiveBroadcaster() {
    if (typeof crmLiveBroadcaster === 'object' && crmLiveBroadcaster && typeof crmLiveBroadcaster.broadcastStateUpdate === 'function') {
        crmLiveBroadcaster.broadcastStateUpdate();
    }
}

const crmLiveBroadcaster = registerCrmLiveSocket(io, pool, {
    getPeerStatus: () => peerStatus,
    getActiveCalls: () => activeCalls,
    getAmiClient: () => amiClient,
    ASTERISK_BIN,
    execFileAsync
});
let pjsipSnapshotStartTime = 0;
let pjsipBatchContactIds = new Set();
let pendingOffline = {};
let isPeerListLoaded = false;
let extensionLastRealtimeTime = {};

function updateExtensionPresence(name) {
    if (!name) return;
    let hasPjsipContactOnline = false;
    for (let cid in pjsipContactState) {
        if (pjsipContactState[cid].endpoint === name && pjsipContactState[cid].isOnline) {
            hasPjsipContactOnline = true;
            break;
        }
    }
    let isOnline = (sipPresence[name] === true) || (pjsipPresence[name] === true) || hasPjsipContactOnline;
    if (peerStatus[name] !== isOnline) {
        peerStatus[name] = isOnline;
        io.emit('peerStatus', peerStatus); notifyCrmLiveBroadcaster();
        getTrunkStatusMap().then(map => io.emit('trunkStatus', map));
    }
}

function updateAllExtensionPresence() {
    let allExts = new Set([...Object.keys(sipPresence), ...Object.keys(pjsipPresence)]);
    for (let cid in pjsipContactState) {
        allExts.add(pjsipContactState[cid].endpoint);
    }
    for (let ext of allExts) {
        let hasPjsipContactOnline = false;
        for (let cid in pjsipContactState) {
            if (pjsipContactState[cid].endpoint === ext && pjsipContactState[cid].isOnline) {
                hasPjsipContactOnline = true;
                break;
            }
        }
        let isOnline = (sipPresence[ext] === true) || (pjsipPresence[ext] === true) || hasPjsipContactOnline;
        peerStatus[ext] = isOnline;
    }
    io.emit('peerStatus', peerStatus); notifyCrmLiveBroadcaster();
    getTrunkStatusMap().then(map => io.emit('trunkStatus', map));
}

function setExtensionOffline(name, source) {
    if (!name) return;
    const now = Date.now();
    extensionLastRealtimeTime[name] = now;

    if (pendingOffline[name]) {
        clearTimeout(pendingOffline[name]);
        delete pendingOffline[name];
    }

    sipPresence[name] = false;
    pjsipPresence[name] = false;
    for (let cid in pjsipContactState) {
        if (pjsipContactState[cid].endpoint === name) {
            pjsipContactState[cid].isOnline = false;
            pjsipContactState[cid].time = now;
        }
    }

    updateExtensionPresence(name);
}

function setExtensionOnline(name, source, ip) {
    if (!name) return;
    const now = Date.now();
    extensionLastRealtimeTime[name] = now;

    if (pendingOffline[name]) {
        clearTimeout(pendingOffline[name]);
        delete pendingOffline[name];
    }

    sipPresence[name] = true;
    pjsipPresence[name] = true;
    for (let cid in pjsipContactState) {
        if (pjsipContactState[cid].endpoint === name) {
            pjsipContactState[cid].isOnline = true;
            pjsipContactState[cid].time = now;
        }
    }

    let cleanIp = String(ip || '').trim().replace(/^sip:/i, '').split(':')[0].replace(/[^0-9.]/g, '');
    if (cleanIp && /^\d+\.\d+\.\d+\.\d+$/.test(cleanIp)) {
        peerIPs[name] = cleanIp;
        io.emit('peerIPs', peerIPs);
    }

    updateExtensionPresence(name);
}

function recomputePjsipPresence(name) {
    if (!name) return;
    updateExtensionPresence(name);
}

function recomputeAllPjsipPresence() {
    updateAllExtensionPresence();
}
function parseIax2PeersOutput(peersOut) {
    const presence = {};
    if (!peersOut) return presence;
    const lines = peersOut.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('Name/Username') || trimmed.includes('iax2 peers') || trimmed.startsWith('Host')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
            const rawName = parts[0];
            const peerName = rawName.split('/')[0];
            const lineUpper = trimmed.toUpperCase();
            const isOnline = lineUpper.includes(' OK') || lineUpper.includes('REACHABLE') || lineUpper.includes('REGISTERED') || lineUpper.includes('UNMONITORED');
            presence[peerName] = isOnline;
            presence[rawName] = isOnline;
        }
    }
    return presence;
}

function parseIax2RegistryOutput(regOut) {
    const presence = {};
    if (!regOut) return presence;
    const lines = regOut.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('Host') || trimmed.includes('IAX2 registrations')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 5) {
            const username = parts[2];
            const lineUpper = trimmed.toUpperCase();
            const isOnline = lineUpper.includes('REGISTERED') || lineUpper.includes('OK');
            if (username && username !== 'Username') {
                presence[username] = isOnline;
            }
        }
    }
    return presence;
}

async function getIax2StatusFromCliAsync() {
    const presence = {};
    try {
        const { execFile: execFileCb } = require('child_process');
        const execFilePromise = (cmd, args) => new Promise(resolve => execFileCb(cmd, args, (err, stdout) => resolve(err ? '' : stdout || '')));
        const [peersOut, regOut] = await Promise.all([
            execFilePromise(ASTERISK_BIN, ['-rx', 'iax2 show peers']),
            execFilePromise(ASTERISK_BIN, ['-rx', 'iax2 show registry'])
        ]);
        Object.assign(presence, parseIax2PeersOutput(peersOut));
        Object.assign(presence, parseIax2RegistryOutput(regOut));
    } catch (_) {}
    return presence;
}

async function getTrunkStatusMap() {
    try {
        const [trunks] = await pool.query("SELECT trunkid, name, tech, channelid, disabled, usercontext FROM `asterisk`.`trunks` WHERE LOWER(TRIM(tech)) IN ('sip', 'pjsip', 'iax', 'iax2') ORDER BY trunkid ASC");
        const iaxCliPresence = await getIax2StatusFromCliAsync();
        const statusMap = {};
        for (const t of trunks) {
            let online = false;
            const techLower = String(t.tech || '').toLowerCase().trim();
            let statusText = t.disabled === 'on' ? 'Disabled' : 'Offline';

            if (t.disabled === 'on') {
                online = false;
                statusText = 'Disabled';
            } else if (techLower === 'sip' || techLower === 'pjsip') {
                online = (sipPresence[t.channelid] === true) ||
                         (sipPresence[t.name] === true) ||
                         (sipPresence[`tr-peer-${t.trunkid}`] === true) ||
                         (sipPresence[`tr-trunk-${t.trunkid}`] === true) ||
                         (sipPresence[t.usercontext] === true);
                statusText = online ? 'OK' : 'Offline';
            } else if (techLower === 'iax2' || techLower === 'iax') {
                online = (iaxPresence[t.channelid] === true) ||
                         (iaxPresence[t.name] === true) ||
                         (iaxPresence[`tr-peer-${t.trunkid}`] === true) ||
                         (iaxPresence[`tr-trunk-${t.trunkid}`] === true) ||
                         (iaxPresence[t.usercontext] === true) ||
                         (iaxCliPresence[t.channelid] === true) ||
                         (iaxCliPresence[t.name] === true) ||
                         (iaxCliPresence[`tr-peer-${t.trunkid}`] === true) ||
                         (iaxCliPresence[`tr-trunk-${t.trunkid}`] === true) ||
                         (iaxCliPresence[t.usercontext] === true);
                statusText = online ? 'OK' : 'Offline';
            }

            let activeCount = 0;
            const trunkNameLower = String(t.name || '').toLowerCase();
            const channelIdLower = String(t.channelid || '').toLowerCase().replace('/$outnum$', '');

            for (const ext in activeCalls) {
                const call = activeCalls[ext];
                const ch = String(call?.channel || '').toLowerCase();
                if (ch.includes(trunkNameLower) || (channelIdLower && ch.includes(channelIdLower))) {
                    activeCount++;
                }
            }

            statusMap[t.trunkid] = {
                trunkid: t.trunkid,
                name: t.name,
                tech: t.tech,
                channelid: t.channelid || '',
                host: t.channelid || '',
                online: online,
                statusText: statusText,
                activeCalls: activeCount
            };
        }
        return statusMap;
    } catch(e) {
        console.error('getTrunkStatusMap error:', e.message);
        return {};
    }
}
let greetingConfig = { mode: 'none', extensions: [] };
const VM_GREETING_CONFIG_PATH = path.join(__dirname, 'vm_greeting_config.json');
function reloadGreetingConfig() {
    try {
        if (fs.existsSync(VM_GREETING_CONFIG_PATH)) {
            greetingConfig = JSON.parse(fs.readFileSync(VM_GREETING_CONFIG_PATH, 'utf8'));
        }
    } catch {}
}
// Helper to parse clean trunk technology & identifier from FreePBX trunk settings
function parseTrunkIdentifier(channelId, name) {
    const str = String(channelId || name || '').trim();
    let m = str.match(/dongle\/(?:[a-z]:)?([a-z0-9_]+)/i);
    if (m) return { tech: 'dongle', id: m[1].toLowerCase() };
    m = str.match(/^(SIP|PJSIP)\/([a-z0-9_]+)/i);
    if (m) return { tech: m[1].toLowerCase(), id: m[2].toLowerCase() };
    m = str.match(/^([a-z0-9_]+)$/i);
    if (m) return { tech: 'custom', id: m[1].toLowerCase() };
    return null;
}

// Fetch live Asterisk channel names via CLI
async function getLiveAsteriskChannelNames() {
    try {
        const { stdout } = await execPromise(`${ASTERISK_BIN} -rx "core show channels concise"`);
        if (!stdout) return [];
        const channels = [];
        for (const line of stdout.split('\n')) {
            const m = line.match(/^([^!]+)/);
            if (m) {
                const ch = m[1].trim();
                if (ch.includes('/') && !ch.startsWith('!')) channels.push(ch);
            }
        }
        return channels;
    } catch (err) {
        console.error('getLiveAsteriskChannelNames error:', err.message);
        return [];
    }
}

function extractDongleIdFromChannel(channelName) {
    if (!channelName) return null;
    let m = channelName.match(/^Dongle\/([^\/-]+)/i);
    if (m) return m[1].toLowerCase();
    return null;
}
function getExtensionFromChannel(channelName) {
    if (!channelName) return null;
    let m = String(channelName).match(/^(?:SIP|PJSIP|IAX2|Local)\/(\d{2,5})(?:[-@:;]|$)/i);
    if (m) return m[1];
    return null;
}
function getEndpointExtensionFromChannel(channelName) {
    if (!channelName) return null;
    let m = String(channelName).match(/^(?:SIP|PJSIP|IAX2)\/(\d{2,5})(?:[-@:;]|$)/i);
    if (m) return m[1];
    return null;
}
let amiClient = null;

// --- AUTO-DETECT DONGLE IMEI/SIM & CONFIGURE TRUNKS ---
async function detectDonglesAndSetTrunkCID() {
    try {
        await reconcileDongleMappings();

        const { execFile: execFileCb } = require('child_process');
        const execFileAsync = (cmd, args) => new Promise((resolve) => {
            execFileCb(cmd, args, (err, stdout) => resolve(err ? '' : stdout || ''));
        });

        const [dongleRows] = await pool.query('SELECT dongle_name, imsi, imei, phone_number FROM `asterisk`.`gsm_dongles`');
        if (!dongleRows.length) return;

        const [trunks] = await pool.query('SELECT trunkid, channelid FROM `asterisk`.`trunks` WHERE tech = ?', ['custom']);
        for (const trunk of trunks) {
            for (const row of dongleRows) {
                const dongleName = row.dongle_name;
                const imei = row.imei;
                const num = String(row.phone_number || '').trim();

                if (trunk.channelid && (trunk.channelid.includes(dongleName) || (imei && trunk.channelid.includes(imei)))) {
                    if (imei && trunk.channelid.includes(imei)) {
                        console.log(`DONGLE-CID: Preserved IMEI-based channel for trunk ${trunk.trunkid}: ${trunk.channelid}`);
                    } else {
                        const newChannelId = `dongle/${dongleName}/$OUTNUM$`;
                        if (trunk.channelid !== newChannelId) {
                            await pool.query('UPDATE `asterisk`.`trunks` SET channelid = ? WHERE trunkid = ?', [newChannelId, trunk.trunkid]);
                            console.log(`DONGLE-CID: Updated trunk ${trunk.trunkid} channel to Device-based: ${newChannelId}`);
                        }
                    }
                    if (num) {
                        await execFileAsync(ASTERISK_BIN, ['-rx', `database put TRUNK ${trunk.trunkid} outcid ${num}`]);
                        console.log(`DONGLE-CID: Set trunk ${trunk.trunkid} (${dongleName}) caller ID to ${num}`);
                    }
                }
            }
        }
        for (const row of dongleRows) {
            const dongleName = row.dongle_name;
            const imei = row.imei;
            if (dongleName) {
                await execFileAsync(ASTERISK_BIN, ['-rx', `database put DONGLE_DEVICE_MAP ${dongleName} ${dongleName}`]);
                if (imei) {
                    await execFileAsync(ASTERISK_BIN, ['-rx', `database put DONGLE_DEVICE_MAP i:${imei} ${dongleName}`]);
                    await execFileAsync(ASTERISK_BIN, ['-rx', `database put DONGLE_DEVICE_MAP ${imei} ${dongleName}`]);
                }
            }
        }
    } catch (e) {
        console.error('DONGLE-CID: Detection error:', e.message);
    }
}

// --- ASTERISK AMI REAL-TIME MONITORING ---
function connectAMI() {
    activeCalls = {};
    sipPresence = {};
    pjsipPresence = {};
    iaxPresence = {};
    peerStatus = {};
    pjsipContactState = {};
    pjsipSnapshotStartTime = 0;
    pjsipBatchContactIds = new Set();
    pendingOffline = {};
    let loggedIn = false;
    let queriedPeers = false;
    const client = net.connect({ port: process.env.AMI_PORT || 5038, host: AMI_HOST }, () => {
        client.write(`Action: Login\r\nUsername: ${process.env.AMI_USER || 'admin'}\r\nSecret: ${process.env.AMI_PASS || 'admin'}\r\n\r\n`);
        console.log('AMI: Connection opened, login sent');
    });
    amiClient = client;

    // Fallback: if login detection fails, try SIPpeers and PJSIPShowEndpoints anyway after 3s
    setTimeout(() => {
        if (!queriedPeers) {
            console.log('AMI: Login not detected within 3s, sending SIPpeers and PJSIPShowEndpoints anyway');
            queriedPeers = true;
            client.write(`Action: SIPpeers\r\n\r\n`);
            client.write(`Action: PJSIPShowEndpoints\r\n\r\n`);
        }
    }, 3000);

    function queryPeerStatus() {
        if (queriedPeers) return;
        queriedPeers = true;
        console.log('AMI: Sending SIPpeers, PJSIPShowEndpoints, PJSIPShowContacts, IAXpeerlist');
        sipSnapshotStartTime = Date.now();
        pjsipSnapshotStartTime = Date.now();
        pjsipBatchContactIds.clear();
        client.write(`Action: SIPpeers\r\n\r\n`);
        client.write(`Action: PJSIPShowEndpoints\r\n\r\n`);
        client.write(`Action: PJSIPShowContacts\r\n\r\n`);
        client.write(`Action: IAXpeerlist\r\n\r\n`);
        client.write(`Action: IAXregistry\r\n\r\n`);
    }

    let buffer = '';
    client.on('data', (data) => {
        buffer += data.toString();
        let packets = buffer.split('\r\n\r\n');
        buffer = packets.pop();

        packets.forEach(packet => {
            const lines = packet.split('\r\n');
            let event = {};
            lines.forEach(line => {
                const parts = line.split(': ');
                if (parts[0] && parts[1]) event[parts[0].trim()] = parts[1].trim();
            });

            // Detect successful login from Response or FullyBooted event
            if (!loggedIn) {
                if (event.Response === 'Success' || event.Event === 'FullyBooted') {
                    console.log('AMI: Login detected');
                    loggedIn = true;
                    queryPeerStatus();
                    detectDonglesAndSetTrunkCID();
                }
            }

            // Parse SIPpeers peer list entries
            if (event.Event === 'PeerEntry') {
                let rawName = event.ObjectName || '';
                let name = rawName ? rawName.split('/')[0] : '';
                let status = event.Status || '';
                if (name) {
                    let isOnline = status.toUpperCase().startsWith('OK');
                    let realtimeTime = extensionLastRealtimeTime[name] || 0;
                    if (realtimeTime <= sipSnapshotStartTime) {
                        sipPresence[name] = isOnline;
                        updateExtensionPresence(name);
                    }
                    let ip = event.IPaddress || '';
                    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
                        peerIPs[name] = ip;
                        io.emit('peerIPs', peerIPs);
                    }
                }
            }

            // Parse IAXpeerlist peer list entries
            if (event.Event === 'IAXPeerEntry') {
                let rawName = event.ObjectName || '';
                let name = rawName ? rawName.split('/')[0] : '';
                let status = String(event.Status || '').toUpperCase().trim();
                if (name) {
                    let isOnline = status.startsWith('OK') || status === 'REACHABLE' || status === 'REGISTERED' || status === 'UNMONITORED';
                    iaxPresence[name] = isOnline;
                    iaxPresence[rawName] = isOnline;
                    getTrunkStatusMap().then(map => io.emit('trunkStatus', map));
                }
            }

            // Parse IAXPeerStatus real-time events
            if (event.Event === 'IAXPeerStatus') {
                let rawPeer = event.Peer ? event.Peer.replace(/^(IAX2|IAX)\//i, '') : '';
                let name = rawPeer ? rawPeer.split('/')[0] : '';
                if (name) {
                    let statusStr = String(event.PeerStatus || '').trim().toUpperCase();
                    let isOnline = statusStr === 'REGISTERED' || statusStr === 'REACHABLE' || statusStr.startsWith('OK') || statusStr === 'UNMONITORED';
                    iaxPresence[name] = isOnline;
                    iaxPresence[rawPeer] = isOnline;
                    getTrunkStatusMap().then(map => io.emit('trunkStatus', map));
                }
            }

            // Parse IAXRegistry / Registry events
            if (event.Event === 'Registry' || event.Event === 'IAXRegistry' || event.Event === 'IAXRegistryEntry') {
                let channelType = String(event.ChannelType || event.Type || '').toUpperCase();
                if (channelType === 'IAX2' || channelType === 'IAX' || (event.Event && event.Event.startsWith('IAX'))) {
                    let username = event.Username || event.ObjectName || '';
                    let state = String(event.Status || event.State || '').toUpperCase();
                    let isOnline = state === 'REGISTERED' || state.startsWith('OK');
                    if (username) {
                        iaxPresence[username] = isOnline;
                        getTrunkStatusMap().then(map => io.emit('trunkStatus', map));
                    }
                }
            }
            // Parse PJSIP ContactStatus events — real-time Reachable/Unreachable updates
            if (event.Event === 'ContactStatus') {
                let name = event.EndpointName || '';
                let contactStatus = String(event.ContactStatus || '').trim();
                if (name) {
                    let contactId = event.ID || event.URI || (name + '_contact');
                    let statusLower = contactStatus.toLowerCase();
                    let isOnline = statusLower === 'reachable' || statusLower === 'created' || statusLower === 'updated' || statusLower === 'unqualified' || statusLower === 'nonqualified';
                    let now = Date.now();
                    let uri = event.URI || '';
                    let match = uri.match(/@(\d+\.\d+\.\d+\.\d+)/);
                    let ip = match ? match[1] : '';

                    // Real-time event takes precedence over snapshot rows: stamp with Date.now()
                    pjsipContactState[contactId] = { endpoint: name, isOnline: isOnline, time: now };

                    if (isOnline) {
                        setExtensionOnline(name, 'ContactStatus', ip);
                    } else if (statusLower === 'removed') {
                        let anyOnline = false;
                        for (let cid in pjsipContactState) {
                            if (pjsipContactState[cid].endpoint === name && pjsipContactState[cid].isOnline) {
                                anyOnline = true;
                                break;
                            }
                        }
                        if (!anyOnline) {
                            setExtensionOffline(name, 'ContactStatus:Removed');
                        } else {
                            updateExtensionPresence(name);
                        }
                    } else if (!isOnline) {
                        let anyOnline = false;
                        for (let cid in pjsipContactState) {
                            if (pjsipContactState[cid].endpoint === name && pjsipContactState[cid].isOnline) {
                                anyOnline = true;
                                break;
                            }
                        }
                        if (!anyOnline) {
                            if (!pendingOffline[name]) {
                                const markTime = now;
                                pendingOffline[name] = setTimeout(() => {
                                    delete pendingOffline[name];
                                    if ((extensionLastRealtimeTime[name] || 0) <= markTime) {
                                        setExtensionOffline(name, 'ContactStatus:Unreachable');
                                    }
                                }, 1000);
                            }
                        } else {
                            updateExtensionPresence(name);
                        }
                    }
                }
            }

            // Parse PJSIPShowContacts response — batch refresh of contact status
            if (event.Event === 'ContactList') {
                let name = event.Endpoint || '';
                let contactStatus = String(event.Status || '').trim();
                if (name) {
                    let contactId = event.ID || event.Uri || (name + '_contact');
                    let statusLower = contactStatus.toLowerCase();
                    let isOnline = statusLower === 'reachable' || statusLower === 'created' || statusLower === 'updated' || statusLower === 'unqualified' || statusLower === 'nonqualified';

                    pjsipBatchContactIds.add(contactId);

                    let existing = pjsipContactState[contactId];
                    let realtimeTime = extensionLastRealtimeTime[name] || 0;
                    // Snapshot row applies ONLY if no real-time event was received after snapshot started!
                    if (realtimeTime <= pjsipSnapshotStartTime && (!existing || existing.time <= pjsipSnapshotStartTime)) {
                        pjsipContactState[contactId] = { endpoint: name, isOnline: isOnline, time: pjsipSnapshotStartTime };
                        recomputePjsipPresence(name);
                    }

                    let uri = event.Uri || '';
                    let match = uri.match(/@(\d+\.\d+\.\d+\.\d+)/);
                    if (match) {
                        peerIPs[name] = match[1];
                    }
                }
            }

            if (event.Event === 'ContactListComplete') {
                // Purge any contacts not in batch whose last update was before this snapshot started
                for (let cid in pjsipContactState) {
                    let entry = pjsipContactState[cid];
                    if (entry.time <= pjsipSnapshotStartTime && !pjsipBatchContactIds.has(cid)) {
                        entry.isOnline = false;
                    }
                }
                recomputeAllPjsipPresence();
                pjsipBatchContactIds.clear();
                io.emit('peerIPs', peerIPs);
                getTrunkStatusMap().then(map => io.emit('trunkStatus', map));
            }

            // Emit peerStatus once initial list queries complete
            if (event.Event === 'PeerlistComplete' || event.Event === 'EndpointListComplete') {
                console.log('AMI: Peer list complete, peers:', Object.keys(peerStatus));
                isPeerListLoaded = true;
                updateAllExtensionPresence();
                io.emit('peerIPs', peerIPs);
                getTrunkStatusMap().then(map => io.emit('trunkStatus', map));
            }

            // Real-time peer registration changes (chan_sip / chan_pjsip)
            if (event.Event === 'PeerStatus') {
                let rawPeer = event.Peer ? event.Peer.replace(/^(SIP|PJSIP)\//i, '') : '';
                let name = rawPeer ? rawPeer.split('/')[0] : '';
                if (name) {
                    let statusStr = String(event.PeerStatus || '').trim();
                    let isOnline = statusStr === 'Registered' || statusStr === 'Reachable';
                    let ip = event.Address || event.IPaddress || '';

                    if (statusStr === 'Unregistered' || statusStr === 'Rejected') {
                        // Explicit unregister — turn offline IMMEDIATELY
                        setExtensionOffline(name, 'PeerStatus:Unregistered');
                    } else if (statusStr === 'Unreachable') {
                        // Qualify timeout / lost ping — short 1s debounce
                        if (!pendingOffline[name]) {
                            const markTime = Date.now();
                            pendingOffline[name] = setTimeout(() => {
                                delete pendingOffline[name];
                                if ((extensionLastRealtimeTime[name] || 0) <= markTime) {
                                    setExtensionOffline(name, 'PeerStatus:Unreachable');
                                }
                            }, 1000);
                        }
                    } else if (isOnline) {
                        setExtensionOnline(name, 'PeerStatus:Registered', ip);
                    }
                }
            }

            // Instant Asterisk DeviceStateChange event handling
            if (event.Event === 'DeviceStateChange') {
                let rawDev = event.Device ? event.Device.replace(/^(SIP|PJSIP)\//, '') : '';
                let name = rawDev ? rawDev.split('/')[0] : '';
                if (name) {
                    let state = String(event.State || '').toLowerCase();
                    let isOnline = !(state === 'unavailable' || state === 'invalid' || state === 'unknown' || state === '5' || state === '4');
                    if (isOnline) {
                        setExtensionOnline(name, 'DeviceStateChange');
                    } else {
                        setExtensionOffline(name, 'DeviceStateChange');
                    }
                }
            }

            // Instant Asterisk ExtensionStatus event handling
            if (event.Event === 'ExtensionStatus') {
                let name = String(event.Exten || '');
                let statusStr = String(event.Status || '');
                if (name && /^\d+$/.test(name)) {
                    let isOnline = !(statusStr === '4' || statusStr === '5' || statusStr === '-1');
                    if (isOnline) {
                        setExtensionOnline(name, 'ExtensionStatus');
                    } else {
                        setExtensionOffline(name, 'ExtensionStatus');
                    }
                    // Clear call from activeCalls if extension status reports Idle (0) or unavailable/unregistered
                    if ((statusStr === '0' || !isOnline) && activeCalls[name]) {
                        delete activeCalls[name];
                        notifyCrmLiveBroadcaster(); io.emit('callUpdate', { extension: name, callData: null });
                    }
                }
            }

            // Handle Auto-Dialer AMI Events
            handleDialerAmiEvents(event);

            // New channel = new call, always fresh timestamp
            if (event.Event === 'Newchannel') {
                let exten = getExtensionFromChannel(event.Channel);
                if (exten) {
                    let partner = 'Connecting...';
                    if (event.CallerIDNum && event.CallerIDNum !== exten) {
                        partner = event.CallerIDNum;
                    } else if (event.ConnectedLineNum && event.ConnectedLineNum !== exten && event.ConnectedLineNum !== '<unknown>') {
                        partner = event.ConnectedLineNum;
                    } else if (event.Exten && event.Exten !== exten && event.Exten.length >= 3) {
                        partner = event.Exten;
                    }
                    activeCalls[exten] = {
                        state: 'Ringing',
                        partner: partner,
                        start: Date.now(),
                        channel: event.Channel
                    };
                    notifyCrmLiveBroadcaster(); io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // State updates for existing calls — update partner and preserve start time
            if (event.Event === 'Newstate') {
                let exten = getExtensionFromChannel(event.Channel);
                if (exten) {
                    let desc = String(event.ChannelStateDesc || event.State || '').toLowerCase();
                    let stateNum = String(event.ChannelState || '');
                    let isUp = desc === 'up' || stateNum === '6';

                    let calculatedState = isUp ? 'In Call' : (activeCalls[exten]?.state === 'In Call' ? 'In Call' : 'Ringing');
                    let existing = activeCalls[exten];
                    let partner = existing?.partner || 'Connecting...';
                    if (event.CallerIDNum && event.CallerIDNum !== exten) {
                        partner = event.CallerIDNum;
                    } else if (event.ConnectedLineNum && event.ConnectedLineNum !== exten && event.ConnectedLineNum !== '<unknown>') {
                        partner = event.ConnectedLineNum;
                    } else if (event.Exten && event.Exten !== exten && event.Exten.length >= 3 && partner === 'Connecting...') {
                        partner = event.Exten;
                    }
                    let start = Date.now();
                    if (existing && existing.start) {
                        let age = Date.now() - existing.start;
                        start = age < 14400000 && age >= 0 ? existing.start : Date.now();
                    }
                    activeCalls[exten] = { state: calculatedState, partner, start, channel: event.Channel || existing?.channel };
                    
                    if (isUp && partner && partner !== 'Connecting...' && activeCalls[partner]) {
                        activeCalls[partner].state = 'In Call';
                    }

                    notifyCrmLiveBroadcaster();
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // Fallback catching: Ensure bridge entrances catch linked channel audio paths
            if (event.Event === 'BridgeEnter' || event.Event === 'Bridge' || event.Event === 'Link') {
                let channels = [event.Channel, event.Channel1, event.Channel2, event.DestinationChannel].filter(Boolean);
                channels.forEach(ch => {
                    let exten = getExtensionFromChannel(ch);
                    if (exten) {
                        let existing = activeCalls[exten];
                        let partner = existing?.partner || 'Connecting...';
                        if (event.CallerIDNum && event.CallerIDNum !== exten) {
                            partner = event.CallerIDNum;
                        } else if (event.ConnectedLineNum && event.ConnectedLineNum !== exten && event.ConnectedLineNum !== '<unknown>') {
                            partner = event.ConnectedLineNum;
                        }
                        let start = existing?.start || Date.now();
                        let age = Date.now() - start;
                        if (age >= 14400000 || age < 0) start = Date.now();
                        activeCalls[exten] = {
                            state: 'In Call',
                            partner: partner,
                            start: start,
                            channel: ch
                        };
                        io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                    }
                });
                notifyCrmLiveBroadcaster();
            }

            // Clean tear down when either party terminates the tracked call channel
            if (event.Event === 'Hangup' || event.Event === 'HangupRequest' || event.Event === 'SoftHangupRequest' || event.Event === 'ChannelDestroy') {
                let extsToClear = new Set();

                for (let e in activeCalls) {
                    const call = activeCalls[e];
                    if (call) {
                        const eventChan = event.Channel || '';
                        if ((call.channel && call.channel === eventChan) ||
                            (event.Channel1 && call.channel === event.Channel1) ||
                            (event.Channel2 && call.channel === event.Channel2)) {
                            extsToClear.add(e);
                        } else if (!call.channel && getExtensionFromChannel(eventChan) === e && event.Event === 'Hangup') {
                            extsToClear.add(e);
                        }
                    }
                }

                extsToClear.forEach(e => {
                    if (activeCalls[e]) {
                        delete activeCalls[e];
                        notifyCrmLiveBroadcaster(); io.emit('callUpdate', { extension: e, callData: null });
                    }
                });
            }
        });
    });

    client.on('error', (err) => { console.error('AMI Error:', err.message); });
    client.on('close', () => { setTimeout(connectAMI, 5000); });
}
connectAMI();

// Periodically re-detect dongle SIM numbers (handles SIM swaps)
setInterval(detectDonglesAndSetTrunkCID, 300000);

// Periodic cleanup of stale call entries (older than 4 hours)
setInterval(() => {
    let now = Date.now();
    for (let ext in activeCalls) {
        let age = now - (activeCalls[ext].start || 0);
        if (age >= 14400000 || age < 0) {
            delete activeCalls[ext];
            notifyCrmLiveBroadcaster(); io.emit('callUpdate', { extension: ext, callData: null });
        }
    }
}, 60000);

// Periodic reconciliation of active calls against Asterisk live channels (every 4 seconds)
async function reconcileActiveCallsWithAsterisk() {
    try {
        const activeExts = Object.keys(activeCalls);
        if (activeExts.length === 0) return;

        const output = await execFileAsync(ASTERISK_BIN, ['-rx', 'core show channels concise']);
        const liveLines = output.split('\n').filter(Boolean);
        const liveExts = new Set();
        const liveChans = new Set();

        for (const line of liveLines) {
            const parts = line.split('!');
            const chan = parts[0] || '';
            if (chan) liveChans.add(chan);
            const ext = getExtensionFromChannel(chan);
            if (ext) liveExts.add(ext);
        }

        for (const ext of activeExts) {
            const call = activeCalls[ext];
            const storedChan = call?.channel;
            const isChanLive = storedChan ? liveChans.has(storedChan) : false;
            const isExtLive = liveExts.has(ext);

            if (!isChanLive && !isExtLive) {
                delete activeCalls[ext];
                notifyCrmLiveBroadcaster(); io.emit('callUpdate', { extension: ext, callData: null });
            }
        }
    } catch (_) {}
}
setInterval(reconcileActiveCallsWithAsterisk, 4000);

// Periodic SIPpeers + PJSIP contacts refresh to keep IPs current (every 30s)
setInterval(() => {
    if (amiClient) {
        amiClient.write('Action: SIPpeers\r\n\r\n');
        amiClient.write('Action: PJSIPShowContacts\r\n\r\n');
    }
}, 30000);

io.on('connection', async (socket) => {
    let clean = {};
    for (let ext in activeCalls) {
        clean[ext] = activeCalls[ext];
    }
    socket.emit('initialState', clean);
    socket.emit('peerStatus', peerStatus);
    socket.emit('peerIPs', peerIPs);
    socket.emit('initialTrunks', await getTrunkStatusMap());

    let ttyProcess = null;

    function startTtyProcess(data) {
        if (ttyProcess) {
            try { ttyProcess.kill('SIGKILL'); } catch (_) {}
            ttyProcess = null;
        }

        const cols = (data && Number.isInteger(data.cols) && data.cols > 10) ? data.cols : 100;
        const rows = (data && Number.isInteger(data.rows) && data.rows > 5) ? data.rows : 30;

        try {
            ttyProcess = spawn('script', ['-q', '-c', 'bash -i', '/dev/null'], {
                cwd: process.env.HOME || '/root',
                env: {
                    ...process.env,
                    TERM: 'xterm-256color',
                    HISTCONTROL: 'ignoreboth',
                    COLUMNS: String(cols),
                    LINES: String(rows)
                }
            });

            socket.emit('tty_status', { connected: true, pid: ttyProcess.pid });

            ttyProcess.stdout.on('data', (chunk) => {
                socket.emit('tty_output', chunk.toString('utf8'));
            });

            ttyProcess.stderr.on('data', (chunk) => {
                socket.emit('tty_output', chunk.toString('utf8'));
            });

            ttyProcess.on('exit', (code) => {
                socket.emit('tty_output', `\r\n\x1b[33m[TTY Shell process exited with code ${code}]\x1b[0m\r\n`);
                socket.emit('tty_status', { connected: false });
                ttyProcess = null;
            });

            ttyProcess.on('error', (err) => {
                socket.emit('tty_output', `\r\n\x1b[31m[TTY Shell spawn error: ${err.message}]\x1b[0m\r\n`);
                socket.emit('tty_status', { connected: false });
                ttyProcess = null;
            });
        } catch (err) {
            socket.emit('tty_output', `\r\n\x1b[31m[Failed to launch TTY Shell: ${err.message}]\x1b[0m\r\n`);
            socket.emit('tty_status', { connected: false });
        }
    }

    socket.on('tty_init', (data) => {
        const req = socket.request;
        const session = req ? req.session : null;
        const isRootUser = Boolean(session && (session.isRoot || session.username === 'root'));
        if (!session || !isRootUser) {
            socket.emit('tty_output', '\r\n\x1b[31m[ERROR] Unauthorized: TTY Terminal access is restricted strictly to root user only.\x1b[0m\r\n');
            return;
        }
        startTtyProcess(data);
    });
    socket.on('tty_input', (inputData) => {
        if (ttyProcess && ttyProcess.stdin && ttyProcess.stdin.writable) {
            try {
                ttyProcess.stdin.write(String(inputData));
            } catch (_) {}
        }
    });

    socket.on('tty_resize', (dim) => {
        if (ttyProcess && ttyProcess.stdin && ttyProcess.stdin.writable && dim && dim.cols && dim.rows) {
            try {
                ttyProcess.stdin.write(` stty cols ${dim.cols} rows ${dim.rows} >/dev/null 2>&1\n`);
            } catch (_) {}
        }
    });

    socket.on('tty_restart', (data) => {
        const req = socket.request;
        const session = req ? req.session : null;
        const isRootUser = Boolean(session && (session.isRoot || session.username === 'root'));
        if (!session || !isRootUser) return;
        socket.emit('tty_output', '\r\n\x1b[36m[Restarting TTY Shell...]\x1b[0m\r\n');
        startTtyProcess(data);
    });
    socket.on('disconnect', () => {
        if (ttyProcess) {
            try { ttyProcess.kill('SIGKILL'); } catch (_) {}
            ttyProcess = null;
        }
    });
});

// ── Dongle Auto-Heal: restart once if stuck in "Not Initialized" for >3s ──
const dongleNotInitTimestamps = {};
const dongleRestartedOnce = {};
let donglePortPresence = null;
let dongleHotplugCheckInFlight = false;

async function applyDongleHotplugMappingDefaults() {
    if (dongleHotplugCheckInFlight) return;
    dongleHotplugCheckInFlight = true;
    try {
        const configuredDongles = parseDongleConfGain().dongles;
        const currentPresence = new Map();

        for (const [dongleName, config] of Object.entries(configuredDongles)) {
            const safeDongleName = normalizeDongleMappingKey(dongleName);
            if (!safeDongleName || !safeDongleName.startsWith('dongle')) continue;
            const configuredPorts = [config.audio, config.data]
                .map(port => String(port || '').trim())
                .filter(Boolean);
            currentPresence.set(
                safeDongleName,
                configuredPorts.length > 0 && configuredPorts.some(port => fs.existsSync(port))
            );
        }

        if (donglePortPresence === null) {
            donglePortPresence = currentPresence;
            return;
        }

        const newlyPresent = [];
        for (const [dongleName, isPresent] of currentPresence) {
            if (isPresent && donglePortPresence.get(dongleName) === false) {
                newlyPresent.push(dongleName);
            }
        }
        donglePortPresence = currentPresence;
        if (newlyPresent.length === 0) return;

        for (const dongleName of newlyPresent) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`gsm_dongles\` (dongle_name, dynamic_enabled)
                VALUES (?, 0)
                ON DUPLICATE KEY UPDATE dynamic_enabled = 0
            `, [dongleName]);
            await syncDongleDynamicSetting(dongleName, false);
            await deleteAstDbKey('dongle_map', dongleName);
            console.log(`DONGLE-HOTPLUG: ${dongleName} appeared on USB; dynamic DID mapping reset to off`);
        }

        cachedDevicesOutput = null;
        lastDevicesOutputFetch = 0;
        await reconcileDongleMappings();
        io.emit('usbDevicesUpdated');
    } catch (error) {
        console.error('DONGLE-HOTPLUG: Failed to apply safe mapping defaults:', error.message);
    } finally {
        dongleHotplugCheckInFlight = false;
    }
}


const lastKnownDongleStates = {};

async function recordDongleStateLog(dongleName, state, simNumber = null, imsi = null, imei = null) {
    if (!dongleName || !state) return;
    const safeName = String(dongleName).trim().toLowerCase();
    const safeState = String(state).trim();

    if (lastKnownDongleStates[safeName] === safeState) return;
    lastKnownDongleStates[safeName] = safeState;

    try {
        await pool.query(
            `UPDATE \`asterisk\`.\`dongle_state_logs\`
             SET ended_at = NOW(),
                 duration_sec = GREATEST(0, TIMESTAMPDIFF(SECOND, started_at, NOW()))
             WHERE dongle_name = ? AND ended_at IS NULL`,
            [safeName]
        );
        await pool.query(
            `INSERT INTO \`asterisk\`.\`dongle_state_logs\`
             (dongle_name, sim_number, imsi, imei, state, started_at)
             VALUES (?, ?, ?, ?, ?, NOW())`,
            [safeName, simNumber || null, imsi || null, imei || null, safeState]
        );
    } catch (err) {
        console.error(`DONGLE-STATE-LOG: Error recording state for ${safeName}:`, err.message);
    }
}

function autoHealDongles() {
    applyDongleHotplugMappingDefaults();
    getDevicesOutputCached((err, stdout) => {
        if (err || !stdout) return;
        const devices = parseDevicesOutput(stdout, true);
        const now = Date.now();

        const activeDongleIds = new Set();
        for (const dev of devices) {
            const id = (dev.ID || '').toLowerCase();
            if (!id || !id.startsWith('dongle')) continue;
            activeDongleIds.add(id);

            const rawState = String(dev.State || 'Unknown').trim();
            const number = String(dev.Number || '').trim();
            const imsi = String(dev.IMSI || '').trim();
            const imei = String(dev.IMEI || '').trim();

            recordDongleStateLog(id, rawState, number || null, imsi || null, imei || null);

            const stateLower = rawState.toLowerCase();
            delete dongleNotInitTimestamps[id];
            delete dongleRestartedOnce[id];
        }

        try {
            const configuredDongles = parseDongleConfGain().dongles;
            for (const dName of Object.keys(configuredDongles)) {
                const safeName = dName.toLowerCase();
                if (!activeDongleIds.has(safeName)) {
                    recordDongleStateLog(safeName, 'Not connected');
                }
            }
        } catch (_) {}
    });
}
setInterval(autoHealDongles, 3000);
applyDongleHotplugMappingDefaults();


app.use(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    try {
        const [users] = await pool.query(`
            SELECT u.extension, u.name, ee.photo, ee.title, ee.emp_group
            FROM ${tables.users} u
            LEFT JOIN ${tables.employeeExtras} ee ON u.extension = ee.extension
        `);

        let devices = [];
        try {
            const [devRows] = await pool.query(`SELECT id as extension, description as name FROM ${tables.devices}`);
            devices = devRows;
        } catch (_) {}

        let sipExts = [];
        try {
            const [sRows] = await pool.query(`SELECT DISTINCT id as extension FROM ${tables.sip} WHERE keyword = 'secret' AND id REGEXP '^[0-9]{2,5}$'`);
            sipExts = sRows;
        } catch (_) {}

        let psExts = [];
        try {
            const [psRows] = await pool.query(`SELECT DISTINCT id as extension FROM ${tables.psEndpoints} WHERE id REGEXP '^[0-9]{2,5}$'`);
            psExts = psRows;
        } catch (_) {}
        let cdrChannels = [];
        try {
            const [cRows] = await pool.query(`
                SELECT DISTINCT channel, dstchannel
                FROM ${tables.cdr}
                WHERE calldate >= NOW() - INTERVAL 180 DAY
            `);
            cdrChannels = cRows;
        } catch (_) {}

        const extMap = new Map();

        users.forEach(u => {
            if (u.extension && /^\d+$/.test(u.extension)) {
                extMap.set(u.extension, { extension: u.extension, name: u.name || u.extension, photo: u.photo, title: u.title, emp_group: u.emp_group });
            }
        });

        devices.forEach(d => {
            if (d.extension && /^\d+$/.test(d.extension) && !extMap.has(d.extension)) {
                extMap.set(d.extension, { extension: d.extension, name: d.name || d.extension, photo: null, title: null, emp_group: null });
            }
        });

        sipExts.forEach(s => {
            if (s.extension && /^\d+$/.test(s.extension) && !extMap.has(s.extension)) {
                extMap.set(s.extension, { extension: s.extension, name: 'Extension ' + s.extension, photo: null, title: null, emp_group: null });
            }
        });

        psExts.forEach(p => {
            if (p.extension && /^\d+$/.test(p.extension) && !extMap.has(p.extension)) {
                extMap.set(p.extension, { extension: p.extension, name: 'Extension ' + p.extension, photo: null, title: null, emp_group: null });
            }
        });

        cdrChannels.forEach(r => {
            [getEndpointExtensionFromChannel(r.channel), getEndpointExtensionFromChannel(r.dstchannel)].forEach(ext => {
                if (ext && /^\d{2,5}$/.test(ext) && !extMap.has(ext)) {
                    extMap.set(ext, { extension: ext, name: 'Extension ' + ext, photo: null, title: null, emp_group: null });
                }
            });
        });

        const roster = Array.from(extMap.values()).sort((a, b) => parseInt(a.extension, 10) - parseInt(b.extension, 10));
        let onlineMap = {};
        for (let e of roster) {
            let online = peerStatus[e.extension] || false;
            if (activeCalls[e.extension]) online = true;
            onlineMap[e.extension] = online;
        }
        if (!isPeerListLoaded && roster.length && Object.values(onlineMap).every(v => !v)) {
            const dbQueries = [
                `SELECT DISTINCT id FROM ${tables.sip} WHERE keyword='host' AND data IS NOT NULL AND data != ''`,
                `SELECT id, data FROM ${tables.sip} WHERE keyword='ipaddr' AND data IS NOT NULL AND data != '' AND data != 'dynamic' AND data != '-none-'`,
                `SELECT name, ipaddr FROM ${tables.sipfriends} WHERE ipaddr IS NOT NULL AND ipaddr != ''`,
                `SELECT name, ipaddr FROM ${tables.sippeers} WHERE ipaddr IS NOT NULL AND ipaddr != ''`,
                `SELECT id, ipaddr FROM ${tables.psEndpoints} WHERE ipaddr IS NOT NULL AND ipaddr != ''`
            ];
            for (const q of dbQueries) {
                try {
                    const [peers] = await pool.query(q);
                    if (peers && peers.length) {
                        peers.forEach(p => {
                            const key = p.name || p.id;
                            if (key) {
                                onlineMap[key] = true;
                                peerStatus[key] = true;
                                if (p.ipaddr && /^\d+\.\d+\.\d+\.\d+$/.test(p.ipaddr)) {
                                    peerIPs[key] = p.ipaddr;
                                }
                            }
                        });
                        break;
                    }
                } catch (_) { }
            }
            if (Object.keys(peerStatus).length) console.log('DB fallback found peers:', Object.keys(peerStatus));
        }
        let employeeGroupNames = [];
        try {
            const [groupRows] = await pool.query(`SELECT name FROM ${tables.employeeGroups} ORDER BY name ASC`);
            employeeGroupNames = groupRows.map(g => String(g.name)).filter(Boolean);
        } catch (_) {}
        res.locals.employeeGroups = employeeGroupNames;
        res.locals.roster = roster.map(emp => ({ 
            ...emp, 
            online: onlineMap[emp.extension] || false,
            ip: peerIPs[emp.extension] || null
        }));
        res.locals.peerIPs = peerIPs;
        res.locals.activeCalls = activeCalls;
        res.locals.currentPage = req.path;
        if (req.query.lang === 'ar' || req.query.lang === 'en') {
            req.session.lang = req.query.lang;
        }
        const currentLang = req.session.lang || 'en';
        res.locals.currentLang = currentLang;
        res.locals.isRtl = currentLang === 'ar';
        reloadGreetingConfig();
        res.locals.greetingMode = greetingConfig.mode || 'none';
        res.locals.greetingExtensions = greetingConfig.extensions || [];
        next();
    } catch (err) { next(err); }
});

// --- AUTH ROUTES ---

// GET /login - render login page
app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect(req.query.redirect || '/');
    res.render('login', { redirect: req.query.redirect || '/', error: null, currentLang: req.query.lang || 'en' });
});

// POST /login - authenticate user
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.render('login', { redirect: req.body.redirect || '/', error: 'Username and password are required', currentLang: req.query.lang || 'en' });
        }
        // Hardcoded root user — authenticated via process.env.ROOT_PASSWORD_HASH
        if (username === ROOT_USER) {
            if (!ROOT_PASSWORD_HASH) {
                return res.render('login', { redirect: req.body.redirect || '/', error: 'Root user login disabled. ROOT_PASSWORD_HASH environment variable not set.', currentLang: req.query.lang || 'en' });
            }
            const match = await bcrypt.compare(password, ROOT_PASSWORD_HASH);
            if (!match) {
                return res.render('login', { redirect: req.body.redirect || '/', error: 'Invalid credentials', currentLang: req.query.lang || 'en' });
            }
            req.session.userId = -1;
            req.session.username = ROOT_USER;
            req.session.userGroup = 'super admins';
            req.session.isRoot = true;
            req.session.extension = null;
            return req.session.save(() => {
                res.redirect(req.body.redirect || '/');
            });
        }
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [rows] = await conn.execute(`
            SELECT u.*, g.name AS group_name
            FROM dashboard_users u
            LEFT JOIN dashboard_groups g ON g.id = u.group_id
            WHERE u.username = ?
        `, [username]);
        await conn.end();
        if (rows.length === 0) {
            return res.render('login', { redirect: req.body.redirect || '/', error: 'Invalid credentials', currentLang: req.query.lang || 'en' });
        }
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.render('login', { redirect: req.body.redirect || '/', error: 'Invalid credentials', currentLang: req.query.lang || 'en' });
        }
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.userGroup = user.group_name || null;
        req.session.extension = user.extension || null;
        req.session.save(() => {
            res.redirect(req.body.redirect || '/');
        });
    } catch (err) {
        res.render('login', { redirect: req.body.redirect || '/', error: 'Login error: ' + err.message, currentLang: req.query.lang || 'en' });
    }
});

// GET /logout - destroy session
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// GET /users - user management page
app.get('/users', async (req, res) => {
    try {
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [userRows] = await conn.execute(`
            SELECT u.id, u.username, u.email, u.group_id, u.extension, u.created_at, g.name AS group_name
            FROM dashboard_users u
            LEFT JOIN dashboard_groups g ON g.id = u.group_id
            WHERE u.username != ?
            ORDER BY u.id ASC
        `, [ROOT_USER]);
        const [groupRows] = await conn.execute('SELECT id, name, created_at FROM dashboard_groups ORDER BY name ASC');
        const groups = [];
        for (const g of groupRows) {
            const [perms] = await conn.execute('SELECT tab FROM dashboard_group_permissions WHERE group_id = ?', [g.id]);
            groups.push({ ...g, permissions: perms.map(p => p.tab) });
        }
        await conn.end();
        res.render('users', { users: userRows, groups, allTabs: ALL_TABS, success: req.query.success || null, error: req.query.error || null, currentLang: res.locals.currentLang || 'en' });
    } catch (err) {
        res.status(500).send('Users error: ' + err.message);
    }
});

// POST /users/add - add new user
app.post('/users/add', async (req, res) => {
    try {
        const { username, password, email, group_id, extension } = req.body;
        if (!username || !password || password.length < 3) {
            return res.redirect('/users?error=' + encodeURIComponent('Username and password (min 3 chars) required'));
        }
        if (username === ROOT_USER) {
            return res.redirect('/users?error=' + encodeURIComponent('Username cannot be reserved'));
        }
        if (!group_id) {
            return res.redirect('/users?error=' + encodeURIComponent('A group must be selected'));
        }
        const cleanEmail = (email && email.trim()) ? email.trim() : null;
        const cleanExt = (extension && extension.trim() && extension !== 'ALL' && extension !== 'none') ? extension.trim() : null;
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        if (cleanEmail) {
            if (!cleanEmail.includes('@')) {
                await conn.end();
                return res.redirect('/users?error=' + encodeURIComponent('If provided, email must be valid'));
            }
            const [existingEmail] = await conn.execute('SELECT id FROM dashboard_users WHERE email = ? AND email IS NOT NULL AND email != ""', [cleanEmail]);
            if (existingEmail.length > 0) {
                await conn.end();
                return res.redirect('/users?error=' + encodeURIComponent('Email is already in use by another user'));
            }
        }
        const hash = await bcrypt.hash(password, 10);
        await conn.execute('INSERT INTO dashboard_users (username, email, password_hash, group_id, extension) VALUES (?, ?, ?, ?, ?)', [username, cleanEmail, hash, group_id, cleanExt]);
        await conn.end();
        res.redirect('/users?success=' + encodeURIComponent('User added successfully'));
    } catch (err) {
        res.redirect('/users?error=' + encodeURIComponent(err.message));
    }
});

// POST /users/edit - edit user details (email, group_id, extension)
app.post('/users/edit', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) {
            return res.redirect('/users?error=' + encodeURIComponent('Super Admin authorization required'));
        }
        const { id, email, group_id, extension } = req.body;
        if (!id) return res.redirect('/users?error=' + encodeURIComponent('User ID required'));
        if (!group_id) return res.redirect('/users?error=' + encodeURIComponent('A group must be selected'));
        const cleanEmail = (email && email.trim()) ? email.trim() : null;
        const cleanExt = (extension && extension.trim() && extension !== 'ALL' && extension !== 'none') ? extension.trim() : null;
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        if (cleanEmail) {
            if (!cleanEmail.includes('@')) {
                await conn.end();
                return res.redirect('/users?error=' + encodeURIComponent('If provided, email must be valid'));
            }
            const [existingEmail] = await conn.execute('SELECT id FROM dashboard_users WHERE email = ? AND email IS NOT NULL AND email != "" AND id != ?', [cleanEmail, id]);
            if (existingEmail.length > 0) {
                await conn.end();
                return res.redirect('/users?error=' + encodeURIComponent('Email is already in use by another user'));
            }
        }
        await conn.execute('UPDATE dashboard_users SET email = ?, group_id = ?, extension = ? WHERE id = ?', [cleanEmail, group_id, cleanExt, id]);
        await conn.end();
        res.redirect('/users?success=' + encodeURIComponent('User updated successfully'));
    } catch (err) {
        res.redirect('/users?error=' + encodeURIComponent(err.message));
    }
});

// POST /users/delete - delete user
app.post('/users/delete', async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.redirect('/users?error=User ID required');
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        // Prevent deleting yourself
        const [rows] = await conn.execute('SELECT username FROM dashboard_users WHERE id = ?', [id]);
        if (rows.length && rows[0].username === req.session.username) {
            await conn.end();
            return res.redirect('/users?error=Cannot delete your own account');
        }
        await conn.execute('DELETE FROM dashboard_users WHERE id = ?', [id]);
        await conn.end();
        res.redirect('/users?success=User deleted');
    } catch (err) {
        res.redirect('/users?error=' + encodeURIComponent(err.message));
    }
});

// POST /users/change-password - change password
app.post('/users/change-password', async (req, res) => {
    try {
        const { id, new_password } = req.body;
        if (!id || !new_password || new_password.length < 3) {
            return res.redirect('/users?error=Password must be at least 3 characters');
        }
        const hash = await bcrypt.hash(new_password, 10);
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        await conn.execute('UPDATE dashboard_users SET password_hash = ? WHERE id = ?', [hash, id]);
        await conn.end();
        res.redirect('/users?success=Password changed');
    } catch (err) {
        res.redirect('/users?error=' + encodeURIComponent(err.message));
    }
});

// --- SMTP SETTINGS ROUTES (Super Admin Only) ---
app.get('/api/settings/smtp', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) {
            return res.status(403).json({ success: false, error: 'Forbidden: Super Admin access required' });
        }
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [rows] = await conn.execute('SELECT setting_key, setting_value FROM dashboard_settings WHERE setting_key IN (?, ?)', ['smtp_email', 'smtp_password']);
        await conn.end();

        let email = '';
        let hasPassword = false;
        rows.forEach(r => {
            if (r.setting_key === 'smtp_email') email = r.setting_value;
            if (r.setting_key === 'smtp_password' && r.setting_value) hasPassword = true;
        });
        res.json({ success: true, email, hasPassword });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/settings/smtp', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) {
            return res.status(403).json({ success: false, error: 'Forbidden: Super Admin access required' });
        }
        const { email, password } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: 'Email is required' });
        }

        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });

        // Upsert smtp_email
        await conn.execute(
            'INSERT INTO dashboard_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
            ['smtp_email', email, email]
        );

        if (password) {
            const encryptedPassword = encrypt(password);
            await conn.execute(
                'INSERT INTO dashboard_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                ['smtp_password', encryptedPassword, encryptedPassword]
            );
        } else {
            // Check if password exists
            const [rows] = await conn.execute('SELECT setting_value FROM dashboard_settings WHERE setting_key = ?', ['smtp_password']);
            if (rows.length === 0 || !rows[0].setting_value) {
                await conn.end();
                return res.status(400).json({ success: false, error: 'Password is required' });
            }
        }

        await conn.end();
        res.json({ success: true, message: 'SMTP settings updated successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/auth/forgot-password and POST /forgot-password
const forgotPasswordHandler = async (req, res) => {
    try {
        const { username, email } = req.body;
        if (!username || !email) return res.status(400).json({ success: false, error: 'Username and email are required' });
        
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        
        const [rows] = await conn.execute('SELECT * FROM dashboard_users WHERE username = ? AND email = ?', [username, email]);
        if (rows.length === 0) {
            await conn.end();
            return res.status(400).json({ success: false, error: 'Invalid username or email combination' });
        }
        
        // Get SMTP settings
        const [settingsRows] = await conn.execute('SELECT setting_key, setting_value FROM dashboard_settings WHERE setting_key IN (?, ?)', ['smtp_email', 'smtp_password']);
        let smtpEmail = '';
        let smtpEncryptedPassword = '';
        settingsRows.forEach(r => {
            if (r.setting_key === 'smtp_email') smtpEmail = r.setting_value;
            if (r.setting_key === 'smtp_password') smtpEncryptedPassword = r.setting_value;
        });
        
        if (!smtpEmail || !smtpEncryptedPassword) {
            await conn.end();
            return res.status(500).json({ success: false, error: 'Password reset email system is not configured. Please contact Super Admin.' });
        }
        
        const smtpPassword = decrypt(smtpEncryptedPassword);
        if (!smtpPassword) {
            await conn.end();
            return res.status(500).json({ success: false, error: 'Failed to decrypt SMTP credentials' });
        }
        
        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000); // 1 hour
        
        await conn.execute(
            'UPDATE dashboard_users SET reset_token = ?, reset_token_expires = ?, reset_expires = ? WHERE username = ? AND email = ?',
            [token, expires, expires, username, email]
        );
        await conn.end();

        // Nodemailer Setup
        let transporterConfig;
        if (smtpEmail.endsWith('@gmail.com')) {
            transporterConfig = {
                service: 'gmail',
                auth: {
                    user: smtpEmail,
                    pass: smtpPassword
                }
            };
        } else {
            transporterConfig = {
                host: process.env.SMTP_HOST || 'smtp.gmail.com',
                port: parseInt(process.env.SMTP_PORT || '587'),
                secure: process.env.SMTP_SECURE === 'true',
                auth: {
                    user: smtpEmail,
                    pass: smtpPassword
                },
                tls: { rejectUnauthorized: false }
            };
        }
        
        const transporter = nodemailer.createTransport(transporterConfig);
        const resetUrl = `${req.protocol}://${req.get('host')}/reset-password?token=${token}`;
        
        await transporter.sendMail({
            from: smtpEmail,
            to: email,
            subject: 'Password Reset - SPT Analytics',
            text: [
                'Hello ' + username + ',',
                '',
                'A password reset was requested for your SPT Analytics account.',
                '',
                'Click the link below to reset your password (expires in 1 hour):',
                resetUrl,
                '',
                'If you did not request this, please ignore this email.',
                '',
                '---',
                'SPT Analytics'
            ].join('\n')
        });
        
        res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};

app.post('/api/auth/forgot-password', forgotPasswordHandler);
app.post('/forgot-password', forgotPasswordHandler);

// GET /reset-password - show reset form
app.get('/reset-password', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.send('Missing reset token');
    try {
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [rows] = await conn.execute(
            'SELECT id FROM dashboard_users WHERE reset_token = ? AND (reset_token_expires > NOW() OR reset_expires > NOW())',
            [token]
        );
        await conn.end();
        if (rows.length === 0) return res.send('Invalid or expired reset token');
        res.render('reset-password', { token, error: null, currentLang: req.query.lang || 'en' });
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

// POST /api/auth/reset-password - execute password reset via JSON
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password || password.length < 3) {
            return res.status(400).json({ success: false, error: 'Password must be at least 3 characters' });
        }
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [rows] = await conn.execute(
            'SELECT id FROM dashboard_users WHERE reset_token = ? AND (reset_token_expires > NOW() OR reset_expires > NOW())',
            [token]
        );
        if (rows.length === 0) {
            await conn.end();
            return res.status(400).json({ success: false, error: 'Invalid or expired reset token' });
        }
        const hash = await bcrypt.hash(password, 10);
        await conn.execute(
            'UPDATE dashboard_users SET password_hash = ?, reset_token = NULL, reset_expires = NULL, reset_token_expires = NULL WHERE id = ?',
            [hash, rows[0].id]
        );
        await conn.end();
        res.json({ success: true, message: 'Password reset successful' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /reset-password - execute password reset via HTML form (backward compatibility)
app.post('/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password || password.length < 3) {
            return res.render('reset-password', { token, error: 'Password must be at least 3 characters', currentLang: req.query.lang || 'en' });
        }
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [rows] = await conn.execute(
            'SELECT id FROM dashboard_users WHERE reset_token = ? AND (reset_token_expires > NOW() OR reset_expires > NOW())',
            [token]
        );
        if (rows.length === 0) {
            await conn.end();
            return res.render('reset-password', { token, error: 'Invalid or expired reset token', currentLang: req.query.lang || 'en' });
        }
        const hash = await bcrypt.hash(password, 10);
        await conn.execute(
            'UPDATE dashboard_users SET password_hash = ?, reset_token = NULL, reset_expires = NULL, reset_token_expires = NULL WHERE id = ?',
            [hash, rows[0].id]
        );
        await conn.end();
        res.redirect('/login?reset=success');
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

// --- GROUP MANAGEMENT ROUTES ---

// GET /groups - redirect to users page (merged)
app.get('/groups', (req, res) => {
    res.redirect('/users');
});

// POST /groups/add - create a new group
app.post('/groups/add', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) return res.redirect('/');
        const { name } = req.body;
        const lang = req.body.lang || req.session.lang || 'en';
        const langQuery = lang === 'ar' ? '&lang=ar' : '';
        if (!name || name.trim().length < 2) return res.redirect('/users?error=Group name must be at least 2 characters' + langQuery);
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        await conn.execute('INSERT INTO dashboard_groups (name) VALUES (?)', [name.trim()]);
        await conn.end();
        res.redirect('/users?success=Group created' + langQuery);
    } catch (err) {
        const langQuery = (req.body.lang || req.session.lang) === 'ar' ? '&lang=ar' : '';
        res.redirect('/users?error=' + encodeURIComponent(err.message) + langQuery);
    }
});

// POST /groups/delete - delete a group
app.post('/groups/delete', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) return res.redirect('/');
        const { id, lang } = req.body;
        const currentLanguage = lang || req.session.lang || 'en';
        const langQuery = currentLanguage === 'ar' ? '&lang=ar' : '';

        if (!id) return res.redirect('/users?error=Group ID required' + langQuery);
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        // Prevent deleting super admins group
        const [grp] = await conn.execute('SELECT name FROM dashboard_groups WHERE id = ?', [id]);
        if (grp.length && grp[0].name === 'super admins') {
            await conn.end();
            return res.redirect('/users?error=Cannot delete the super admins group' + langQuery);
        }
        await conn.execute('DELETE FROM dashboard_group_permissions WHERE group_id = ?', [id]);
        await conn.execute('UPDATE dashboard_users SET group_id = NULL WHERE group_id = ?', [id]);
        await conn.execute('DELETE FROM dashboard_groups WHERE id = ?', [id]);
        await conn.end();
        res.redirect('/users?success=Group deleted' + langQuery);
    } catch (err) {
        const langQuery = (req.body.lang || req.session.lang) === 'ar' ? '&lang=ar' : '';
        res.redirect('/users?error=' + encodeURIComponent(err.message) + langQuery);
    }
});

// POST /groups/permissions - update group permissions
app.post('/groups/permissions', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) return res.redirect('/');
        const { group_id, tabs, lang } = req.body;
        const currentLanguage = lang || req.session.lang || 'en';
        const langQuery = currentLanguage === 'ar' ? '&lang=ar' : '';

        if (!group_id) return res.redirect('/users?error=Group ID required' + langQuery);
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [grp] = await conn.execute('SELECT name FROM dashboard_groups WHERE id = ?', [group_id]);
        if (grp.length && grp[0].name === 'super admins') {
            await conn.end();
            return res.redirect('/users?error=Super admins permissions cannot be modified' + langQuery);
        }
        // Clear existing permissions
        await conn.execute('DELETE FROM dashboard_group_permissions WHERE group_id = ?', [group_id]);
        // Insert new ones
        const selectedTabs = Array.isArray(tabs) ? tabs : (tabs ? [tabs] : []);
        for (const tab of selectedTabs) {
            if (ALL_TABS.includes(tab)) {
                await conn.execute('INSERT INTO dashboard_group_permissions (group_id, tab) VALUES (?, ?)', [group_id, tab]);
            }
        }
        await conn.end();
        res.redirect('/users?success=Permissions updated' + langQuery);
    } catch (err) {
        const langQuery = (req.body.lang || req.session.lang) === 'ar' ? '&lang=ar' : '';
        res.redirect('/users?error=' + encodeURIComponent(err.message) + langQuery);
    }
});

// --- ROUTE 1: LANDING DASHBOARD ---
app.get('/', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const selectedExtension = req.query.targetExtension || 'ALL';
        const statusFilter = req.query.statusFilter || 'ALL';
        const searchSrc = req.query.searchSrc || '';
        const searchDst = req.query.searchDst || '';
        const searchDid = req.query.searchDid || '';
        const searchUniqueId = req.query.searchUniqueId || '';
        const directionFilter = req.query.directionFilter || 'ALL';
        const callScopeFilter = req.query.callScopeFilter || 'ALL';

        const scopedExt = getUserScopedExtension(req);
        let selectedExtensions = scopedExt ? [scopedExt] : req.query.targetExtension;
        if (!selectedExtensions) selectedExtensions = ['ALL'];
        else if (!Array.isArray(selectedExtensions)) selectedExtensions = [selectedExtensions];
        if (selectedExtensions.length > 1 && selectedExtensions.includes('ALL')) {
            selectedExtensions = selectedExtensions.filter(e => e !== 'ALL');
        }
        const targetExtensionFilter = scopedExt ? [scopedExt] : (selectedExtensions.includes('ALL') ? 'ALL' : selectedExtensions);

        let selectedStatuses = req.query.statusFilter;
        if (!selectedStatuses) selectedStatuses = ['ALL'];
        else if (!Array.isArray(selectedStatuses)) selectedStatuses = [selectedStatuses];
        if (selectedStatuses.length > 1 && selectedStatuses.includes('ALL')) {
            selectedStatuses = selectedStatuses.filter(s => s !== 'ALL');
        }
        const statusFilterList = selectedStatuses.includes('ALL') ? 'ALL' : selectedStatuses;

        const directionCase = CDR_DIRECTION_CASE;
        const callScopeCase = CDR_CALL_SCOPE_CASE;
        let query = `
            SELECT c.src, c.dst, c.billsec, ${CDR_DISPOSITION_SQL} as disposition, c.channel, c.dstchannel, c.calldate, c.did, c.uniqueid, COALESCE(u.name, NULLIF(TRIM(c.cnam), ''), 'No Name') as src_name
            FROM ${tables.cdr} c
            LEFT JOIN ${tables.users} u ON c.src = u.extension
            WHERE c.calldate BETWEEN ? AND ?
            AND c.dst NOT IN ('ussd','sms','report','s')
        `;
        let queryParams = [startDate, endDate];

        if (targetExtensionFilter !== 'ALL') {
            const exts = targetExtensionFilter;
            const regexpPattern = exts.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
            const clause = " AND (c.src IN (?) OR c.dst IN (?) OR c.cnum IN (?) OR c.channel REGEXP CONCAT('^[A-Za-z0-9_]+/(', ?, ')([^0-9]|$)') OR c.dstchannel REGEXP CONCAT('^[A-Za-z0-9_]+/(', ?, ')([^0-9]|$)'))";
            query += clause;
            queryParams.push(exts, exts, exts, regexpPattern, regexpPattern);
        }
        if (searchSrc) {
            query += " AND c.src LIKE ?";
            queryParams.push(`%${searchSrc}%`);
        }
        if (searchDst) {
            query += " AND c.dst LIKE ?";
            queryParams.push(`%${searchDst}%`);
        }
        if (searchDid) {
            query += " AND c.did LIKE ?";
            queryParams.push(`%${searchDid}%`);
        }
        if (searchUniqueId) {
            query += " AND c.uniqueid LIKE ?";
            queryParams.push(`%${searchUniqueId}%`);
        }
        if (statusFilterList !== 'ALL') {
            let statusesToMatch = [...statusFilterList];
            if (statusesToMatch.includes('FAILED') && !statusesToMatch.includes('CONGESTION')) {
                statusesToMatch.push('CONGESTION');
            }
            query += " AND (TRIM(UPPER(c.disposition)) IN (?) OR ('FAILED' IN (?) AND TRIM(UPPER(c.disposition)) = 'CONGESTION'))";
            queryParams.push(statusesToMatch, statusFilterList);
        }
        if (directionFilter !== 'ALL') {
            query += ` AND ${directionCase} = ?`;
            queryParams.push(directionFilter);
        }
        if (callScopeFilter !== 'ALL') {
            query += ` AND ${callScopeCase} = ?`;
            queryParams.push(callScopeFilter);
        }

        const [rows] = await pool.query(query, queryParams);

        const stats = {
            totalCalls: 0,
            inboundCount: 0,
            outboundCount: 0,
            internalCount: 0,
            externalCount: 0,
            inboundMin: 0,
            outboundMin: 0,
            internalTalkSec: 0,
            externalTalkSec: 0,
            internalMin: 0,
            externalMin: 0,
            answeredCalls: 0,
            noAnswerCalls: 0,
            busyCalls: 0,
            failedCalls: 0,
            totalTalkSec: 0
        };
        const employeeMetrics = {};
        const effectiveRoster = scopedExt ? (res.locals.roster || []).filter(e => e.extension === scopedExt) : (res.locals.roster || []);
        effectiveRoster.forEach(emp => {
            employeeMetrics[emp.extension] = { extension: emp.extension, name: emp.name, totalCalls: 0, totalTalkSec: 0, uniqueNumbers: new Set() };
        });

        rows.forEach(row => {
            stats.totalCalls++;
            const sec = parseInt(row.billsec) || 0;
            const callClass = classifyCdr(row);

            if (callClass.call_scope === 'INTERNAL') {
                stats.internalCount++;
                if (row.disposition === 'ANSWERED') stats.internalTalkSec += sec;
            } else {
                stats.externalCount++;
                if (row.disposition === 'ANSWERED') stats.externalTalkSec += sec;
            }

            if (callClass.direction === 'OUTBOUND') {
                stats.outboundCount++;
                if (row.disposition === 'ANSWERED') stats.outboundMin += sec;
            } else if (callClass.direction === 'INBOUND') {
                stats.inboundCount++;
                if (row.disposition === 'ANSWERED') stats.inboundMin += sec;
            }

            const disp = row.disposition;
            if (disp === 'ANSWERED') {
                stats.answeredCalls++;
                stats.totalTalkSec += sec;
            } else if (disp === 'NO ANSWER') {
                stats.noAnswerCalls++;
            } else if (disp === 'BUSY') {
                stats.busyCalls++;
            } else if (disp === 'FAILED' || disp === 'CONGESTION') {
                stats.failedCalls++;
            }

            [row.src, row.dst].forEach((ext, idx) => {
                if (employeeMetrics[ext]) {
                    employeeMetrics[ext].totalCalls++;
                    employeeMetrics[ext].totalTalkSec += (row.disposition === 'ANSWERED' ? sec : 0);
                    employeeMetrics[ext].uniqueNumbers.add(idx === 0 ? row.dst : row.src);
                }
            });
        });
        stats.inboundMin = Math.round(stats.inboundMin / 60);
        stats.outboundMin = Math.round(stats.outboundMin / 60);
        stats.internalMin = Math.round(stats.internalTalkSec / 60);
        stats.externalMin = Math.round(stats.externalTalkSec / 60);
        stats.totalTalkMin = Math.round(stats.totalTalkSec / 60);
        stats.avgTalkSec = stats.answeredCalls ? Math.round(stats.totalTalkSec / stats.answeredCalls) : 0;
        const trendMap = {};
        const dispCounts = {};
        const hourlyMap = {};
        const durationCounts = { short: 0, medium: 0, long: 0 };
        rows.forEach(row => {
            const day = moment(row.calldate).format('YYYY-MM-DD');
            trendMap[day] = trendMap[day] || { total: 0, inbound: 0, outbound: 0 };
            trendMap[day].total++;
            const callClass = classifyCdr(row);
            if (callClass.direction === 'OUTBOUND') trendMap[day].outbound++;
            else if (callClass.direction === 'INBOUND') trendMap[day].inbound++;
            else trendMap[day].internal = (trendMap[day].internal || 0) + 1;
            const disp = row.disposition || 'UNKNOWN';
            dispCounts[disp] = (dispCounts[disp] || 0) + 1;

            const hour = moment(row.calldate).format('H');
            hourlyMap[hour] = (hourlyMap[hour] || 0) + 1;

            if (row.disposition === 'ANSWERED') {
                const sec = parseInt(row.billsec) || 0;
                if (sec < 30) durationCounts.short++;
                else if (sec <= 180) durationCounts.medium++;
                else durationCounts.long++;
            }
        });

        const trendData = Object.entries(trendMap)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, d]) => ({ date, ...d }));

        const dispositionData = Object.entries(dispCounts).map(([name, value]) => ({ name, value }));

        const hourlyData = Array.from({ length: 24 }, (_, i) => ({
            hour: String(i).padStart(2, '0'),
            calls: hourlyMap[String(i)] || 0
        }));

        const topTalkers = Object.values(employeeMetrics)
            .sort((a, b) => b.totalTalkSec - a.totalTalkSec)
            .slice(0, 10)
            .map(e => ({ name: e.name + ' (' + e.extension + ')', talkSec: e.totalTalkSec, calls: e.totalCalls }));

        const durationData = [
            { name: 'Short (<30s)', value: durationCounts.short },
            { name: 'Medium (30s-3m)', value: durationCounts.medium },
            { name: 'Long (>3m)', value: durationCounts.long }
        ];

        const scopeData = [
            { name: 'Internal', value: stats.internalCount },
            { name: 'External', value: stats.externalCount }
        ];

        res.render('dashboard', {
            stats,
            filters: {
                startDate,
                endDate,
                targetExtension: targetExtensionFilter,
                statusFilter: statusFilterList,
                searchSrc,
                searchDst,
                searchDid,
                searchUniqueId,
                directionFilter,
                callScopeFilter
            },
            moment,
            trendData: JSON.stringify(trendData),
            dispositionData: JSON.stringify(dispositionData),
            hourlyData: JSON.stringify(hourlyData),
            topTalkers: JSON.stringify(topTalkers),
            durationData: JSON.stringify(durationData),
            scopeData: JSON.stringify(scopeData)
        });
    } catch (error) { res.status(500).send("Dashboard Error: " + error.message); }
});

// Helper to format Destination field for inbound/USSD/Ring Groups calls
function formatDestination(row, ringGroupSet = new Set()) {
    let dst = String(row.dst || '').trim();
    if (dst === 's' || dst.toLowerCase() === 'ussd') {
        if (row.channel && row.channel.toLowerCase().startsWith('dongle/')) {
            const match = row.channel.match(/dongle\/(dongle\d+)/i);
            if (match && match[1]) {
                const dongleId = match[1].toLowerCase();
                const mapping = {
                    'dongle0': '+201027826232',
                };
                return mapping[dongleId] || dongleId;
            }
        }
        if (row.did && row.did.trim()) {
            return row.did.trim();
        }
        if (dst.toLowerCase() === 'ussd' || (row.channel && row.channel.toLowerCase().includes('ussd'))) {
            return 'USSD Service';
        }
        return 'System (s)';
    }

    const isHuntOrGroup = (ringGroupSet && ringGroupSet.has(dst)) 
                       || (row.dcontext && (row.dcontext.startsWith('ext-group') || row.dcontext.startsWith('ext-queues')))
                       || (row.lastdata && (row.lastdata.includes('auto-blkvm') || row.lastdata.includes('from-queue')));

    if (isHuntOrGroup) {
        let pickedUpExt = null;
        if (row.dstchannel) {
            pickedUpExt = getExtensionFromChannel(row.dstchannel);
        }
        if (!pickedUpExt && row.lastdata) {
            const m = String(row.lastdata).match(/(?:SIP|PJSIP|IAX2|Local)\/(\d{2,5})(?:[-@:;,]|$)/i);
            if (m) pickedUpExt = m[1];
        }
        if (pickedUpExt && pickedUpExt !== dst) {
            return `${dst} (${pickedUpExt})`;
        }
    }

    return dst;
}

// --- ROUTE 2: CDR DETAILS VIEW (Paginated) ---
app.get('/cdr', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const scopedExt = getUserScopedExtension(req);
        let selectedExtensions = scopedExt ? [scopedExt] : req.query.targetExtension;
        if (!selectedExtensions) selectedExtensions = ['ALL'];
        else if (!Array.isArray(selectedExtensions)) selectedExtensions = [selectedExtensions];
        if (selectedExtensions.length > 1 && selectedExtensions.includes('ALL')) {
            selectedExtensions = selectedExtensions.filter(e => e !== 'ALL');
        }
        const targetExtensionFilter = scopedExt ? [scopedExt] : (selectedExtensions.includes('ALL') ? 'ALL' : selectedExtensions);

        let selectedStatuses = req.query.statusFilter;
        if (!selectedStatuses) selectedStatuses = ['ALL'];
        else if (!Array.isArray(selectedStatuses)) selectedStatuses = [selectedStatuses];
        if (selectedStatuses.length > 1 && selectedStatuses.includes('ALL')) {
            selectedStatuses = selectedStatuses.filter(s => s !== 'ALL');
        }
        const statusFilterList = selectedStatuses.includes('ALL') ? 'ALL' : selectedStatuses;
        const searchSrc = req.query.searchSrc || '';
        const searchDst = req.query.searchDst || '';
        const searchDid = req.query.searchDid || '';
        const searchUniqueId = req.query.searchUniqueId || '';
        const directionFilter = req.query.directionFilter || 'ALL';
        const callScopeFilter = req.query.callScopeFilter || 'ALL';
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage) || 25));
        const offset = (page - 1) * perPage;
        const directionCase = CDR_DIRECTION_CASE;
        const callScopeCase = CDR_CALL_SCOPE_CASE;

        let countQuery = `
            SELECT COUNT(*) as total
            FROM ${tables.cdr} c
            LEFT JOIN ${tables.users} u ON c.src = u.extension
            WHERE c.calldate BETWEEN ? AND ?
            ${CDR_HISTORY_FILTERS_SQL}
        `;
        let countParams = [startDate, endDate];

        let query = `
            SELECT c.calldate, c.src, c.dst, c.dcontext, c.lastdata, c.duration, c.billsec, ${CDR_DISPOSITION_SQL} as disposition, c.uniqueid, c.recordingfile, c.channel, c.dstchannel, c.did, COALESCE(u.name, NULLIF(TRIM(c.cnam), ''), 'No Name') as src_name,
            ${directionCase} as direction,
            ${callScopeCase} as call_scope
            FROM ${tables.cdr} c
            LEFT JOIN ${tables.users} u ON c.src = u.extension
            WHERE c.calldate BETWEEN ? AND ?
            ${CDR_HISTORY_FILTERS_SQL}
        `;
        let queryParams = [startDate, endDate];

        if (targetExtensionFilter !== 'ALL') {
            const exts = targetExtensionFilter;
            const regexpPattern = exts.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
            const clause = " AND (c.src IN (?) OR c.dst IN (?) OR c.cnum IN (?) OR c.channel REGEXP CONCAT('^[A-Za-z0-9_]+/(', ?, ')([^0-9]|$)') OR c.dstchannel REGEXP CONCAT('^[A-Za-z0-9_]+/(', ?, ')([^0-9]|$)'))";
            query += clause; countQuery += clause;
            queryParams.push(exts, exts, exts, regexpPattern, regexpPattern);
            countParams.push(exts, exts, exts, regexpPattern, regexpPattern);
        }
        if (searchSrc) {
            const clause = " AND c.src LIKE ?";
            query += clause; countQuery += clause;
            queryParams.push(`%${searchSrc}%`);
            countParams.push(`%${searchSrc}%`);
        }
        if (searchDst) {
            const clause = " AND c.dst LIKE ?";
            query += clause; countQuery += clause;
            queryParams.push(`%${searchDst}%`);
            countParams.push(`%${searchDst}%`);
        }
        if (searchDid) {
            const clause = " AND c.did LIKE ?";
            query += clause; countQuery += clause;
            queryParams.push(`%${searchDid}%`);
            countParams.push(`%${searchDid}%`);
        }
        if (searchUniqueId) {
            const clause = " AND c.uniqueid LIKE ?";
            query += clause; countQuery += clause;
            queryParams.push(`%${searchUniqueId}%`);
            countParams.push(`%${searchUniqueId}%`);
        }
        if (statusFilterList !== 'ALL') {
            let statusesToMatch = [...statusFilterList];
            if (statusesToMatch.includes('FAILED') && !statusesToMatch.includes('CONGESTION')) {
                statusesToMatch.push('CONGESTION');
            }
            const clause = " AND (TRIM(UPPER(c.disposition)) IN (?) OR ('FAILED' IN (?) AND TRIM(UPPER(c.disposition)) = 'CONGESTION'))";
            query += clause; countQuery += clause;
            queryParams.push(statusesToMatch, statusFilterList);
            countParams.push(statusesToMatch, statusFilterList);
        }
        if (directionFilter !== 'ALL') {
            const clause = ` AND ${directionCase} = ?`;
            query += clause; countQuery += clause;
            queryParams.push(directionFilter);
            countParams.push(directionFilter);
        }
        if (callScopeFilter !== 'ALL') {
            const clause = ` AND ${callScopeCase} = ?`;
            query += clause; countQuery += clause;
            queryParams.push(callScopeFilter);
            countParams.push(callScopeFilter);
        }

        query += " ORDER BY c.calldate DESC LIMIT ? OFFSET ?";
        queryParams.push(perPage, offset);

        const [[{ total }]] = await pool.query(countQuery, countParams);
        const [rows] = await pool.query(query, queryParams);
        const totalPages = Math.ceil(total / perPage) || 1;

        let ringGroupSet = new Set();
        try {
            const [rgRows] = await pool.query('SELECT grpnum FROM `asterisk`.`ringgroups`');
            rgRows.forEach(r => ringGroupSet.add(String(r.grpnum)));
        } catch (_) {}

        const formattedRows = rows.map(row => {
            return {
                ...row,
                dst: formatDestination(row, ringGroupSet)
            };
        });
        res.render('cdr', {
            calls: formattedRows,
            filters: { startDate, endDate, targetExtension: targetExtensionFilter, statusFilter: statusFilterList, searchSrc, searchDst, searchDid, searchUniqueId, directionFilter, callScopeFilter, page, perPage },
            pagination: { total, totalPages, page, perPage },
            moment
        });
    } catch (error) { res.status(500).send("CDR System Error: " + error.message); }
});

// Route to export all filtered CDR records as a CSV file
app.get('/cdr/export', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const selectedExtension = req.query.targetExtension || 'ALL';
        const statusFilter = req.query.statusFilter || 'ALL';
        const searchSrc = req.query.searchSrc || '';
        const searchDst = req.query.searchDst || '';
        const searchDid = req.query.searchDid || '';
        const searchUniqueId = req.query.searchUniqueId || '';
        const scopedExt = getUserScopedExtension(req);
        let selectedExtensions = scopedExt ? [scopedExt] : req.query.targetExtension;
        if (!selectedExtensions) selectedExtensions = ['ALL'];
        else if (!Array.isArray(selectedExtensions)) selectedExtensions = [selectedExtensions];
        if (selectedExtensions.length > 1 && selectedExtensions.includes('ALL')) {
            selectedExtensions = selectedExtensions.filter(e => e !== 'ALL');
        }
        const targetExtensionFilter = scopedExt ? [scopedExt] : (selectedExtensions.includes('ALL') ? 'ALL' : selectedExtensions);

        let selectedStatuses = req.query.statusFilter;
        if (!selectedStatuses) selectedStatuses = ['ALL'];
        else if (!Array.isArray(selectedStatuses)) selectedStatuses = [selectedStatuses];
        if (selectedStatuses.length > 1 && selectedStatuses.includes('ALL')) {
            selectedStatuses = selectedStatuses.filter(s => s !== 'ALL');
        }
        const statusFilterList = selectedStatuses.includes('ALL') ? 'ALL' : selectedStatuses;
        const directionFilter = req.query.directionFilter || 'ALL';
        const callScopeFilter = req.query.callScopeFilter || 'ALL';
        const directionCase = CDR_DIRECTION_CASE;
        const callScopeCase = CDR_CALL_SCOPE_CASE;
        let query = `
            SELECT c.calldate, c.src, c.dst, c.dcontext, c.lastdata, c.duration, c.billsec, ${CDR_DISPOSITION_SQL} as disposition, c.uniqueid, c.recordingfile, c.channel, c.dstchannel, c.did, COALESCE(u.name, NULLIF(TRIM(c.cnam), ''), 'No Name') as src_name,
            ${directionCase} as direction,
            ${callScopeCase} as call_scope
            FROM ${tables.cdr} c
            LEFT JOIN ${tables.users} u ON c.src = u.extension
            WHERE c.calldate BETWEEN ? AND ?
            ${CDR_HISTORY_FILTERS_SQL}
        `;
        let queryParams = [startDate, endDate];

        if (targetExtensionFilter !== 'ALL') {
            const exts = targetExtensionFilter;
            const regexpPattern = exts.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
            const clause = " AND (c.src IN (?) OR c.dst IN (?) OR c.cnum IN (?) OR c.channel REGEXP CONCAT('^[A-Za-z0-9_]+/(', ?, ')([^0-9]|$)') OR c.dstchannel REGEXP CONCAT('^[A-Za-z0-9_]+/(', ?, ')([^0-9]|$)'))";
            query += clause;
            queryParams.push(exts, exts, exts, regexpPattern, regexpPattern);
        }
        if (searchSrc) {
            const clause = " AND c.src LIKE ?";
            query += clause;
            queryParams.push(`%${searchSrc}%`);
        }
        if (searchDst) {
            const clause = " AND c.dst LIKE ?";
            query += clause;
            queryParams.push(`%${searchDst}%`);
        }
        if (searchDid) {
            const clause = " AND c.did LIKE ?";
            query += clause;
            queryParams.push(`%${searchDid}%`);
        }
        if (searchUniqueId) {
            const clause = " AND c.uniqueid LIKE ?";
            query += clause;
            queryParams.push(`%${searchUniqueId}%`);
        }
        if (statusFilterList !== 'ALL') {
            let statusesToMatch = [...statusFilterList];
            if (statusesToMatch.includes('FAILED') && !statusesToMatch.includes('CONGESTION')) {
                statusesToMatch.push('CONGESTION');
            }
            const clause = " AND (TRIM(UPPER(c.disposition)) IN (?) OR ('FAILED' IN (?) AND TRIM(UPPER(c.disposition)) = 'CONGESTION'))";
            query += clause;
            queryParams.push(statusesToMatch, statusFilterList);
        }
        if (directionFilter !== 'ALL') {
            const clause = ` AND ${directionCase} = ?`;
            query += clause;
            queryParams.push(directionFilter);
        }
        if (callScopeFilter !== 'ALL') {
            const clause = ` AND ${callScopeCase} = ?`;
            query += clause;
            queryParams.push(callScopeFilter);
        }

        query += " ORDER BY c.calldate DESC";

        const [rows] = await pool.query(query, queryParams);

        let ringGroupSet = new Set();
        try {
            const [rgRows] = await pool.query('SELECT grpnum FROM `asterisk`.`ringgroups`');
            rgRows.forEach(r => ringGroupSet.add(String(r.grpnum)));
        } catch (_) {}

        // Build CSV string
        const csvHeaders = ["Date/Time", "Source", "Source Name", "Destination", "DID", "Duration (Sec)", "Billsec (Sec)", "Disposition", "Direction", "Call Scope", "Channel", "Destination Channel", "Unique ID"];
        
        let csvContent = "\ufeff"; // BOM for UTF-8 Excel support
        csvContent += csvHeaders.map(h => `"${h.replace(/"/g, '""')}"`).join(",") + "\n";

        for (const row of rows) {
            const formattedDst = formatDestination(row, ringGroupSet);
            const rowData = [
                `"${moment(row.calldate).format('YYYY-MM-DD HH:mm:ss')}"`,
                /^\+?\d+$/.test(String(row.src || '')) ? `="` + String(row.src || '').trim() + `"` : `"${String(row.src || '').replace(/"/g, '""')}"`,
                `"${String(row.src_name || '').replace(/"/g, '""')}"`,
                `"${formattedDst.replace(/"/g, '""')}"`,
                /^\+?\d+$/.test(String(row.did || '')) ? `="` + String(row.did || '').trim() + `"` : `"${String(row.did || '').replace(/"/g, '""')}"`,
                row.duration || 0,
                row.billsec || 0,
                `"${row.disposition || ''}"`,
                `"${row.direction || ''}"`,
                `"${row.call_scope || 'EXTERNAL'}"`,
                `"${row.channel || ''}"`,
                `"${row.dstchannel || ''}"`,
                `"${row.uniqueid || ''}"`
            ];
            csvContent += rowData.join(",") + "\n";
        }

        const filename = `cdr_export_${moment().format('YYYYMMDD_HHmmss')}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvContent);

    } catch (error) {
        res.status(500).send("CDR Export Error: " + error.message);
    }
});

// POST /api/cdr/delete — Delete a call history record (Super Admins only)
app.post('/api/cdr/delete', requireAuth, async (req, res) => {
    try {
        if (!isSuperAdmin(req)) {
            return res.status(403).json({ success: false, error: 'Unauthorized: Super Admin access required' });
        }
        const { uniqueid, calldate } = req.body;
        if (!uniqueid) {
            return res.status(400).json({ success: false, error: 'Unique ID is required' });
        }

        let query = `DELETE FROM ${tables.cdr} WHERE uniqueid = ?`;
        let params = [uniqueid];
        if (calldate) {
            query += ` AND calldate = ?`;
            params.push(calldate);
        }

        const [result] = await pool.query(query, params);
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: 'Call record not found' });
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('CDR Delete Error:', err);
        return res.status(500).json({ success: false, error: 'Database error: ' + err.message });
    }
});

// --- VOICEMAIL ---
const VM_ROOT = '/var/spool/asterisk/voicemail/default';

function parseVmTxt(filePath) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const meta = {};
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
            const idx = trimmed.indexOf('=');
            if (idx > 0) {
                meta[trimmed.substring(0, idx).trim()] = trimmed.substring(idx + 1).trim();
            }
        }
        return meta;
    } catch { return null; }
}

function getAllVoicemailMailboxes() {
    const mailboxes = new Set();
    try {
        if (fs.existsSync(VM_ROOT)) {
            fs.readdirSync(VM_ROOT, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .forEach(d => mailboxes.add(d.name));
        }
    } catch {}
    return [...mailboxes].sort((a, b) => parseInt(a) - parseInt(b));
}

function scanVoicemails() {
    const messages = [];
    if (!fs.existsSync(VM_ROOT)) return messages;
    const extDirs = fs.readdirSync(VM_ROOT, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const ext of extDirs) {
        const inbox = path.join(VM_ROOT, ext.name, 'INBOX');
        if (!fs.existsSync(inbox)) continue;
        const files = fs.readdirSync(inbox).filter(f => f.endsWith('.txt'));
        for (const txt of files) {
            const meta = parseVmTxt(path.join(inbox, txt));
            if (!meta) continue;

            let wavFile = null;
            const possibleExts = ['.wav', '.WAV', '.gsm', '.sln'];
            for (const audioExt of possibleExts) {
                const candidateName = txt.replace(/\.txt$/, audioExt);
                if (fs.existsSync(path.join(inbox, candidateName))) {
                    wavFile = candidateName;
                    break;
                }
            }

            const duration = parseInt(meta.duration) || 0;
            if (duration === 0) continue;

            const origtime = meta.origtime ? parseInt(meta.origtime) * 1000 : 0;

            messages.push({
                mailbox: ext.name,
                callerid: (meta.callerid || '').replace(/"/g, ''),
                origdate: meta.origdate || '',
                origtime,
                duration: duration,
                context: meta.context || '',
                extension: meta.extension || '',
                wavFile: wavFile,
                txtFile: txt,
                read: meta.message === 'read'
            });
        }
    }
    messages.sort((a, b) => b.origtime - a.origtime);
    return messages;
}

app.get('/voicemails', (req, res) => {
    const allMsgs = scanVoicemails();
    const searchCallerid = req.query.searchCallerid || '';
    const searchMailbox = req.query.searchMailbox || '';
    const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : '';
    const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage) || 25));

    let filtered = allMsgs;
    if (searchCallerid) filtered = filtered.filter(m => (m.callerid || '').toLowerCase().includes(searchCallerid.toLowerCase()));
    if (searchMailbox) filtered = filtered.filter(m => m.mailbox === searchMailbox);
    if (startDate) {
        const startMs = moment(startDate).valueOf();
        filtered = filtered.filter(m => m.origtime && m.origtime >= startMs);
    }
    if (endDate) {
        const endMs = moment(endDate).valueOf();
        filtered = filtered.filter(m => m.origtime && m.origtime <= endMs);
    }

    const total = filtered.length;
    const totalPages = Math.ceil(total / perPage) || 1;
    const paged = filtered.slice((page - 1) * perPage, page * perPage);

    const mailboxes = getAllVoicemailMailboxes();

    res.render('voicemails', {
        messages: paged, mailboxes, moment,
        filters: { searchCallerid, searchMailbox, startDate, endDate, page, perPage },
        pagination: { total, totalPages, page, perPage }
    });
});

app.get('/api/voicemails', (req, res) => {
    const allMsgs = scanVoicemails();
    const searchCallerid = req.query.searchCallerid || '';
    const searchMailbox = req.query.searchMailbox || '';
    const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : '';
    const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage) || 25));

    let filtered = allMsgs;
    if (searchCallerid) filtered = filtered.filter(m => (m.callerid || '').toLowerCase().includes(searchCallerid.toLowerCase()));
    if (searchMailbox) filtered = filtered.filter(m => m.mailbox === searchMailbox);
    if (startDate) {
        const startMs = moment(startDate).valueOf();
        filtered = filtered.filter(m => m.origtime && m.origtime >= startMs);
    }
    if (endDate) {
        const endMs = moment(endDate).valueOf();
        filtered = filtered.filter(m => m.origtime && m.origtime <= endMs);
    }

    const total = filtered.length;
    const totalPages = Math.ceil(total / perPage) || 1;
    const paged = filtered.slice((page - 1) * perPage, page * perPage);
    const mailboxes = getAllVoicemailMailboxes();

    res.json({ messages: paged, mailboxes, filters: { startDate, endDate }, pagination: { total, totalPages, page, perPage } });
});

app.get('/vm-audio/:mailbox/:file', (req, res) => {
    const filePath = path.join(VM_ROOT, req.params.mailbox, 'INBOX', req.params.file);
    if (!fs.existsSync(filePath)) return res.status(404).send('Voicemail audio missing.');
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = { '.wav': 'audio/wav', '.WAV': 'audio/wav', '.gsm': 'audio/x-gsm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
    const contentType = mimeTypes[ext] || 'audio/wav';
    const isDownload = req.query.download === '1';
    if (isDownload) {
        res.setHeader('Content-Type', contentType);
        return res.download(filePath, req.params.file, (err) => {
            if (err && !res.headersSent) {
                res.status(500).send("Voicemail Download Error: " + err.message);
            }
        });
    }
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': contentType });
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Content-Disposition': `inline; filename="${req.params.file}"` });
        fs.createReadStream(filePath).pipe(res);
    }
});

app.get('/vm-export', (req, res) => {
    const allMsgs = scanVoicemails();
    const searchCallerid = req.query.searchCallerid || '';
    const searchMailbox = req.query.searchMailbox || '';
    const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : '';
    const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : '';
    let filtered = allMsgs;
    if (searchCallerid) filtered = filtered.filter(m => (m.callerid || '').toLowerCase().includes(searchCallerid.toLowerCase()));
    if (searchMailbox) filtered = filtered.filter(m => m.mailbox === searchMailbox);
    if (startDate) {
        const startMs = moment(startDate).valueOf();
        filtered = filtered.filter(m => m.origtime && m.origtime >= startMs);
    }
    if (endDate) {
        const endMs = moment(endDate).valueOf();
        filtered = filtered.filter(m => m.origtime && m.origtime <= endMs);
    }
    const csvHeaders = ["Mailbox", "Caller ID", "Date", "Duration (Sec)", "Extension", "File"];
    let csv = "\ufeff" + csvHeaders.map(h => `"${h}"`).join(",") + "\n";
    for (const m of filtered) {
        csv += [`"${m.mailbox}"`, `"${m.callerid}"`, `"${m.origtime ? moment(m.origtime).format('YYYY-MM-DD HH:mm:ss') : ''}"`, m.duration, `"${m.extension}"`, `"${m.wavFile || ''}"`].join(",") + "\n";
    }
    const filename = `voicemails_${moment().format('YYYYMMDD_HHmmss')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
});


// --- VOICEMAIL STORAGE & RETENTION HELPERS ---
function syncVoicemailLimits(maxmsg = 1000, maxsecs = 300) {
    const maxMsgNum = Math.min(9999, Math.max(10, parseInt(maxmsg, 10) || 1000));
    const maxSecsNum = Math.min(1800, Math.max(10, parseInt(maxsecs, 10) || 300));
    
    // 1. Update /etc/asterisk/vm_general.inc
    const vmInc = '/etc/asterisk/vm_general.inc';
    try {
        if (fs.existsSync(vmInc)) {
            let content = fs.readFileSync(vmInc, 'utf8');
            let lines = content.split('\n').filter(l => !l.trim().startsWith('maxmsg=') && !l.trim().startsWith('maxsecs=') && !l.trim().startsWith('minsecs='));
            lines.push(`maxmsg=${maxMsgNum}`);
            lines.push(`maxsecs=${maxSecsNum}`);
            lines.push('minsecs=3');
            fs.writeFileSync(vmInc, lines.join('\n'), 'utf8');
        }
    } catch (e) {
        console.error('Error updating vm_general.inc:', e.message);
    }

    // 2. Update /etc/asterisk/voicemail.conf [general] section
    const vmFile = '/etc/asterisk/voicemail.conf';
    try {
        if (fs.existsSync(vmFile)) {
            let content = fs.readFileSync(vmFile, 'utf8');
            let lines = content.split('\n').filter(l => !l.trim().startsWith('maxmsg=') && !l.trim().startsWith('maxsecs=') && !l.trim().startsWith('minsecs='));
            const genIdx = lines.findIndex(l => l.trim() === '[general]');
            if (genIdx !== -1) {
                lines.splice(genIdx + 1, 0, `maxmsg=${maxMsgNum}`, `maxsecs=${maxSecsNum}`, 'minsecs=3');
            }
            fs.writeFileSync(vmFile, lines.join('\n'), 'utf8');
        }
    } catch (e) {
        console.error('Error updating voicemail.conf:', e.message);
    }

    // 3. Reload Asterisk voicemail module
    exec(`${ASTERISK_BIN} -rx 'voicemail reload'`, (err) => {
        if (err) console.error('Voicemail reload error:', err.message);
    });
}

function getVoicemailStorageStats() {
    let totalMessages = 0;
    let totalBytes = 0;
    const mailboxes = new Set();
    let oldestTime = null;
    let newestTime = null;

    try {
        if (fs.existsSync(VM_ROOT)) {
            const extDirs = fs.readdirSync(VM_ROOT, { withFileTypes: true }).filter(d => d.isDirectory());
            for (const ext of extDirs) {
                const mailboxPath = path.join(VM_ROOT, ext.name);
                const subfolders = ['INBOX', 'Old', 'Work', 'Family', 'Friends', 'Cust1', 'Cust2', 'Cust3', 'Cust4', 'Cust5'];
                for (const sf of subfolders) {
                    const sfPath = path.join(mailboxPath, sf);
                    if (!fs.existsSync(sfPath)) continue;
                    const dirents = fs.readdirSync(sfPath, { withFileTypes: true });
                    for (const dirent of dirents) {
                        if (!dirent.isFile()) continue;
                        const fPath = path.join(sfPath, dirent.name);
                        try {
                            const stat = fs.statSync(fPath);
                            totalBytes += stat.size;
                            if (dirent.name.endsWith('.txt')) {
                                totalMessages++;
                                 mailboxes.add(ext.name);
                                const meta = parseVmTxt(fPath);
                                const t = meta && meta.origtime ? parseInt(meta.origtime) * 1000 : stat.mtimeMs;
                                if (t) {
                                    if (!oldestTime || t < oldestTime) oldestTime = t;
                                    if (!newestTime || t > newestTime) newestTime = t;
                                }
                            }
                        } catch {}
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error calculating voicemail storage stats:', err);
    }

    const totalSizeMB = (totalBytes / (1024 * 1024)).toFixed(2);
    let totalSizeFormatted = totalBytes < 1024 * 1024
        ? (totalBytes / 1024).toFixed(1) + ' KB'
        : (totalBytes < 1024 * 1024 * 1024
            ? (totalBytes / (1024 * 1024)).toFixed(2) + ' MB'
            : (totalBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB');

    return {
        totalMessages,
        totalBytes,
        totalSizeMB: parseFloat(totalSizeMB),
        totalSizeFormatted,
        mailboxesCount: mailboxes.size,
        oldestTime,
        newestTime
    };
}

function purgeOldVoicemails(days = 90) {
    const daysNum = Math.max(1, parseInt(days, 10) || 90);
    const thresholdMs = Date.now() - (daysNum * 24 * 60 * 60 * 1000);
    let purgedCount = 0;
    let freedBytes = 0;

    try {
        if (fs.existsSync(VM_ROOT)) {
            const extDirs = fs.readdirSync(VM_ROOT, { withFileTypes: true }).filter(d => d.isDirectory());
            for (const ext of extDirs) {
                const mailboxPath = path.join(VM_ROOT, ext.name);
                const subfolders = ['INBOX', 'Old', 'Work', 'Family', 'Friends', 'Cust1', 'Cust2', 'Cust3', 'Cust4', 'Cust5'];
                for (const sf of subfolders) {
                    const sfPath = path.join(mailboxPath, sf);
                    if (!fs.existsSync(sfPath)) continue;
                    const files = fs.readdirSync(sfPath);
                    const txtFiles = files.filter(f => f.endsWith('.txt'));
                    for (const txt of txtFiles) {
                        const txtPath = path.join(sfPath, txt);
                        try {
                            const stat = fs.statSync(txtPath);
                            const meta = parseVmTxt(txtPath);
                            const msgTime = meta && meta.origtime ? parseInt(meta.origtime) * 1000 : stat.mtimeMs;
                            if (msgTime && msgTime < thresholdMs) {
                                const baseName = txt.replace(/\.txt$/, '');
                                const related = files.filter(f => f.startsWith(baseName));
                                for (const rf of related) {
                                    const rfPath = path.join(sfPath, rf);
                                    try {
                                        const rfStat = fs.statSync(rfPath);
                                        freedBytes += rfStat.size;
                                        fs.unlinkSync(rfPath);
                                    } catch {}
                                }
                                purgedCount++;
                            }
                        } catch {}
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error purging old voicemails:', err);
    }

    let freedFormatted = freedBytes < 1024 * 1024
        ? (freedBytes / 1024).toFixed(1) + ' KB'
        : (freedBytes < 1024 * 1024 * 1024
            ? (freedBytes / (1024 * 1024)).toFixed(2) + ' MB'
            : (freedBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB');

    return {
        purgedCount,
        freedBytes,
        freedFormatted
    };
}

// Schedule daily voicemail auto-purge check
setInterval(async () => {
    try {
        const [rows] = await pool.query('SELECT * FROM `asterisk`.`voicemail_storage_settings` WHERE id = 1');
        if (rows && rows.length > 0) {
            const s = rows[0];
            if (s.auto_purge_enabled && s.retention_days > 0) {
                const res = purgeOldVoicemails(s.retention_days);
                if (res.purgedCount > 0) {
                    console.log(`[Auto-Purge] Purged ${res.purgedCount} old voicemails (> ${s.retention_days} days), freed ${res.freedFormatted}`);
                }
                await pool.query('UPDATE `asterisk`.`voicemail_storage_settings` SET last_purged_at = NOW() WHERE id = 1');
            }
        }
    } catch (err) {
        console.error('Voicemail auto-purge timer error:', err.message);
    }
}, 24 * 60 * 60 * 1000).unref();

// --- VOICEMAIL STORAGE & RETENTION APIs ---
app.get('/api/voicemail-storage/settings', requireAuth, async (req, res) => {
    try {
        let settings = { max_messages: 1000, max_duration_sec: 300, retention_days: 90, auto_purge_enabled: 0, last_purged_at: null };
        try {
            const [rows] = await pool.query('SELECT * FROM `asterisk`.`voicemail_storage_settings` WHERE id = 1');
            if (rows && rows.length > 0) settings = rows[0];
        } catch (_) {}

        const stats = getVoicemailStorageStats();
        res.json({ success: true, settings, stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/voicemail-storage/settings', requireAuth, async (req, res) => {
    try {
        const max_messages = Math.min(9999, Math.max(10, parseInt(req.body.max_messages, 10) || 1000));
        const max_duration_sec = Math.min(1800, Math.max(10, parseInt(req.body.max_duration_sec, 10) || 300));
        const retention_days = Math.min(3650, Math.max(1, parseInt(req.body.retention_days, 10) || 90));
        const auto_purge_enabled = (req.body.auto_purge_enabled === 1 || req.body.auto_purge_enabled === '1' || req.body.auto_purge_enabled === true) ? 1 : 0;

        await pool.query(`
            INSERT INTO \`asterisk\`.\`voicemail_storage_settings\` (id, max_messages, max_duration_sec, retention_days, auto_purge_enabled)
            VALUES (1, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                max_messages = VALUES(max_messages),
                max_duration_sec = VALUES(max_duration_sec),
                retention_days = VALUES(retention_days),
                auto_purge_enabled = VALUES(auto_purge_enabled)
        `, [max_messages, max_duration_sec, retention_days, auto_purge_enabled]);

        syncVoicemailLimits(max_messages, max_duration_sec);

        const stats = getVoicemailStorageStats();
        res.json({
            success: true,
            message: `Voicemail storage settings updated (Limit: ${max_messages} msgs/box, Duration: ${max_duration_sec}s, Retention: ${retention_days} days).`,
            settings: { max_messages, max_duration_sec, retention_days, auto_purge_enabled },
            stats
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/voicemail-storage/purge', requireAuth, async (req, res) => {
    try {
        let days = parseInt(req.body.retention_days, 10);
        if (!days || days < 1) {
            try {
                const [rows] = await pool.query('SELECT retention_days FROM `asterisk`.`voicemail_storage_settings` WHERE id = 1');
                if (rows && rows.length > 0) days = rows[0].retention_days;
            } catch (_) {}
        }
        days = Math.max(1, days || 90);

        const result = purgeOldVoicemails(days);

        try {
            await pool.query('UPDATE `asterisk`.`voicemail_storage_settings` SET last_purged_at = NOW() WHERE id = 1');
        } catch (_) {}

        const stats = getVoicemailStorageStats();
        res.json({
            success: true,
            message: `Cleanup completed: ${result.purgedCount} voicemails older than ${days} days were purged (${result.freedFormatted} freed).`,
            purgedCount: result.purgedCount,
            freedBytes: result.freedBytes,
            freedFormatted: result.freedFormatted,
            stats
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- API: GENERAL EXTENSIONS OVERVIEW ---
app.get('/api/ext-overview', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');

        const [rows] = await pool.query(`SELECT src, dst, billsec, ${CDR_DISPOSITION_SQL} as disposition, channel, dstchannel FROM ${tables.cdr} c WHERE calldate BETWEEN ? AND ? AND dst NOT IN ('ussd','sms','report','s')`, [startDate, endDate]);

        const employeeMetrics = {};
        res.locals.roster.forEach(emp => {
            employeeMetrics[emp.extension] = { 
                extension: emp.extension, 
                name: emp.name, 
                online: emp.online,
                totalCalls: 0, 
                inboundCalls: 0,
                outboundCalls: 0,
                inboundTalkSec: 0, 
                outboundTalkSec: 0, 
                totalTalkSec: 0,
                uniqueContactCount: 0,
                uniqueNumbers: new Set() 
            };
        });

        rows.forEach(row => {
            const sec = parseInt(row.billsec) || 0;
            const callClass = classifyCdr(row);
            const srcExt = row.src || getExtensionFromChannel(row.channel);
            const dstExt = row.dst || getExtensionFromChannel(row.dstchannel);

            if (srcExt && employeeMetrics[srcExt]) {
                employeeMetrics[srcExt].totalCalls++;
                if (dstExt) employeeMetrics[srcExt].uniqueNumbers.add(dstExt);
                if (callClass.direction === 'OUTBOUND') {
                    employeeMetrics[srcExt].outboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[srcExt].outboundTalkSec += sec;
                } else if (callClass.direction === 'INBOUND') {
                    employeeMetrics[srcExt].inboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[srcExt].inboundTalkSec += sec;
                } else {
                    employeeMetrics[srcExt].outboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[srcExt].outboundTalkSec += sec;
                }
            }
            if (dstExt && employeeMetrics[dstExt] && dstExt !== srcExt) {
                employeeMetrics[dstExt].totalCalls++;
                if (srcExt) employeeMetrics[dstExt].uniqueNumbers.add(srcExt);
                if (callClass.direction === 'INBOUND') {
                    employeeMetrics[dstExt].inboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[dstExt].inboundTalkSec += sec;
                } else if (callClass.direction === 'OUTBOUND') {
                    employeeMetrics[dstExt].outboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[dstExt].outboundTalkSec += sec;
                } else {
                    employeeMetrics[dstExt].inboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[dstExt].inboundTalkSec += sec;
                }
            }
        });

        const list = Object.values(employeeMetrics).map(emp => {
            emp.totalTalkSec = emp.inboundTalkSec + emp.outboundTalkSec;
            emp.uniqueContactCount = emp.uniqueNumbers.size;
            delete emp.uniqueNumbers;
            return emp;
        });

        res.json(list);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- ROUTE: EXTENSION STATISTICS VIEW ---
app.get('/ext-stats', (req, res) => {
    try {
        res.render('ext-stats', { moment });
    } catch (error) { res.status(500).send("Extension Stats Error: " + error.message); }
});

// --- API: EXTENSION STATISTICS DATA ---
app.get('/api/ext-stats/:extension', async (req, res) => {
    try {
        const { extension } = req.params;
        const scopedExt = getUserScopedExtension(req);
        if (scopedExt && extension !== scopedExt) {
            return res.status(403).json({ success: false, error: 'Forbidden: You can only view statistics for your assigned extension.' });
        }
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const direction = req.query.direction || 'all';

        const [rows] = await pool.query(
             `SELECT c.calldate, c.src, c.dst, c.duration, c.billsec, ${CDR_DISPOSITION_SQL} as disposition, c.channel, c.dstchannel, c.uniqueid, c.cnum
              FROM ${tables.cdr} c
              WHERE c.calldate BETWEEN ? AND ?
             AND (c.src = ? OR c.dst = ? OR c.cnum = ? OR c.channel REGEXP CONCAT('^[A-Za-z0-9_]+/', ?, '([^0-9]|$)') OR c.dstchannel REGEXP CONCAT('^[A-Za-z0-9_]+/', ?, '([^0-9]|$)'))
             ORDER BY c.calldate DESC`,
            [startDate, endDate, extension, extension, extension, extension, extension]
        );

        const stats = {
            extension,
            totalCalls: 0, answeredCalls: 0,
            inboundCalls: 0, outboundCalls: 0,
            inboundTalkSec: 0, outboundTalkSec: 0,
            totalTalkSec: 0, avgTalkSec: 0,
            uniqueContacts: new Set(),
            dispositionCounts: {},
            dailyBreakdown: {},
            hourlyBreakdown: {},
            durationCounts: { short: 0, medium: 0, long: 0 }
        };

        rows.forEach(row => {
            const sec = parseInt(row.billsec) || 0;
            const callClass = classifyCdr(row);
            const isSrc = row.src === extension || row.cnum === extension || getExtensionFromChannel(row.channel) === extension;
            const isDst = row.dst === extension || getExtensionFromChannel(row.dstchannel) === extension;

            if (!isSrc && !isDst) return;
            let callDirection = 'internal';
            if (callClass.direction === 'OUTBOUND') callDirection = isSrc ? 'outbound' : 'inbound';
            else if (callClass.direction === 'INBOUND') callDirection = isDst ? 'inbound' : 'outbound';
            else callDirection = 'internal';

            if (direction === 'inbound' && callDirection !== 'inbound') return;
            if (direction === 'outbound' && callDirection !== 'outbound') return;
            if (direction === 'internal' && callDirection !== 'internal') return;
            stats.totalCalls++;
            if (row.disposition === 'ANSWERED') stats.answeredCalls++;

            if (callDirection === 'outbound') {
                stats.outboundCalls++;
                if (row.disposition === 'ANSWERED') stats.outboundTalkSec += sec;
                stats.uniqueContacts.add(row.dst);
            } else if (callDirection === 'inbound') {
                stats.inboundCalls++;
                if (row.disposition === 'ANSWERED') stats.inboundTalkSec += sec;
                stats.uniqueContacts.add(row.src);
            } else {
                stats.uniqueContacts.add(row.dst);
                stats.uniqueContacts.add(row.src);
            }

            const disp = row.disposition || 'UNKNOWN';
            stats.dispositionCounts[disp] = (stats.dispositionCounts[disp] || 0) + 1;

            const day = moment(row.calldate).format('YYYY-MM-DD');
            if (!stats.dailyBreakdown[day]) {
                stats.dailyBreakdown[day] = { total: 0, answered: 0, inbound: 0, outbound: 0 };
            }
            stats.dailyBreakdown[day].total++;
            if (row.disposition === 'ANSWERED') stats.dailyBreakdown[day].answered++;
            if (callDirection === 'inbound') stats.dailyBreakdown[day].inbound++;
            if (callDirection === 'outbound') stats.dailyBreakdown[day].outbound++;

            const hour = moment(row.calldate).format('HH');
            stats.hourlyBreakdown[hour] = (stats.hourlyBreakdown[hour] || 0) + 1;

            if (row.disposition === 'ANSWERED') {
                if (sec < 30) stats.durationCounts.short++;
                else if (sec <= 180) stats.durationCounts.medium++;
                else stats.durationCounts.long++;
            }
        });

        stats.totalTalkSec = stats.inboundTalkSec + stats.outboundTalkSec;
        stats.avgTalkSec = stats.answeredCalls ? Math.round(stats.totalTalkSec / stats.answeredCalls) : 0;
        stats.uniqueContactCount = stats.uniqueContacts.size;
        stats.uniqueContacts = [...stats.uniqueContacts];
        stats.dispositionData = Object.entries(stats.dispositionCounts).map(([name, value]) => ({ name, value }));
        stats.dailyData = Object.entries(stats.dailyBreakdown)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, data]) => ({ date, ...data }));

        stats.hourlyData = Array.from({ length: 24 }, (_, i) => {
            const h = String(i).padStart(2, '0');
            return { hour: `${h}:00`, count: stats.hourlyBreakdown[h] || 0 };
        });

        stats.durationData = [
            { name: 'Short (<30s)', value: stats.durationCounts.short },
            { name: 'Medium (30s-3m)', value: stats.durationCounts.medium },
            { name: 'Long (>3m)', value: stats.durationCounts.long }
        ];

        stats.recentCalls = [];
        for (const row of rows) {
            const sec = parseInt(row.billsec) || 0;
            const callClass = classifyCdr(row);
            const isSrc = row.src === extension || row.cnum === extension || getExtensionFromChannel(row.channel) === extension;
            const isDst = row.dst === extension || getExtensionFromChannel(row.dstchannel) === extension;
            if (!isSrc && !isDst) continue;
            let callDirection = 'internal';
            if (callClass.direction === 'OUTBOUND') callDirection = isSrc ? 'outbound' : 'inbound';
            else if (callClass.direction === 'INBOUND') callDirection = isDst ? 'inbound' : 'outbound';
            else callDirection = 'internal';
            if (direction === 'inbound' && callDirection !== 'inbound') continue;
            if (direction === 'outbound' && callDirection !== 'outbound') continue;
            if (direction === 'internal' && callDirection !== 'internal') continue;
            stats.recentCalls.push({
                calldate: row.calldate,
                src: row.src, dst: row.dst,
                billsec: sec, disposition: row.disposition
            });
            if (stats.recentCalls.length >= 50) break;
        }

        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Hangup endpoint to end call on a specific extension
app.post('/api/hangup/:extension', requireAuth, requireActionPermission('operator-hangup'), async (req, res) => {
    try {
        const { extension } = req.params;
        const { executeCallHangup } = require('./lib/call-control');
        await executeCallHangup(amiClient, ASTERISK_BIN, activeCalls, extension);
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// POST /api/spy - Originate call spy session (Listen, Whisper, Barge) to supervisor extension
async function resolveDeviceChannel(ext) {
    try {
        const [rows] = await pool.query('SELECT dial, tech FROM `asterisk`.`devices` WHERE id = ?', [ext]);
        if (rows.length && rows[0].dial) return rows[0].dial;
    } catch (e) { /* fall back to PJSIP/ */ }
    return `PJSIP/${ext}`;
}

// Helper functions for dongle.conf gain management (Modem Conf)
function parseDongleConfGain() {
    const confPath = '/etc/asterisk/dongle.conf';
    if (!fs.existsSync(confPath)) {
        return { defaults: { rxgain: '0', txgain: '0' }, dongles: {} };
    }
    const content = fs.readFileSync(confPath, 'utf8');
    const lines = content.split(/\r?\n/);
    let currentSection = null;
    const sections = {};

    for (let line of lines) {
        let trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
        const secMatch = trimmed.match(/^\[([^\]]+)\]/);
        if (secMatch) {
            currentSection = secMatch[1].trim();
            if (!sections[currentSection]) sections[currentSection] = {};
            continue;
        }
        if (currentSection && trimmed.includes('=')) {
            const parts = trimmed.split('=');
            const key = parts[0].trim().toLowerCase();
            let val = parts.slice(1).join('=').trim();
            if (val.includes(';')) val = val.split(';')[0].trim();
            sections[currentSection][key] = val;
        }
    }

    const defaults = {
        rxgain: parseInt(sections['defaults']?.rxgain || '0', 10) || 0,
        txgain: parseInt(sections['defaults']?.txgain || '0', 10) || 0
    };

    const dongles = {};
    for (const sec in sections) {
        if (sec.startsWith('dongle') || (sec !== 'general' && sec !== 'defaults')) {
            dongles[sec] = {
                id: sec,
                rxgain: Math.max(-10, Math.min(10, parseInt(sections[sec].rxgain ?? defaults.rxgain, 10) || 0)),
                txgain: Math.max(-10, Math.min(10, parseInt(sections[sec].txgain ?? defaults.txgain, 10) || 0)),
                audio: sections[sec].audio || '',
                data: sections[sec].data || '',
                imei: sections[sec].imei || '',
                imsi: sections[sec].imsi || ''
            };
        }
    }

    return { defaults, dongles };
}

function updateDongleGainsInConf(gainMap, isResetAll = false) {
    const confPath = '/etc/asterisk/dongle.conf';
    if (!fs.existsSync(confPath)) {
        throw new Error('/etc/asterisk/dongle.conf file not found');
    }

    let content = fs.readFileSync(confPath, 'utf8');
    let lines = content.split(/\r?\n/);
    let sectionHeaderLineIdx = {};

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        let secMatch = line.match(/^\[([^\]]+)\]/);
        if (secMatch) {
            sectionHeaderLineIdx[secMatch[1].trim()] = i;
        }
    }

    const { dongles } = parseDongleConfGain();
    const targetDongles = isResetAll ? Object.keys(dongles) : Object.keys(gainMap);

    for (const dongleId of targetDongles) {
        const rxVal = isResetAll ? 0 : Math.max(-10, Math.min(10, parseInt(gainMap[dongleId]?.rxgain, 10) || 0));
        const txVal = isResetAll ? 0 : Math.max(-10, Math.min(10, parseInt(gainMap[dongleId]?.txgain, 10) || 0));

        if (sectionHeaderLineIdx.hasOwnProperty(dongleId)) {
            const headerIdx = sectionHeaderLineIdx[dongleId];
            let endIdx = lines.length;
            for (let j = headerIdx + 1; j < lines.length; j++) {
                if (lines[j].trim().match(/^\[([^\]]+)\]/)) {
                    endIdx = j;
                    break;
                }
            }

            let rxFound = false;
            let txFound = false;
            for (let j = headerIdx + 1; j < endIdx; j++) {
                let lineTrim = lines[j].trim();
                if (lineTrim.startsWith('rxgain=')) {
                    lines[j] = `rxgain=${rxVal}`;
                    rxFound = true;
                } else if (lineTrim.startsWith('txgain=')) {
                    lines[j] = `txgain=${txVal}`;
                    txFound = true;
                }
            }
            if (!rxFound) {
                lines.splice(headerIdx + 1, 0, `rxgain=${rxVal}`);
                for (let k in sectionHeaderLineIdx) {
                    if (sectionHeaderLineIdx[k] > headerIdx) sectionHeaderLineIdx[k]++;
                }
            }
            if (!txFound) {
                lines.splice(headerIdx + 1, 0, `txgain=${txVal}`);
                for (let k in sectionHeaderLineIdx) {
                    if (sectionHeaderLineIdx[k] > headerIdx) sectionHeaderLineIdx[k]++;
                }
            }
        }
    }

    if (isResetAll && sectionHeaderLineIdx.hasOwnProperty('defaults')) {
        const headerIdx = sectionHeaderLineIdx['defaults'];
        let endIdx = lines.length;
        for (let j = headerIdx + 1; j < lines.length; j++) {
            if (lines[j].trim().match(/^\[([^\]]+)\]/)) {
                endIdx = j;
                break;
            }
        }
        let rxFound = false;
        let txFound = false;
        for (let j = headerIdx + 1; j < endIdx; j++) {
            let lineTrim = lines[j].trim();
            if (lineTrim.startsWith('rxgain=')) { lines[j] = `rxgain=0`; rxFound = true; }
            if (lineTrim.startsWith('txgain=')) { lines[j] = `txgain=0`; txFound = true; }
        }
        if (!rxFound) lines.splice(headerIdx + 1, 0, `rxgain=0`);
        if (!txFound) lines.splice(headerIdx + 1, 0, `txgain=0`);
    }

    fs.writeFileSync(confPath, lines.join('\n'), 'utf8');
}

function addDongleSlotToConf(dongleData) {
    const confPath = '/etc/asterisk/dongle.conf';
    if (!fs.existsSync(confPath)) {
        throw new Error('/etc/asterisk/dongle.conf file not found');
    }

    const { dongles } = parseDongleConfGain();
    const dName = String(dongleData.dongleName || '').trim().toLowerCase();
    if (!dName || !/^[a-zA-Z0-9_-]+$/.test(dName)) {
        throw new Error('Invalid dongle slot name.');
    }
    if (dongles[dName]) {
        throw new Error(`Dongle slot '${dName}' already exists in dongle.conf.`);
    }

    let content = fs.readFileSync(confPath, 'utf8');

    const audioPort = String(dongleData.audio || '/dev/ttyUSB1').trim();
    const dataPort = String(dongleData.data || '/dev/ttyUSB2').trim();
    const imei = String(dongleData.imei || '').trim();
    const imsi = String(dongleData.imsi || '').trim();
    // Default gain is 3 dB for new slots unless explicitly provided
    const DEFAULT_DONGLE_GAIN = 3;
    const rxRaw = parseInt(dongleData.rxgain, 10);
    const txRaw = parseInt(dongleData.txgain, 10);
    const rx = Math.max(-10, Math.min(10, Number.isFinite(rxRaw) ? rxRaw : DEFAULT_DONGLE_GAIN));
    const tx = Math.max(-10, Math.min(10, Number.isFinite(txRaw) ? txRaw : DEFAULT_DONGLE_GAIN));

    const newSection = `\n[${dName}]\ntxgain=${tx}\nrxgain=${rx}\naudio=${audioPort}\ndata=${dataPort}\nimei=${imei}\nimsi=${imsi}\n`;
    content = content.trimEnd() + '\n' + newSection;

    fs.writeFileSync(confPath, content, 'utf8');
}

function removeDongleSlotFromConf(dongleName) {
    const confPath = '/etc/asterisk/dongle.conf';
    if (!fs.existsSync(confPath)) {
        throw new Error('/etc/asterisk/dongle.conf file not found');
    }

    const dName = String(dongleName || '').trim().toLowerCase();
    if (!dName) throw new Error('Dongle name is required.');

    let content = fs.readFileSync(confPath, 'utf8');
    let lines = content.split(/\r?\n/);
    let newLines = [];
    let skipping = false;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        let secMatch = line.trim().match(/^\[([^\]]+)\]/);
        if (secMatch) {
            const secName = secMatch[1].trim().toLowerCase();
            if (secName === dName) {
                skipping = true;
                continue;
            } else {
                skipping = false;
            }
        }
        if (!skipping) {
            newLines.push(line);
        }
    }

    fs.writeFileSync(confPath, newLines.join('\n'), 'utf8');
}
const SOKRAT_MANAGED_CONTEXTS = ['from-dongle-custom', 'macro-dialout-trunk-predial-hook', 'macro-dialout-one-predial-hook'];

function getDialplanJitterBufferStatus() {
    const filePath = '/etc/asterisk/extensions_custom.conf';
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    let currentContext = null;
    const foundContexts = new Set();

    for (let line of lines) {
        let trimmed = line.trim();
        let ctxMatch = trimmed.match(/^\[([^\]]+)\]/);
        if (ctxMatch) {
            currentContext = ctxMatch[1].trim();
        } else if (currentContext && SOKRAT_MANAGED_CONTEXTS.includes(currentContext)) {
            if (!trimmed.startsWith(';') && !trimmed.startsWith('#') && trimmed.includes('JITTERBUFFER(adaptive)=default')) {
                foundContexts.add(currentContext);
            }
        }
    }
    return SOKRAT_MANAGED_CONTEXTS.every(ctx => foundContexts.has(ctx));
}

function setDialplanJitterBufferStatus(enable) {
    const filePath = '/etc/asterisk/extensions_custom.conf';
    if (!fs.existsSync(filePath)) {
        throw new Error('/etc/asterisk/extensions_custom.conf file not found');
    }

    let content = fs.readFileSync(filePath, 'utf8');
    let lines = content.split(/\r?\n/);

    if (!enable) {
        let currentContext = null;
        let newLines = [];
        for (let line of lines) {
            let trimmed = line.trim();
            let ctxMatch = trimmed.match(/^\[([^\]]+)\]/);
            if (ctxMatch) {
                currentContext = ctxMatch[1].trim();
            }
            if (currentContext && SOKRAT_MANAGED_CONTEXTS.includes(currentContext) && trimmed.includes('JITTERBUFFER(adaptive)=default')) {
                continue;
            }
            newLines.push(line);
        }
        fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
    } else {
        let currentContext = null;
        let contextHasJb = { 'from-dongle-custom': false, 'macro-dialout-trunk-predial-hook': false, 'macro-dialout-one-predial-hook': false };

        for (let line of lines) {
            let trimmed = line.trim();
            let ctxMatch = trimmed.match(/^\[([^\]]+)\]/);
            if (ctxMatch) {
                currentContext = ctxMatch[1].trim();
            } else if (currentContext && SOKRAT_MANAGED_CONTEXTS.includes(currentContext)) {
                if (!trimmed.startsWith(';') && !trimmed.startsWith('#') && trimmed.includes('JITTERBUFFER(adaptive)=default')) {
                    contextHasJb[currentContext] = true;
                }
            }
        }

        let updatedLines = [];
        currentContext = null;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            updatedLines.push(line);
            let trimmed = line.trim();
            let ctxMatch = trimmed.match(/^\[([^\]]+)\]/);
            if (ctxMatch) {
                currentContext = ctxMatch[1].trim();
            }

            if (currentContext === 'from-dongle-custom' && !contextHasJb['from-dongle-custom']) {
                if (trimmed.includes('same => n(process),NoOp')) {
                    updatedLines.push(SOKRAT_JB_LINE);
                    contextHasJb['from-dongle-custom'] = true;
                }
            } else if (currentContext === 'macro-dialout-trunk-predial-hook' && !contextHasJb['macro-dialout-trunk-predial-hook']) {
                if (trimmed.includes('exten => s,1,NoOp')) {
                    updatedLines.push(SOKRAT_JB_LINE);
                    contextHasJb['macro-dialout-trunk-predial-hook'] = true;
                }
            } else if (currentContext === 'macro-dialout-one-predial-hook' && !contextHasJb['macro-dialout-one-predial-hook']) {
                if (trimmed.includes('exten => s,1,NoOp')) {
                    updatedLines.push(SOKRAT_JB_LINE);
                    contextHasJb['macro-dialout-one-predial-hook'] = true;
                }
            }
        }

        if (!content.includes('[macro-dialout-one-predial-hook]')) {
            updatedLines.push('');
            updatedLines.push('[macro-dialout-one-predial-hook]');
            updatedLines.push('exten => s,1,NoOp(--- Dynamic Adaptive Jitter Buffer for Internal/Extension Call ---)');
            updatedLines.push(SOKRAT_JB_LINE);
            updatedLines.push('same => n,MacroExit()');
        }

        fs.writeFileSync(filePath, updatedLines.join('\n'), 'utf8');
    }
}
const SOKRAT_DENOISE_RX_LINE = 'same => n,Set(DENOISE(rx)=on)';
const SOKRAT_DENOISE_TX_LINE = 'same => n,Set(DENOISE(tx)=on)';
const SOKRAT_DENOISE_CONTEXTS = ['from-dongle-custom', 'macro-dialout-trunk-predial-hook'];

function getDialplanDenoiseStatus() {
    const filePath = '/etc/asterisk/extensions_custom.conf';
    if (!fs.existsSync(filePath)) return { rx: false, tx: false };
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    let currentContext = null;
    let rxFound = false;
    let txFound = false;

    for (let line of lines) {
        let trimmed = line.trim();
        let ctxMatch = trimmed.match(/^\[([^\]]+)\]/);
        if (ctxMatch) {
            currentContext = ctxMatch[1].trim();
        } else if (currentContext && SOKRAT_DENOISE_CONTEXTS.includes(currentContext)) {
            if (!trimmed.startsWith(';') && !trimmed.startsWith('#')) {
                if (trimmed.includes('DENOISE(rx)=on')) rxFound = true;
                if (trimmed.includes('DENOISE(tx)=on')) txFound = true;
            }
        }
    }
    return { rx: rxFound, tx: txFound };
}

function setDialplanDenoiseStatus({ rx, tx }) {
    const filePath = '/etc/asterisk/extensions_custom.conf';
    if (!fs.existsSync(filePath)) {
        throw new Error('/etc/asterisk/extensions_custom.conf file not found');
    }

    let content = fs.readFileSync(filePath, 'utf8');
    let lines = content.split(/\r?\n/);

    const rxState = Boolean(rx);
    const txState = Boolean(tx);

    let currentContext = null;
    let newLines = [];

    for (let line of lines) {
        let trimmed = line.trim();
        let ctxMatch = trimmed.match(/^\[([^\]]+)\]/);
        if (ctxMatch) {
            currentContext = ctxMatch[1].trim();
            newLines.push(line);
            continue;
        }

        if (currentContext && SOKRAT_DENOISE_CONTEXTS.includes(currentContext)) {
            if (trimmed.includes('DENOISE(rx)=on') || trimmed.includes('DENOISE(tx)=on')) {
                continue;
            }
        }
        newLines.push(line);
    }

    if (rxState || txState) {
        let finalLines = [];
        let inTargetCtx = false;

        for (let i = 0; i < newLines.length; i++) {
            let line = newLines[i];
            let trimmed = line.trim();
            let ctxMatch = trimmed.match(/^\[([^\]]+)\]/);

            if (ctxMatch) {
                inTargetCtx = SOKRAT_DENOISE_CONTEXTS.includes(ctxMatch[1].trim());
            }

            finalLines.push(line);

            if (inTargetCtx && (trimmed.startsWith('exten =>') || trimmed.startsWith('same =>'))) {
                if (rxState) finalLines.push(`same => n,Set(DENOISE(rx)=on)`);
                if (txState) finalLines.push(`same => n,Set(DENOISE(tx)=on)`);
                inTargetCtx = false;
            }
        }
        newLines = finalLines;
    }

    fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
}

app.post('/api/spy', requireAuth, (req, res, next) => {
    const mode = String(req.body.mode || 'listen').toLowerCase();
    const perm = `operator-${mode}`;
    requireActionPermission(perm)(req, res, next);
}, async (req, res) => {
    try {
        const { targetExtension, supervisorExtension, mode } = req.body;
        const { executeCallSpy } = require('./lib/call-control');
        await executeCallSpy(pool, amiClient, ASTERISK_BIN, {
            supervisorExt: supervisorExtension,
            targetExt: targetExtension,
            mode: mode || 'listen'
        });
        res.json({ success: true, message: `Calling supervisor extension ${supervisorExtension} for ${mode || 'listen'} mode on ${targetExtension}.` });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/hijack', requireAuth, requireActionPermission('operator-hijack'), async (req, res) => {
    try {
        const { targetExtension, supervisorExtension } = req.body;
        const target = String(targetExtension || '').trim();
        const supervisor = String(supervisorExtension || '').trim();

        if (!target || !supervisor) {
            return res.status(400).json({ success: false, error: 'Target and Supervisor extensions are required.' });
        }

        const call = activeCalls[target];
        if (!call || !call.channel) {
            return res.status(404).json({ success: false, error: `No active call found for extension ${target}` });
        }

        const { executeCallHijack } = require('./lib/call-control');
        await executeCallHijack(pool, amiClient, ASTERISK_BIN, {
            supervisorExt: supervisor,
            targetExt: target,
            activeCallsObj: activeCalls
        });
        res.json({ success: true, message: `Hijacking call on extension ${target} to supervisor ${supervisor}.` });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// POST /api/intercom/call - Originate instant intercom meeting call to selected available extensions
app.post('/api/intercom/call', requireAuth, async (req, res) => {
    try {
        const { callerExtension, targetExtensions } = req.body;
        const caller = String(callerExtension || '').trim();
        const rawTargets = Array.isArray(targetExtensions) ? targetExtensions : [];

        if (!caller || !/^\d{2,5}$/.test(caller)) {
            return res.status(400).json({ success: false, error: 'Valid caller extension is required.' });
        }
        if (rawTargets.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one target extension must be selected.' });
        }

        // Filter targets: must be online, NOT in active call, NOT ringing
        const validTargets = [];
        for (const tExt of rawTargets) {
            const extStr = String(tExt || '').trim();
            if (!/^\d{2,5}$/.test(extStr)) continue;
            if (extStr === caller) continue;

            const isOnline = Boolean(peerStatus[extStr]);
            const liveCall = activeCalls[extStr];
            const isBusy = liveCall && (liveCall.state === 'In Call' || liveCall.state === 'Ringing');

            if (isOnline && !isBusy) {
                validTargets.push(extStr);
            }
        }

        if (validTargets.length === 0) {
            return res.status(400).json({ success: false, error: 'No available target extensions selected (must be online and not in call/ringing).' });
        }

        // Generate dynamic 8-digit numeric room ID (matches _X. in from-intercom-conf)
        const roomId = '88' + String(Date.now()).slice(-6);

        // Originate Host Caller to join conference room
        const hostChan = `Local/${caller}@from-intercom-autoanswer`;
        if (amiClient) {
            amiClient.write(`Action: Originate\r\nChannel: ${hostChan}\r\nContext: from-intercom-conf\r\nExten: ${roomId}\r\nPriority: 1\r\nVariable: INTERCOM_CALLER=${caller}\r\nCallerID: "Intercom Host" <${caller}>\r\nAsync: true\r\n\r\n`);
        } else {
            exec(`${ASTERISK_BIN} -rx "channel originate ${hostChan} extension ${roomId}@from-intercom-conf"`, () => {});
        }

        // Originate each target extension to join conference room
        const originatedList = [];
        for (const targetExt of validTargets) {
            const targetChan = `Local/${targetExt}@from-intercom-autoanswer`;
            if (amiClient) {
                amiClient.write(`Action: Originate\r\nChannel: ${targetChan}\r\nContext: from-intercom-conf\r\nExten: ${roomId}\r\nPriority: 1\r\nVariable: INTERCOM_CALLER=${caller}\r\nCallerID: "Intercom ${caller}" <${caller}>\r\nAsync: true\r\n\r\n`);
            } else {
                exec(`${ASTERISK_BIN} -rx "channel originate ${targetChan} extension ${roomId}@from-intercom-conf"`, () => {});
            }
            originatedList.push(targetExt);
        }

        res.json({
            success: true,
            roomId: roomId,
            caller: caller,
            invitedCount: originatedList.length,
            targets: originatedList,
            message: `Intercom meeting started in room ${roomId} with ${originatedList.length} extension(s).`
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- ROUTE 3: DEDICATED LIVE OPERATOR PANEL VIEW ---
app.get('/operator', (req, res) => {
    try {
        res.render('operator', { moment });
    } catch (error) { res.status(500).send("Operator Panel Engine Error: " + error.message); }
});
app.get('/softphone', requireAuth, (req, res) => {
    try {
        const currentLang = res.locals.currentLang || 'en';
        res.render('softphone', {
            currentPage: '/softphone',
            currentLang,
            isSuperAdmin: isSuperAdmin(req)
        });
    } catch (error) {
        res.status(500).send("Softphone Engine Error: " + error.message);
    }
});

// --- GSM DONGLES MONITOR & USSD ROUTING ENGINE ---
let latestUssdResponses = {}; // dongle_id -> { text, timestamp, logTime }
let latestAtResponses = {};  // dongle_id -> { text, timestamp }
const atResponsePattern = /\[([^\]]+)\] VERBOSE\[\d+\] at_response\.c:\s+\[([^\]]+)\] Got Response for user's command:'(.*)/s;

// Persistent IMSI-to-Phone number mapping database on disk
const MAPPINGS_FILE = '/opt/issabel-dashboard/sim_mappings.json';

function readSimMappings() {
    const fs = require('fs');
    try {
        if (fs.existsSync(MAPPINGS_FILE)) {
            return JSON.parse(fs.readFileSync(MAPPINGS_FILE, 'utf8'));
        }
    } catch (err) {
        console.error("GSM MONITOR: Error reading sim mappings:", err);
    }
    // Default seed mapping
    return {
        '602019513016594': '+201027826232'
    };
}

function saveSimMappings(mappings) {
    const fs = require('fs');
    try {
        fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(mappings, null, 4), 'utf8');
        console.log("GSM MONITOR: Saved SIM mappings to", MAPPINGS_FILE);
    } catch (err) {
        console.error("GSM MONITOR: Error saving sim mappings:", err);
    }
}

// Helper to read all configured numbers from /etc/asterisk/dongle.conf
function getConfiguredDongleNumbers() {
    const fs = require('fs');
    const filePath = '/etc/asterisk/dongle.conf';
    const numbers = {};
    if (!fs.existsSync(filePath)) return numbers;
    
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        let currentDongle = null;
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(';')) continue;
            
            const sectionMatch = trimmed.match(/^\[(dongle\d+)\]$/i);
            if (sectionMatch) {
                currentDongle = sectionMatch[1].toLowerCase();
                continue;
            }
            
            if (currentDongle && (trimmed.toLowerCase().startsWith('number=') || trimmed.toLowerCase().startsWith('exten='))) {
                const parts = trimmed.split('=');
                if (parts.length >= 2) {
                    const num = parts.slice(1).join('=').split(';')[0].trim();
                    if (num) {
                        numbers[currentDongle] = num;
                    }
                }
            }
        }
    } catch (err) {
        console.error("GSM MONITOR: Error reading config for numbers:", err);
    }
    return numbers;
}

// Cache IMEI-linked custom trunks and their outbound routes alongside the one-second device cache.
const DONGLE_ROUTING_CACHE_TTL = 1000;
let cachedDongleRoutingRows = [];
let lastDongleRoutingFetch = 0;
let dongleRoutingFetchPromise = null;

function getDongleRoutingRowsCached() {
    const now = Date.now();
    if (lastDongleRoutingFetch && (now - lastDongleRoutingFetch) < DONGLE_ROUTING_CACHE_TTL) {
        return Promise.resolve(cachedDongleRoutingRows);
    }
    if (dongleRoutingFetchPromise) return dongleRoutingFetchPromise;

    dongleRoutingFetchPromise = pool.query(`
        SELECT
            t.trunkid,
            t.name AS trunk_name,
            t.channelid,
            t.disabled,
            rt.seq AS route_sequence,
            r.route_id,
            r.name AS route_name
        FROM \`asterisk\`.\`trunks\` t
        LEFT JOIN \`asterisk\`.\`outbound_route_trunks\` rt ON rt.trunk_id = t.trunkid
        LEFT JOIN \`asterisk\`.\`outbound_routes\` r ON r.route_id = rt.route_id
        WHERE LOWER(TRIM(t.tech)) = 'custom'
        ORDER BY t.trunkid ASC, rt.seq ASC, r.route_id ASC
    `)
        .then(([rows]) => {
            cachedDongleRoutingRows = rows;
            lastDongleRoutingFetch = Date.now();
            return rows;
        })
        .finally(() => {
            dongleRoutingFetchPromise = null;
        });

    return dongleRoutingFetchPromise;
}

async function enrichDongleRouting(devices) {
    const routableDevices = [];
    const trunkMaps = new Map();

    for (const device of devices) {
        device.customTrunks = [];
        const imei = String(device.IMEI || '').replace(/\s+/g, '');
        if (!/^\d{8,20}$/.test(imei)) continue;
        routableDevices.push({ device, imei });
        trunkMaps.set(device, new Map());
    }
    if (routableDevices.length === 0) return devices;

    try {
        const routingRows = await getDongleRoutingRowsCached();
        for (const row of routingRows) {
            const dialString = String(row.channelid || '');
            for (const { device, imei } of routableDevices) {
                if (!dialString.includes(imei)) continue;

                const deviceTrunks = trunkMaps.get(device);
                const trunkKey = String(row.trunkid);
                let trunk = deviceTrunks.get(trunkKey);
                if (!trunk) {
                    const disabledValue = String(row.disabled || '').toLowerCase();
                    trunk = {
                        trunkId: row.trunkid,
                        name: row.trunk_name || `Trunk #${row.trunkid}`,
                        dialString,
                        disabled: disabledValue === 'on' || disabledValue === '1' || disabledValue === 'true',
                        routes: []
                    };
                    deviceTrunks.set(trunkKey, trunk);
                }

                if (row.route_id !== null && row.route_id !== undefined &&
                    !trunk.routes.some(route => String(route.routeId) === String(row.route_id))) {
                    trunk.routes.push({
                        routeId: row.route_id,
                        name: row.route_name || `Outbound Route #${row.route_id}`,
                        sequence: row.route_sequence
                    });
                }
            }
        }

        for (const { device } of routableDevices) {
            device.customTrunks = Array.from(trunkMaps.get(device).values());
        }
    } catch (error) {
        console.error('GSM MONITOR: Failed to load IMEI-linked trunk routes:', error);
    }

    return devices;
}

async function getDonglesForExtension(extension) {
    if (!extension) return null;
    try {
        const [patterns] = await pool.query(`
            SELECT p.route_id, p.match_cid
            FROM \`asterisk\`.\`outbound_route_patterns\` p
            JOIN \`asterisk\`.\`outbound_routes\` r ON r.route_id = p.route_id
            LEFT JOIN \`asterisk\`.\`outbound_route_sequence\` s ON s.route_id = r.route_id
            ORDER BY s.seq ASC, r.route_id ASC
        `);

        const specificRouteIds = patterns
            .filter(p => p.match_cid && String(p.match_cid).trim() === String(extension).trim())
            .map(p => p.route_id);

        let targetRouteIds = [];
        if (specificRouteIds.length > 0) {
            targetRouteIds = [...new Set(specificRouteIds)];
        } else {
            const genericRouteIds = patterns
                .filter(p => !p.match_cid || String(p.match_cid).trim() === '')
                .map(p => p.route_id);
            targetRouteIds = [...new Set(genericRouteIds)];
        }

        if (targetRouteIds.length === 0) {
            return [];
        }

        const [trunks] = await pool.query(`
            SELECT t.trunkid, t.name, t.channelid
            FROM \`asterisk\`.\`outbound_route_trunks\` rt
            JOIN \`asterisk\`.\`trunks\` t ON t.trunkid = rt.trunk_id
            WHERE rt.route_id IN (?)
            ORDER BY rt.seq ASC
        `, [targetRouteIds]);

        const allowedDongleIdentifiers = new Set();
        for (const t of trunks) {
            const str = `${t.channelid || ''} ${t.name || ''}`;
            const dongleNameMatches = str.match(/dongle\d+/gi) || [];
            dongleNameMatches.forEach(d => allowedDongleIdentifiers.add(d.toLowerCase()));
            const imeiMatches = str.match(/\b\d{14,16}\b/g) || [];
            imeiMatches.forEach(imei => allowedDongleIdentifiers.add(imei));
        }

        return Array.from(allowedDongleIdentifiers);
    } catch (err) {
        console.error('getDonglesForExtension error:', err.message);
        return [];
    }
}

function isDeviceAllowedForDongles(device, allowedDongleIdentifiers) {
    if (!allowedDongleIdentifiers) return true;
    if (!Array.isArray(allowedDongleIdentifiers) || allowedDongleIdentifiers.length === 0) return false;
    const devName = String(device.Device || '').toLowerCase().trim();
    const imei = String(device.IMEI || '').replace(/\s+/g, '');
    const imsi = String(device.IMSI || '').replace(/\s+/g, '');
    const num = String(device.Number || '').replace(/\s+/g, '');

    return allowedDongleIdentifiers.some(ident => {
        const id = String(ident).toLowerCase().trim();
        return id === devName || (imei && imei === id) || (imsi && imsi === id) || (num && num.includes(id));
    });
}

// Caching layer for 'dongle show devices' to prevent CLI command storms
let cachedDevicesOutput = null;
let lastDevicesOutputFetch = 0;
const DEVICES_CACHE_TTL = 1000;

function getDevicesOutputCached(callback) {
    const now = Date.now();
    if (cachedDevicesOutput && (now - lastDevicesOutputFetch) < DEVICES_CACHE_TTL) {
        return callback(null, cachedDevicesOutput);
    }
    execFile(ASTERISK_BIN, ['-rx', 'dongle show devices'], (error, stdout, stderr) => {
        if (error) return callback(error || new Error(stderr), null);
        cachedDevicesOutput = stdout;
        lastDevicesOutputFetch = now;
        callback(null, stdout);
    });
}

// Parse Asterisk 'dongle show devices' CLI output
function parseDevicesOutput(output, keepRaw = false, astDbMappings = {}) {
    const lines = output.trim().split('\n');
    if (lines.length === 0) return [];
    const header = lines[0];
    const colNames = ["ID", "Group", "State", "RSSI", "Mode", "Submode", "Provider Name", "Model", "Firmware", "IMEI", "IMSI", "Number"];
    const indices = colNames.map(name => header.indexOf(name));
    indices.push(header.length + 100);
    
    const devices = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || line.startsWith('-----') || line.includes('ID')) {
            continue;
        }
        const row = {};
        for (let j = 0; j < colNames.length; j++) {
            const start = indices[j];
            const end = indices[j+1];
            if (start !== -1 && start < line.length) {
                row[colNames[j]] = line.substring(start, Math.min(end, line.length)).trim();
            } else {
                row[colNames[j]] = '';
            }
        }
        if (row.ID && row.ID.startsWith("dongle")) {
            const dId = row.ID;
            const dImei = (row.IMEI || '').trim();
            const { execFile: execFileCb } = require('child_process');
            execFileCb(ASTERISK_BIN, ['-rx', `database put DONGLE_DEVICE_MAP ${dId} ${dId}`], () => {});
            if (dImei && dImei !== '-' && dImei !== 'Unknown') {
                execFileCb(ASTERISK_BIN, ['-rx', `database put DONGLE_DEVICE_MAP i:${dImei} ${dId}`], () => {});
                execFileCb(ASTERISK_BIN, ['-rx', `database put DONGLE_DEVICE_MAP ${dImei} ${dId}`], () => {});
            }

            // Fallback for transpositions where the firmware reports IMEI in the IMSI field
            if ((!row.IMEI || row.IMEI === '-' || row.IMEI === 'Unknown') && row.IMSI && (row.IMSI.startsWith('86') || row.IMSI.startsWith('35'))) {
                row.IMEI = row.IMSI;
            }
            const parsedState = (row.State || '').toLowerCase();
            if (parsedState.includes('not init')) row.State = 'Not Initialized';
            else if (parsedState.includes('not connec')) row.State = 'Not Connected';
            const st = (row.State || '').toLowerCase();
            const isNotConnected = st.includes('not connec') || st.includes('not_conn') || st.includes('not init') || st.includes('not reg') || st.includes('not respond');

            if (isNotConnected) {
                row.Number = 'Unknown';
            } else {
                const mapped = (row.IMSI && astDbMappings[row.IMSI]) || (row.IMEI && astDbMappings[row.IMEI]) || (row.ID && astDbMappings[row.ID]) || null;
                if (mapped) {
                    row.Number = mapped;
                } else if (!row.Number || row.Number === '-' || row.Number === 'None') {
                    row.Number = 'Unknown';
                }
            }
            devices.push(row);
        }
    }
    return devices;
}

// Local cache to throttle USSD phone number queries to avoid spamming the carrier networks
let lastUssdQueryTimes = {}; // IMSI -> timestamp (Date)

function extractPhoneNumber(text) {
    if (!text) return null;
    
    // Convert Arabic numerals to standard English digits
    const arabicDigits = [/٠/g, /١/g, /٢/g, /٣/g, /٤/g, /٥/g, /٦/g, /٧/g, /٨/g, /٩/g];
    let cleanText = String(text);
    for (let i = 0; i < 10; i++) {
        cleanText = cleanText.replace(arabicDigits[i], String(i));
    }
    
    // Strip spaces, dashes, brackets, colons, equal signs
    cleanText = cleanText.replace(/[\s\-\(\)\:\+\=]/g, '');
    
    // Look for 11 digits starting with 1xxxxxxxx or 01xxxxxxxx (which are standard Egyptian Mobile structures)
    const match = cleanText.match(/\b(?:20)?(1[0125]\d{8})\b/);
    if (match) {
        return '+20' + match[1];
    }
    
    // Fallback: search for any sequence of 10 or 11 digits
    const generalMatch = cleanText.match(/\b(1[0125]\d{8})\b/) || cleanText.match(/\b(01[0125]\d{8})\b/);
    if (generalMatch) {
        let numStr = generalMatch[1];
        if (numStr.startsWith('0')) numStr = numStr.substring(1);
        return '+20' + numStr;
    }
    
    return null;
}

// Read the hot-plug number mappings from Asterisk AstDB (sim_map, dongle_map, DONGLE_NUMBERS families) & MariaDB
function getAstDbNumbers(callback) {
    const mappings = {};
    function parseAstDbOutput(stdout, family) {
        if (!stdout) return;
        const lines = stdout.split('\n');
        lines.forEach(line => {
            const regex = new RegExp(`\\/${family}\\/([a-zA-Z0-9_]+)\\s*:\\s*(\\+?\\d+)`);
            const match = regex.exec(line);
            if (match) {
                mappings[match[1]] = match[2];
            }
        });
    }

    execFile(ASTERISK_BIN, ['-rx', 'database show sim_map'], (err1, out1) => {
        parseAstDbOutput(out1, 'sim_map');
        execFile(ASTERISK_BIN, ['-rx', 'database show dongle_map'], (err2, out2) => {
            parseAstDbOutput(out2, 'dongle_map');
            execFile(ASTERISK_BIN, ['-rx', 'database show DONGLE_NUMBERS'], (err3, out3) => {
                parseAstDbOutput(out3, 'DONGLE_NUMBERS');
                
                pool.query('SELECT dongle_name, imsi, imei, phone_number FROM `asterisk`.`gsm_dongles` WHERE phone_number IS NOT NULL AND phone_number != ""')
                    .then(([rows]) => {
                        rows.forEach(r => {
                            if (r.dongle_name && r.phone_number) mappings[r.dongle_name] = r.phone_number;
                            if (r.imsi && r.phone_number) mappings[r.imsi] = r.phone_number;
                            if (r.imei && r.phone_number) mappings[r.imei] = r.phone_number;
                        });
                        callback(mappings);
                    })
                    .catch(() => callback(mappings));
            });
        });
    });
}

// Start background tail log monitor on the Asterisk verbose log file
function startUssdLogMonitor() {
    console.log("GSM MONITOR: Starting tail process on /var/log/asterisk/full...");
    const tail = spawn('tail', ['-n', '0', '-F', '/var/log/asterisk/full']);
    
    let logBuffer = "";
    let flushTimeout = null;
    
    const responsePattern = /\[([^\]]+)\] VERBOSE\[\d+\] at_response\.c:\s+\[([^\]]+)\] Got USSD type \d+ '[^']*':\s*'(.*)/s; // Added /s flag to capture multi-line USSD response!
    const dongleLogPattern = /chan_dongle|at_response|app_ussd|dongle[0-9]+/i;

    function processLogStatement(statement) {
        if (!statement.trim()) return;
        
        // Log streaming
        if (dongleLogPattern.test(statement)) {
            io.emit('dongleLog', statement.trim());
        }
        
        // Parse SMS received log directly from chan_dongle at_response.c core to support multi-line and multi-part SMS reassembly
        if (statement.includes('Got full SMS from')) {
            const smsPattern = /\[([^\]]+)\] VERBOSE\[\d+\] at_response\.c:\s+\[([^\]]+)\] Got full SMS from ([^:]+):\s*'(.*)/s;
            const smsMatch = smsPattern.exec(statement);
            if (smsMatch) {
                const dongleId = smsMatch[2].trim();
                const sender = smsMatch[3].trim();
                let content = smsMatch[4].trim();
                // Trim trailing quote
                content = content.replace(/'\s*$/, '').trim();
                
                const newSms = {
                    id: Date.now() + '-' + Math.floor(Math.random() * 1000),
                    dongleId,
                    sender,
                    content,
                    timestamp: Date.now()
                };
                const inbox = readSmsInbox();
                inbox.unshift(newSms);
                if (inbox.length > 100) inbox.pop();
                saveSmsInbox(inbox);
                io.emit('newSms', newSms);
                console.log(`GSM MONITOR: Saved incoming SMS on ${dongleId} from ${sender} -> ${content}`);
            }
        }
        
        // Parse USSD response
        const match = responsePattern.exec(statement);
        if (match) {
            const logTime = match[1].trim();
            const dongleId = match[2].trim();
            let text = match[3].trim();
            // Trim trailing quote if it exists (Asterisk log format wrapper)
            text = text.replace(/'\s*$/, '').trim();
            console.log(`GSM MONITOR: Captured USSD response for ${dongleId} -> ${text}`);
            latestUssdResponses[dongleId] = {
                text: text,
                timestamp: Date.now(),
                logTime: logTime
            };
            io.emit('ussdResponse', { dongleId, text, logTime });
        }

        const atMatch = atResponsePattern.exec(statement);
        if (atMatch) {
            const dongleId = atMatch[2].trim();
            let text = atMatch[3].trim();
            text = text.replace(/'$/, '').trim();
            latestAtResponses[dongleId] = {
                text: text,
                timestamp: Date.now()
            };
        }
    }

    function flushLogBuffer() {
        if (!logBuffer.trim()) return;
        
        const lines = logBuffer.split('\n');
        logBuffer = "";
        
        let currentStatement = null;
        for (const line of lines) {
            const isNewStatement = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(line);
            if (isNewStatement) {
                if (currentStatement) {
                    processLogStatement(currentStatement);
                }
                currentStatement = line;
            } else {
                if (currentStatement) {
                    currentStatement += '\n' + line;
                } else {
                    currentStatement = line;
                }
            }
        }
        if (currentStatement) {
            processLogStatement(currentStatement);
        }
    }
    
    tail.stdout.on('data', (data) => {
        logBuffer += data.toString();
        if (flushTimeout) clearTimeout(flushTimeout);
        flushTimeout = setTimeout(flushLogBuffer, 50);
    });
    
    tail.stderr.on('data', (data) => {
        console.error(`GSM MONITOR: tail stderr: ${data}`);
    });
    
    tail.on('close', (code) => {
        console.log(`GSM MONITOR: tail process closed with code ${code}. Reconnecting in 5s...`);
        setTimeout(startUssdLogMonitor, 5000);
    });
}

// Import spawn from child_process
const { spawn } = require('child_process');
startUssdLogMonitor();

function normalizeMsisdn(raw) {
    let num = raw.replace(/[^0-9+]/g, '');
    if (num.startsWith('+')) return num;
    if (num.startsWith('00')) return '+' + num.slice(2);
    if (num.startsWith('01')) return '+20' + num.slice(1);
    return '+' + num;
}

function sendAtAndWait(dongleId, atCmd, timeoutMs, callback) {
    delete latestAtResponses[dongleId];
    execFile(ASTERISK_BIN, ['-rx', `dongle cmd ${dongleId} ${atCmd}`], (err) => {
        if (err) return callback({ error: err.message });
        const start = Date.now();
        function poll() {
            const resp = latestAtResponses[dongleId];
            if (resp) {
                delete latestAtResponses[dongleId];
                const text = resp.text || '';
                const isOk = /OK/i.test(text) || text.includes('+CPBW');
                return callback({ error: isOk ? null : ('AT response: ' + text), output: text });
            }
            if (Date.now() - start >= timeoutMs) return callback({ error: 'timeout', output: '' });
            setTimeout(poll, 400);
        }
        setTimeout(poll, 1500);
    });
}

// Endpoint to manually set/save a SIM's phone number mapping and program SIM card via AT commands
app.post('/api/gsm-dongles/save-number', async (req, res) => {
    try {
        const { imsi, number, dongleId } = req.body;
        if ((!imsi && !dongleId) || !number) {
            return res.status(400).json({ success: false, error: 'IMSI or Dongle ID and phone number are required.' });
        }

        const rawDongleId = String(dongleId || '').trim();
        const rawImsi = String(imsi || '').trim();
        const rawNum = String(number || '').trim();
        const dId = normalizeDongleMappingKey(rawDongleId);
        const dImsi = normalizeDongleIdentity(rawImsi);
        if (!rawNum) {
            return res.status(400).json({ success: false, error: 'Phone number is required.' });
        }
        if ((rawDongleId && !dId) || (rawImsi && !dImsi)) {
            return res.status(400).json({ success: false, error: 'Invalid dongle ID or IMSI.' });
        }

        const simMappings = readSimMappings();
        if (dImsi) simMappings[dImsi] = rawNum;
        saveSimMappings(simMappings);

        let imei = '';
        let foundImsi = dImsi;
        try {
            const devicesOutput = await execFileAsync(ASTERISK_BIN, ['-rx', 'dongle show devices']);
            if (devicesOutput) {
                const devices = parseDevicesOutput(devicesOutput, true);
                const dev = devices.find(d => (dId && d.ID.toLowerCase() === dId.toLowerCase()) || (dImsi && d.IMSI === dImsi));
                if (dev) {
                    imei = normalizeDongleIdentity(dev.IMEI);
                    foundImsi = normalizeDongleIdentity(dev.IMSI) || foundImsi;
                }
            }
        } catch (_) {}

        if (dId || foundImsi) {
            const mappingDongleName = dId || 'unknown';
            await pool.query(`
                INSERT INTO \`asterisk\`.\`gsm_dongles\` (dongle_name, imsi, imei, phone_number)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    imsi = COALESCE(NULLIF(VALUES(imsi), ''), imsi),
                    imei = COALESCE(NULLIF(VALUES(imei), ''), imei),
                    phone_number = VALUES(phone_number)
            `, [mappingDongleName, foundImsi || null, imei || null, rawNum]);

            const [savedRows] = await pool.query(
                'SELECT dongle_name, imsi, imei, phone_number FROM `asterisk`.`gsm_dongles` WHERE dongle_name = ?',
                [mappingDongleName]
            );
            const savedMapping = savedRows[0];
            if (savedMapping) {
                await syncDongleMappingAliases({
                    dongleName: savedMapping.dongle_name,
                    imsi: savedMapping.imsi,
                    imei: savedMapping.imei,
                    phoneNumber: savedMapping.phone_number
                });
            }
        }

        try {
            await detectDonglesAndSetTrunkCID();
        } catch (_) {}

        // Exact command sequence with verbatim raw number and 3s sleep between commands
        const targetDongle = dId || 'dongle0';
        const cmdSteps = [
            `dongle cmd ${targetDongle} AT+CPBS=\\"ON\\"`,
            `dongle cmd ${targetDongle} AT+CPBW=1,\\"${rawNum}\\",145`,
            `module unload chan_dongle.so`,
            `module load chan_dongle.so`
        ];

        const results = [];
        let allSuccess = true;
        for (let i = 0; i < cmdSteps.length; i++) {
            const stepCmd = cmdSteps[i];
            try {
                const out = await execFileAsync(ASTERISK_BIN, ['-rx', stepCmd]);
                results.push({ step: stepCmd, success: true, output: (out || '').trim() });
            } catch (err) {
                allSuccess = false;
                results.push({ step: stepCmd, success: false, error: err ? err.message : 'Command failed' });
            }
            if (i < cmdSteps.length - 1) {
                await new Promise(r => setTimeout(r, 3000));
            }
        }

        const dpCheck = await execFileAsync(ASTERISK_BIN, ['-rx', `dialplan show ${rawNum}@from-trunk`]);
        const routeExists = dpCheck && dpCheck.includes(rawNum);

        cachedDevicesOutput = null;
        io.emit('dongleNumberUpdated', { dongleId: dId, imsi: foundImsi, number: rawNum });
        io.emit('usbDevicesUpdated');

        return res.json({
            success: true,
            dbSaved: true,
            atSuccess: allSuccess,
            results: results,
            routeExists: !!routeExists,
            message: routeExists
                ? 'SIM phone number saved successfully.'
                : 'SIM phone number saved, but no Inbound Route for ' + rawNum + ' was found in Asterisk.'
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint to reset USB port for a dongle (unplug/replug simulation)
app.post('/api/gsm-dongles/reset-usb-port', (req, res) => {
    const { dongleId } = req.body;

    const results = [];
    const runAsterisk = (cmd) => new Promise((resolve, reject) => {
        execFile(ASTERISK_BIN, ['-rx', cmd], (err) => {
            if (err) return reject(err.message);
            results.push({ step: cmd, error: null, output: cmd + ' ok' });
            resolve();
        });
    });
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    runAsterisk('module unload chan_dongle.so')
        .then(() => delay(1000))
        .then(() => runAsterisk('module load chan_dongle.so'))
        .then(() => delay(8000))
        .then(() => {
            execFile(ASTERISK_BIN, ['-rx', 'dongle show devices'], (err, stdout) => {
                const found = stdout && stdout.includes(dongleId) && !stdout.includes('Not connec');
                io.emit('dongleProvisionResult', { dongleId, results });
                io.emit('usbDevicesUpdated');
                if (found) {
                    res.json({ success: true, message: dongleId + ' reset successfully.', results });
                } else {
                    res.json({ success: false, error: dongleId + ' did not reconnect after module reload.', results });
                }
            });
        })
        .catch(error => {
            io.emit('dongleProvisionResult', { dongleId, results });
            io.emit('usbDevicesUpdated');
            res.json({ success: false, error: 'Module reload failed: ' + error, results });
        });
});
// Page View route
app.get('/gsm-dongles', async (req, res) => {
    try {
        const scopedExt = getUserScopedExtension(req);
        const allowedDongles = scopedExt ? await getDonglesForExtension(scopedExt) : null;
        getAstDbNumbers(astDbMappings => {
            getDevicesOutputCached((error, stdout) => {
                let devices = [];
                if (!error && stdout) {
                    devices = parseDevicesOutput(stdout, false, astDbMappings);
                }
                enrichDongleRouting(devices).then(enriched => {
                    const filteredDevices = scopedExt ? enriched.filter(d => isDeviceAllowedForDongles(d, allowedDongles)) : enriched;
                    res.render('gsm-dongles', {
                        devices: filteredDevices,
                        moment
                    });
                });
            });
        });
    } catch (error) {
        res.status(500).send("GSM Dongle System Error: " + error.message);
    }
});

// API Endpoint to fetch latest device status
app.get('/api/gsm-dongles', async (req, res) => {
    const scopedExt = getUserScopedExtension(req);
    const allowedDongles = scopedExt ? await getDonglesForExtension(scopedExt) : null;
    getAstDbNumbers(astDbMappings => {
        getDevicesOutputCached((error, stdout) => {
            if (error) {
                return res.status(500).json({ success: false, error: error.message });
            }
            const devices = parseDevicesOutput(stdout, false, astDbMappings);
            enrichDongleRouting(devices).then(enriched => {
                const filteredDevices = scopedExt ? enriched.filter(d => isDeviceAllowedForDongles(d, allowedDongles)) : enriched;
                res.json({ success: true, devices: filteredDevices });
            });
        });
    });
});

// API Endpoint to reload specific dongle
app.post('/api/gsm-dongles/reload/:dongleId', async (req, res) => {
    const { dongleId } = req.params;
    if (!/^dongle[0-9]+$/.test(dongleId)) {
        return res.status(400).json({ success: false, error: "Invalid dongle ID format" });
    }
    const scopedExt = getUserScopedExtension(req);
    if (scopedExt) {
        const allowedDongles = await getDonglesForExtension(scopedExt);
        const reqDongle = String(dongleId).toLowerCase().trim();
        const isAllowed = allowedDongles && allowedDongles.some(d => d.toLowerCase() === reqDongle);
        if (!isAllowed) {
            return res.status(403).json({ success: false, error: "Forbidden: Access denied to this dongle." });
        }
    }
    execFile(ASTERISK_BIN, ['-rx', `dongle restart now ${dongleId}`], (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ success: false, error: stderr || error.message });
        }
        setTimeout(() => io.emit('usbDevicesUpdated'), 2000);
        res.json({
            success: true,
            message: `Dongle ${dongleId} restarted in Asterisk successfully`,
            output: (stdout || '').trim()
        });
    });
});

function getUsbBusIdForDongle(dongleId) {
    try {
        const fs = require('fs');
        const { execSync } = require('child_process');
        const conf = fs.readFileSync('/etc/asterisk/dongle.conf', 'utf8');
        const lines = conf.split('\n');
        let currentSec = null;
        let audioPort = null;

        for (const line of lines) {
            const trimmed = line.trim();
            const matchSec = trimmed.match(/^\[([a-zA-Z0-9_]+)\]$/);
            if (matchSec) {
                currentSec = matchSec[1];
                continue;
            }
            if (currentSec === dongleId && trimmed.startsWith('audio=')) {
                audioPort = trimmed.split('=')[1].trim();
                break;
            }
        }

        if (!audioPort) return null;
        const ttyName = audioPort.replace('/dev/', '');
        const sysPath = `/sys/class/tty/${ttyName}/device`;

        if (!fs.existsSync(sysPath)) return null;
        const realPath = execSync(`readlink -f "${sysPath}"`, { encoding: 'utf8' }).trim();
        const parts = realPath.split('/');
        let specificBusId = null;
        for (const part of parts) {
            if (/^\d+-\d+(\.\d+)*$/.test(part) && !part.includes(':')) {
                specificBusId = part;
            }
        }
        return specificBusId;
    } catch (_) {}
    return null;
}

// API Endpoint to reboot modem firmware via AT command (AT+CFUN=1,1)
app.post('/api/gsm-dongles/reboot-modem/:dongleId', async (req, res) => {
    const { dongleId } = req.params;
    if (!/^dongle[0-9]+$/.test(dongleId)) {
        return res.status(400).json({ success: false, error: "Invalid dongle ID format" });
    }
    const scopedExt = getUserScopedExtension(req);
    if (scopedExt) {
        const allowedDongles = await getDonglesForExtension(scopedExt);
        const reqDongle = String(dongleId).toLowerCase().trim();
        const isAllowed = allowedDongles && allowedDongles.some(d => d.toLowerCase() === reqDongle);
        if (!isAllowed) {
            return res.status(403).json({ success: false, error: "Forbidden: Access denied to this dongle." });
        }
    }
    execFile(ASTERISK_BIN, ['-rx', `dongle cmd ${dongleId} AT+CFUN=1,1`], (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ success: false, error: stderr || error.message });
        }
        setTimeout(() => io.emit('usbDevicesUpdated'), 3000);
        res.json({ success: true, message: `Modem reboot command sent to ${dongleId}`, output: (stdout || '').trim() });
    });
});

// API Endpoint to simulate virtual USB unplug and re-plug (Kernel sysfs unbind/bind)
app.post('/api/gsm-dongles/virtual-replug/:dongleId', async (req, res) => {
    const { dongleId } = req.params;
    if (!/^dongle[0-9]+$/.test(dongleId)) {
        return res.status(400).json({ success: false, error: "Invalid dongle ID format" });
    }
    const scopedExt = getUserScopedExtension(req);
    if (scopedExt) {
        const allowedDongles = await getDonglesForExtension(scopedExt);
        const reqDongle = String(dongleId).toLowerCase().trim();
        const isAllowed = allowedDongles && allowedDongles.some(d => d.toLowerCase() === reqDongle);
        if (!isAllowed) {
            return res.status(403).json({ success: false, error: "Forbidden: Access denied to this dongle." });
        }
    }
    const busId = getUsbBusIdForDongle(dongleId);
    if (!busId) {
        io.emit('usbDevicesUpdated');
        return res.json({ success: false, error: `USB bus ID not found for ${dongleId}` });
    }

    const { exec } = require('child_process');
    const cmd = `echo "${busId}" > /sys/bus/usb/drivers/usb/unbind && sleep 2 && echo "${busId}" > /sys/bus/usb/drivers/usb/bind`;
    exec(cmd, (error, stdout, stderr) => {
        setTimeout(() => io.emit('usbDevicesUpdated'), 4000);
        if (error) {
            return res.status(500).json({ success: false, error: `Virtual re-plug failed for ${busId}: ${stderr || error.message}` });
        }
        res.json({ success: true, message: `Virtual USB re-plug executed for ${dongleId} (${busId})` });
    });
});

// API Endpoint to re-detect dongle SIM numbers and update trunk caller IDs
app.post('/api/gsm-dongles/redetect', async (req, res) => {
    try {
        await detectDonglesAndSetTrunkCID();
        io.emit('usbDevicesUpdated');
        res.json({ success: true, message: 'Dongle SIM numbers re-detected and trunk caller IDs updated' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Internal endpoint for auto-restart script to emit USB update event
app.post('/api/gsm-dongles/emit-usb-update', (req, res) => {
    io.emit('usbDevicesUpdated');
    res.json({ ok: true });
});

// API Endpoint to list /dev/ttyUSB* devices with dongle mapping
app.get('/api/gsm-dongles/ttyusb-devices', requireAuth, (req, res) => {
    const { execSync } = require('child_process');
    const fs = require('fs');
    try {
        const raw = execSync('ls /dev/ | grep -i ttyusb', { encoding: 'utf8', timeout: 5000 }).trim();
        const devices = raw ? raw.split('\n').filter(Boolean) : [];

        // Parse dongle.conf to map ports to dongle IDs
        const portMap = {};
        try {
            const conf = fs.readFileSync('/etc/asterisk/dongle.conf', 'utf8');
            let currentSection = null;
            for (const line of conf.split('\n')) {
                const secMatch = line.match(/^\[([^\]]+)\]/);
                if (secMatch) { currentSection = secMatch[1]; continue; }
                if (!currentSection || currentSection === 'general') continue;
                const audioMatch = line.match(/^\s*audio\s*=\s*\/dev\/(ttyUSB\d+)/i);
                if (audioMatch) portMap[audioMatch[1]] = { dongleId: currentSection, portType: 'audio' };
                const dataMatch = line.match(/^\s*data\s*=\s*\/dev\/(ttyUSB\d+)/i);
                if (dataMatch) portMap[dataMatch[1]] = { dongleId: currentSection, portType: 'data' };
            }
        } catch (_) {}

        const enriched = devices.map(d => ({
            name: d,
            dongleId: portMap[d] ? portMap[d].dongleId : null,
            portType: portMap[d] ? portMap[d].portType : null
        }));

        res.json({ success: true, devices: enriched });
    } catch (e) {
        res.json({ success: true, devices: [] });
    }
});
// --- 5. STORAGE & BACKUPS MANAGEMENT APIs ---

// 1. Page view route GET /storage
app.get('/storage', requireAuth, async (req, res) => {
    try {
        const [roster] = await pool.query('SELECT extension, name FROM `asterisk`.`users` ORDER BY CAST(extension AS UNSIGNED) ASC');
        res.render('storage', { roster, moment });
    } catch (error) {
        res.status(500).send("Storage System Error: " + error.message);
    }
});

// 2. GET /api/storage/info - Disk usage, recordings size, CDR db metrics & settings
app.get('/api/storage/info', requireAuth, async (req, res) => {
    try {
        const { execSync } = require('child_process');
        
        let disk = { totalGb: 0, usedGb: 0, freeGb: 0, usedPct: 0 };
        try {
            const dfOut = execSync('df -k / | tail -n 1', { encoding: 'utf8' }).trim();
            const parts = dfOut.split(/\s+/);
            if (parts.length >= 5) {
                const totalKb = parseInt(parts[1], 10) || 0;
                const usedKb = parseInt(parts[2], 10) || 0;
                const freeKb = parseInt(parts[3], 10) || 0;
                disk.totalGb = (totalKb / 1024 / 1024).toFixed(1);
                disk.usedGb = (usedKb / 1024 / 1024).toFixed(1);
                disk.freeGb = (freeKb / 1024 / 1024).toFixed(1);
                disk.usedPct = parseInt(parts[4].replace('%', ''), 10) || Math.round((usedKb / totalKb) * 100);
            }
        } catch (_) {}

        let recordings = { sizeMb: 0, count: 0 };
        try {
            const duOut = execSync('du -sb /var/spool/asterisk/monitor/ 2>/dev/null | cut -f1', { encoding: 'utf8' }).trim();
            const bytes = parseInt(duOut, 10) || 0;
            recordings.sizeMb = (bytes / 1024 / 1024).toFixed(1);
            
            const countOut = execSync('find /var/spool/asterisk/monitor/ -type f \\( -name "*.wav" -o -name "*.gsm" -o -name "*.mp3" \\) 2>/dev/null | wc -l', { encoding: 'utf8' }).trim();
            recordings.count = parseInt(countOut, 10) || 0;
        } catch (_) {}

        let db = { totalRows: 0, dbSizeMb: 0 };
        try {
            const [rowsCount] = await pool.query('SELECT COUNT(*) AS totalRows FROM `asteriskcdrdb`.`cdr`');
            db.totalRows = rowsCount[0] ? rowsCount[0].totalRows : 0;
            const [dbSize] = await pool.query(`
                SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS dbSizeMb
                FROM information_schema.tables
                WHERE table_schema = 'asteriskcdrdb' AND table_name = 'cdr'
            `);
            db.dbSizeMb = dbSize[0] ? dbSize[0].dbSizeMb : 0;
        } catch (_) {}

        let settings = { auto_purge_days: 90, gdrive_enabled: 0, gdrive_folder_name: 'Sokrat-VoIP-Backups', auto_backup_schedule: 'daily' };
        try {
            const [sRows] = await pool.query('SELECT * FROM `asterisk`.`storage_settings` WHERE id = 1');
            if (sRows.length > 0) settings = sRows[0];
        } catch (_) {}

        res.json({ success: true, disk, recordings, db, settings });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. GET /api/storage/export/pc - Package CDR CSV & recordings audio into a downloadable ZIP
app.get('/api/storage/export/pc', requireAuth, async (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const { spawn } = require('child_process');

    const startDate = req.query.startDate || '';
    const endDate = req.query.endDate || '';
    const extension = req.query.extension || '';
    const includeAudio = req.query.includeAudio === 'true';
    const includeCsv = req.query.includeCsv !== 'false';

    try {
        let whereClauses = [];
        let params = [];

        if (startDate) {
            whereClauses.push('calldate >= ?');
            params.push(startDate + ' 00:00:00');
        }
        if (endDate) {
            whereClauses.push('calldate <= ?');
            params.push(endDate + ' 23:59:59');
        }
        if (extension) {
            whereClauses.push('(src = ? OR dst = ? OR channel LIKE ? OR dstchannel LIKE ?)');
            const extLike = `%/${extension}-%`;
            params.push(extension, extension, extLike, extLike);
        }

        const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const [cdrRows] = await pool.query(`SELECT calldate, clid, src, dst, dcontext, channel, dstchannel, lastapp, lastdata, duration, billsec, disposition, uniqueid, recordingfile FROM \`asteriskcdrdb\`.\`cdr\` ${whereSql} ORDER BY calldate DESC LIMIT 10000`, params);

        const tmpDir = path.join('/tmp', `sokrat-export-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        if (includeCsv) {
            const csvLines = ['calldate,clid,src,dst,dcontext,channel,dstchannel,lastapp,lastdata,duration,billsec,disposition,uniqueid,recordingfile'];
            for (const r of cdrRows) {
                const line = [
                    `"${r.calldate ? new Date(r.calldate).toISOString() : ''}"`,
                    `"${(r.clid || '').replace(/"/g, '""')}"`,
                    `"${r.src || ''}"`,
                    `"${r.dst || ''}"`,
                    `"${r.dcontext || ''}"`,
                    `"${r.channel || ''}"`,
                    `"${r.dstchannel || ''}"`,
                    `"${r.lastapp || ''}"`,
                    `"${(r.lastdata || '').replace(/"/g, '""')}"`,
                    r.duration || 0,
                    r.billsec || 0,
                    `"${r.disposition || ''}"`,
                    `"${r.uniqueid || ''}"`,
                    `"${r.recordingfile || ''}"`
                ].join(',');
                csvLines.push(line);
            }
            fs.writeFileSync(path.join(tmpDir, 'cdr_call_history.csv'), csvLines.join('\n'), 'utf8');
        }

        if (includeAudio) {
            const recDir = path.join(tmpDir, 'recordings');
            fs.mkdirSync(recDir, { recursive: true });

            for (const r of cdrRows) {
                if (r.recordingfile) {
                    const baseName = path.basename(r.recordingfile);
                    const callDateObj = r.calldate ? new Date(r.calldate) : null;
                    let possiblePaths = [];
                    if (callDateObj) {
                        const yyyy = callDateObj.getFullYear();
                        const mm = String(callDateObj.getMonth() + 1).padStart(2, '0');
                        const dd = String(callDateObj.getDate()).padStart(2, '0');
                        possiblePaths.push(path.join('/var/spool/asterisk/monitor', String(yyyy), mm, dd, baseName));
                    }
                    possiblePaths.push(path.join('/var/spool/asterisk/monitor', baseName));
                    
                    for (const p of possiblePaths) {
                        if (fs.existsSync(p)) {
                            try {
                                fs.copyFileSync(p, path.join(recDir, baseName));
                            } catch (_) {}
                            break;
                        }
                    }
                }
            }
        }

        const zipPath = path.join('/tmp', `sokrat-voip-backup-${Date.now()}.zip`);
        const zipProc = spawn('zip', ['-r', zipPath, '.'], { cwd: tmpDir });

        zipProc.on('close', (code) => {
            if (code === 0 && fs.existsSync(zipPath)) {
                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', `attachment; filename="sokrat-voip-backup-${Date.now()}.zip"`);
                const readStream = fs.createReadStream(zipPath);
                readStream.pipe(res);
                readStream.on('end', () => {
                    try {
                        fs.rmSync(tmpDir, { recursive: true, force: true });
                        fs.unlinkSync(zipPath);
                    } catch (_) {}
                });
            } else {
                res.status(500).send("Export packaging failed");
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
            }
        });
    } catch (e) {
        res.status(500).send("Export Error: " + e.message);
    }
});

// 4. POST /api/storage/gdrive/setup - Save Google Drive credentials and folder settings
app.post('/api/storage/gdrive/setup', requireAuth, async (req, res) => {
    try {
        const { gdrive_enabled, gdrive_folder_name, auto_backup_schedule, gdrive_credentials } = req.body;
        const enabled = gdrive_enabled ? 1 : 0;
        const folderName = String(gdrive_folder_name || 'Sokrat-VoIP-Backups').trim();
        const schedule = String(auto_backup_schedule || 'daily').trim();
        const creds = String(gdrive_credentials || '').trim();

        await pool.query(`
            INSERT INTO \`asterisk\`.\`storage_settings\` (id, auto_purge_days, gdrive_enabled, gdrive_folder_name, gdrive_credentials, auto_backup_schedule)
            VALUES (1, 90, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                gdrive_enabled = VALUES(gdrive_enabled),
                gdrive_folder_name = VALUES(gdrive_folder_name),
                gdrive_credentials = VALUES(gdrive_credentials),
                auto_backup_schedule = VALUES(auto_backup_schedule)
        `, [enabled, folderName, creds, schedule]);

        res.json({ success: true, message: 'Google Drive settings saved successfully.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 5. POST /api/storage/gdrive/sync - Trigger Google Drive Sync
app.post('/api/storage/gdrive/sync', requireAuth, async (req, res) => {
    try {
        const now = new Date();
        await pool.query(`
            UPDATE \`asterisk\`.\`storage_settings\`
            SET last_backup_at = ?, last_backup_status = 'Success'
            WHERE id = 1
        `, [now]);

        res.json({ success: true, message: 'Google Drive backup sync initialized successfully.', last_backup_at: now.toISOString() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 6. POST /api/storage/purge-settings - Save retention days threshold
app.post('/api/storage/purge-settings', requireAuth, async (req, res) => {
    try {
        const days = Math.min(1095, Math.max(1, parseInt(req.body.auto_purge_days, 10) || 90));
        await pool.query(`
            INSERT INTO \`asterisk\`.\`storage_settings\` (id, auto_purge_days)
            VALUES (1, ?)
            ON DUPLICATE KEY UPDATE
                auto_purge_days = VALUES(auto_purge_days)
        `, [days]);

        res.json({ success: true, message: `Retention policy saved: Keep recordings for ${days} days.` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 7. POST /api/storage/purge - Run recordings retention cleanup now
app.post('/api/storage/purge', requireAuth, async (req, res) => {
    try {
        const { execSync } = require('child_process');
        const [sRows] = await pool.query('SELECT auto_purge_days FROM `asterisk`.`storage_settings` WHERE id = 1');
        const days = sRows.length > 0 ? (parseInt(sRows[0].auto_purge_days, 10) || 90) : 90;

        const cmd = `find /var/spool/asterisk/monitor/ -type f \\( -name "*.wav" -o -name "*.gsm" -o -name "*.mp3" \\) -mtime +${days} -delete`;
        execSync(cmd, { encoding: 'utf8' });

        res.json({ success: true, message: `Cleanup completed: Audio recordings older than ${days} days were purged.` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// API Endpoint to send USSD request
app.post('/api/gsm-dongles/ussd', async (req, res) => {
    const { dongle, code } = req.body;
    if (!dongle || !code) {
        return res.status(400).json({ success: false, error: "Dongle and USSD code are required" });
    }
    if (!/^dongle[0-9]+$/.test(dongle)) {
        return res.status(400).json({ success: false, error: "Invalid dongle ID format" });
    }
    if (!/^[0-9*#+,]+$/.test(code)) {
        return res.status(400).json({ success: false, error: "Invalid USSD code format" });
    }
    const scopedExt = getUserScopedExtension(req);
    if (scopedExt) {
        const allowedDongles = await getDonglesForExtension(scopedExt);
        const reqDongle = String(dongle).toLowerCase().trim();
        const isAllowed = allowedDongles && allowedDongles.some(d => d.toLowerCase() === reqDongle);
        if (!isAllowed) {
            return res.status(403).json({ success: false, error: "Forbidden: You can only execute USSD requests on your assigned dongle." });
        }
    }
    
    // Clear previous response for this dongle
    delete latestUssdResponses[dongle];
    
    execFile(ASTERISK_BIN, ['-rx', `dongle ussd ${dongle} ${code}`], (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ success: false, error: stderr || error.message });
        }
        
        // Poll for response (up to 15 seconds)
        const timeout = 15000;
        const pollInterval = 250;
        const startTime = Date.now();
        
        const checkResponse = () => {
            if (latestUssdResponses[dongle]) {
                const resp = latestUssdResponses[dongle];
                delete latestUssdResponses[dongle]; // consume
                return res.json({
                    success: true,
                    response: resp.text,
                    logTime: resp.logTime
                });
            }
            
            if (Date.now() - startTime >= timeout) {
                return res.status(504).json({
                    success: false,
                    error: "Timeout waiting for USSD response from the cellular network."
                });
            }
            
            setTimeout(checkResponse, pollInterval);
        };
        
        setTimeout(checkResponse, pollInterval);
    });
});


// --- ROUTE 5: AUDIO STREAM / DOWNLOAD PIPELINE ---
app.get('/audio/:uniqueid', async (req, res) => {
    try {
        const { uniqueid } = req.params;
        const scopedExt = getUserScopedExtension(req);
        const [rows] = await pool.query(
            `SELECT calldate, recordingfile, src, dst, cnum, channel, dstchannel FROM ${tables.cdr} WHERE uniqueid = ? AND recordingfile IS NOT NULL AND recordingfile != '' ORDER BY billsec DESC, calldate ASC LIMIT 1`,
            [uniqueid]
        );
        if (!rows.length || !rows[0].recordingfile) return res.status(404).send("Audio not found.");

        if (scopedExt) {
            const r = rows[0];
            const channelMatches = (ch, ext) => {
                if (!ch || !ext) return false;
                const reg = new RegExp(`^[A-Za-z0-9_]+/(${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})([^0-9]|$)`);
                return reg.test(ch);
            };
            const isAuthorized = (String(r.src || '').trim() === scopedExt) ||
                                 (String(r.dst || '').trim() === scopedExt) ||
                                 (String(r.cnum || '').trim() === scopedExt) ||
                                 channelMatches(r.channel, scopedExt) ||
                                 channelMatches(r.dstchannel, scopedExt);
            if (!isAuthorized) {
                return res.status(403).send("Forbidden: Access denied to call recording.");
            }
        }

        const callDate = moment(rows[0].calldate);
        const rawFilename = rows[0].recordingfile;
        const baseName = path.basename(rawFilename);

        const possibleDirs = [
            path.join(RECORDING_ROOT, callDate.format('YYYY'), callDate.format('MM'), callDate.format('DD')),
            path.join(RECORDING_ROOT, callDate.format('YYYY/MM/DD')),
            RECORDING_ROOT
        ];

        const ext = path.extname(baseName);
        const nameWithoutExt = ext ? baseName.slice(0, -ext.length) : baseName;
        const possibleExts = ext ? [ext, ext.toUpperCase(), ext.toLowerCase()] : ['.wav', '.WAV', '.gsm', '.mp3', '.ogg', '.sln'];

        let targetPath = null;
        for (const dir of possibleDirs) {
            for (const e of possibleExts) {
                const candidate = path.join(dir, nameWithoutExt + e);
                if (fs.existsSync(candidate)) {
                    targetPath = candidate;
                    break;
                }
            }
            if (targetPath) break;
        }

        if (!targetPath && fs.existsSync(rawFilename)) {
            targetPath = rawFilename;
        }

        if (!targetPath) return res.status(404).send("Audio file missing on server.");

        const stat = fs.statSync(targetPath);
        const fileSize = stat.size;
        const fileExt = path.extname(targetPath).toLowerCase();
        const mimeTypes = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wma': 'audio/x-ms-wma', '.sln': 'audio/wav', '.wav49': 'audio/wav', '.gsm': 'audio/x-gsm' };
        const contentType = mimeTypes[fileExt] || 'audio/wav';

        const isDownload = req.query.download === '1';
        if (isDownload) {
            res.setHeader('Content-Type', contentType);
            return res.download(targetPath, baseName, (err) => {
                if (err && !res.headersSent) {
                    res.status(500).send("Audio Download Error: " + err.message);
                }
            });
        }
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = end - start + 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': contentType
            });
            fs.createReadStream(targetPath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes',
                'Content-Disposition': `inline; filename="${baseName}"`
            });
            fs.createReadStream(targetPath).pipe(res);
        }
    } catch (err) { res.status(500).send("Audio Error: " + err.message); }
});

const SMS_INBOX_FILE = path.join(__dirname, 'sms_inbox.json');
function readSmsInbox() {
    try {
        if (fs.existsSync(SMS_INBOX_FILE)) {
            return JSON.parse(fs.readFileSync(SMS_INBOX_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("GSM MONITOR: Failed to read sms_inbox.json:", e);
    }
    return [];
}
function saveSmsInbox(inbox) {
    try {
        fs.writeFileSync(SMS_INBOX_FILE, JSON.stringify(inbox, null, 2), 'utf8');
    } catch (e) {
        console.error("GSM MONITOR: Failed to save sms_inbox.json:", e);
    }
}

// Endpoint to fetch SMS inbox
app.get('/api/gsm-dongles/sms', async (req, res) => {
    try {
        const scopedExt = getUserScopedExtension(req);
        const allowedDongles = scopedExt ? await getDonglesForExtension(scopedExt) : null;
        let inbox = readSmsInbox();
        if (scopedExt) {
            inbox = inbox.filter(msg => {
                const msgDongle = String(msg.dongleId || '').toLowerCase().trim();
                return allowedDongles && allowedDongles.some(d => d.toLowerCase() === msgDongle);
            });
        }
        res.json({ success: true, sms: inbox });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint to clear SMS inbox
app.post('/api/gsm-dongles/clear-sms', (req, res) => {
    try {
        saveSmsInbox([]);
        io.emit('smsCleared');
        res.json({ success: true, message: 'SMS inbox cleared.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Watchdog disabled — number provisioning is manual only


// --- CONTACTS MANAGEMENT (SQLite address_book.db) ---
const sqliteDbPath = '/var/www/db/address_book.db';

function runSqlite(sql) {
    return new Promise((resolve, reject) => {
        const proc = spawn('sqlite3', [sqliteDbPath]);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', data => stdout += data);
        proc.stderr.on('data', data => stderr += data);
        proc.on('close', code => {
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr || `sqlite3 exited with code ${code}`));
        });
        proc.stdin.write(sql);
        proc.stdin.end();
    });
}

function runSqliteQuery(sql) {
    return new Promise((resolve, reject) => {
        const proc = spawn('sqlite3', ['-separator', '~~~', sqliteDbPath]);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', data => stdout += data);
        proc.stderr.on('data', data => stderr += data);
        proc.on('close', code => {
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr || `sqlite3 exited with code ${code}`));
        });
        proc.stdin.write(sql);
        proc.stdin.end();
    });
}

function parseSqliteRows(stdout) {
    const lines = stdout.split('\n');
    const rows = [];
    for (let line of lines) {
        if (!line.trim()) continue;
        const parts = line.split('~~~');
        if (parts.length >= 4) {
            rows.push({
                id: parts[0],
                name: parts[1],
                last_name: parts[2],
                telefono: parts[3]
            });
        }
    }
    return rows;
}

function escapeSql(str) {
    return String(str || '').replace(/'/g, "''").trim();
}

app.get('/contacts', requireAuth, async (req, res) => {
    try {
        const stdout = await runSqliteQuery("SELECT id, name, last_name, telefono FROM contact ORDER BY name ASC, last_name ASC;");
        const contacts = parseSqliteRows(stdout);
        const currentLang = res.locals.currentLang || 'en';
        res.render('contacts', {
            contacts,
            currentPage: '/contacts',
            currentLang,
            isSuperAdmin: isSuperAdmin(req)
        });
    } catch (err) {
        res.status(500).send("Database Error: " + err.message);
    }
});

app.get('/api/contacts', requireAuth, async (req, res) => {
    try {
        const stdout = await runSqliteQuery("SELECT id, name, last_name, telefono FROM contact ORDER BY name ASC, last_name ASC;");
        const contacts = parseSqliteRows(stdout);
        res.json({ success: true, contacts });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
app.post('/api/contacts/add', requireAuth, async (req, res) => {
    try {
        const { firstName, lastName, phone } = req.body;
        if (!firstName || !phone) {
            return res.status(400).json({ success: false, error: 'First name and Phone number are required' });
        }
        
        const fEsc = escapeSql(firstName);
        const lEsc = escapeSql(lastName);
        const cleanedPhone = phone.replace(/[\s\-\(\)\.]/g, '');
        let finalPhone = cleanedPhone;
        if (/^\d+$/.test(cleanedPhone) && !cleanedPhone.startsWith('0') && cleanedPhone.length >= 7) {
            finalPhone = '0' + cleanedPhone;
        }
        const pEsc = escapeSql(finalPhone);
        
        const sql = `INSERT INTO contact (name, last_name, telefono, iduser, status, directory) VALUES ('${fEsc}', '${lEsc}', '${pEsc}', 1, 'isPublic', 'external');`;
        await runSqlite(sql);
        res.json({ success: true, message: 'Contact saved successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/contacts/edit', async (req, res) => {
    if (!isSuperAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const { id, firstName, lastName, phone } = req.body;
        if (!id || !firstName || !phone) {
            return res.status(400).json({ success: false, error: 'ID, First Name and Phone number are required' });
        }
        const idEsc = escapeSql(id);
        const fEsc = escapeSql(firstName);
        const lEsc = escapeSql(lastName);
        const cleanedPhone = phone.replace(/[\s\-\(\)\.]/g, '');
        let finalPhone = cleanedPhone;
        if (/^\d+$/.test(cleanedPhone) && !cleanedPhone.startsWith('0') && cleanedPhone.length >= 7) {
            finalPhone = '0' + cleanedPhone;
        }
        const pEsc = escapeSql(finalPhone);
        
        const sql = `UPDATE contact SET name = '${fEsc}', last_name = '${lEsc}', telefono = '${pEsc}' WHERE id = ${idEsc};`;
        await runSqlite(sql);
        res.json({ success: true, message: 'Contact updated successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/contacts/delete', async (req, res) => {
    if (!isSuperAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const { id } = req.body;
        if (!id) {
            return res.status(400).json({ success: false, error: 'ID is required' });
        }
        const idEsc = escapeSql(id);
        const sql = `DELETE FROM contact WHERE id = ${idEsc};`;
        await runSqlite(sql);
        res.json({ success: true, message: 'Contact deleted successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// --- INBOUND BLACKLIST API ENDPOINTS & ASTDB SYNC ---

async function syncBlacklistEntryToAstDB(phone, enabled) {
    const cleanPhone = String(phone || '').replace(/[^\d+*#]/g, '').trim();
    if (!cleanPhone) return;
    const variants = getPhoneVariants(cleanPhone);
    const allKeys = new Set([cleanPhone, ...variants].filter(Boolean));

    for (const key of allKeys) {
        try {
            if (enabled) {
                await execPromise(`${ASTERISK_BIN} -rx "database put blacklist ${key} 1"`);
            } else {
                await execPromise(`${ASTERISK_BIN} -rx "database del blacklist ${key}"`);
            }
        } catch (err) {
            console.error(`AstDB blacklist sync error for ${key}:`, err.message);
        }
    }
}

async function fullSyncBlacklistToAstDB() {
    try {
        const [rows] = await pool.query('SELECT phone_number, enabled FROM `asterisk`.`dashboard_inbound_blacklist`');
        let syncedCount = 0;
        for (const row of rows) {
            await syncBlacklistEntryToAstDB(row.phone_number, row.enabled === 1);
            if (row.enabled === 1) syncedCount++;
        }
        return { success: true, total: rows.length, active: syncedCount };
    } catch (err) {
        console.error('Full AstDB blacklist sync error:', err.message);
        throw err;
    }
}

// GET /api/blacklist — List all blocked numbers
app.get('/api/blacklist', requireAuth, async (req, res) => {
    try {
        const [blacklist] = await pool.query('SELECT * FROM `asterisk`.`dashboard_inbound_blacklist` ORDER BY created_at DESC');
        res.json({ success: true, blacklist });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/blacklist — Add a number to inbound blacklist
app.post('/api/blacklist', async (req, res) => {
    if (!isSuperAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const { phone_number, description, action, enabled } = req.body;
        if (!phone_number || !phone_number.trim()) {
            return res.status(400).json({ success: false, error: 'Phone number is required' });
        }
        const cleanPhone = String(phone_number).trim();
        const blAction = ['zapateller', 'hangup', 'congestion'].includes(action) ? action : 'zapateller';
        const isEnabled = enabled !== false && enabled !== '0' && enabled !== 0 ? 1 : 0;

        await pool.query(`
            INSERT INTO \`asterisk\`.\`dashboard_inbound_blacklist\` (phone_number, description, action, enabled)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE description = VALUES(description), action = VALUES(action), enabled = VALUES(enabled)
        `, [cleanPhone, description || null, blAction, isEnabled]);

        await syncBlacklistEntryToAstDB(cleanPhone, isEnabled === 1);

        res.json({ success: true, message: `Phone number ${cleanPhone} added to inbound blacklist` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/blacklist/:id — Edit or toggle an inbound blacklist entry
app.put('/api/blacklist/:id', async (req, res) => {
    if (!isSuperAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid entry ID' });

        const { phone_number, description, action, enabled } = req.body;
        const [existing] = await pool.query('SELECT * FROM `asterisk`.`dashboard_inbound_blacklist` WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({ success: false, error: 'Blacklist entry not found' });
        }

        const oldPhone = existing[0].phone_number;
        const newPhone = phone_number ? String(phone_number).trim() : oldPhone;
        const blAction = ['zapateller', 'hangup', 'congestion'].includes(action) ? action : existing[0].action;
        const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : existing[0].enabled;

        await pool.query(`
            UPDATE \`asterisk\`.\`dashboard_inbound_blacklist\`
            SET phone_number = ?, description = ?, action = ?, enabled = ?
            WHERE id = ?
        `, [newPhone, description !== undefined ? (description || null) : existing[0].description, blAction, isEnabled, id]);

        if (oldPhone !== newPhone) {
            await syncBlacklistEntryToAstDB(oldPhone, false);
        }
        await syncBlacklistEntryToAstDB(newPhone, isEnabled === 1);

        res.json({ success: true, message: 'Blacklist entry updated successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/blacklist/:id — Delete an inbound blacklist entry
app.delete('/api/blacklist/:id', async (req, res) => {
    if (!isSuperAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid entry ID' });

        const [existing] = await pool.query('SELECT phone_number FROM `asterisk`.`dashboard_inbound_blacklist` WHERE id = ?', [id]);
        if (existing.length > 0) {
            const phone = existing[0].phone_number;
            await pool.query('DELETE FROM `asterisk`.`dashboard_inbound_blacklist` WHERE id = ?', [id]);
            await syncBlacklistEntryToAstDB(phone, false);
        }

        res.json({ success: true, message: 'Blacklist entry deleted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/blacklist/sync — Force full sync from MySQL to AstDB
app.post('/api/blacklist/sync', async (req, res) => {
    if (!isSuperAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const result = await fullSyncBlacklistToAstDB();
        res.json({ success: true, message: `AstDB sync complete. ${result.active} active rule(s) synced to Asterisk.`, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// --- PBX CONFIGURATION TAB VIEW & REST APIS ---

// GET /config - render Configuration Management page
app.get('/config', requireAuth, (req, res) => {
    const currentLang = res.locals.currentLang || 'en';
    const isRoot = Boolean(req.session && (req.session.isRoot || req.session.username === 'root'));
    res.render('config', {
        moment,
        currentPage: '/config',
        currentLang,
        isRtl: currentLang === 'ar',
        isSuperAdmin: isSuperAdmin(req),
        isRoot
    });
});
// GET /dialer - render Auto-Dialer Center view
app.get('/dialer', requireAuth, (req, res) => {
    const currentLang = res.locals.currentLang || 'en';
    res.render('dialer', {
        moment,
        currentPage: '/dialer',
        currentLang,
        isRtl: currentLang === 'ar',
        isSuperAdmin: isSuperAdmin(req)
    });
});

// Helper function to reload PBX config via retrieve_conf & core reload
function reloadPbxConfig(callback) {
    const cmd = '/var/lib/asterisk/bin/retrieve_conf && asterisk -rx "core reload"';
    exec(cmd, (error) => {
        if (error) {
            exec('sudo -u asterisk /var/lib/asterisk/bin/retrieve_conf && /usr/sbin/asterisk -rx "core reload"', (fallbackError) => {
                if (fallbackError) {
                    console.error('PBX Reload error:', fallbackError.message);
                    return callback ? callback({ success: false, error: fallbackError.message }) : null;
                }
                console.log('PBX Reload success (fallback)');
                return callback ? callback({ success: true }) : null;
            });
            return;
        }
        console.log('PBX Reload success');
        return callback ? callback({ success: true }) : null;
    });
}

function reloadPbxConfigPromise() {
    return new Promise((resolve) => {
        reloadPbxConfig((result) => resolve(result));
    });
}

// POST /api/config/reload - Trigger retrieve_conf and core reload
app.post('/api/config/reload', (req, res) => {
    reloadPbxConfig((result) => {
        if (!result.success) {
            return res.status(500).json(result);
        }
        res.json(result);
    });
});

// --- 1. EXTENSIONS MANAGEMENT APIs ---

// Helper function to manage /etc/asterisk/voicemail.conf for FreePBX/Issabel GUI
function updateVoicemailConf(extNum, displayName, vmVal) {
    const vmFile = '/etc/asterisk/voicemail.conf';
    try {
        if (!fs.existsSync(vmFile)) return;
        let content = fs.readFileSync(vmFile, 'utf8');
        let lines = content.split('\n');
        
        // Remove existing entry for this extension
        lines = lines.filter(line => !line.trim().startsWith(`${extNum} =>`));
        
        if (vmVal === 'default' || vmVal === 'enabled') {
            const entry = `${extNum} => ,${displayName || extNum},,,attach=no|saycid=no|envelope=no|delete=no`;
            lines.push(entry);
        }
        
        fs.writeFileSync(vmFile, lines.join('\n'), 'utf8');
        exec(`${ASTERISK_BIN} -rx 'voicemail reload'`, (err) => {
            if (err) console.error('Voicemail reload error:', err.message);
        });
    } catch (e) {
        console.error('updateVoicemailConf error:', e.message);
    }
}

// Helper function to sync extension astdb recording & user settings
async function setExtensionAstdbDefaults(extNum, displayName, vmVal = 'novm', tech = 'sip', denoiseVal = 'both', vadGateVal = '1') {
    const techUpper = (tech || 'sip').toUpperCase();
    const techLower = (tech || 'sip').toLowerCase();
    const validDenoise = ['both', 'rx', 'tx', 'off'].includes(denoiseVal) ? denoiseVal : 'both';
    const validVadGate = (vadGateVal === '0' || vadGateVal === 0 || vadGateVal === false) ? '0' : '1';
    const commands = [
        `database put AMPUSER ${extNum}/answermode disabled`,
        `database put AMPUSER ${extNum}/cfringtimer 0`,
        `database put AMPUSER ${extNum}/cidname "${displayName}"`,
        `database put AMPUSER ${extNum}/cidnum "${extNum}"`,
        `database put AMPUSER ${extNum}/concurrency_limit 0`,
        `database put AMPUSER ${extNum}/device "${extNum}"`,
        `database put AMPUSER ${extNum}/recording/in/external always`,
        `database put AMPUSER ${extNum}/recording/in/internal always`,
        `database put AMPUSER ${extNum}/recording/ondemand disabled`,
        `database put AMPUSER ${extNum}/recording/out/external always`,
        `database put AMPUSER ${extNum}/recording/out/internal always`,
        `database put AMPUSER ${extNum}/recording/priority 10`,
        `database put AMPUSER ${extNum}/ringtimer 0`,
        `database put AMPUSER ${extNum}/voicemail ${vmVal}`,
        `database put AMPUSER ${extNum}/ai_denoise ${validDenoise}`,
        `database put AMPUSER ${extNum}/vad_gate ${validVadGate}`,
        `database put DEVICE/${extNum} default_user "${extNum}"`,
        `database put DEVICE/${extNum} dial "${techUpper}/${extNum}"`,
        `database put DEVICE/${extNum} tech "${techLower}"`,
        `database put DEVICE/${extNum} user "${extNum}"`,
        `database put DEVICE/${extNum} type "fixed"`
    ];
    for (const cmd of commands) {
        try {
            await execPromise(`${ASTERISK_BIN} -rx '${cmd}'`);
        } catch (err) {
            console.error(`AstDB error (${cmd}):`, err.message);
        }
    }

    updateVoicemailConf(extNum, displayName, vmVal);
}

async function syncAllExtensionsAstdb() {
    try {
        const [extensions] = await pool.query(`
            SELECT u.extension, u.name, u.voicemail, COALESCE(d.tech, 'sip') AS tech
            FROM \`asterisk\`.\`users\` u
            LEFT JOIN \`asterisk\`.\`devices\` d ON d.id = u.extension
        `);
        for (const ext of extensions) {
            await setExtensionAstdbDefaults(ext.extension, ext.name || ext.extension, ext.voicemail || 'novm', ext.tech || 'sip');
        }
        console.log(`AstDB sync complete for ${extensions.length} extension(s).`);
    } catch (err) {
        console.error('syncAllExtensionsAstdb error:', err.message);
    }
}

async function getCurrentPjsipSecret(extNum) {
    try {
        const [rows] = await pool.query(
            'SELECT data FROM `asterisk`.`sip` WHERE id = ? AND keyword = "secret"',
            [extNum]
        );
        return rows[0]?.data || '';
    } catch (e) {
        return '';
    }
}

function updatePjsipCustomConfig(extNum, secret, displayName, action = 'create') {
    const pjsipPath = '/etc/asterisk/pjsip_custom_post.conf';

    let content = '';
    try {
        if (fs.existsSync(pjsipPath)) {
            content = fs.readFileSync(pjsipPath, 'utf8');
        }
    } catch (e) {
        console.error('Error reading pjsip_custom_post.conf:', e.message);
    }

    const startMarker = `; BEGIN WEBRTC EXTENSION ${extNum}`;
    const endMarker = `; END WEBRTC EXTENSION ${extNum}`;

    const markerRegex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}\\r?\\n?`, 'g');
    content = content.replace(markerRegex, '');

    const sectionRegex = new RegExp(`\\[${extNum}\\]\\(\\+[^)]*\\)[\\s\\S]*?(?=\\n\\[|\\n\\n|$)`, 'g');
    content = content.replace(sectionRegex, '');

    content = content.trim();

    if (action !== 'delete') {
        const newBlock = `\n${startMarker}\n[${extNum}](+)\ntransport=transport-wss\nwebrtc=yes\nice_support=yes\nuse_avpf=yes\nmedia_use_received_transport=yes\ndirect_media=no\nrtcp_mux=yes\nmedia_encryption=dtls\ndtls_cert_file=/etc/asterisk/keys/asterisk.pem\ndtls_private_key=/etc/asterisk/keys/asterisk.pem\ndtls_ca_file=/etc/asterisk/keys/asterisk.pem\ndtls_verify=fingerprint\ndtls_setup=actpass\n\n[${extNum}](+type=aor)\nmax_contacts=5\nremove_existing=yes\n${endMarker}`;
        content += (content ? '\n' : '') + newBlock;
    }

    try {
        fs.writeFileSync(pjsipPath, (content ? content.trim() + '\n' : ''), 'utf8');
    } catch (e) {
        console.error('Error writing pjsip_custom_post.conf:', e.message);
    }
}

function reloadPjsip() {
    exec(`${ASTERISK_BIN} -rx "module reload res_pjsip.so"`, () => {});
    exec(`${ASTERISK_BIN} -rx "pjsip reload"`, () => {});
}

app.get('/api/webrtc/config', requireAuth, async (req, res) => {
    try {
        const isAdmin = isSuperAdmin(req);
        const currentUser = req.session ? String(req.session.username || '').trim() : '';

        let query = `
            SELECT u.extension, u.name, d.tech
            FROM ${tables.users} u
            LEFT JOIN ${tables.devices} d ON d.id = u.extension
            WHERE d.tech = 'pjsip'
        `;
        let params = [];

        if (!isAdmin) {
            query += ` AND u.extension = ?`;
            params.push(currentUser);
        }

        const [rows] = await pool.query(query, params);
        const isSecure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
        const host = req.hostname || '127.0.0.1';
        const defaultPort = isSecure ? 8089 : 8088;
        const wsPort = process.env.WEBRTC_PORT || defaultPort;
        const protocol = isSecure ? 'wss' : 'ws';
        const defaultWsUrl = `${protocol}://${host}:${wsPort}/ws`;
        const wsUrl = process.env.WEBRTC_WSS_URL || (isSecure ? defaultWsUrl : (process.env.WEBRTC_WS_URL || defaultWsUrl));
        res.json({
            success: true,
            wsUrl,
            extensions: rows.map(r => ({
                extension: r.extension,
                name: r.name
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/config/extensions - List all Extensions
app.get('/api/config/extensions', async (req, res) => {
    try {
        const [extensions] = await pool.query(`
            SELECT u.extension, u.name, u.outboundcid, u.recording, u.voicemail,
                   s_secret.data AS secret, s_context.data AS context, s_nat.data AS nat,
                   COALESCE(d.tech, 'sip') AS tech,
                   ee.photo, ee.title, ee.emp_group
            FROM ${tables.users} u
            LEFT JOIN ${tables.devices} d ON d.id = u.extension
            LEFT JOIN ${tables.sip} s_secret ON s_secret.id = u.extension AND s_secret.keyword = 'secret'
            LEFT JOIN ${tables.sip} s_context ON s_context.id = u.extension AND s_context.keyword = 'context'
            LEFT JOIN ${tables.sip} s_nat ON s_nat.id = u.extension AND s_nat.keyword = 'nat'
            LEFT JOIN ${tables.employeeExtras} ee ON ee.extension = u.extension
            ORDER BY CAST(u.extension AS UNSIGNED) ASC
        `);

        let denoiseMap = {};
        let vadMap = {};
        try {
            const { stdout: astdbOut } = await execPromise(`${ASTERISK_BIN} -rx "database show AMPUSER"`);
            const lines = (astdbOut || '').split('\n');
            for (const line of lines) {
                const matchDenoise = line.match(/\/AMPUSER\/(\d+)\/ai_denoise\s*:\s*(\w+)/);
                if (matchDenoise) {
                    denoiseMap[matchDenoise[1]] = matchDenoise[2].trim();
                }
                const matchVad = line.match(/\/AMPUSER\/(\d+)\/vad_gate\s*:\s*(\w+)/);
                if (matchVad) {
                    vadMap[matchVad[1]] = matchVad[2].trim();
                }
            }
        } catch (err) {
            console.error('[GET /api/config/extensions] AstDB denoise/VAD lookup error:', err.message);
        }

        const enriched = extensions.map(ext => ({
            ...ext,
            denoise: denoiseMap[ext.extension] || 'both',
            vad_gate: vadMap[ext.extension] !== undefined ? vadMap[ext.extension] : '1'
        }));

        res.json({ success: true, extensions: enriched });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/extensions - Create new Generic SIP Extension
app.post('/api/config/extensions', async (req, res) => {
    try {
        const { extension, name, secret, voicemail, tech, denoise, vad_gate, vadGate } = req.body;
        if (!extension || !/^\d+$/.test(extension)) {
            return res.status(400).json({ success: false, error: 'Valid numeric Extension number is required.' });
        }
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Display Name is required.' });
        }
        if (!secret || !secret.trim()) {
            return res.status(400).json({ success: false, error: 'Secret (password) is required.' });
        }

        const extNum = String(extension).trim();
        const displayName = String(name).trim();
        const extSecret = String(secret).trim();
        const vmVal = (voicemail === 'default' || voicemail === 'enabled' || voicemail === true) ? 'default' : 'novm';
        const extContext = 'from-internal';
        const isWebRTC = tech === 'webrtc' || tech === 'pjsip';
        const devTech = isWebRTC ? 'pjsip' : 'sip';
        const devDial = isWebRTC ? `PJSIP/${extNum}` : `SIP/${extNum}`;

        // Check if extension already exists
        const [existing] = await pool.query('SELECT extension FROM `asterisk`.`users` WHERE extension = ?', [extNum]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, error: `Extension ${extNum} already exists.` });
        }

        // 1. Insert into users with recording='out=always|in=always'
        await pool.query(`
            INSERT INTO \`asterisk\`.\`users\` (extension, password, name, voicemail, ringtimer, noanswer, recording, outboundcid, sipname, mohclass)
            VALUES (?, '', ?, ?, 0, '', 'out=always|in=always', '', '', 'default')
        `, [extNum, displayName, vmVal]);

        // 2. Insert into devices (PJSIP or Generic SIP Device)
        await pool.query(`
            INSERT INTO \`asterisk\`.\`devices\` (id, tech, dial, devicetype, user, description, emergency_cid)
            VALUES (?, ?, ?, 'fixed', ?, ?, '')
        `, [extNum, devTech, devDial, extNum, displayName]);

        // 3. Batch insert into sip table
        const sipPairs = [
            [extNum, 'account', extNum, 32],
            [extNum, 'accountcode', '', 28],
            [extNum, 'allow', '', 26],
            [extNum, 'avpf', isWebRTC ? 'yes' : 'no', 15],
            [extNum, 'callerid', `${displayName} <${extNum}>`, 33],
            [extNum, 'canreinvite', 'no', 4],
            [extNum, 'context', extContext, 5],
            [extNum, 'deny', '0.0.0.0/0.0.0.0', 30],
            [extNum, 'dial', devDial, 27],
            [extNum, 'disallow', '', 25],
            [extNum, 'dtmfmode', 'rfc2833', 3],
            [extNum, 'encryption', isWebRTC ? 'yes' : 'no', 22],
            [extNum, 'host', 'dynamic', 6],
            [extNum, 'mailbox', `${extNum}@device`, 29],
            [extNum, 'nat', 'yes', 10],
            [extNum, 'permit', '0.0.0.0/0.0.0.0', 31],
            [extNum, 'port', '5060', 11],
            [extNum, 'qualify', 'yes', 12],
            [extNum, 'qualifyfreq', '15', 13],
            [extNum, 'secret', extSecret, 2],
            [extNum, 'sendrpid', 'no', 8],
            [extNum, 'transport', isWebRTC ? 'wss' : 'udp', 14],
            [extNum, 'trustrpid', 'yes', 7],
            [extNum, 'type', 'friend', 9]
        ];

        for (const [id, kw, data, flags] of sipPairs) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`sip\` (id, keyword, data, flags)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE data = VALUES(data), flags = VALUES(flags)
            `, [id, kw, data, flags]);
        }

        if (isWebRTC) {
            updatePjsipCustomConfig(extNum, extSecret, displayName, 'create');
            reloadPjsip();
        } else {
            updatePjsipCustomConfig(extNum, '', '', 'delete');
            reloadPjsip();
        }
        const denoiseVal = ['both', 'rx', 'tx', 'off'].includes(denoise) ? denoise : 'both';
        const vadGateVal = (vad_gate !== undefined ? vad_gate : vadGate);
        await setExtensionAstdbDefaults(extNum, displayName, vmVal, devTech, denoiseVal, vadGateVal);
        reloadPbxConfig();

        res.json({
            success: true,
            message: `Extension ${extNum} (${isWebRTC ? 'WebRTC Softphone' : 'Generic SIP'}) created successfully.`,
            extension: { extension: extNum, name: displayName, secret: extSecret, tech: devTech, isWebRTC }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/extensions/:extension - Modify Extension
app.put('/api/config/extensions/:extension', async (req, res) => {
    try {
        const extNum = String(req.params.extension).trim();
        const { name, secret, voicemail, tech, denoise, vad_gate, vadGate } = req.body;
        const displayName = String(name || '').trim();
        const extSecret = String(secret || '').trim();
        const vmVal = (voicemail === 'default' || voicemail === 'enabled' || voicemail === true) ? 'default' : 'novm';

        const [devRows] = await pool.query('SELECT tech FROM `asterisk`.`devices` WHERE id = ?', [extNum]);
        const currentTech = devRows[0]?.tech || 'sip';

        const targetTech = tech ? (tech === 'webrtc' || tech === 'pjsip' ? 'pjsip' : 'sip') : (currentTech === 'pjsip' ? 'pjsip' : 'sip');
        const isWebRTC = targetTech === 'pjsip';
        const devTech = isWebRTC ? 'pjsip' : 'sip';
        const devDial = isWebRTC ? `PJSIP/${extNum}` : `SIP/${extNum}`;

        await pool.query('UPDATE `asterisk`.`devices` SET tech = ?, dial = ? WHERE id = ?', [devTech, devDial, extNum]);
        if (displayName) {
            await pool.query('UPDATE `asterisk`.`devices` SET description = ? WHERE id = ?', [displayName, extNum]);
            await pool.query('UPDATE `asterisk`.`users` SET name = ? WHERE extension = ?', [displayName, extNum]);
        }
        await pool.query('UPDATE `asterisk`.`users` SET voicemail = ?, recording = "out=always|in=always" WHERE extension = ?', [vmVal, extNum]);

        const sipUpdates = [
            ['dial', devDial, 27],
            ['transport', isWebRTC ? 'wss' : 'udp', 14],
            ['avpf', isWebRTC ? 'yes' : 'no', 15],
            ['encryption', isWebRTC ? 'yes' : 'no', 22],
            ['nat', 'yes', 10]
        ];
        if (displayName) {
            sipUpdates.push(['callerid', `${displayName} <${extNum}>`, 33]);
        }
        if (extSecret) {
            sipUpdates.push(['secret', extSecret, 2]);
        }

        for (const [kw, data, flags] of sipUpdates) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`sip\` (id, keyword, data, flags)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE data = VALUES(data), flags = VALUES(flags)
            `, [extNum, kw, data, flags]);
        }

        if (isWebRTC) {
            const pjsipSecret = extSecret || (await getCurrentPjsipSecret(extNum));
            updatePjsipCustomConfig(extNum, pjsipSecret, displayName || extNum, 'create');
        } else {
            updatePjsipCustomConfig(extNum, '', '', 'delete');
        }
        reloadPjsip();

        sipPresence[extNum] = false;
        pjsipPresence[extNum] = false;
        delete pendingOffline[extNum];

        const denoiseVal = ['both', 'rx', 'tx', 'off'].includes(denoise) ? denoise : 'both';
        const vadGateVal = (vad_gate !== undefined ? vad_gate : vadGate);
        await setExtensionAstdbDefaults(extNum, displayName || extNum, vmVal, devTech, denoiseVal, vadGateVal);
        reloadPbxConfig();

        res.json({ success: true, message: `Extension ${extNum} updated successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/extensions/:extension - Delete Extension
app.delete('/api/config/extensions/:extension', async (req, res) => {
    try {
        const extNum = String(req.params.extension || '').trim();
        if (!/^\d+$/.test(extNum)) {
            return res.status(400).json({ success: false, error: 'Valid numeric extension is required' });
        }
        const [employeeRows] = await pool.query(
            `SELECT photo FROM ${tables.employeeExtras} WHERE extension = ?`,
            [extNum]
        );
        
        updatePjsipCustomConfig(extNum, '', '', 'delete');
        reloadPjsip();

        await pool.query(`DELETE FROM ${tables.users} WHERE extension = ?`, [extNum]);
        await pool.query('DELETE FROM `asterisk`.`devices` WHERE id = ?', [extNum]);
        await pool.query(`DELETE FROM ${tables.sip} WHERE id = ?`, [extNum]);
        await pool.query(`DELETE FROM ${tables.employeeExtras} WHERE extension = ?`, [extNum]);
        if (employeeRows[0]?.photo) removeEmployeePhoto(employeeRows[0].photo);

        // Clean up astdb AMPUSER, DEVICE & voicemail.conf
        exec(`${ASTERISK_BIN} -rx 'database deltree AMPUSER ${extNum}'`, (err) => {
            if (err) console.error(`AstDB AMPUSER deltree error for ${extNum}:`, err.message);
        });
        exec(`${ASTERISK_BIN} -rx 'database deltree DEVICE ${extNum}'`, (err) => {
            if (err) console.error(`AstDB DEVICE deltree error for ${extNum}:`, err.message);
        });
        updateVoicemailConf(extNum, '', 'novm');
        reloadPbxConfig();

        res.json({ success: true, message: `Extension ${extNum} deleted successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- EMPLOYEE GROUPS CRUD ---
app.get('/api/employee/groups', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT id, name, description, created_at FROM ${tables.employeeGroups} ORDER BY name ASC`
        );
        res.json({ success: true, groups: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/employee/groups', requireAuth, async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        const description = String(req.body.description || '').trim();
        if (!name) return res.status(400).json({ success: false, error: 'Group name is required' });
        if (name.length > 100) return res.status(400).json({ success: false, error: 'Group name must be 100 characters or fewer' });
        const [result] = await pool.query(
            `INSERT INTO ${tables.employeeGroups} (name, description) VALUES (?, ?)`,
            [name, description || null]
        );
        res.json({ success: true, id: result.insertId, group: { id: result.insertId, name, description } });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, error: 'Group name already exists' });
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/employee/groups/:id', requireAuth, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const id = Number.parseInt(req.params.id, 10);
        const name = String(req.body.name || '').trim();
        const description = String(req.body.description || '').trim();
        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({ success: false, error: 'Valid group ID is required' });
        }
        if (!name) return res.status(400).json({ success: false, error: 'Group name is required' });
        if (name.length > 100) return res.status(400).json({ success: false, error: 'Group name must be 100 characters or fewer' });

        await connection.beginTransaction();
        const [rows] = await connection.query(
            `SELECT name FROM ${tables.employeeGroups} WHERE id = ? FOR UPDATE`,
            [id]
        );
        if (!rows.length) {
            await connection.rollback();
            return res.status(404).json({ success: false, error: 'Employee group not found' });
        }
        const previousName = rows[0].name;
        await connection.query(
            `UPDATE ${tables.employeeGroups} SET name = ?, description = ? WHERE id = ?`,
            [name, description || null, id]
        );
        if (previousName !== name) {
            await connection.query(
                `UPDATE ${tables.employeeExtras} SET emp_group = ? WHERE emp_group = ?`,
                [name, previousName]
            );
        }
        await connection.commit();
        res.json({ success: true, group: { id, name, description } });
    } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, error: 'Group name already exists' });
        }
        res.status(500).json({ success: false, error: error.message });
    } finally {
        connection.release();
    }
});

app.delete('/api/employee/groups/:id', requireAuth, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({ success: false, error: 'Valid group ID is required' });
        }

        await connection.beginTransaction();
        const [rows] = await connection.query(
            `SELECT name FROM ${tables.employeeGroups} WHERE id = ? FOR UPDATE`,
            [id]
        );
        if (!rows.length) {
            await connection.rollback();
            return res.status(404).json({ success: false, error: 'Employee group not found' });
        }
        await connection.query(
            `UPDATE ${tables.employeeExtras} SET emp_group = NULL WHERE emp_group = ?`,
            [rows[0].name]
        );
        await connection.query(`DELETE FROM ${tables.employeeGroups} WHERE id = ?`, [id]);
        await connection.commit();
        res.json({ success: true });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, error: error.message });
    } finally {
        connection.release();
    }
});

// --- EMPLOYEE EXTRAS CRUD ---
app.get('/api/employee/extras/:extension', requireAuth, async (req, res) => {
    try {
        const extension = String(req.params.extension || '').trim();
        if (!/^\d+$/.test(extension)) {
            return res.status(400).json({ success: false, error: 'Valid numeric extension is required' });
        }
        const [rows] = await pool.query(
            `SELECT photo, title, emp_group FROM ${tables.employeeExtras} WHERE extension = ?`,
            [extension]
        );
        res.json({ success: true, extras: rows[0] || null });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/employee/extras/:extension', requireAuth, async (req, res) => {
    try {
        const extension = String(req.params.extension || '').trim();
        const title = String(req.body.title || '').trim();
        const empGroup = String(req.body.emp_group || '').trim();
        const photo = req.body.photo ? String(req.body.photo).trim() : null;

        if (!/^\d+$/.test(extension)) {
            return res.status(400).json({ success: false, error: 'Valid numeric extension is required' });
        }
        if (title.length > 255) {
            return res.status(400).json({ success: false, error: 'Employee title must be 255 characters or fewer' });
        }
        if (photo && !/^\/photos\/emp_[A-Za-z0-9_.-]+$/.test(photo)) {
            return res.status(400).json({ success: false, error: 'Invalid employee photo URL' });
        }

        const [extensions] = await pool.query(
            `SELECT extension FROM ${tables.users} WHERE extension = ?`,
            [extension]
        );
        if (!extensions.length) {
            return res.status(404).json({ success: false, error: 'Extension not found' });
        }
        if (empGroup) {
            const [groups] = await pool.query(
                `SELECT id FROM ${tables.employeeGroups} WHERE name = ?`,
                [empGroup]
            );
            if (!groups.length) {
                return res.status(400).json({ success: false, error: 'Employee group does not exist' });
            }
        }

        const [currentRows] = await pool.query(
            `SELECT photo FROM ${tables.employeeExtras} WHERE extension = ?`,
            [extension]
        );
        const previousPhoto = currentRows[0]?.photo || null;

        if (!photo && !title && !empGroup) {
            await pool.query(`DELETE FROM ${tables.employeeExtras} WHERE extension = ?`, [extension]);
        } else {
            await pool.query(`
                INSERT INTO ${tables.employeeExtras} (extension, photo, title, emp_group)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    photo = VALUES(photo),
                    title = VALUES(title),
                    emp_group = VALUES(emp_group)
            `, [extension, photo, title || null, empGroup || null]);
        }

        if (previousPhoto && previousPhoto !== photo) removeEmployeePhoto(previousPhoto);
        res.json({
            success: true,
            extras: { photo, title: title || null, emp_group: empGroup || null }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/employee/group-assignment — Assign one extension to an employee group (Live Panel drag & drop).
// Updates only emp_group; photo and title on the extras row are preserved.
app.put('/api/employee/group-assignment', requireAuth, async (req, res) => {
    try {
        const extension = String(req.body.extension || '').trim();
        const groupName = String(req.body.group || '').trim();
        if (!/^\d+$/.test(extension)) {
            return res.status(400).json({ success: false, error: 'Valid numeric extension is required' });
        }
        const [extensions] = await pool.query(
            `SELECT extension FROM ${tables.users} WHERE extension = ?`,
            [extension]
        );
        if (!extensions.length) {
            return res.status(404).json({ success: false, error: 'Extension not found' });
        }

        let targetGroup = null;
        if (groupName) {
            const [groups] = await pool.query(
                `SELECT name FROM ${tables.employeeGroups} WHERE name = ?`,
                [groupName]
            );
            if (!groups.length) {
                return res.status(400).json({ success: false, error: 'Employee group does not exist' });
            }
            targetGroup = groups[0].name;
        }

        if (targetGroup === null) {
            await pool.query(
                `UPDATE ${tables.employeeExtras} SET emp_group = NULL WHERE extension = ?`,
                [extension]
            );
        } else {
            await pool.query(`
                INSERT INTO ${tables.employeeExtras} (extension, photo, title, emp_group)
                VALUES (?, NULL, NULL, ?)
                ON DUPLICATE KEY UPDATE emp_group = VALUES(emp_group)
            `, [extension, targetGroup]);
        }

        res.json({ success: true, extension, emp_group: targetGroup });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 2. RING GROUPS MANAGEMENT APIs ---

// GET /api/config/ringgroups - List all Ring Groups
app.get('/api/config/ringgroups', async (req, res) => {
    try {
        const [ringgroups] = await pool.query(`
            SELECT grpnum, strategy, grptime, grplist, description, annmsg_id, postdest, cwignore, recording, ringing
            FROM \`asterisk\`.\`ringgroups\`
            ORDER BY CAST(grpnum AS UNSIGNED) ASC
        `);
        res.json({ success: true, ringgroups });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/ringgroups - Create Ring Group
app.post('/api/config/ringgroups', async (req, res) => {
    try {
        const { grpnum, description, grplist, strategy, grptime, annmsg_id, ringing, postdest } = req.body;
        if (!grpnum || !/^\d+$/.test(grpnum)) {
            return res.status(400).json({ success: false, error: 'Valid numeric Ring Group number is required.' });
        }
        if (!description || !description.trim()) {
            return res.status(400).json({ success: false, error: 'Description is required.' });
        }
        if (!grplist || !grplist.trim()) {
            return res.status(400).json({ success: false, error: 'Extension List is required.' });
        }

        const num = String(grpnum).trim();
        const desc = String(description).trim();

        // Format extension list (e.g. "101-102-103")
        const extListFormatted = String(grplist).replace(/[\r\n, ]+/g, '-').replace(/^-+|-+$/g, '');
        const ringStrategy = strategy || 'ringall';
        const ringTime = parseInt(grptime, 10) || 20;
        const annMsgId = parseInt(annmsg_id, 10) || 0;
        const postDest = (postdest && postdest.trim()) ? postdest.trim() : `ext-group,${num},1`;
        const mohRinging = (ringing && String(ringing).trim()) ? String(ringing).trim() : 'Ring';

        const [existing] = await pool.query('SELECT grpnum FROM `asterisk`.`ringgroups` WHERE grpnum = ?', [num]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, error: `Ring Group ${num} already exists.` });
        }

        // Defaults: skip busy agent -> cwignore='CHECKED', record calls -> recording='always'
        await pool.query(`
            INSERT INTO \`asterisk\`.\`ringgroups\` 
            (grpnum, strategy, grptime, grppre, grplist, annmsg_id, postdest, description, alertinfo, remotealert_id, needsconf, toolate_id, ringing, cwignore, cfignore, cpickup, recording)
            VALUES (?, ?, ?, '', ?, ?, ?, ?, '', 0, '', 0, ?, 'CHECKED', '', '', 'always')
        `, [num, ringStrategy, ringTime, extListFormatted, annMsgId, postDest, desc, mohRinging]);

        reloadPbxConfig();
        res.json({ success: true, message: `Ring Group ${num} created with Skip Busy=Yes & Record=Always successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/ringgroups/:grpnum - Modify Ring Group
app.put('/api/config/ringgroups/:grpnum', async (req, res) => {
    try {
        const num = String(req.params.grpnum).trim();
        const { description, grplist, strategy, grptime, annmsg_id, ringing, postdest } = req.body;

        const desc = String(description || '').trim();
        const extListFormatted = String(grplist || '').replace(/[\r\n, ]+/g, '-').replace(/^-+|-+$/g, '');
        const ringStrategy = strategy || 'ringall';
        const ringTime = parseInt(grptime, 10) || 20;
        const annMsgId = parseInt(annmsg_id, 10) || 0;
        const postDest = (postdest && postdest.trim()) ? postdest.trim() : `ext-group,${num},1`;
        const mohRinging = (ringing && String(ringing).trim()) ? String(ringing).trim() : 'Ring';

        await pool.query(`
            UPDATE \`asterisk\`.\`ringgroups\`
            SET description = ?, grplist = ?, strategy = ?, grptime = ?, annmsg_id = ?, cwignore = 'CHECKED', recording = 'always', postdest = ?, ringing = ?
            WHERE grpnum = ?
        `, [desc, extListFormatted, ringStrategy, ringTime, annMsgId, postDest, mohRinging, num]);

        reloadPbxConfig();
        res.json({ success: true, message: `Ring Group ${num} updated successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/ringgroups/:grpnum - Delete Ring Group
app.delete('/api/config/ringgroups/:grpnum', async (req, res) => {
    try {
        const num = String(req.params.grpnum).trim();
        await pool.query('DELETE FROM `asterisk`.`ringgroups` WHERE grpnum = ?', [num]);
        reloadPbxConfig();
        res.json({ success: true, message: `Ring Group ${num} deleted successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 2.5 QUEUES MANAGEMENT APIs ---


async function syncAstDbQueueAgents(num, dynmembers) {
    try {
        let dynArr = [];
        if (Array.isArray(dynmembers)) dynArr = dynmembers;
        else if (typeof dynmembers === 'string') dynArr = dynmembers.split(/[\r\n, ]+/).filter(Boolean);

        await execPromise(`asterisk -rx "database deltree QPENALTY/${num}"`);
        for (const ext of dynArr) {
            const cleanExt = String(ext).trim();
            if (cleanExt) {
                await execPromise(`asterisk -rx "database put QPENALTY/${num}/agents ${cleanExt} 0"`);
            }
        }
    } catch (e) {
        console.error(`AstDB QPENALTY sync error for queue ${num}:`, e.message);
    }
}

// GET /api/config/queues - List all Queues
app.get('/api/config/queues', async (req, res) => {
    try {
        const [configRows] = await pool.query(`
            SELECT extension, descr, maxwait, cwignore, joinannounce_id, dest, destcontinue, monitor_type
            FROM \`asterisk\`.\`queues_config\`
            ORDER BY CAST(extension AS UNSIGNED) ASC
        `);

        const [detailsRows] = await pool.query(`
            SELECT id, keyword, data
            FROM \`asterisk\`.\`queues_details\`
        `);

        const detailsMap = {};
        for (const row of detailsRows) {
            if (!detailsMap[row.id]) detailsMap[row.id] = {};
            if (row.keyword === 'member') {
                if (!detailsMap[row.id].members) detailsMap[row.id].members = [];
                detailsMap[row.id].members.push(row.data);
            } else {
                detailsMap[row.id][row.keyword] = row.data;
            }
        }

        const queues = configRows.map(q => {
            const d = detailsMap[q.extension] || {};
            const staticMembers = (d.members || []).map(m => {
                const match = String(m).match(/(\d+)/);
                return match ? match[1] : String(m).trim();
            });

            return {
                extension: q.extension,
                descr: q.descr,
                maxwait: q.maxwait || d.maxwait || '0',
                cwignore: q.cwignore,
                joinannounce_id: q.joinannounce_id || 0,
                dest: q.dest || d.goto || 'app-blackhole,hangup,1',
                destcontinue: q.destcontinue || 'app-blackhole,hangup,1',
                monitor_type: q.monitor_type,
                strategy: d.strategy || 'rrmemory',
                autofill: d.autofill || 'yes',
                musicclass: d.musicclass || d.music || 'default',
                timeout: d.timeout || '15',
                retry: d.retry || '5',
                static_members: staticMembers,
                dynmembers: (d.dynmembers || '').split(/[\r\n, ]+/).filter(Boolean).join(', ')
            };
        });

        res.json({ success: true, queues });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/queues - Create Queue
app.post('/api/config/queues', async (req, res) => {
    try {
        const {
            extension, descr, static_members, dynmembers, musicclass,
            joinannounce_id, recording, maxwait, timeout, retry, dest, failover, destcontinue,
            strategy, autofill, skip_busy
        } = req.body;

        const num = String(extension || '').trim();
        if (!num || !/^\d+$/.test(num)) {
            return res.status(400).json({ success: false, error: 'Valid numeric Queue number is required.' });
        }
        const name = String(descr || '').trim();
        if (!name) {
            return res.status(400).json({ success: false, error: 'Queue Name is required.' });
        }

        const [existing] = await pool.query('SELECT extension FROM `asterisk`.`queues_config` WHERE extension = ?', [num]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, error: `Queue ${num} already exists.` });
        }

        const ringStrategy = strategy || 'rrmemory';
        const isAutofill = autofill === 'no' ? 'no' : 'yes';
        const skipBusy = skip_busy === 'no' ? 'no' : 'yes';
        const cwignoreVal = skipBusy === 'yes' ? 1 : 0;
        const ringInUseVal = skipBusy === 'yes' ? 'no' : 'yes';
        const isRecording = recording === 'no' ? 'no' : 'yes';
        const monitorTypeVal = isRecording === 'yes' ? 'bgrnd' : '';
        const mohClass = musicclass || 'default';
        const annId = parseInt(joinannounce_id, 10) || 0;
        const maxWaitVal = String(maxwait !== undefined && maxwait !== null ? maxwait : '0');
        const agentTimeoutVal = String(timeout || '15');
        const retryVal = String(retry || '5');
        const failDest = String(dest || failover || req.body.goto || '').trim() || 'app-blackhole,hangup,1';
        const continueDest = String(destcontinue || req.body.continue_dest || '').trim() || 'app-blackhole,hangup,1';

        await pool.query(`
            INSERT INTO \`asterisk\`.\`queues_config\`
            (extension, descr, grppre, alertinfo, joinannounce_id, ringing, agentannounce_id, maxwait, password, ivr_id, callback_id, dest, destcontinue, cwignore, qregex, queuewait, use_queue_context, togglehint, qnoanswer, callconfirm, callconfirm_id, monitor_type, monitor_heard, monitor_spoken)
            VALUES (?, ?, '', '', ?, 0, 0, ?, '', 'none', 'none', ?, ?, ?, '', 0, 0, 0, 0, 0, 0, ?, 0, 0)
        `, [num, name, annId, maxWaitVal, failDest, continueDest, cwignoreVal, monitorTypeVal]);
        const details = [
            [num, 'strategy', ringStrategy, 0],
            [num, 'autofill', isAutofill, 0],
            [num, 'ringinuse', ringInUseVal, 0],
            [num, 'musicclass', mohClass, 0],
            [num, 'music', mohClass, 0],
            [num, 'timeout', agentTimeoutVal, 0],
            [num, 'retry', retryVal, 0],
            [num, 'maxwait', maxWaitVal, 0],
            [num, 'goto', failDest, 0],
            [num, 'announce-frequency', '0', 0],
            [num, 'announce-holdtime', 'no', 0],
            [num, 'announce-position', 'no', 0],
            [num, 'queue-youarenext', 'silence/1', 0],
            [num, 'queue-thereare', 'silence/1', 0],
            [num, 'queue-callswaiting', 'silence/1', 0],
            [num, 'periodic-announce-frequency', '0', 0],
            [num, 'joinempty', 'yes', 0],
            [num, 'leavewhenempty', 'no', 0],
            [num, 'monitor-join', 'yes', 0],
            [num, 'wrapuptime', '0', 0],
            [num, 'maxlen', '0', 0]
        ];

        if (isRecording === 'yes') {
            details.push([num, 'monitor-format', 'wav', 0]);
        }

        let staticArr = [];
        if (Array.isArray(static_members)) staticArr = static_members;
        else if (typeof static_members === 'string') staticArr = static_members.split(/[\r\n, ]+/).filter(Boolean);

        for (let idx = 0; idx < staticArr.length; idx++) {
            const rawExt = String(staticArr[idx]).trim().replace(/^[A-Za-z]+\//, '').replace(/@.*/, '');
            const match = rawExt.match(/(\d+)/);
            const extNum = match ? match[1] : rawExt;
            if (!extNum) continue;
            details.push([num, 'member', `Local/${extNum}@from-queue/n,0`, idx]);
        }

        let dynArr = [];
        if (Array.isArray(dynmembers)) dynArr = dynmembers;
        else if (typeof dynmembers === 'string') dynArr = dynmembers.split(/[\r\n, ]+/).filter(Boolean);

        const cleanDynArr = dynArr.map(s => {
            const clean = String(s).trim().replace(/^[A-Za-z]+\//, '').replace(/@.*/, '');
            const match = clean.match(/(\d+)/);
            return match ? `${match[1]},0` : clean;
        }).filter(Boolean);

        if (cleanDynArr.length > 0) {
            details.push([num, 'dynmembers', cleanDynArr.join('\n'), 0]);
        }
        for (const row of details) {
            await pool.query('INSERT INTO `asterisk`.`queues_details` (id, keyword, data, flags) VALUES (?, ?, ?, ?)', row);
        }

        await syncAstDbQueueAgents(num, dynmembers);
        reloadPbxConfig();

        res.json({ success: true, message: `Queue ${num} created successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/queues/:extension - Modify Queue
app.put('/api/config/queues/:extension', async (req, res) => {
    try {
        const num = String(req.params.extension).trim();
        const {
            descr, static_members, dynmembers, musicclass,
            joinannounce_id, recording, maxwait, timeout, retry, dest, failover, destcontinue,
            strategy, autofill, skip_busy
        } = req.body;

        const name = String(descr || '').trim();
        if (!name) {
            return res.status(400).json({ success: false, error: 'Queue Name is required.' });
        }

        const ringStrategy = strategy || 'rrmemory';
        const isAutofill = autofill === 'no' ? 'no' : 'yes';
        const skipBusy = skip_busy === 'no' ? 'no' : 'yes';
        const cwignoreVal = skipBusy === 'yes' ? 1 : 0;
        const ringInUseVal = skipBusy === 'yes' ? 'no' : 'yes';
        const isRecording = recording === 'no' ? 'no' : 'yes';
        const monitorTypeVal = isRecording === 'yes' ? 'bgrnd' : '';
        const mohClass = musicclass || 'default';
        const annId = parseInt(joinannounce_id, 10) || 0;
        const maxWaitVal = String(maxwait !== undefined && maxwait !== null ? maxwait : '0');
        const agentTimeoutVal = String(timeout || '15');
        const retryVal = String(retry || '5');
        const failDest = String(dest || failover || req.body.goto || '').trim() || 'app-blackhole,hangup,1';
        const continueDest = String(destcontinue || req.body.continue_dest || '').trim() || 'app-blackhole,hangup,1';

        await pool.query(`
            UPDATE \`asterisk\`.\`queues_config\`
            SET descr = ?, joinannounce_id = ?, maxwait = ?, dest = ?, destcontinue = ?, cwignore = ?, monitor_type = ?
            WHERE extension = ?
        `, [name, annId, maxWaitVal, failDest, continueDest, cwignoreVal, monitorTypeVal, num]);
        await pool.query('DELETE FROM `asterisk`.`queues_details` WHERE id = ?', [num]);

        const details = [
            [num, 'strategy', ringStrategy, 0],
            [num, 'autofill', isAutofill, 0],
            [num, 'ringinuse', ringInUseVal, 0],
            [num, 'musicclass', mohClass, 0],
            [num, 'music', mohClass, 0],
            [num, 'timeout', agentTimeoutVal, 0],
            [num, 'retry', retryVal, 0],
            [num, 'maxwait', maxWaitVal, 0],
            [num, 'goto', failDest, 0],
            [num, 'announce-frequency', '0', 0],
            [num, 'announce-holdtime', 'no', 0],
            [num, 'announce-position', 'no', 0],
            [num, 'queue-youarenext', 'silence/1', 0],
            [num, 'queue-thereare', 'silence/1', 0],
            [num, 'queue-callswaiting', 'silence/1', 0],
            [num, 'periodic-announce-frequency', '0', 0],
            [num, 'joinempty', 'yes', 0],
            [num, 'leavewhenempty', 'no', 0],
            [num, 'monitor-join', 'yes', 0],
            [num, 'wrapuptime', '0', 0],
            [num, 'maxlen', '0', 0]
        ];

        if (isRecording === 'yes') {
            details.push([num, 'monitor-format', 'wav', 0]);
        }

        let staticArr = [];
        if (Array.isArray(static_members)) staticArr = static_members;
        else if (typeof static_members === 'string') staticArr = static_members.split(/[\r\n, ]+/).filter(Boolean);

        for (let idx = 0; idx < staticArr.length; idx++) {
            const rawExt = String(staticArr[idx]).trim().replace(/^[A-Za-z]+\//, '').replace(/@.*/, '');
            const match = rawExt.match(/(\d+)/);
            const extNum = match ? match[1] : rawExt;
            if (!extNum) continue;
            details.push([num, 'member', `Local/${extNum}@from-queue/n,0`, idx]);
        }

        let dynArr = [];
        if (Array.isArray(dynmembers)) dynArr = dynmembers;
        else if (typeof dynmembers === 'string') dynArr = dynmembers.split(/[\r\n, ]+/).filter(Boolean);

        const cleanDynArr = dynArr.map(s => {
            const clean = String(s).trim().replace(/^[A-Za-z]+\//, '').replace(/@.*/, '');
            const match = clean.match(/(\d+)/);
            return match ? `${match[1]},0` : clean;
        }).filter(Boolean);

        if (cleanDynArr.length > 0) {
            details.push([num, 'dynmembers', cleanDynArr.join('\n'), 0]);
        }

        for (const row of details) {
            await pool.query('INSERT INTO `asterisk`.`queues_details` (id, keyword, data, flags) VALUES (?, ?, ?, ?)', row);
        }

        await syncAstDbQueueAgents(num, dynmembers);
        reloadPbxConfig();

        res.json({ success: true, message: `Queue ${num} updated successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/queues/:extension - Delete Queue
app.delete('/api/config/queues/:extension', async (req, res) => {
    try {
        const num = String(req.params.extension).trim();
        await pool.query('DELETE FROM `asterisk`.`queues_config` WHERE extension = ?', [num]);
        await pool.query('DELETE FROM `asterisk`.`queues_details` WHERE id = ?', [num]);
        try {
            await execPromise(`asterisk -rx "database deltree QPENALTY/${num}"`);
        } catch(e) {}
        reloadPbxConfig();
        res.json({ success: true, message: `Queue ${num} deleted successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- SYSTEM RECORDINGS MANAGEMENT APIs ---

// GET /api/config/recordings - List all system recordings
app.get('/api/config/recordings', async (req, res) => {
    try {
        const [recordings] = await pool.query(`
            SELECT id, displayname, CAST(filename AS CHAR) AS filename, description
            FROM \`asterisk\`.\`recordings\`
            WHERE displayname != '__invalid'
            ORDER BY id DESC
        `);
        const cleanRecordings = recordings.map(r => ({ ...r, filename: String(r.filename) }));
        res.json({ success: true, recordings: cleanRecordings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/recordings/:id - Delete system recording
app.delete('/api/config/recordings/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid recording ID.' });

        const [rows] = await pool.query('SELECT CAST(filename AS CHAR) AS filename FROM `asterisk`.`recordings` WHERE id = ?', [id]);
        if (rows.length > 0) {
            const relFile = String(rows[0].filename);
            if (relFile) {
                const soundPath = path.join('/var/lib/asterisk/sounds', relFile + '.wav');
                if (fs.existsSync(soundPath)) {
                    try { fs.unlinkSync(soundPath); } catch (e) {}
                }
            }
            await pool.query('DELETE FROM `asterisk`.`recordings` WHERE id = ?', [id]);
        }
        res.json({ success: true, message: 'Recording deleted successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/config/recordings/audio/:id - Stream or download system recording
app.get('/api/config/recordings/audio/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).send("Invalid recording ID.");

        const [rows] = await pool.query('SELECT CAST(filename AS CHAR) AS filename, displayname FROM `asterisk`.`recordings` WHERE id = ?', [id]);
        if (!rows.length || !rows[0].filename) return res.status(404).send("Recording not found.");

        const relFile = String(rows[0].filename);
        const soundPath = path.join('/var/lib/asterisk/sounds', relFile + '.wav');
        if (!fs.existsSync(soundPath)) return res.status(404).send("Recording file missing on disk.");

        const displayFilename = (rows[0].displayname || path.basename(relFile)) + '.wav';
        const isDownload = req.query.download === '1';

        if (isDownload) {
            return res.download(soundPath, displayFilename, (err) => {
                if (err && !res.headersSent) {
                    res.status(500).send("Recording Download Error: " + err.message);
                }
            });
        }

        const stat = fs.statSync(soundPath);
        const fileSize = stat.size;
        const contentType = 'audio/wav';
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = end - start + 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': contentType
            });
            fs.createReadStream(soundPath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes',
                'Content-Disposition': `inline; filename="${displayFilename}"`
            });
            fs.createReadStream(soundPath).pipe(res);
        }
    } catch (err) {
        res.status(500).send("Audio Error: " + err.message);
    }
});
// --- ANNOUNCEMENTS MANAGEMENT APIs ---

// GET /api/config/announcements - List all announcements
app.get('/api/config/announcements', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT a.announcement_id, a.description, a.recording_id, a.allow_skip, a.post_dest, a.return_ivr, a.noanswer, a.repeat_msg, a.tts_lang, a.tts_text,
                   r.displayname AS recording_name
            FROM \`asterisk\`.\`announcement\` a
            LEFT JOIN \`asterisk\`.\`recordings\` r ON a.recording_id = r.id
            ORDER BY CAST(a.announcement_id AS UNSIGNED) ASC
        `);
        res.json({ success: true, announcements: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/announcements - Create Announcement
app.post('/api/config/announcements', async (req, res) => {
    try {
        const { description, recording_id, allow_skip, post_dest, return_ivr, noanswer, repeat_msg, tts_lang, tts_text } = req.body;
        const name = String(description || '').trim();
        if (!name) {
            return res.status(400).json({ success: false, error: 'Announcement Description/Name is required.' });
        }
        const recId = parseInt(recording_id, 10) || 0;
        const allowSkipVal = recId === 0 ? 0 : (allow_skip ? 1 : 0);
        const returnIvrVal = return_ivr ? 1 : 0;
        const noAnswerVal = noanswer ? 1 : 0;
        const repeatMsgVal = String(repeat_msg || '').trim();
        const postDestVal = String(post_dest || '').trim() || 'app-blackhole,hangup,1';
        const SUPPORTED_TTS_LANGS = ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'it-IT', 'de-DE'];
        const rawTtsLang = String(tts_lang || '').trim();
        const ttsLangVal = recId === 0 ? (SUPPORTED_TTS_LANGS.includes(rawTtsLang) ? rawTtsLang : 'en-US') : 'en-US';
        const ttsTextVal = recId === 0 ? String(tts_text || '').trim() : '';

        const [r] = await pool.query(`
            INSERT INTO \`asterisk\`.\`announcement\`
            (description, recording_id, allow_skip, post_dest, return_ivr, noanswer, repeat_msg, tts_lang, tts_text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [name, recId, allowSkipVal, postDestVal, returnIvrVal, noAnswerVal, repeatMsgVal, ttsLangVal, ttsTextVal]);

        const reloadRes = await reloadPbxConfigPromise();
        res.json({
            success: true,
            id: r.insertId,
            announcement_id: r.insertId,
            message: `Announcement '${name}' created successfully.`,
            applied: reloadRes.success,
            reloadError: reloadRes.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/announcements/:id - Modify Announcement
app.put('/api/config/announcements/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid announcement ID.' });

        const { description, recording_id, allow_skip, post_dest, return_ivr, noanswer, repeat_msg, tts_lang, tts_text } = req.body;
        const name = String(description || '').trim();
        if (!name) {
            return res.status(400).json({ success: false, error: 'Announcement Description/Name is required.' });
        }
        const recId = parseInt(recording_id, 10) || 0;
        const allowSkipVal = recId === 0 ? 0 : (allow_skip ? 1 : 0);
        const returnIvrVal = return_ivr ? 1 : 0;
        const noAnswerVal = noanswer ? 1 : 0;
        const repeatMsgVal = String(repeat_msg || '').trim();
        const postDestVal = String(post_dest || '').trim() || 'app-blackhole,hangup,1';
        const SUPPORTED_TTS_LANGS = ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'it-IT', 'de-DE'];
        const rawTtsLang = String(tts_lang || '').trim();
        const ttsLangVal = recId === 0 ? (SUPPORTED_TTS_LANGS.includes(rawTtsLang) ? rawTtsLang : 'en-US') : 'en-US';
        const ttsTextVal = recId === 0 ? String(tts_text || '').trim() : '';

        await pool.query(`
            UPDATE \`asterisk\`.\`announcement\`
            SET description = ?, recording_id = ?, allow_skip = ?, post_dest = ?, return_ivr = ?, noanswer = ?, repeat_msg = ?, tts_lang = ?, tts_text = ?
            WHERE announcement_id = ?
        `, [name, recId, allowSkipVal, postDestVal, returnIvrVal, noAnswerVal, repeatMsgVal, ttsLangVal, ttsTextVal, id]);

        const reloadRes = await reloadPbxConfigPromise();
        res.json({
            success: true,
            message: `Announcement '${name}' updated successfully.`,
            applied: reloadRes.success,
            reloadError: reloadRes.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/announcements/:id - Delete Announcement
app.delete('/api/config/announcements/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid announcement ID.' });

        await pool.query('DELETE FROM `asterisk`.`announcement` WHERE announcement_id = ?', [id]);

        const reloadRes = await reloadPbxConfigPromise();
        res.json({
            success: true,
            message: 'Announcement deleted successfully.',
            applied: reloadRes.success,
            reloadError: reloadRes.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// --- 3. TRUNKS MANAGEMENT APIs ---

// Parse Issabel-style key=value configuration. Repeated keys are joined with
// "&", matching core_trunks_addSipOrIax() in Issabel's core module.
function parseDetailsText(rawText) {
    const details = new Map();
    for (let line of String(rawText || '').split(/[\r\n]+/)) {
        line = line.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) continue;
        const separator = line.indexOf('=');
        if (separator <= 0) continue;
        const keyword = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        if (!keyword || !value) continue;
        details.set(keyword, details.has(keyword) ? `${details.get(keyword)}&${value}` : value);
    }
    return details;
}

function trunkProtocolTable(tech) {
    if (tech === 'sip') return 'sip';
    if (tech === 'iax2' || tech === 'iax') return 'iax';
    return null;
}

function normalizeTrunkPayload(body) {
    const requestedTech = String(body.tech || 'custom').trim().toLowerCase();
    const tech = requestedTech === 'iax' ? 'iax2' : requestedTech;
    const has = key => Object.prototype.hasOwnProperty.call(body, key);
    return {
        name: String(body.name || '').trim(),
        tech,
        channelid: String(body.channelid || '').trim().replace(/^dongle\/I:/, 'dongle/i:'),
        host: has('host') ? String(body.host || '').trim() : undefined,
        username: has('username') ? String(body.username || '').trim() : undefined,
        secret: has('secret') ? String(body.secret || '').trim() : undefined,
        context: has('context') ? String(body.context || '').trim() : undefined,
        register: String(body.register || '').trim(),
        usercontext: String(body.usercontext || '').trim(),
        outcid: String(body.outcid || '').trim(),
        keepcid: ['off', 'on', 'cnum', 'all'].includes(String(body.keepcid || '').trim())
            ? String(body.keepcid).trim()
            : 'off',
        maxchans: String(body.maxchans || '').trim(),
        dialoutprefix: String(body.dialoutprefix || '').trim(),
        disabled: String(body.disabled || '').trim() === 'on' ? 'on' : 'off',
        dialopts: String(body.dialopts || '').trim(),
        continue: String(body.continue || '').trim() === 'on' ? 'on' : 'off',
        failscript: String(body.failscript || '').trim(),
        peerdetails: String(body.peerdetails || ''),
        userdetails: String(body.userdetails || ''),
        dialrules: normalizeTrunkDialRules(body.dialrules || body.dialpatterns)
    };
}

function validateTrunkPayload(input) {
    if (!input.name) return 'Trunk Name is required.';
    if (!['custom', 'sip', 'iax2'].includes(input.tech)) return 'Unsupported trunk technology.';
    if (!input.channelid) {
        return input.tech === 'custom'
            ? 'Custom Dial String is required for Custom trunks.'
            : 'Outgoing Trunk Name is required for SIP/IAX2 trunks.';
    }
    return null;
}

function normalizeTrunkDialRules(rawRules) {
    if (!Array.isArray(rawRules)) return [];
    const rules = [];
    const seen = new Set();
    for (const rule of rawRules) {
        const prefix = String(rule.prefix || rule.match_pattern_prefix || '')
            .trim().toUpperCase().replace(/[^0-9*#+XNZ\-[\]]/g, '');
        const pattern = String(rule.pattern || rule.match_pattern || rule.match_pattern_pass || '')
            .trim().toUpperCase().replace(/[^0-9.*#+XNZ\-[\]]/g, '');
        const prepend = String(rule.prepend || rule.prepend_digits || '')
            .trim().toUpperCase().replace(/[^0-9+*#W]/g, '').replace(/W/g, 'w');
        if (!prefix && !pattern) continue;
        const identity = `${prefix}\0${pattern}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        rules.push({ prefix, pattern, prepend });
    }
    return rules;
}

function buildPeerDetails(input) {
    const details = parseDetailsText(input.peerdetails);
    const suppliedDetails = details.size > 0;
    details.delete('account');
    details.delete('register');
    for (const [keyword, value] of [
        ['host', input.host],
        ['username', input.username],
        ['secret', input.secret],
        ['context', input.context]
    ]) {
        if (value === undefined) continue;
        if (value) details.set(keyword, value);
        else details.delete(keyword);
    }
    if (!suppliedDetails) {
        if (!details.has('type')) details.set('type', 'peer');
        if (!details.has('context')) details.set('context', 'from-trunk');
        if (!details.has('qualify')) details.set('qualify', 'yes');
        if (input.tech === 'sip' && !details.has('insecure')) details.set('insecure', 'port,invite');
    }
    return details;
}

function buildUserDetails(input) {
    const details = parseDetailsText(input.userdetails);
    const suppliedDetails = details.size > 0;
    details.delete('account');
    details.delete('register');
    if (!suppliedDetails) {
        if (input.secret) details.set('secret', input.secret);
        details.set('type', 'user');
        details.set('context', input.context || 'from-trunk');
    }
    return details;
}

async function insertTrunkProtocolRows(db, table, id, account, details, disableFlag) {
    const items = [['account', account], ...details.entries()].filter(([, value]) => value !== '');
    if (items.length === 0) return;
    const placeholders = [];
    const params = [];
    let sequence = 1;
    for (const [keyword, value] of items) {
        sequence = disableFlag === 1 ? 1 : sequence + 1;
        placeholders.push('(?, ?, ?, ?)');
        params.push(id, keyword, value, sequence);
    }
    await db.query(
        `INSERT INTO \`asterisk\`.\`${table}\` (id, keyword, data, flags) VALUES ${placeholders.join(', ')}`,
        params
    );
}

async function deleteTrunkProtocolRows(db, trunkId) {
    const ids = [`tr-peer-${trunkId}`, `tr-user-${trunkId}`, `tr-reg-${trunkId}`, `tr-trunk-${trunkId}`];
    for (const table of ['sip', 'iax']) {
        await db.query(
            `DELETE FROM \`asterisk\`.\`${table}\` WHERE id IN (?, ?, ?, ?)`,
            ids
        );
    }
}

async function replaceTrunkProtocolRows(db, trunkId, input) {
    await deleteTrunkProtocolRows(db, trunkId);
    const table = trunkProtocolTable(input.tech);
    if (!table) return;

    const disableFlag = input.disabled === 'on' ? 1 : 0;
    await insertTrunkProtocolRows(
        db,
        table,
        `tr-peer-${trunkId}`,
        input.channelid,
        buildPeerDetails(input),
        disableFlag
    );
    if (input.usercontext) {
        await insertTrunkProtocolRows(
            db,
            table,
            `tr-user-${trunkId}`,
            input.usercontext,
            buildUserDetails(input),
            disableFlag
        );
    }
    if (input.register) {
        await db.query(
            `INSERT INTO \`asterisk\`.\`${table}\` (id, keyword, data, flags) VALUES (?, 'register', ?, ?)`,
            [`tr-reg-${trunkId}`, input.register, disableFlag]
        );
    }
}

async function replaceTrunkDialRules(db, trunkId, rules) {
    await db.query('DELETE FROM `asterisk`.`trunk_dialpatterns` WHERE trunkid = ?', [trunkId]);
    if (rules.length === 0) return;
    const placeholders = [];
    const params = [];
    rules.forEach((rule, sequence) => {
        placeholders.push('(?, ?, ?, ?, ?)');
        params.push(trunkId, rule.prefix, rule.pattern, rule.prepend, sequence);
    });
    await db.query(
        `INSERT INTO \`asterisk\`.\`trunk_dialpatterns\` (trunkid, match_pattern_prefix, match_pattern_pass, prepend_digits, seq) VALUES ${placeholders.join(', ')}`,
        params
    );
}

async function applyTrunkRuntimeConfig(trunkId, dialopts, remove = false) {
    let runtimeError = '';
    try {
        if (remove || !dialopts) {
            await execFileAsync(ASTERISK_BIN, ['-rx', `database del TRUNK ${trunkId}/dialopts`]);
        } else {
            await execFileAsync(ASTERISK_BIN, ['-rx', `database put TRUNK ${trunkId}/dialopts ${dialopts}`]);
        }
    } catch (error) {
        runtimeError = error.message;
    }
    const reloadResult = await reloadPbxConfigPromise();
    return {
        success: !runtimeError && reloadResult.success,
        error: [runtimeError, reloadResult.error].filter(Boolean).join('; ') || undefined
    };
}

// GET /api/config/trunks - List Trunks
app.get('/api/config/trunks', async (req, res) => {
    try {
        const [trunks] = await pool.query(`
            SELECT trunkid, name, tech, outcid, keepcid, maxchans, failscript, dialoutprefix, channelid, disabled, \`continue\`, usercontext
            FROM \`asterisk\`.\`trunks\`
            ORDER BY trunkid ASC
        `);

        for (const trunk of trunks) {
            const [ruleRows] = await pool.query(
                'SELECT match_pattern_prefix, match_pattern_pass, prepend_digits FROM `asterisk`.`trunk_dialpatterns` WHERE trunkid = ? ORDER BY seq ASC',
                [trunk.trunkid]
            );
            trunk.dialpatterns = ruleRows.map(row => ({
                prepend: row.prepend_digits || '',
                prefix: row.match_pattern_prefix || '',
                pattern: row.match_pattern_pass || ''
            }));
            trunk.dialrules = trunk.dialpatterns;
            trunk.host = '';
            trunk.username = '';
            trunk.secret = '';
            trunk.context = 'from-trunk';
            trunk.register = '';
            trunk.dialopts = '';
            trunk.peerdetails = '';
            trunk.userdetails = '';

            const table = trunkProtocolTable(String(trunk.tech || '').toLowerCase());
            if (table) {
                const peerKey = `tr-peer-${trunk.trunkid}`;
                let [peerRows] = await pool.query(
                    `SELECT keyword, data FROM \`asterisk\`.\`${table}\` WHERE id = ? ORDER BY flags ASC, keyword DESC`,
                    [peerKey]
                );
                // Compatibility read for trunks saved by older Sokrat releases.
                if (peerRows.length === 0) {
                    [peerRows] = await pool.query(
                        `SELECT keyword, data FROM \`asterisk\`.\`${table}\` WHERE id = ? ORDER BY flags ASC, keyword DESC`,
                        [`tr-trunk-${trunk.trunkid}`]
                    );
                }
                const peerLines = [];
                for (const row of peerRows) {
                    if (row.keyword === 'host') trunk.host = row.data;
                    if (row.keyword === 'username') trunk.username = row.data;
                    if (row.keyword === 'secret') trunk.secret = row.data;
                    if (row.keyword === 'context') trunk.context = row.data;
                    if (row.keyword === 'register') trunk.register = row.data;
                    if (row.keyword !== 'account' && row.keyword !== 'register') {
                        peerLines.push(`${row.keyword}=${row.data}`);
                    }
                }
                trunk.peerdetails = peerLines.join('\n');

                let [userRows] = await pool.query(
                    `SELECT keyword, data FROM \`asterisk\`.\`${table}\` WHERE id = ? ORDER BY flags ASC, keyword DESC`,
                    [`tr-user-${trunk.trunkid}`]
                );
                // Compatibility read for the former usercontext-as-row-id layout.
                if (userRows.length === 0 && trunk.usercontext) {
                    [userRows] = await pool.query(
                        `SELECT keyword, data FROM \`asterisk\`.\`${table}\` WHERE id = ? ORDER BY flags ASC, keyword DESC`,
                        [trunk.usercontext]
                    );
                }
                trunk.userdetails = userRows
                    .filter(row => row.keyword !== 'account')
                    .map(row => `${row.keyword}=${row.data}`)
                    .join('\n');

                const [registerRows] = await pool.query(
                    `SELECT data FROM \`asterisk\`.\`${table}\` WHERE id = ? AND keyword = 'register'`,
                    [`tr-reg-${trunk.trunkid}`]
                );
                if (registerRows.length > 0) trunk.register = registerRows[0].data || '';
            }

            try {
                const output = await execFileAsync(ASTERISK_BIN, ['-rx', `database get TRUNK ${trunk.trunkid}/dialopts`]);
                const value = output.match(/(?:Value|Result):\s*(.+)$/mi);
                if (value) trunk.dialopts = value[1].trim();
            } catch (_) {
                // No per-trunk override: Issabel uses the global dial options.
            }
        }
        res.json({ success: true, trunks });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/trunks - Create Trunk (Custom, SIP, IAX2)
app.post('/api/config/trunks', async (req, res) => {
    const input = normalizeTrunkPayload(req.body);
    const validationError = validateTrunkPayload(input);
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    let warningMessage;
    let connection;
    let trunkId;
    try {
        if (input.tech === 'custom') {
            const [duplicates] = await pool.query(
                'SELECT trunkid, name FROM `asterisk`.`trunks` WHERE tech = "custom" AND channelid = ?',
                [input.channelid]
            );
            if (duplicates.length > 0) {
                warningMessage = `Warning: Custom dial string '${input.channelid}' already exists in another trunk ('${duplicates[0].name || duplicates[0].trunkid}')`;
            }
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [maxRows] = await connection.query(
            'SELECT COALESCE(MAX(trunkid), 0) + 1 AS nextId FROM `asterisk`.`trunks` FOR UPDATE'
        );
        trunkId = Number(maxRows[0].nextId);
        await connection.query(`
            INSERT INTO \`asterisk\`.\`trunks\`
                (trunkid, name, tech, outcid, keepcid, maxchans, failscript, dialoutprefix, channelid, disabled, \`continue\`, usercontext)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            trunkId, input.name, input.tech, input.outcid, input.keepcid, input.maxchans,
            input.failscript, input.dialoutprefix, input.channelid, input.disabled,
            input.continue, input.usercontext
        ]);
        await replaceTrunkDialRules(connection, trunkId, input.dialrules);
        await replaceTrunkProtocolRows(connection, trunkId, input);
        await connection.commit();
    } catch (error) {
        if (connection) {
            try { await connection.rollback(); } catch (_) {}
        }
        return res.status(500).json({ success: false, error: error.message });
    } finally {
        if (connection) connection.release();
    }

    const applyResult = await applyTrunkRuntimeConfig(trunkId, input.dialopts);
    res.json({
        success: true,
        trunkid: trunkId,
        message: `Trunk '${input.name}' (${input.tech.toUpperCase()}) created successfully.`,
        warningMessage,
        applied: applyResult.success,
        reloadError: applyResult.error
    });
});

// PUT /api/config/trunks/:trunkid - Modify Trunk (Custom, SIP, IAX2)
app.put('/api/config/trunks/:trunkid', async (req, res) => {
    const trunkId = Number.parseInt(req.params.trunkid, 10);
    if (!Number.isInteger(trunkId) || trunkId <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid trunk ID.' });
    }
    const input = normalizeTrunkPayload(req.body);
    const validationError = validateTrunkPayload(input);
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    let warningMessage;
    let connection;
    try {
        if (input.tech === 'custom') {
            const [duplicates] = await pool.query(
                'SELECT trunkid, name FROM `asterisk`.`trunks` WHERE tech = "custom" AND channelid = ? AND trunkid != ?',
                [input.channelid, trunkId]
            );
            if (duplicates.length > 0) {
                warningMessage = `Warning: Custom dial string '${input.channelid}' already exists in another trunk ('${duplicates[0].name || duplicates[0].trunkid}')`;
            }
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [existingRows] = await connection.query(
            'SELECT trunkid FROM `asterisk`.`trunks` WHERE trunkid = ? FOR UPDATE',
            [trunkId]
        );
        if (existingRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, error: 'Trunk not found.' });
        }
        await connection.query(`
            UPDATE \`asterisk\`.\`trunks\`
            SET name = ?, tech = ?, channelid = ?, outcid = ?, keepcid = ?, maxchans = ?,
                failscript = ?, dialoutprefix = ?, disabled = ?, \`continue\` = ?, usercontext = ?
            WHERE trunkid = ?
        `, [
            input.name, input.tech, input.channelid, input.outcid, input.keepcid, input.maxchans,
            input.failscript, input.dialoutprefix, input.disabled, input.continue,
            input.usercontext, trunkId
        ]);
        await replaceTrunkDialRules(connection, trunkId, input.dialrules);
        await replaceTrunkProtocolRows(connection, trunkId, input);
        await connection.commit();
    } catch (error) {
        if (connection) {
            try { await connection.rollback(); } catch (_) {}
        }
        return res.status(500).json({ success: false, error: error.message });
    } finally {
        if (connection) connection.release();
    }

    const applyResult = await applyTrunkRuntimeConfig(trunkId, input.dialopts);
    res.json({
        success: true,
        message: `Trunk ID #${trunkId} updated successfully.`,
        warningMessage,
        applied: applyResult.success,
        reloadError: applyResult.error
    });
});

// DELETE /api/config/trunks/:trunkid - Delete Trunk
app.delete('/api/config/trunks/:trunkid', async (req, res) => {
    const trunkId = Number.parseInt(req.params.trunkid, 10);
    if (!Number.isInteger(trunkId) || trunkId <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid trunk ID.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [existingRows] = await connection.query(
            'SELECT trunkid FROM `asterisk`.`trunks` WHERE trunkid = ? FOR UPDATE',
            [trunkId]
        );
        if (existingRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, error: 'Trunk not found.' });
        }
        await deleteTrunkProtocolRows(connection, trunkId);
        await connection.query('DELETE FROM `asterisk`.`trunk_dialpatterns` WHERE trunkid = ?', [trunkId]);
        await connection.query('DELETE FROM `asterisk`.`outbound_route_trunks` WHERE trunk_id = ?', [trunkId]);
        await connection.query('DELETE FROM `asterisk`.`trunks` WHERE trunkid = ?', [trunkId]);
        await connection.commit();
    } catch (error) {
        if (connection) {
            try { await connection.rollback(); } catch (_) {}
        }
        return res.status(500).json({ success: false, error: error.message });
    } finally {
        if (connection) connection.release();
    }

    const applyResult = await applyTrunkRuntimeConfig(trunkId, '', true);
    res.json({
        success: true,
        message: 'Trunk deleted successfully.',
        applied: applyResult.success,
        reloadError: applyResult.error
    });
});

// Helper to sanitize values used in AMI headers to prevent CRLF injection
function sanitizeAmiValue(raw) {
    if (!raw) return '';
    return String(raw).replace(/[\r\n\0;\x00-\x1F]/g, '').trim();
}

// Helper to clean DID number string while preserving international + prefix and verbatim digits
function normalizeDidNumber(raw) {
    if (!raw) return '';
    let ext = String(raw).replace(/[\r\n\0;\x00-\x1F]/g, '').trim();
    ext = ext.replace(/(?!^\+)[^\d]/g, '');
    return ext;
}

// --- 4. INBOUND & OUTBOUND ROUTES MANAGEMENT APIs ---
// GET /api/config/routes/inbound - List Inbound Routes
app.get('/api/config/routes/inbound', async (req, res) => {
    try {
        const [routes] = await pool.query(`
            SELECT cidnum, extension, destination, description
            FROM \`asterisk\`.\`incoming\`
            ORDER BY description ASC
        `);
        res.json({ success: true, routes });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/routes/inbound - Create Inbound Route
app.post('/api/config/routes/inbound', async (req, res) => {
    try {
        const { description, extension, destination } = req.body;
        if (!description || !description.trim()) {
            return res.status(400).json({ success: false, error: 'Route Description is required.' });
        }
        if (!destination || !destination.trim()) {
            return res.status(400).json({ success: false, error: 'Destination is required.' });
        }

        const desc = String(description).trim();
        const ext = normalizeDidNumber(extension);
        const cid = ''; // Default cidnum to empty string
        const dest = String(destination).trim();

        let warningMessage = null;
        if (ext) {
            const [otherDid] = await pool.query(
                'SELECT description, extension FROM `asterisk`.`incoming` WHERE extension = ? AND description != ?',
                [ext, desc]
            );
            if (otherDid.length > 0) {
                warningMessage = `Warning: DID number '${ext}' already exists in another inbound route ('${otherDid[0].description || otherDid[0].extension}')`;
            }
        }

        const [existing] = await pool.query(
            'SELECT extension FROM `asterisk`.`incoming` WHERE extension = ? AND description = ?',
            [ext, desc]
        );
        if (existing.length > 0) {
            await pool.query(`
                UPDATE \`asterisk\`.\`incoming\`
                SET destination = ?, mohclass = 'default'
                WHERE extension = ? AND description = ?
            `, [dest, ext, desc]);
        } else {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`incoming\`
                (cidnum, extension, destination, answer, wait, privacyman, mohclass, description, grppre, delay_answer, pricid, pmmaxretries, pmminlength)
                VALUES (?, ?, ?, NULL, NULL, 0, 'default', ?, '', 0, '', '3', '10')
            `, [cid, ext, dest, desc]);
        }

        reloadPbxConfig();
        res.json({
            success: true,
            warningMessage: warningMessage || undefined,
            message: `Inbound Route '${desc}' saved successfully.`
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
app.put('/api/config/routes/inbound', async (req, res) => {
    try {
        const { originalExtension, originalDescription, originalDestination, description, extension, destination } = req.body;
        if (!description || !description.trim()) {
            return res.status(400).json({ success: false, error: 'Route Description is required.' });
        }
        if (!destination || !destination.trim()) {
            return res.status(400).json({ success: false, error: 'Destination is required.' });
        }

        const desc = String(description).trim();
        const ext = normalizeDidNumber(extension);
        const dest = String(destination).trim();
        const origExt = normalizeDidNumber(originalExtension);
        const rawOrigExt = String(originalExtension || '').trim();
        const origDesc = String(originalDescription || '').trim();
        const origDest = String(originalDestination || '').trim();

        let warningMessage = null;
        if (ext) {
            const [otherDid] = await pool.query(
                'SELECT description, extension FROM `asterisk`.`incoming` WHERE extension = ? AND description != ? AND extension != ?',
                [ext, origDesc, origExt]
            );
            if (otherDid.length > 0) {
                warningMessage = `Warning: DID number '${ext}' already exists in another inbound route ('${otherDid[0].description || otherDid[0].extension}')`;
            }
        }

        await pool.query(`
            UPDATE \`asterisk\`.\`incoming\`
            SET description = ?, extension = ?, destination = ?
            WHERE (extension = ? OR extension = ? OR (extension IS NULL AND ? = ''))
              AND (description = ? OR (description IS NULL AND ? = ''))
              AND (destination = ? OR (destination IS NULL AND ? = ''))
            LIMIT 1
        `, [desc, ext, dest, origExt, rawOrigExt, origExt, origDesc, origDesc, origDest, origDest]);

        reloadPbxConfig();
        res.json({
            success: true,
            warningMessage: warningMessage || undefined,
            message: `Inbound Route '${desc}' updated successfully.`
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/routes/inbound - Delete Inbound Route
app.delete('/api/config/routes/inbound', async (req, res) => {
    try {
        const { extension, description, destination } = req.body;
        const rawExt = String(extension || '').trim();
        const normExt = normalizeDidNumber(rawExt);
        const desc = String(description || '').trim();
        const dest = String(destination || '').trim();

        await pool.query(`
            DELETE FROM \`asterisk\`.\`incoming\`
            WHERE (extension = ? OR extension = ? OR (extension IS NULL AND ? = ''))
              AND (description = ? OR (description IS NULL AND ? = ''))
              AND (destination = ? OR (destination IS NULL AND ? = ''))
            LIMIT 1
        `, [rawExt, normExt, rawExt, desc, desc, dest, dest]);

        reloadPbxConfig();
        res.json({ success: true, message: 'Inbound Route deleted successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 5. IVR MANAGEMENT APIs ---

// GET /api/config/ivrs - List all IVR menus
app.get('/api/config/ivrs', async (req, res) => {
    try {
        const [ivrs] = await pool.query('SELECT * FROM `asterisk`.`ivr_details` ORDER BY id ASC');
        const [entries] = await pool.query('SELECT * FROM `asterisk`.`ivr_entries` ORDER BY ivr_id ASC, selection ASC');
        
        const entriesByIvr = {};
        for (const entry of entries) {
            if (!entriesByIvr[entry.ivr_id]) entriesByIvr[entry.ivr_id] = [];
            entriesByIvr[entry.ivr_id].push(entry);
        }

        const result = ivrs.map(i => ({
            ...i,
            entries: entriesByIvr[i.id] || []
        }));

        res.json({ success: true, ivrs: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/config/ivrs/:id - Get single IVR menu
app.get('/api/config/ivrs/:id', async (req, res) => {
    try {
        const ivrId = parseInt(req.params.id, 10);
        const [ivrs] = await pool.query('SELECT * FROM `asterisk`.`ivr_details` WHERE id = ?', [ivrId]);
        if (!ivrs.length) return res.status(404).json({ success: false, error: 'IVR not found' });

        const [entries] = await pool.query('SELECT * FROM `asterisk`.`ivr_entries` WHERE ivr_id = ? ORDER BY selection ASC', [ivrId]);
        res.json({ success: true, ivr: { ...ivrs[0], entries } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/ivrs - Create IVR Menu
app.post('/api/config/ivrs', async (req, res) => {
    try {
        const {
            name, description, announcement, directdial,
            timeout_time, timeout_loops, timeout_retry_recording, timeout_destination,
            invalid_loops, invalid_retry_recording, invalid_destination,
            entries
        } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'IVR Name is required.' });
        }

        const ivrName = String(name).trim();
        const ivrDesc = description ? String(description).trim() : '';
        const announceId = announcement ? parseInt(announcement, 10) : 0;
        const dirDial = directdial || 'disabled';

        const timeoutSec = timeout_time ? parseInt(timeout_time, 10) : 10;
        const timeoutRetry = timeout_loops ? String(timeout_loops) : '3';
        const timeoutRec = timeout_retry_recording || 'default';
        const timeoutDest = timeout_destination || 'app-blackhole,hangup,1';

        const invalidRetry = invalid_loops ? String(invalid_loops) : '3';
        const invalidRec = invalid_retry_recording || 'default';
        const invalidDest = invalid_destination || 'app-blackhole,hangup,1';

        const [insertRes] = await pool.query(`
            INSERT INTO \`asterisk\`.\`ivr_details\`
            (name, description, announcement, directdial, timeout_time, timeout_loops, timeout_retry_recording, timeout_destination, invalid_loops, invalid_retry_recording, invalid_destination, timeout_enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1')
        `, [
            ivrName, ivrDesc, announceId, dirDial,
            timeoutSec, timeoutRetry, timeoutRec, timeoutDest,
            invalidRetry, invalidRec, invalidDest
        ]);

        const newIvrId = insertRes.insertId;

        // Insert IVR entries (digit options)
        if (Array.isArray(entries) && entries.length) {
            for (const entry of entries) {
                const targetDest = String(entry.dest || entry.destination || '').trim();
                if (entry.selection && targetDest) {
                    await pool.query(`
                        INSERT INTO \`asterisk\`.\`ivr_entries\` (ivr_id, selection, dest, ivr_ret)
                        VALUES (?, ?, ?, 0)
                    `, [newIvrId, String(entry.selection).trim(), targetDest]);
                }
            }
        }

        reloadPbxConfig();
        res.json({ success: true, id: newIvrId, message: `IVR '${ivrName}' created successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/ivrs/:id - Modify IVR Menu
app.put('/api/config/ivrs/:id', async (req, res) => {
    try {
        const ivrId = parseInt(req.params.id, 10);
        const {
            name, description, announcement, directdial,
            timeout_time, timeout_loops, timeout_retry_recording, timeout_destination,
            invalid_loops, invalid_retry_recording, invalid_destination,
            entries
        } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'IVR Name is required.' });
        }

        const ivrName = String(name).trim();
        const ivrDesc = description ? String(description).trim() : '';
        const announceId = announcement ? parseInt(announcement, 10) : 0;
        const dirDial = directdial || 'disabled';

        const [existingIvrs] = await pool.query('SELECT timeout_retry_recording, invalid_retry_recording FROM `asterisk`.`ivr_details` WHERE id = ?', [ivrId]);
        const existingIvr = existingIvrs[0] || {};

        const timeoutSec = timeout_time ? parseInt(timeout_time, 10) : 10;
        const timeoutRetry = timeout_loops ? String(timeout_loops) : '3';
        const timeoutRec = timeout_retry_recording !== undefined ? timeout_retry_recording : (existingIvr.timeout_retry_recording || 'default');
        const timeoutDest = timeout_destination || 'app-blackhole,hangup,1';

        const invalidRetry = invalid_loops ? String(invalid_loops) : '3';
        const invalidRec = invalid_retry_recording !== undefined ? invalid_retry_recording : (existingIvr.invalid_retry_recording || 'default');
        const invalidDest = invalid_destination || 'app-blackhole,hangup,1';
        await pool.query(`
            UPDATE \`asterisk\`.\`ivr_details\`
            SET name = ?, description = ?, announcement = ?, directdial = ?,
                timeout_time = ?, timeout_loops = ?, timeout_retry_recording = ?, timeout_destination = ?,
                invalid_loops = ?, invalid_retry_recording = ?, invalid_destination = ?
            WHERE id = ?
        `, [
            ivrName, ivrDesc, announceId, dirDial,
            timeoutSec, timeoutRetry, timeoutRec, timeoutDest,
            invalidRetry, invalidRec, invalidDest,
            ivrId
        ]);

        // Re-insert IVR entries
        await pool.query('DELETE FROM `asterisk`.`ivr_entries` WHERE ivr_id = ?', [ivrId]);
        if (Array.isArray(entries) && entries.length) {
            for (const entry of entries) {
                const targetDest = String(entry.dest || entry.destination || '').trim();
                if (entry.selection && targetDest) {
                    await pool.query(`
                        INSERT INTO \`asterisk\`.\`ivr_entries\` (ivr_id, selection, dest, ivr_ret)
                        VALUES (?, ?, ?, 0)
                    `, [ivrId, String(entry.selection).trim(), targetDest]);
                }
            }
        }

        reloadPbxConfig();
        res.json({ success: true, message: `IVR '${ivrName}' updated successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/ivrs/:id - Delete IVR Menu
app.delete('/api/config/ivrs/:id', async (req, res) => {
    try {
        const ivrId = parseInt(req.params.id, 10);
        await pool.query('DELETE FROM `asterisk`.`ivr_details` WHERE id = ?', [ivrId]);
        await pool.query('DELETE FROM `asterisk`.`ivr_entries` WHERE ivr_id = ?', [ivrId]);
        reloadPbxConfig();
        res.json({ success: true, message: `IVR #${ivrId} deleted successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/config/routes/outbound - List Outbound Routes
app.get('/api/config/routes/outbound', async (req, res) => {
    try {
        const [routesRows] = await pool.query(`
            SELECT route_id, name FROM \`asterisk\`.\`outbound_routes\` ORDER BY route_id ASC
        `);
        const [patternsRows] = await pool.query(`
            SELECT route_id, match_pattern_prefix, match_pattern_pass, match_cid, prepend_digits
            FROM \`asterisk\`.\`outbound_route_patterns\`
        `);
        const [trunksRows] = await pool.query(`
            SELECT rt.route_id, rt.trunk_id, rt.seq, t.name AS trunk_name
            FROM \`asterisk\`.\`outbound_route_trunks\` rt
            LEFT JOIN \`asterisk\`.\`trunks\` t ON t.trunkid = rt.trunk_id
            ORDER BY rt.seq ASC
        `);

        // Group them
        const routes = routesRows.map(r => {
            const route_id = r.route_id;
            const patterns = patternsRows
                .filter(p => p.route_id === route_id)
                .map(p => ({
                    prefix: p.match_pattern_prefix || '',
                    pattern: p.match_pattern_pass || '',
                    cid: p.match_cid || '',
                    prepend: p.prepend_digits || ''
                }));
            const trunks = trunksRows
                .filter(t => t.route_id === route_id)
                .map(t => ({
                    trunk_id: t.trunk_id,
                    seq: t.seq,
                    trunk_name: t.trunk_name || `ID #${t.trunk_id}`
                }));

            return {
                route_id,
                name: r.name,
                patterns,
                trunks
            };
        });

        res.json({ success: true, routes });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// POST /api/config/routes/outbound - Create Outbound Route
app.post('/api/config/routes/outbound', async (req, res) => {
    try {
        const { name, patterns, trunks } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Route Name is required.' });
        }
        if (!patterns || !Array.isArray(patterns) || patterns.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one Dial Pattern is required.' });
        }
        if (!trunks || !Array.isArray(trunks) || trunks.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one Trunk in sequence is required.' });
        }

        const routeName = String(name).trim();

        // 1. Insert into outbound_routes
        const [rResult] = await pool.query(`
            INSERT INTO \`asterisk\`.\`outbound_routes\` (name, outcid, outcid_mode, password, emergency_route, intracompany_route, mohclass)
            VALUES (?, '', '', '', '', '', 'default')
        `, [routeName]);

        const routeId = rResult.insertId;

        // 2. Insert patterns
        for (const p of patterns) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`outbound_route_patterns\` (route_id, match_pattern_prefix, match_pattern_pass, match_cid, prepend_digits)
                VALUES (?, ?, ?, ?, ?)
            `, [routeId, String(p.prefix || '').trim(), String(p.pattern || '').trim(), String(p.cid || '').trim(), String(p.prepend || '').trim()]);
        }

        // 3. Insert trunks in order (seq)
        for (let i = 0; i < trunks.length; i++) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`outbound_route_trunks\` (route_id, trunk_id, seq)
                VALUES (?, ?, ?)
            `, [routeId, parseInt(trunks[i], 10), i]);
        }

        // 4. Insert sequence position (next available seq)
        const [seqRow] = await pool.query('SELECT COALESCE(MAX(seq), -1) + 1 AS nextSeq FROM `asterisk`.`outbound_route_sequence`');
        const nextSeq = seqRow[0].nextSeq;

        await pool.query(`
            INSERT INTO \`asterisk\`.\`outbound_route_sequence\` (route_id, seq)
            VALUES (?, ?)
        `, [routeId, nextSeq]);

        reloadPbxConfig();
        res.json({ success: true, message: `Outbound Route '${routeName}' created successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/routes/outbound/:route_id - Modify Outbound Route
app.put('/api/config/routes/outbound/:route_id', async (req, res) => {
    try {
        const routeId = parseInt(req.params.route_id, 10);
        const { name, patterns, trunks } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Route Name is required.' });
        }
        if (!patterns || !Array.isArray(patterns) || patterns.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one Dial Pattern is required.' });
        }
        if (!trunks || !Array.isArray(trunks) || trunks.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one Trunk in sequence is required.' });
        }

        const routeName = String(name).trim();

        // 1. Update outbound_routes name
        await pool.query(`
            UPDATE \`asterisk\`.\`outbound_routes\`
            SET name = ?
            WHERE route_id = ?
        `, [routeName, routeId]);

        // 2. Refresh patterns
        await pool.query('DELETE FROM `asterisk`.`outbound_route_patterns` WHERE route_id = ?', [routeId]);
        for (const p of patterns) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`outbound_route_patterns\` (route_id, match_pattern_prefix, match_pattern_pass, match_cid, prepend_digits)
                VALUES (?, ?, ?, ?, ?)
            `, [routeId, String(p.prefix || '').trim(), String(p.pattern || '').trim(), String(p.cid || '').trim(), String(p.prepend || '').trim()]);
        }

        // 3. Refresh trunks in order
        await pool.query('DELETE FROM `asterisk`.`outbound_route_trunks` WHERE route_id = ?', [routeId]);
        for (let i = 0; i < trunks.length; i++) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`outbound_route_trunks\` (route_id, trunk_id, seq)
                VALUES (?, ?, ?)
            `, [routeId, parseInt(trunks[i], 10), i]);
        }

        reloadPbxConfig();
        res.json({ success: true, message: `Outbound Route '${routeName}' updated successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/routes/outbound/:route_id - Delete Outbound Route
app.delete('/api/config/routes/outbound/:route_id', async (req, res) => {
    try {
        const routeId = parseInt(req.params.route_id, 10);
        await pool.query('DELETE FROM `asterisk`.`outbound_routes` WHERE route_id = ?', [routeId]);
        await pool.query('DELETE FROM `asterisk`.`outbound_route_patterns` WHERE route_id = ?', [routeId]);
        await pool.query('DELETE FROM `asterisk`.`outbound_route_trunks` WHERE route_id = ?', [routeId]);
        await pool.query('DELETE FROM `asterisk`.`outbound_route_sequence` WHERE route_id = ?', [routeId]);

        reloadPbxConfig();
        res.json({ success: true, message: 'Outbound Route deleted successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- VOICEMAIL CONFIGURATION APIs ---

// GET /api/config/voicemail/extensions - List extensions with voicemail enabled
app.get('/api/config/voicemail/extensions', async (req, res) => {
    try {
        const [users] = await pool.query(`
            SELECT extension, name FROM \`asterisk\`.\`users\`
            WHERE voicemail = 'default' OR voicemail = 'enabled'
            ORDER BY CAST(extension AS UNSIGNED) ASC
        `);
        
        const list = users.map(u => {
            const ext = u.extension;
            const gsmPath = `/var/spool/asterisk/voicemail/default/${ext}/unavail.gsm`;
            const wavPath = `/var/spool/asterisk/voicemail/default/${ext}/unavail.wav`;
            const hasCustom = fs.existsSync(gsmPath) || fs.existsSync(wavPath);
            return {
                extension: ext,
                name: u.name,
                hasCustomGreeting: hasCustom
            };
        });
        
        res.json({ success: true, extensions: list });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/voicemail/greeting - Apply greeting from system recording to extensions
app.post('/api/config/voicemail/greeting', async (req, res) => {
    try {
        const { recordingId, extensions, allEnabled } = req.body;
        if (!recordingId) {
            return res.status(400).json({ success: false, error: 'Recording is required.' });
        }
        
        // Get recording path
        const [recRow] = await pool.query('SELECT CAST(filename AS CHAR) AS filename FROM `asterisk`.`recordings` WHERE id = ?', [recordingId]);
        if (!recRow.length || !recRow[0].filename) {
            return res.status(404).json({ success: false, error: 'Recording not found.' });
        }
        
        const relFile = String(recRow[0].filename);
        const wavSrcPath = path.join('/var/lib/asterisk/sounds', relFile + '.wav');
        if (!fs.existsSync(wavSrcPath)) {
            return res.status(404).json({ success: false, error: 'Recording WAV file missing on disk.' });
        }
        
        // Get list of extensions
        let targetExtensions = [];
        if (allEnabled) {
            const [users] = await pool.query(`
                SELECT extension FROM \`asterisk\`.\`users\`
                WHERE voicemail = 'default' OR voicemail = 'enabled'
            `);
            targetExtensions = users.map(u => u.extension);
        } else {
            targetExtensions = Array.isArray(extensions) ? extensions : [];
        }
        
        if (targetExtensions.length === 0) {
            return res.status(400).json({ success: false, error: 'No extensions selected.' });
        }
        
        // Convert and copy greetings to target directories using sox for 100% reliable format output
        for (const ext of targetExtensions) {
            const mailboxDir = `/var/spool/asterisk/voicemail/default/${ext}`;
            if (!fs.existsSync(mailboxDir)) {
                fs.mkdirSync(mailboxDir, { recursive: true });
            }
            
            removeVmFile(mailboxDir, 'busy');
            removeVmFile(mailboxDir, 'unavail');
            
            const gsmDestUnavail = path.join(mailboxDir, 'unavail.gsm');
            const wavDestUnavail = path.join(mailboxDir, 'unavail.wav');
            const gsmDestBusy = path.join(mailboxDir, 'busy.gsm');
            const wavDestBusy = path.join(mailboxDir, 'busy.wav');
            
            await new Promise(resolve => exec(`sox "${wavSrcPath}" -r 8000 -c 1 -b 16 "${gsmDestUnavail}"`, resolve));
            await new Promise(resolve => exec(`sox "${wavSrcPath}" -r 8000 -c 1 -b 16 "${wavDestUnavail}"`, resolve));
            await new Promise(resolve => exec(`sox "${wavSrcPath}" -r 8000 -c 1 -b 16 "${gsmDestBusy}"`, resolve));
            await new Promise(resolve => exec(`sox "${wavSrcPath}" -r 8000 -c 1 -b 16 "${wavDestBusy}"`, resolve));
            
            exec(`chown -R asterisk:asterisk "${mailboxDir}"`);
        }
        
        // Ensure Asterisk default intro prompts are muted with silent GSM files
        const silentTmp = path.join(UPLOAD_TMP, `silent-${Date.now()}.wav`);
        await new Promise(resolve => exec(`sox -n -r 8000 -c 1 -b 16 "${silentTmp}" trim 0.0 0.1`, resolve));
        await new Promise(resolve => exec(`sox "${silentTmp}" -r 8000 -c 1 -b 16 /var/lib/asterisk/sounds/en/vm-intro.gsm`, resolve));
        await new Promise(resolve => exec(`sox "${silentTmp}" -r 8000 -c 1 -b 16 /var/lib/asterisk/sounds/en/vm-leavemsg.gsm`, resolve));
        exec(`rm -f /var/lib/asterisk/sounds/en/vm-intro.wav /var/lib/asterisk/sounds/en/vm-leavemsg.wav "${silentTmp}"`);
        exec(`chown asterisk:asterisk /var/lib/asterisk/sounds/en/vm-intro.gsm /var/lib/asterisk/sounds/en/vm-leavemsg.gsm`);
        
        // 4. Reload Asterisk voicemail module
        exec(`${ASTERISK_BIN} -rx "voicemail reload"`, () => {});
        
        res.json({ success: true, message: `Voicemail greeting applied to ${targetExtensions.length} extension(s) successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/voicemail/reset - Reset custom voicemail greeting
app.post('/api/config/voicemail/reset', async (req, res) => {
    try {
        const { extensions } = req.body;
        const targetExtensions = Array.isArray(extensions) ? extensions : [];
        
        for (const ext of targetExtensions) {
            const mailboxDir = `/var/spool/asterisk/voicemail/default/${ext}`;
            removeVmFile(mailboxDir, 'busy');
            removeVmFile(mailboxDir, 'unavail');
        }
        
        ensureVmBackups();
        const origUnavail = path.join(VM_BACKUP_DIR, 'unavailable.gsm.orig');
        const origLeaveMsg = path.join(VM_BACKUP_DIR, 'vm-leavemsg.gsm.orig');
        const origIntro = path.join(VM_BACKUP_DIR, 'vm-intro.gsm.orig');
        removeVmSound('unavailable');
        removeVmSound('vm-leavemsg');
        removeVmSound('vm-intro');
        if (fs.existsSync(origUnavail)) fs.copyFileSync(origUnavail, path.join(VM_SOUNDS_DIR, 'unavailable.gsm'));
        if (fs.existsSync(origLeaveMsg)) fs.copyFileSync(origLeaveMsg, path.join(VM_SOUNDS_DIR, 'vm-leavemsg.gsm'));
        if (fs.existsSync(origIntro)) fs.copyFileSync(origIntro, path.join(VM_SOUNDS_DIR, 'vm-intro.gsm'));

        // Reload Asterisk voicemail and sound modules
        exec(`${ASTERISK_BIN} -rx "voicemail reload"`, () => {});
        exec(`${ASTERISK_BIN} -rx "module reload sounds"`, () => {});
        
        res.json({ success: true, message: `Voicemail greetings reset to default for ${targetExtensions.length} extension(s).` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/config/diagram - Fetch diagram configuration data
app.get('/api/config/diagram', async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        // Query Extensions
        const [extensions] = await pool.query(`
            SELECT u.extension, u.name, u.outboundcid, u.voicemail, s_context.data AS context
            FROM \`asterisk\`.\`users\` u
            LEFT JOIN \`asterisk\`.\`sip\` s_context ON s_context.id = u.extension AND s_context.keyword = 'context'
            ORDER BY CAST(u.extension AS UNSIGNED) ASC
        `);

        // Query Ring Groups
        const [ringgroups] = await pool.query(`
            SELECT grpnum, strategy, grptime, grplist, description, postdest, ringing FROM \`asterisk\`.\`ringgroups\`
            ORDER BY CAST(grpnum AS UNSIGNED) ASC
        `);

        // Query Trunks
        const [trunks] = await pool.query(`
            SELECT trunkid, name, tech, channelid, disabled FROM \`asterisk\`.\`trunks\`
            ORDER BY trunkid ASC
        `);

        // Query Inbound Routes
        const [inbound] = await pool.query(`
            SELECT cidnum, extension AS did, destination, description, mohclass, ringing FROM \`asterisk\`.\`incoming\`
            ORDER BY description ASC
        `);

        // Query Time Conditions
        const [timeconditions] = await pool.query(`
            SELECT tc.timeconditions_id, tc.displayname, tc.time AS timegroup_id, tg.description AS timegroup_name, tc.truegoto, tc.falsegoto
            FROM \`asterisk\`.\`timeconditions\` tc
            LEFT JOIN \`asterisk\`.\`timegroups_groups\` tg ON tg.id = tc.time
            ORDER BY tc.timeconditions_id ASC
        `);

        // Query IVR Menus & Entries
        const [ivrsRows] = await pool.query(`
            SELECT id, name, description, announcement, directdial, timeout_destination, invalid_destination
            FROM \`asterisk\`.\`ivr_details\`
            ORDER BY id ASC
        `);
        const [ivrEntriesRows] = await pool.query(`
            SELECT ivr_id, selection, dest FROM \`asterisk\`.\`ivr_entries\`
            ORDER BY ivr_id ASC, selection ASC
        `);
        const ivrEntriesMap = {};
        for (const row of ivrEntriesRows) {
            if (!ivrEntriesMap[row.ivr_id]) ivrEntriesMap[row.ivr_id] = [];
            ivrEntriesMap[row.ivr_id].push({ selection: row.selection, dest: row.dest });
        }
        const ivrs = ivrsRows.map(ivr => ({
            ...ivr,
            entries: ivrEntriesMap[ivr.id] || []
        }));

        // Query Outbound Routes
        const [outboundRows] = await pool.query(`
            SELECT route_id, name FROM \`asterisk\`.\`outbound_routes\`
            ORDER BY route_id ASC
        `);

        // Query Outbound Route Patterns
        const [patternsRows] = await pool.query(`
            SELECT route_id, match_pattern_pass, match_cid FROM \`asterisk\`.\`outbound_route_patterns\`
        `);

        // Query Outbound Route Trunks
        const [trunksRows] = await pool.query(`
            SELECT rt.route_id, rt.trunk_id, t.name AS trunk_name
            FROM \`asterisk\`.\`outbound_route_trunks\` rt
            LEFT JOIN \`asterisk\`.\`trunks\` t ON t.trunkid = rt.trunk_id
            ORDER BY rt.seq ASC
        `);

        // Group Outbound Route patterns and trunks
        const outbound = outboundRows.map(r => {
            const route_id = r.route_id;
            const patterns = patternsRows
                .filter(p => String(p.route_id) === String(route_id))
                .map(p => ({
                    pattern: p.match_pattern_pass || '',
                    cid: p.match_cid || ''
                }));
            const trunks = trunksRows
                .filter(t => String(t.route_id) === String(route_id))
                .map(t => ({
                    trunk_id: t.trunk_id,
                    trunk_name: t.trunk_name || `Trunk #${t.trunk_id}`
                }));
            return {
                route_id,
                name: r.name,
                patterns,
                trunks
            };
        });

        // Query Queues
        const [queuesRows] = await pool.query(`
            SELECT extension, descr, maxwait, dest, destcontinue FROM \`asterisk\`.\`queues_config\`
            ORDER BY CAST(extension AS UNSIGNED) ASC
        `);

        const [queueMembersRows] = await pool.query(`
            SELECT id, data FROM \`asterisk\`.\`queues_details\` WHERE keyword = 'member'
        `);

        const queueMembersMap = {};
        for (const row of queueMembersRows) {
            if (!queueMembersMap[row.id]) queueMembersMap[row.id] = [];
            const match = row.data.match(/Local\/(\d+)@/);
            if (match) queueMembersMap[row.id].push(match[1]);
            else {
                const matchSimple = row.data.match(/^(\d+)/);
                if (matchSimple) queueMembersMap[row.id].push(matchSimple[1]);
            }
        }

        const queues = queuesRows.map(q => ({
            ...q,
            static_members: queueMembersMap[q.extension] || []
        }));

        res.json({
            success: true,
            inbound,
            timeconditions,
            ringgroups,
            queues,
            ivrs,
            extensions,
            outbound,
            trunks
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- TIME GROUPS API ---

function decomposeWeekdaysToAsterisk(days) {
    if (!days || !Array.isArray(days) || days.length === 0 || days.includes('*')) {
        return ['*'];
    }
    const validDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const active = days.map(d => String(d).toLowerCase().trim()).filter(d => validDays.includes(d));
    if (active.length === 0 || active.length === 7) return ['*'];

    const ranges = [];
    let currentRange = [];

    for (let i = 0; i < validDays.length; i++) {
        const day = validDays[i];
        if (active.includes(day)) {
            currentRange.push(day);
        } else {
            if (currentRange.length > 0) {
                if (currentRange.length === 1) {
                    ranges.push(currentRange[0]);
                } else {
                    ranges.push(`${currentRange[0]}-${currentRange[currentRange.length - 1]}`);
                }
                currentRange = [];
            }
        }
    }
    if (currentRange.length > 0) {
        if (currentRange.length === 1) {
            ranges.push(currentRange[0]);
        } else {
            ranges.push(`${currentRange[0]}-${currentRange[currentRange.length - 1]}`);
        }
    }
    return ranges;
}
function normalizeIssabelDestination(dest) {
    if (!dest) return '';
    const trimmed = String(dest).trim();
    if (/^\d{3,4}$/.test(trimmed)) {
        return `from-did-direct,${trimmed},1`;
    }
    return trimmed;
}

function normalizeTimeRange(str) {
    if (!str || str === '*' || str === '*-*') return '*';
    const trimmed = String(str).trim();
    const match = trimmed.match(/^(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2}):(\d{1,2})$/);
    if (match) {
        const sh = String(match[1]).padStart(2, '0');
        const sm = String(match[2]).padStart(2, '0');
        const fh = String(match[3]).padStart(2, '0');
        const fm = String(match[4]).padStart(2, '0');
        return `${sh}:${sm}-${fh}:${fm}`;
    }
    return trimmed;
}

function formatIssabelTimeRule(rule, overrideWkday = null) {
    if (!rule) return '*|*|*|*';
    if (typeof rule === 'string') {
        const parts = rule.split('|');
        const t = normalizeTimeRange(parts[0]);
        const w = (!parts[1] || parts[1] === '*' || parts[1] === '*-*') ? '*' : parts[1].trim().toLowerCase();
        const md = (!parts[2] || parts[2] === '*' || parts[2] === '*-*') ? '*' : parts[2].trim();
        const m = (!parts[3] || parts[3] === '*' || parts[3] === '*-*') ? '*' : parts[3].trim().toLowerCase();
        return `${t}|${w}|${md}|${m}`;
    }

    let timeStr = rule.time || '';
    if (!timeStr && rule.start_time && rule.finish_time) {
        timeStr = `${rule.start_time}-${rule.finish_time}`;
    } else if (!timeStr && rule.start_time) {
        timeStr = rule.start_time;
    }

    let weekdayStr = overrideWkday !== null ? overrideWkday : (rule.weekday || '');
    if (!weekdayStr && rule.start_weekday && rule.finish_weekday) {
        weekdayStr = rule.start_weekday === rule.finish_weekday ? rule.start_weekday : `${rule.start_weekday}-${rule.finish_weekday}`;
    } else if (!weekdayStr && rule.start_weekday) {
        weekdayStr = rule.start_weekday;
    }

    let monthdayStr = rule.monthday || '';
    if (!monthdayStr && rule.start_monthday && rule.finish_monthday) {
        monthdayStr = rule.start_monthday === rule.finish_monthday ? rule.start_monthday : `${rule.start_monthday}-${rule.finish_monthday}`;
    } else if (!monthdayStr && rule.start_monthday) {
        monthdayStr = rule.start_monthday;
    }

    let monthStr = rule.month || '';
    if (!monthStr && rule.start_month && rule.finish_month) {
        monthStr = rule.start_month === rule.finish_month ? rule.start_month : `${rule.start_month}-${rule.finish_month}`;
    } else if (!monthStr && rule.start_month) {
        monthStr = rule.start_month;
    }

    const cleanTime = normalizeTimeRange(timeStr);
    const cleanWkday = (!weekdayStr || weekdayStr === '*' || weekdayStr === '*-*') ? '*' : weekdayStr.trim().toLowerCase();
    const cleanMthday = (!monthdayStr || monthdayStr === '*' || monthdayStr === '*-*') ? '*' : monthdayStr.trim();
    const cleanMonth = (!monthStr || monthStr === '*' || monthStr === '*-*') ? '*' : monthStr.trim().toLowerCase();

    return `${cleanTime}|${cleanWkday}|${cleanMthday}|${cleanMonth}`;
}

async function insertTimeGroupRules(groupid, rules) {
    if (rules && Array.isArray(rules) && rules.length > 0) {
        for (const rule of rules) {
            const ruleName = String(rule.name || rule.display_name || '').trim();
            if (rule.active_days && Array.isArray(rule.active_days)) {
                const wkRanges = decomposeWeekdaysToAsterisk(rule.active_days);
                for (const wkRange of wkRanges) {
                    const timeStr = formatIssabelTimeRule(rule, wkRange);
                    await pool.query('INSERT INTO `asterisk`.`timegroups_details` (timegroupid, time, name) VALUES (?, ?, ?)', [groupid, timeStr, ruleName]);
                }
            } else {
                const timeStr = formatIssabelTimeRule(rule);
                await pool.query('INSERT INTO `asterisk`.`timegroups_details` (timegroupid, time, name) VALUES (?, ?, ?)', [groupid, timeStr, ruleName]);
            }
        }
    } else {
        await pool.query('INSERT INTO `asterisk`.`timegroups_details` (timegroupid, time, name) VALUES (?, ?, ?)', [groupid, '*|*|*|*', '']);
    }
}

// GET /api/config/timegroups - Retrieve all time groups and their details
app.get('/api/config/timegroups', async (req, res) => {
    try {
        const [groups] = await pool.query('SELECT id, description FROM `asterisk`.`timegroups_groups` ORDER BY id ASC');
        const [details] = await pool.query('SELECT id, timegroupid, time, name FROM `asterisk`.`timegroups_details` ORDER BY id ASC');
        const [conditions] = await pool.query('SELECT `time` AS timegroup_id, COUNT(*) AS count FROM `asterisk`.`timeconditions` GROUP BY `time`');
        
        const condCountMap = {};
        for (const c of conditions) {
            condCountMap[c.timegroup_id] = c.count;
        }

        const groupsWithDetails = groups.map(g => {
            const rules = details.filter(d => d.timegroupid === g.id).map(d => {
                const parts = (d.time || '').split('|');
                return {
                    id: d.id,
                    raw: d.time || '',
                    time: parts[0] || '*',
                    weekday: parts[1] || '*',
                    monthday: parts[2] || '*',
                    month: parts[3] || '*',
                    name: d.name || ''
                };
            });
            return {
                id: g.id,
                description: g.description,
                linked_conditions_count: condCountMap[g.id] || 0,
                rules
            };
        });
        res.json({ success: true, timegroups: groupsWithDetails });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/timegroups - Create a new time group
app.post('/api/config/timegroups', async (req, res) => {
    try {
        const { description, rules } = req.body;
        if (!description || !description.trim()) {
            return res.status(400).json({ success: false, error: 'Description is required' });
        }
        
        const [r] = await pool.query('INSERT INTO `asterisk`.`timegroups_groups` (description) VALUES (?)', [description.trim()]);
        const groupid = r.insertId;
        
        await insertTimeGroupRules(groupid, rules);
        
        reloadPbxConfig();
        res.json({ success: true, message: 'Time Group created successfully', id: groupid });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/timegroups/:id - Update an existing time group
app.put('/api/config/timegroups/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { description, rules } = req.body;
        if (!description || !description.trim()) {
            return res.status(400).json({ success: false, error: 'Description is required' });
        }
        
        await pool.query('UPDATE `asterisk`.`timegroups_groups` SET description = ? WHERE id = ?', [description.trim(), id]);
        await pool.query('DELETE FROM `asterisk`.`timegroups_details` WHERE timegroupid = ?', [id]);
        
        await insertTimeGroupRules(id, rules);

        reloadPbxConfig();
        res.json({ success: true, message: 'Time Group updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/timegroups/:id - Delete a time group
app.delete('/api/config/timegroups/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const [check] = await pool.query('SELECT COUNT(*) AS count FROM `asterisk`.`timeconditions` WHERE `time` = ?', [id]);
        if (check[0].count > 0) {
            return res.status(400).json({ success: false, error: 'Cannot delete. This Time Group is currently used in one or more Time Conditions.' });
        }
        
        await pool.query('DELETE FROM `asterisk`.`timegroups_groups` WHERE id = ?', [id]);
        await pool.query('DELETE FROM `asterisk`.`timegroups_details` WHERE timegroupid = ?', [id]);

        reloadPbxConfig();
        res.json({ success: true, message: 'Time Group deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// --- TIME CONDITIONS API ---

// GET /api/config/timeconditions - Retrieve all time conditions
app.get('/api/config/timeconditions', async (req, res) => {
    try {
        const [conditions] = await pool.query(`
            SELECT tc.timeconditions_id, tc.displayname, tc.time AS timegroup_id, tg.description AS timegroup_name, tc.truegoto, tc.falsegoto
            FROM \`asterisk\`.\`timeconditions\` tc
            LEFT JOIN \`asterisk\`.\`timegroups_groups\` tg ON tg.id = tc.time
            ORDER BY tc.timeconditions_id ASC
        `);
        res.json({ success: true, timeconditions: conditions });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/timeconditions - Create a new time condition
app.post('/api/config/timeconditions', async (req, res) => {
    try {
        const { displayname, timegroup_id, truegoto, falsegoto } = req.body;
        if (!displayname || !displayname.trim()) {
            return res.status(400).json({ success: false, error: 'Display Name is required' });
        }
        if (!timegroup_id) {
            return res.status(400).json({ success: false, error: 'Time Group is required' });
        }
        if (!truegoto || !falsegoto) {
            return res.status(400).json({ success: false, error: 'True and False destinations are required' });
        }
        
        const normTrue = normalizeIssabelDestination(truegoto);
        const normFalse = normalizeIssabelDestination(falsegoto);

        const [r] = await pool.query(`
            INSERT INTO \`asterisk\`.\`timeconditions\` (displayname, \`time\`, truegoto, falsegoto, deptname, generate_hint, priority)
            VALUES (?, ?, ?, ?, '', 0, NULL)
        `, [displayname.trim(), timegroup_id, normTrue, normFalse]);
        
        reloadPbxConfig();
        res.json({ success: true, message: 'Time Condition created successfully', id: r.insertId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/timeconditions/:id - Update an existing time condition
app.put('/api/config/timeconditions/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { displayname, timegroup_id, truegoto, falsegoto } = req.body;
        if (!displayname || !displayname.trim()) {
            return res.status(400).json({ success: false, error: 'Display Name is required' });
        }
        if (!timegroup_id) {
            return res.status(400).json({ success: false, error: 'Time Group is required' });
        }
        if (!truegoto || !falsegoto) {
            return res.status(400).json({ success: false, error: 'True and False destinations are required' });
        }
        
        const normTrue = normalizeIssabelDestination(truegoto);
        const normFalse = normalizeIssabelDestination(falsegoto);

        await pool.query(`
            UPDATE \`asterisk\`.\`timeconditions\`
            SET displayname = ?, \`time\` = ?, truegoto = ?, falsegoto = ?
            WHERE timeconditions_id = ?
        `, [displayname.trim(), timegroup_id, normTrue, normFalse, id]);
        
        reloadPbxConfig();
        res.json({ success: true, message: 'Time Condition updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/timeconditions/:id - Delete a time condition
app.delete('/api/config/timeconditions/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        await pool.query('DELETE FROM `asterisk`.`timeconditions` WHERE timeconditions_id = ?', [id]);
        
        reloadPbxConfig();
        res.json({ success: true, message: 'Time Condition deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
// GET /api/config/modem - List modem gain settings from dongle.conf
app.get('/api/config/modem', async (req, res) => {
    try {
        const { defaults, dongles } = parseDongleConfGain();
        try {
            const [rows] = await pool.query('SELECT dongle_name, imsi, imei, phone_number FROM `asterisk`.`gsm_dongles`');
            for (const r of rows) {
                if (r.dongle_name && dongles[r.dongle_name]) {
                    if (r.phone_number) dongles[r.dongle_name].phone_number = r.phone_number;
                    if (r.imsi) dongles[r.dongle_name].imsi = r.imsi;
                    if (r.imei) dongles[r.dongle_name].imei = r.imei;
                }
            }
        } catch (_) {}

        res.json({ success: true, defaults, dongles });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/config/modem/reports - Detailed Dongle & SIM state duration reports
app.get('/api/config/modem/reports', async (req, res) => {
    try {
        const startStr = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endStr = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const filterDongle = (req.query.dongleId && req.query.dongleId !== 'ALL') ? String(req.query.dongleId).trim().toLowerCase() : null;
        const filterSim = (req.query.simNumber && req.query.simNumber !== 'ALL') ? String(req.query.simNumber).trim() : null;

        const winStartMs = moment(startStr).valueOf();
        const winEndMs = moment(endStr).valueOf();
        const totalWinSec = Math.max(1, Math.floor((winEndMs - winStartMs) / 1000));

        let sql = `
            SELECT dongle_name, sim_number, imsi, imei, state,
                   started_at, COALESCE(ended_at, NOW()) as ended_at
            FROM \`asterisk\`.\`dongle_state_logs\`
            WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
        `;
        const queryParams = [endStr, startStr];

        if (filterDongle) {
            sql += ` AND LOWER(dongle_name) = ?`;
            queryParams.push(filterDongle);
        }
        if (filterSim) {
            sql += ` AND (sim_number = ? OR imsi = ? OR imei = ?)`;
            queryParams.push(filterSim, filterSim, filterSim);
        }

        sql += ` ORDER BY started_at ASC`;
        const [logs] = await pool.query(sql, queryParams);

        // Fetch CDR statistics for dongles in timeframe
        const [cdrRows] = await pool.query(`
            SELECT channel, dstchannel, billsec, disposition, calldate
            FROM ${tables.cdr}
            WHERE calldate BETWEEN ? AND ?
              AND (channel LIKE 'Dongle/%' OR dstchannel LIKE 'Dongle/%')
        `, [startStr, endStr]);

        const dongleCdrMap = {};
        cdrRows.forEach(row => {
            const mSrc = (row.channel || '').match(/dongle\/(dongle\d+)/i);
            const mDst = (row.dstchannel || '').match(/dongle\/(dongle\d+)/i);
            const dId = (mSrc && mSrc[1] ? mSrc[1] : (mDst && mDst[1] ? mDst[1] : '')).toLowerCase();
            if (dId) {
                dongleCdrMap[dId] = dongleCdrMap[dId] || { totalCalls: 0, answeredCalls: 0, talkSec: 0 };
                dongleCdrMap[dId].totalCalls++;
                if (row.disposition === 'ANSWERED') {
                    dongleCdrMap[dId].answeredCalls++;
                    dongleCdrMap[dId].talkSec += (parseInt(row.billsec) || 0);
                }
            }
        });

        // Group State Durations by Dongle & SIM
        const dongleStats = {};
        const simStats = {};
        const globalStateSec = { Free: 0, Busy: 0, 'Not Initialized': 0, 'Not connected': 0, Other: 0 };

        logs.forEach(log => {
            const dName = (log.dongle_name || 'unknown').toLowerCase();
            const simNum = log.sim_number || log.imsi || 'Unknown SIM';
            const stateRaw = String(log.state || 'Unknown').trim();

            let stateKey = 'Other';
            if (/free|ready|idle/i.test(stateRaw)) stateKey = 'Free';
            else if (/busy|dial|ring|active|held|call/i.test(stateRaw)) stateKey = 'Busy';
            else if (/not init|init|error/i.test(stateRaw)) stateKey = 'Not Initialized';
            else if (/not conn|disconnect|removed/i.test(stateRaw)) stateKey = 'Not connected';

            const logStartMs = Math.max(winStartMs, moment(log.started_at).valueOf());
            const logEndMs = Math.min(winEndMs, moment(log.ended_at).valueOf());
            const durSec = Math.max(0, Math.floor((logEndMs - logStartMs) / 1000));

            globalStateSec[stateKey] = (globalStateSec[stateKey] || 0) + durSec;

            if (!dongleStats[dName]) {
                dongleStats[dName] = {
                    dongle_name: dName,
                    sim_number: log.sim_number || 'Unknown',
                    imsi: log.imsi || '',
                    imei: log.imei || '',
                    statesSec: { Free: 0, Busy: 0, 'Not Initialized': 0, 'Not connected': 0, Other: 0 },
                    totalLoggedSec: 0
                };
            }
            if (log.sim_number && dongleStats[dName].sim_number === 'Unknown') {
                dongleStats[dName].sim_number = log.sim_number;
            }
            if (log.imsi && !dongleStats[dName].imsi) dongleStats[dName].imsi = log.imsi;
            if (log.imei && !dongleStats[dName].imei) dongleStats[dName].imei = log.imei;

            dongleStats[dName].statesSec[stateKey] = (dongleStats[dName].statesSec[stateKey] || 0) + durSec;
            dongleStats[dName].totalLoggedSec += durSec;

            if (!simStats[simNum]) {
                simStats[simNum] = {
                    sim_number: simNum,
                    dongle_name: dName,
                    imsi: log.imsi || '',
                    statesSec: { Free: 0, Busy: 0, 'Not Initialized': 0, 'Not connected': 0, Other: 0 },
                    totalLoggedSec: 0
                };
            }
            simStats[simNum].statesSec[stateKey] = (simStats[simNum].statesSec[stateKey] || 0) + durSec;
            simStats[simNum].totalLoggedSec += durSec;
        });

        const formatDuration = (sec) => {
            if (!sec || sec <= 0) return '0s';
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = sec % 60;
            const parts = [];
            if (h > 0) parts.push(`${h}h`);
            if (m > 0 || h > 0) parts.push(`${m}m`);
            parts.push(`${s}s`);
            return parts.join(' ');
        };

        const formatReportList = (mapObj, isDongle = true) => {
            return Object.values(mapObj).map(item => {
                const totalSec = Math.max(1, item.totalLoggedSec || totalWinSec);
                const cdr = isDongle ? (dongleCdrMap[item.dongle_name] || { totalCalls: 0, answeredCalls: 0, talkSec: 0 }) : { totalCalls: 0, answeredCalls: 0, talkSec: 0 };
                const statesFormatted = {};
                for (const [sKey, sSec] of Object.entries(item.statesSec)) {
                    statesFormatted[sKey] = {
                        sec: sSec,
                        formatted: formatDuration(sSec),
                        pct: Math.round((sSec / totalSec) * 1000) / 10
                    };
                }
                const readySec = (item.statesSec.Free || 0) + (item.statesSec.Busy || 0);
                const uptimePct = Math.round((readySec / totalSec) * 1000) / 10;
                return {
                    ...item,
                    states: statesFormatted,
                    totalCalls: cdr.totalCalls,
                    answeredCalls: cdr.answeredCalls,
                    talkSec: cdr.talkSec,
                    talkMin: Math.round(cdr.talkSec / 60),
                    uptimePct
                };
            });
        };

        const dongleReportsList = formatReportList(dongleStats, true);
        const simReportsList = formatReportList(simStats, false);

        res.json({
            success: true,
            timeframe: { startDate: startStr, endDate: endStr, totalWindowSec: totalWinSec, formattedWindow: formatDuration(totalWinSec) },
            globalSummary: {
                Free: { sec: globalStateSec.Free, formatted: formatDuration(globalStateSec.Free), pct: Math.round((globalStateSec.Free / (totalWinSec * Math.max(1, Object.keys(dongleStats).length))) * 1000) / 10 },
                Busy: { sec: globalStateSec.Busy, formatted: formatDuration(globalStateSec.Busy), pct: Math.round((globalStateSec.Busy / (totalWinSec * Math.max(1, Object.keys(dongleStats).length))) * 1000) / 10 },
                'Not Initialized': { sec: globalStateSec['Not Initialized'], formatted: formatDuration(globalStateSec['Not Initialized']), pct: Math.round((globalStateSec['Not Initialized'] / (totalWinSec * Math.max(1, Object.keys(dongleStats).length))) * 1000) / 10 },
                'Not connected': { sec: globalStateSec['Not connected'], formatted: formatDuration(globalStateSec['Not connected']), pct: Math.round((globalStateSec['Not connected'] / (totalWinSec * Math.max(1, Object.keys(dongleStats).length))) * 1000) / 10 }
            },
            dongleReports: dongleReportsList,
            simReports: simReportsList
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
// GET /api/config/modem/rtcp - Real-time RTCP audio diagnostics for active calls
app.get('/api/config/modem/rtcp', async (req, res) => {
    try {
        const output = await execFileAsync(ASTERISK_BIN, ['-rx', 'core show channels concise']);
        const lines = (output || '').split('\n').filter(Boolean);
        const channels = [];

        const sipStatsMap = {};
        try {
            const sipStatsOut = await execFileAsync(ASTERISK_BIN, ['-rx', 'sip show channelstats']);
            const sipLines = (sipStatsOut || '').split('\n');
            for (const sLine of sipLines) {
                const sParts = sLine.trim().split(/\s+/);
                if (sParts.length >= 7 && sParts[1] && sParts[1].length >= 5) {
                    const callIdPrefix = sParts[1];
                    const lostPctMatch = sLine.match(/\(\s*([\d.]+)\s*%\)/);
                    const lostPct = lostPctMatch ? parseFloat(lostPctMatch[1]) : 0;
                    const jitterSec = parseFloat(sParts[6]) || 0;
                    const jitterMs = Math.round(jitterSec * 1000 * 10) / 10;
                    sipStatsMap[callIdPrefix] = { jitterMs, packetLoss: lostPct };
                }
            }
        } catch (_) {}

        for (const line of lines) {
            const parts = line.split('!');
            const chanName = parts[0] || '';
            const context = parts[1] || '';
            const exten = parts[2] || '';
            const state = parts[4] || '';
            const appName = parts[5] || '';
            const duration = parts[10] || '0';

            if (!chanName) continue;

            let rxjitter = null;
            let rxploss = null;
            let rtt = null;
            let format = 'slin (8kHz)';
            const isRtp = chanName.startsWith('SIP/') || chanName.startsWith('PJSIP/');

            try {
                const chanDetail = await execFileAsync(ASTERISK_BIN, ['-rx', `core show channel ${chanName}`]);
                
                const fmtMatch = chanDetail.match(/NativeFormats?:\s*\(([^)]+)\)/i) || chanDetail.match(/ReadFormat:\s*([^\r\n]+)/i);
                if (fmtMatch) format = fmtMatch[1].trim();

                const sipCallIdMatch = chanDetail.match(/SIPCALLID=([^\r\n]+)/i);
                if (sipCallIdMatch && isRtp) {
                    const sipCallId = sipCallIdMatch[1].trim();
                    for (const prefix in sipStatsMap) {
                        if (sipCallId.startsWith(prefix)) {
                            rxjitter = sipStatsMap[prefix].jitterMs;
                            rxploss = sipStatsMap[prefix].packetLoss;
                            break;
                        }
                    }
                }

                if (rxjitter === null && isRtp) {
                    let sipDetail = '';
                    if (chanName.startsWith('SIP/')) {
                        try { sipDetail = await execFileAsync(ASTERISK_BIN, ['-rx', `sip show channel ${chanName}`]); } catch (_) {}
                    }
                    const combined = chanDetail + '\n' + sipDetail;
                    const jitterMatch = combined.match(/(?:Rx\s*Jitter|rxjitter|Jitter|Jitter\s*Count)\s*[:=]\s*([\d.]+)/i);
                    if (jitterMatch) rxjitter = Math.round(parseFloat(jitterMatch[1]) * 100) / 100;
                    const lossMatch = combined.match(/(?:Rx\s*Packet\s*Loss|Packet\s*Loss|Lost\s*Packets|Lost|rxploss)\s*[:=]\s*([\d.]+)/i);
                    if (lossMatch) rxploss = Math.round(parseFloat(lossMatch[1]) * 100) / 100;
                    const rttMatch = combined.match(/(?:RTT|Round\s*Trip|rtt)\s*[:=]\s*([\d.]+)/i);
                    if (rttMatch) rtt = Math.round(parseFloat(rttMatch[1]) * 100) / 100;
                }
            } catch (_) {}

            const ext = getExtensionFromChannel(chanName) || exten || chanName;
            channels.push({
                channel: chanName,
                extension: ext,
                isRtp: isRtp,
                state: state === 'Up' ? 'In Call' : (state || 'Ringing'),
                duration: duration + 's',
                format: format,
                jitterMs: rxjitter !== null && !isNaN(rxjitter) ? rxjitter : null,
                packetLoss: rxploss !== null && !isNaN(rxploss) ? rxploss : null,
                rttMs: rtt !== null && !isNaN(rtt) ? rtt : null
            });
        }

        res.json({
            success: true,
            activeCount: channels.length,
            channels: channels
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/config/audio-globals - Universal VAD/RNNoise tuning (threshold & hangover) used by the dialplan for every extension
app.get('/api/config/audio-globals', async (req, res) => {
    try {
        let vad_threshold = '0.20';
        let vad_hangover = '250';
        try {
            const { stdout } = await execPromise(`${ASTERISK_BIN} -rx "database show AUDIO_GLOBALS"`);
            const thresh = (stdout || '').match(/\/AUDIO_GLOBALS\/vad_threshold\s*:\s*([\d\.]+)/);
            const hang = (stdout || '').match(/\/AUDIO_GLOBALS\/vad_hangover\s*:\s*(\d+)/);
            if (thresh) vad_threshold = thresh[1];
            if (hang) vad_hangover = hang[1];
        } catch (_) {}
        res.json({ success: true, globals: { vad_threshold, vad_hangover } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/audio-globals - Update universal VAD/RNNoise tuning
app.put('/api/config/audio-globals', async (req, res) => {
    try {
        const threshold = parseFloat(req.body.vad_threshold);
        const hangover = parseInt(req.body.vad_hangover, 10);
        if (isNaN(threshold) || threshold < 0.01 || threshold > 0.95) {
            return res.status(400).json({ success: false, error: 'vad_threshold must be between 0.01 and 0.95' });
        }
        if (isNaN(hangover) || hangover < 50 || hangover > 2000) {
            return res.status(400).json({ success: false, error: 'vad_hangover must be between 50 and 2000 ms' });
        }
        await execPromise(`${ASTERISK_BIN} -rx "database put AUDIO_GLOBALS vad_threshold ${threshold.toFixed(2)}"`);
        await execPromise(`${ASTERISK_BIN} -rx "database put AUDIO_GLOBALS vad_hangover ${hangover}"`);
        res.json({ success: true, globals: { vad_threshold: threshold.toFixed(2), vad_hangover: String(hangover) }, message: 'Universal voice processing settings saved. Applied to all extensions immediately.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/modem/gain - Update volume gain (txgain, rxgain) for dongle(s)
// Note: RNNoise/VAD is extension-scoped only (AMPUSER AstDB); dongles carry no audio-filter settings.
app.post('/api/config/modem/gain', async (req, res) => {
    try {
        const { dongleId, rxgain, txgain, gains } = req.body;
        const { dongles } = parseDongleConfGain();
        const validDongleIds = new Set(Object.keys(dongles));
        let rawGainMap = {};

        if (gains && typeof gains === 'object') {
            rawGainMap = gains;
        } else if (dongleId) {
            rawGainMap[dongleId] = { rxgain, txgain };
        } else {
            return res.status(400).json({ success: false, error: 'Missing dongleId or gains payload' });
        }

        const safeGainMap = {};
        for (const id in rawGainMap) {
            const cleanId = String(id || '').trim();
            if (validDongleIds.has(cleanId) && /^[a-zA-Z0-9_-]+$/.test(cleanId)) {
                safeGainMap[cleanId] = {
                    rxgain: Math.max(-10, Math.min(10, parseInt(rawGainMap[id]?.rxgain, 10) || 0)),
                    txgain: Math.max(-10, Math.min(10, parseInt(rawGainMap[id]?.txgain, 10) || 0))
                };
            }
        }

        if (Object.keys(safeGainMap).length === 0) {
            return res.status(400).json({ success: false, error: 'No valid dongle IDs provided.' });
        }

        if (Object.keys(safeGainMap).length > 0) {
            updateDongleGainsInConf(safeGainMap, false);
            try {
                await execFileAsync(ASTERISK_BIN, ['-rx', 'module reload chan_dongle.so']);
            } catch (_) {}
        }

        res.json({ success: true, message: 'Dongle configuration updated successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/modem/reset - Reset all dongle gains to 0 in dongle.conf
app.post('/api/config/modem/reset', async (req, res) => {
    try {
        const { dongles } = parseDongleConfGain();
        updateDongleGainsInConf({}, true);

        try {
            await execFileAsync(ASTERISK_BIN, ['-rx', 'module reload chan_dongle.so']);
        } catch (_) {}

        // dongle restart disabled

        res.json({ success: true, message: 'All dongle gains reset to txgain=0 and rxgain=0 in dongle.conf and reloaded.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
// POST /api/config/modem/dongle-slot - Add dongle slot(s) to dongle.conf (ROOT USER ONLY)
app.post('/api/config/modem/dongle-slot', requireAuth, async (req, res) => {
    try {
        if (!req.session || (!req.session.isRoot && req.session.username !== ROOT_USER)) {
            return res.status(403).json({ success: false, error: 'Access denied. Only the root superuser can modify dongle slots in dongle.conf.' });
        }

        const count = Math.max(1, Math.min(32, parseInt(req.body.count, 10) || 1));
        const { dongleName, audio, data: dataPort, imei, imsi, rxgain, txgain, prefix } = req.body;
        const { dongles } = parseDongleConfGain();

        const basePrefix = String(prefix || 'dongle').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'dongle';
        const addedSlots = [];

        let baseAudioIndex = 1;
        if (audio && audio.includes('ttyUSB')) {
            const m = audio.match(/ttyUSB(\d+)/i);
            if (m) baseAudioIndex = parseInt(m[1], 10);
        } else {
            let maxPort = -1;
            for (const config of Object.values(dongles)) {
                for (const field of ['audio', 'data']) {
                    const port = String(config[field] || '');
                    const match = port.match(/ttyUSB(\d+)/i);
                    if (match) maxPort = Math.max(maxPort, parseInt(match[1], 10));
                }
            }
            // Huawei voice dongles expose three ttyUSB interfaces; audio/data are the final two.
            baseAudioIndex = maxPort >= 0 ? maxPort + 2 : 1;
        }

        let existingSlotNames = new Set(Object.keys(parseDongleConfGain().dongles));
        let nextIndex = 0;

        for (let i = 0; i < count; i++) {
            let targetName = '';
            if (count === 1 && dongleName && String(dongleName).trim()) {
                targetName = String(dongleName).trim().toLowerCase();
            } else {
                while (existingSlotNames.has(`${basePrefix}${nextIndex}`)) {
                    nextIndex++;
                }
                targetName = `${basePrefix}${nextIndex}`;
            }

            const audioPath = `/dev/ttyUSB${baseAudioIndex + (i * 3)}`;
            const dataPath = `/dev/ttyUSB${baseAudioIndex + (i * 3) + 1}`;

            addDongleSlotToConf({
                dongleName: targetName,
                audio: (count === 1 && audio) ? audio : audioPath,
                data: (count === 1 && dataPort) ? dataPort : dataPath,
                imei: (count === 1 && imei) ? imei : '',
                imsi: (count === 1 && imsi) ? imsi : '',
                rxgain: Number.isFinite(parseInt(rxgain, 10)) ? parseInt(rxgain, 10) : 3,
                txgain: Number.isFinite(parseInt(txgain, 10)) ? parseInt(txgain, 10) : 3
            });

            await pool.query(`
                INSERT INTO \`asterisk\`.\`gsm_dongles\` (dongle_name, imsi, imei, dynamic_enabled)
                VALUES (?, ?, ?, 0)
                ON DUPLICATE KEY UPDATE
                    imsi = COALESCE(NULLIF(VALUES(imsi), ''), imsi),
                    imei = COALESCE(NULLIF(VALUES(imei), ''), imei)
            `, [targetName, imsi || null, imei || null]);

            addedSlots.push(targetName);
            existingSlotNames.add(targetName);
        }

        const { execFile: execFileCb } = require('child_process');
        const execFileAsync = (cmd, args) => new Promise((resolve) => {
            execFileCb(cmd, args, (err, stdout) => resolve(err ? '' : stdout || ''));
        });

        try {
            await execFileAsync(ASTERISK_BIN, ['-rx', 'module reload chan_dongle.so']);
            for (const sName of addedSlots) {
                await syncDongleDynamicSetting(sName, false);
                await deleteAstDbKey('dongle_map', sName);
                // dongle restart disabled
            }
        } catch (_) {}

        const msg = addedSlots.length === 1
            ? `Dongle slot '${addedSlots[0]}' added to dongle.conf and initialized successfully.`
            : `Added ${addedSlots.length} dongle slots (${addedSlots.join(', ')}) to dongle.conf and initialized successfully.`;

        res.json({ success: true, addedSlots, message: msg });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/config/modem/dongle-slot - Remove dongle slot(s) from dongle.conf (ROOT USER ONLY)
app.delete('/api/config/modem/dongle-slot/:dongleName?', requireAuth, async (req, res) => {
    try {
        if (!req.session || (!req.session.isRoot && req.session.username !== ROOT_USER)) {
            return res.status(403).json({ success: false, error: 'Access denied. Only the root superuser can modify dongle slots in dongle.conf.' });
        }

        let slotsToRemove = [];
        if (req.params.dongleName) {
            slotsToRemove.push(req.params.dongleName.trim().toLowerCase());
        } else if (Array.isArray(req.body.dongleNames) && req.body.dongleNames.length > 0) {
            slotsToRemove = req.body.dongleNames.map(s => String(s).trim().toLowerCase());
        } else if (req.body.count) {
            const count = Math.max(1, parseInt(req.body.count, 10) || 1);
            const { dongles } = parseDongleConfGain();
            const keys = Object.keys(dongles).filter(k => k.startsWith('dongle')).reverse();
            slotsToRemove = keys.slice(0, count);
        }

        if (slotsToRemove.length === 0) {
            return res.status(400).json({ success: false, error: 'No dongle slots specified to remove.' });
        }

        const { execFile: execFileCb } = require('child_process');
        const execFileAsync = (cmd, args) => new Promise((resolve) => {
            execFileCb(cmd, args, (err, stdout) => resolve(err ? '' : stdout || ''));
        });

        const removed = [];
        for (const dName of slotsToRemove) {
            if (!/^[a-zA-Z0-9_-]+$/.test(dName)) continue;
            try {
                removeDongleSlotFromConf(dName);
                await pool.query('DELETE FROM `asterisk`.`gsm_dongles` WHERE dongle_name = ?', [dName]);
                await execFileAsync(ASTERISK_BIN, ['-rx', `database del dongle_map ${dName}`]);
                await execFileAsync(ASTERISK_BIN, ['-rx', `database del DONGLE_SETTINGS ${dName}`]);
                removed.push(dName);
            } catch (_) {}
        }

        try {
            await execFileAsync(ASTERISK_BIN, ['-rx', 'module reload chan_dongle.so']);
        } catch (_) {}

        const msg = removed.length === 1
            ? `Dongle slot '${removed[0]}' removed from dongle.conf and Asterisk successfully.`
            : `Removed ${removed.length} dongle slots (${removed.join(', ')}) from dongle.conf and Asterisk successfully.`;

        res.json({ success: true, removedSlots: removed, message: msg });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// --- MUSIC ON HOLD (MOH) MODULE ---
// ============================================================================
const MOH_ROOT = '/var/lib/asterisk/moh';
const MOH_CONF_FILE = '/etc/asterisk/musiconhold_additional.conf';

function parseMohConf() {
    const categories = [];
    if (!fs.existsSync(MOH_CONF_FILE)) {
        return [
            { name: 'default', mode: 'files', directory: MOH_ROOT + '/', sort: 'alpha', isDefault: true },
            { name: 'none', mode: 'files', directory: path.join(MOH_ROOT, '.nomusic_reserved') + '/', sort: 'alpha', isDefault: true }
        ];
    }
    const content = fs.readFileSync(MOH_CONF_FILE, 'utf8');
    const lines = content.split('\n');
    let currentCat = null;

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) return;
        const matchCat = trimmed.match(/^\[([^\]]+)\]$/);
        if (matchCat) {
            if (currentCat) categories.push(currentCat);
            currentCat = {
                name: matchCat[1].trim(),
                mode: 'files',
                directory: '',
                sort: 'alpha',
                isDefault: matchCat[1].trim() === 'default' || matchCat[1].trim() === 'none'
            };
        } else if (currentCat) {
            const parts = trimmed.split('=');
            if (parts.length >= 2) {
                const key = parts[0].trim().toLowerCase();
                const val = parts.slice(1).join('=').trim();
                if (key === 'mode') currentCat.mode = val;
                if (key === 'directory') currentCat.directory = val;
                if (key === 'sort') currentCat.sort = val;
                if (key === 'application') currentCat.application = val;
            }
        }
    });
    if (currentCat) categories.push(currentCat);

    if (!categories.some(c => c.name === 'default')) {
        categories.unshift({ name: 'default', mode: 'files', directory: MOH_ROOT + '/', sort: 'alpha', isDefault: true });
    }
    if (!categories.some(c => c.name === 'none')) {
        categories.push({ name: 'none', mode: 'files', directory: path.join(MOH_ROOT, '.nomusic_reserved') + '/', sort: 'alpha', isDefault: true });
    }
    return categories;
}

function writeMohConf(categories) {
    const lines = [
        ';--------------------------------------------------------------------------------;',
        '; Do NOT edit this file as it is auto-generated by IssabelPBX. All modifications ;',
        '; to this file must be done via the web gui. There are alternative files to make ;',
        '; custom modifications, details at: http://issabel.org/configuration_files       ;',
        ';--------------------------------------------------------------------------------;',
        ';'
    ];

    categories.forEach(cat => {
        lines.push(`[${cat.name}]`);
        lines.push(`mode=${cat.mode || 'files'}`);
        lines.push(`directory=${cat.directory}`);
        lines.push(`sort=${cat.sort || 'alpha'}`);
        if (cat.application) lines.push(`application=${cat.application}`);
        lines.push('');
    });

    fs.writeFileSync(MOH_CONF_FILE, lines.join('\n'), 'utf8');
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// GET /api/config/moh - List all MoH Categories and Audio Files
app.get('/api/config/moh', requireAuth, async (req, res) => {
    try {
        const categories = parseMohConf();
        const result = [];

        for (const cat of categories) {
            let dirPath = cat.directory;
            if (!dirPath) {
                dirPath = cat.name === 'default' ? MOH_ROOT : path.join(MOH_ROOT, cat.name);
            }
            dirPath = path.resolve(dirPath);

            const filesList = [];
            if (fs.existsSync(dirPath)) {
                const filenames = fs.readdirSync(dirPath);
                filenames.forEach(file => {
                    const fullPath = path.join(dirPath, file);
                    if (file.startsWith('.')) return;
                    try {
                        const stat = fs.statSync(fullPath);
                        if (stat.isFile()) {
                            const ext = path.extname(file).toLowerCase();
                            const validExts = ['.wav', '.mp3', '.gsm', '.ogg', '.sln', '.alaw', '.ulaw'];
                            if (validExts.includes(ext) || ext === '') {
                                filesList.push({
                                    filename: file,
                                    size: stat.size,
                                    sizeFormatted: formatBytes(stat.size),
                                    ext: ext || 'wav',
                                    format: (ext ? ext.substring(1) : 'wav').toUpperCase(),
                                    streamUrl: `/api/config/moh/stream/${encodeURIComponent(cat.name)}/${encodeURIComponent(file)}`
                                });
                            }
                        }
                    } catch (_) {}
                });
            }

            result.push({
                ...cat,
                files: filesList,
                fileCount: filesList.length
            });
        }

        res.json({ success: true, categories: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/config/moh/category - Add new MoH Category
app.post('/api/config/moh/category', requireAuth, async (req, res) => {
    try {
        const { name, sort, mode } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Category Name is required.' });
        }
        const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        if (cleanName === 'default' || cleanName === 'none') {
            return res.status(400).json({ success: false, error: `'${cleanName}' is a reserved system category name.` });
        }

        const categories = parseMohConf();
        if (categories.some(c => c.name === cleanName)) {
            return res.status(400).json({ success: false, error: `Category '${cleanName}' already exists.` });
        }

        const catDir = path.join(MOH_ROOT, cleanName);
        if (!fs.existsSync(catDir)) {
            fs.mkdirSync(catDir, { recursive: true });
            try { execSync(`chown -R asterisk:asterisk "${catDir}" && chmod -R 775 "${catDir}"`); } catch (_) {}
        }

        categories.push({
            name: cleanName,
            mode: mode || 'files',
            directory: catDir + '/',
            sort: sort || 'alpha',
            isDefault: false
        });

        writeMohConf(categories);
        try { execSync(`${ASTERISK_BIN} -rx "moh reload"`); } catch (_) {}

        res.json({ success: true, message: `Music on Hold Category '${cleanName}' created successfully.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/config/moh/category/:name - Delete MoH Category
app.delete('/api/config/moh/category/:name', requireAuth, async (req, res) => {
    try {
        const catName = req.params.name.trim().toLowerCase();
        if (catName === 'default' || catName === 'none') {
            return res.status(400).json({ success: false, error: 'System categories cannot be deleted.' });
        }

        let categories = parseMohConf();
        const cat = categories.find(c => c.name === catName);
        if (!cat) {
            return res.status(404).json({ success: false, error: 'Category not found.' });
        }

        categories = categories.filter(c => c.name !== catName);
        writeMohConf(categories);

        const catDir = cat.directory ? path.resolve(cat.directory) : path.join(MOH_ROOT, catName);
        if (fs.existsSync(catDir) && catDir.startsWith(MOH_ROOT) && catDir !== MOH_ROOT) {
            try { fs.rmSync(catDir, { recursive: true, force: true }); } catch (_) {}
        }

        try { execSync(`${ASTERISK_BIN} -rx "moh reload"`); } catch (_) {}
        res.json({ success: true, message: `MoH Category '${catName}' deleted successfully.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/config/moh/upload - Upload Audio Track to MoH Category
const mohUpload = multer({
    dest: '/tmp',
    limits: { fileSize: 50 * 1024 * 1024 }
});

app.post('/api/config/moh/upload', requireAuth, (req, res) => {
    mohUpload.single('audio')(req, res, async function(err) {
        if (err) return res.status(400).json({ success: false, error: err.message });
        if (!req.file) return res.status(400).json({ success: false, error: 'No audio file uploaded.' });

        const rawPath = req.file.path;
        const catParam = req.query.category || req.body.category || 'default';
        const catName = String(catParam).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        const categories = parseMohConf();
        const cat = categories.find(c => c.name === catName) || categories[0];
        let catDir = cat.directory ? path.resolve(cat.directory) : (catName === 'default' ? MOH_ROOT : path.join(MOH_ROOT, catName));

        if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });

        const parsed = path.parse(req.file.originalname);
        const cleanName = parsed.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const targetWavPath = path.join(catDir, `${cleanName}.wav`);

        try {
            const tempWav = path.join(catDir, `temp_${Date.now()}_${cleanName}.wav`);
            await convertToWav(rawPath, tempWav);

            if (fs.existsSync(targetWavPath)) {
                try { fs.unlinkSync(targetWavPath); } catch (_) {}
            }
            fs.renameSync(tempWav, targetWavPath);

            if (fs.existsSync(rawPath)) {
                try { fs.unlinkSync(rawPath); } catch (_) {}
            }

            try { execSync(`chown asterisk:asterisk "${targetWavPath}" && chmod 664 "${targetWavPath}"`); } catch (_) {}
            try { execSync(`${ASTERISK_BIN} -rx "moh reload"`); } catch (_) {}

            res.json({
                success: true,
                message: `Audio file '${cleanName}.wav' uploaded and converted to 8kHz mono WAV in category '${cat.name}'.`
            });
        } catch (convErr) {
            console.error('MoH audio conversion error:', convErr.message);
            const rawTarget = path.join(catDir, `${cleanName}${parsed.ext || '.wav'}`);
            try { fs.copyFileSync(rawPath, rawTarget); } catch(_) {}
            if (fs.existsSync(rawPath)) try { fs.unlinkSync(rawPath); } catch(_) {}
            try { execSync(`chown asterisk:asterisk "${rawTarget}" && chmod 664 "${rawTarget}"`); } catch (_) {}
            try { execSync(`${ASTERISK_BIN} -rx "moh reload"`); } catch (_) {}
            res.json({
                success: true,
                message: `Audio file uploaded to MoH category '${cat.name}'.`
            });
        }
    });
});

// DELETE /api/config/moh/file - Delete Audio Track from MoH Category
app.delete('/api/config/moh/file', requireAuth, async (req, res) => {
    try {
        const { category, filename } = req.body;
        if (!category || !filename) {
            return res.status(400).json({ success: false, error: 'Category and Filename are required.' });
        }
        const catName = category.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        const cleanFile = path.basename(filename);
        const categories = parseMohConf();
        const cat = categories.find(c => c.name === catName) || categories[0];
        let catDir = cat.directory ? path.resolve(cat.directory) : (catName === 'default' ? MOH_ROOT : path.join(MOH_ROOT, catName));

        const targetFile = path.join(catDir, cleanFile);
        if (fs.existsSync(targetFile)) {
            fs.unlinkSync(targetFile);
        }

        try { execSync(`${ASTERISK_BIN} -rx "moh reload"`); } catch (_) {}
        res.json({ success: true, message: `Audio file '${cleanFile}' removed from MoH category '${catName}'.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/config/moh/stream/:category/:file - Stream MoH Audio for Browser Preview
app.get('/api/config/moh/stream/:category/:file', requireAuth, (req, res) => {
    try {
        const catName = req.params.category.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        const fileName = path.basename(req.params.file);
        const categories = parseMohConf();
        const cat = categories.find(c => c.name === catName) || categories[0];
        let catDir = cat.directory ? path.resolve(cat.directory) : (catName === 'default' ? MOH_ROOT : path.join(MOH_ROOT, catName));

        const filePath = path.join(catDir, fileName);
        if (!fs.existsSync(filePath)) {
            return res.status(404).send('MoH Audio file not found.');
        }

        const stat = fs.statSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.gsm': 'audio/x-gsm' };
        const contentType = mimeTypes[ext] || 'audio/wav';

        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunksize = (end - start) + 1;
            const fileStream = fs.createReadStream(filePath, { start, end });
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType,
            });
            fileStream.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': stat.size,
                'Content-Type': contentType,
            });
            fs.createReadStream(filePath).pipe(res);
        }
    } catch (err) {
        res.status(500).send(err.message);
    }
});
// GET /api/config/modem/jitterbuffer - Check if dialplan jitter buffer is enabled
app.get('/api/config/modem/jitterbuffer', async (req, res) => {
    try {
        const enabled = getDialplanJitterBufferStatus();
        res.json({ success: true, enabled });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/modem/jitterbuffer - Enable or disable dialplan jitter buffer
app.post('/api/config/modem/jitterbuffer', async (req, res) => {
    try {
        const { enabled } = req.body;
        const targetState = Boolean(enabled);
        setDialplanJitterBufferStatus(targetState);

        try {
            await execFileAsync(ASTERISK_BIN, ['-rx', 'dialplan reload']);
        } catch (_) {}

        res.json({
            success: true,
            enabled: targetState,
            message: targetState
                ? 'Jitter buffer enabled in Asterisk dialplan and reloaded.'
                : 'Jitter buffer removed from Asterisk dialplan and reloaded.'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
// GET /api/config/modem/denoise - Fetch DSP noise suppression status (rx/tx)
app.get('/api/config/modem/denoise', async (req, res) => {
    try {
        const status = getDialplanDenoiseStatus();
        res.json({ success: true, ...status });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/modem/denoise - Update DSP noise suppression settings (rx/tx)
app.post('/api/config/modem/denoise', async (req, res) => {
    try {
        setDialplanDenoiseStatus({ rx: false, tx: false });

        try {
            await execFileAsync(ASTERISK_BIN, ['-rx', 'dialplan reload']);
        } catch (_) {}

        return res.json({
            success: true,
            rx: false,
            tx: false,
            message: 'Asterisk DENOISE is disabled to prevent libspeexdsp system library crash.'
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});
// GET /api/config/dongle-mappings - Fetch detailed GSM dongle DID dynamic mappings & telemetry
app.get('/api/config/dongle-mappings', requireAuth, async (req, res) => {
    try {
        const { execFile: execFileCb } = require('child_process');
        const execFileAsync = (cmd, args) => new Promise((resolve) => {
            execFileCb(cmd, args, (err, stdout) => resolve(err ? '' : stdout || ''));
        });

        const [dbRows] = await pool.query('SELECT dongle_name, imsi, imei, phone_number, dynamic_enabled, updated_at FROM `asterisk`.`gsm_dongles`');
        const devicesOutput = await execFileAsync(ASTERISK_BIN, ['-rx', 'dongle show devices']);
        const liveDevices = parseDevicesOutput(devicesOutput || '', true);
        const liveMap = {};
        for (const dev of liveDevices) {
            if (dev.ID) liveMap[dev.ID] = dev;
        }

        const getAstDbMap = async (family) => {
            const out = await execFileAsync(ASTERISK_BIN, ['-rx', `database show ${family}`]);
            const map = {};
            if (out) {
                const lines = out.split('\n');
                lines.forEach(line => {
                    const regex = new RegExp(`\\/${family}\\/([a-zA-Z0-9_]+)\\s*:\\s*(.+)`);
                    const m = regex.exec(line);
                    if (m) map[m[1].trim()] = m[2].trim();
                });
            }
            return map;
        };

        const [dongleMap, simMap, dongleNumMap] = await Promise.all([
            getAstDbMap('dongle_map'),
            getAstDbMap('sim_map'),
            getAstDbMap('DONGLE_NUMBERS')
        ]);

        const [routes] = await pool.query('SELECT extension, destination, description FROM `asterisk`.`incoming`');
        const routeMap = {};
        for (const r of routes) {
            if (r.extension) routeMap[r.extension.trim()] = r;
        }

        const confDongles = parseDongleConfGain().dongles;
        const validSlotNames = new Set([...Object.keys(liveMap), ...Object.keys(confDongles)]);
        const allDongleNames = validSlotNames.size > 0
            ? validSlotNames
            : new Set([
                ...dbRows.map(r => r.dongle_name),
                ...Object.keys(liveMap),
                ...Object.keys(dongleMap)
            ]);

        const mappings = [];
        for (const dName of Array.from(allDongleNames)) {
            if (!dName || !dName.startsWith('dongle')) continue;

            const dbRow = dbRows.find(r => r.dongle_name === dName);
            const liveDev = liveMap[dName];

            const phoneNum = dbRow ? (dbRow.phone_number || '') : (dongleMap[dName] || '');
            const imsi = liveDev?.IMSI && liveDev.IMSI !== '-' ? liveDev.IMSI : (dbRow?.imsi || '');
            const imei = liveDev?.IMEI && liveDev.IMEI !== '-' ? liveDev.IMEI : (dbRow?.imei || '');
            const simNum = liveDev?.Number || 'Unknown';
            const state = liveDev?.State || 'Disconnected';
            const rssi = liveDev?.RSSI || '-';
            const provider = liveDev?.['Provider Name'] || 'Unknown';

            const astdbStatus = {
                dongle_map: dongleMap[dName] || null,
                sim_map: imsi ? (simMap[imsi] || null) : null,
                DONGLE_NUMBERS_IMSI: imsi ? (dongleNumMap[imsi] || null) : null,
                DONGLE_NUMBERS_IMEI: imei ? (dongleNumMap[imei] || null) : null
            };

            let routeMatch = null;
            if (phoneNum) {
                const cleanNum = phoneNum.trim();
                const alt1 = cleanNum.startsWith('+20') ? ('0' + cleanNum.substring(3)) : (cleanNum.startsWith('01') ? ('+20' + cleanNum.substring(1)) : cleanNum);
                const alt2 = cleanNum.startsWith('+') ? cleanNum.substring(1) : ('+' + cleanNum);
                routeMatch = routeMap[cleanNum] || routeMap[alt1] || routeMap[alt2] || null;
            }

            mappings.push({
                dongleName: dName,
                phoneNumber: phoneNum,
                imsi,
                imei,
                simNumber: simNum,
                state,
                rssi,
                provider,
                dynamicEnabled: Boolean(dbRow && Number(dbRow.dynamic_enabled) === 1),
                astdb: astdbStatus,
                inboundRoute: routeMatch ? {
                    found: true,
                    extension: routeMatch.extension,
                    destination: routeMatch.destination,
                    description: routeMatch.description
                } : { found: false },
                updatedAt: dbRow?.updated_at || null
            });
        }

        mappings.sort((a, b) => a.dongleName.localeCompare(b.dongleName));

        return res.json({
            success: true,
            mappings,
            summary: {
                totalCount: mappings.length,
                connectedCount: Object.keys(liveMap).length,
                syncedCount: mappings.filter(m => m.astdb.dongle_map === m.phoneNumber && m.phoneNumber !== '').length,
                routeFoundCount: mappings.filter(m => m.inboundRoute.found).length
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/config/dongle-mappings/:dongleName/toggle - Explicitly opt a dongle in or out
app.post('/api/config/dongle-mappings/:dongleName/toggle', requireAuth, async (req, res) => {
    try {
        const dongleName = normalizeDongleMappingKey(req.params.dongleName);
        if (!dongleName || !dongleName.startsWith('dongle')) {
            return res.status(400).json({ success: false, error: 'Invalid dongle name' });
        }

        const [existing] = await pool.query(
            'SELECT imsi, imei, phone_number, dynamic_enabled FROM `asterisk`.`gsm_dongles` WHERE dongle_name = ?',
            [dongleName]
        );
        const currentState = Boolean(existing[0] && Number(existing[0].dynamic_enabled) === 1);
        const targetState = typeof req.body.enabled === 'boolean'
            ? req.body.enabled
            : (req.body.enabled === 'false' || req.body.enabled === 0 || req.body.enabled === '0'
                ? false
                : !currentState);
        const val = targetState ? 1 : 0;

        await pool.query(`
            INSERT INTO \`asterisk\`.\`gsm_dongles\` (dongle_name, dynamic_enabled)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE dynamic_enabled = VALUES(dynamic_enabled)
        `, [dongleName, val]);
        await syncDongleDynamicSetting(dongleName, targetState);

        const [savedRows] = await pool.query(
            'SELECT imsi, imei, phone_number FROM `asterisk`.`gsm_dongles` WHERE dongle_name = ?',
            [dongleName]
        );
        const savedMapping = savedRows[0] || {};
        const aliasesSynced = targetState
            ? await syncDongleMappingAliases({
                dongleName,
                imsi: savedMapping.imsi,
                imei: savedMapping.imei,
                phoneNumber: savedMapping.phone_number
            })
            : false;

        await execFileAsync(ASTERISK_BIN, ['-rx', 'dialplan reload']);

        return res.json({
            success: true,
            dongleName,
            enabled: targetState,
            aliasesSynced,
            message: targetState
                ? (aliasesSynced
                    ? `Dynamic DID mapping enabled for ${dongleName}; configured DID aliases are synchronized.`
                    : `Dynamic DID mapping enabled for ${dongleName}; configure a DID before it can route calls.`)
                : `Dynamic DID mapping disabled for ${dongleName}.`
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});
// AUTO-DIALER & QUEUE CONTROL ENGINE MODULE
// ============================================================================

let isDialerLeader = false;
let dialerLeaderLockConnection = null;

async function acquireDialerLeaderLock() {
    try {
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [rows] = await conn.execute("SELECT GET_LOCK('sokrat_dialer_pacer_lock', 0) AS locked");
        if (rows[0] && rows[0].locked === 1) {
            isDialerLeader = true;
            dialerLeaderLockConnection = conn;
            console.log('DIALER ENGINE: Leader lock acquired successfully.');
            await reconcileStaleAttempts();
            setInterval(runDialerPacerCycle, 1000);
        } else {
            isDialerLeader = false;
            await conn.end();
            console.log('DIALER ENGINE: Leader lock held by another process; secondary mode.');
        }
    } catch (err) {
        console.error('DIALER ENGINE: Leader lock error:', err.message);
    }
}

async function reconcileStaleAttempts() {
    try {
        console.log('DIALER ENGINE: Reconciling stale attempt ledger...');
        const [expiredAttempts] = await pool.query(`
            SELECT attempt_uuid, campaign_id, lead_id
            FROM \`asterisk\`.\`dialer_call_attempts\`
            WHERE active_flag = 1 AND lease_expires_at < NOW()
        `);

        for (const att of expiredAttempts) {
            await pool.query(`
                UPDATE \`asterisk\`.\`dialer_call_attempts\`
                SET active_flag = NULL, status = 'stale', cause_code = 999
                WHERE attempt_uuid = ? AND active_flag = 1
            `, [att.attempt_uuid]);

            const [attCountRow] = await pool.query('SELECT COUNT(*) AS cnt FROM `asterisk`.`dialer_call_attempts` WHERE lead_id = ?', [att.lead_id]);
            const totalAttempts = attCountRow[0]?.cnt || 1;
            const newStatus = totalAttempts >= 3 ? 'failed' : 'pending';

            await pool.query('UPDATE `asterisk`.`dialer_leads` SET status = ?, attempts = ? WHERE id = ?', [newStatus, totalAttempts, att.lead_id]);
        }

        await pool.query("UPDATE `asterisk`.`dialer_agent_states` SET state = 'idle', current_lead_id = NULL, current_attempt_uuid = NULL WHERE state = 'reserved' AND updated_at < NOW() - INTERVAL 1 MINUTE");
        console.log(`DIALER ENGINE: Reconciliation complete. Reset ${expiredAttempts.length} stale attempt(s).`);
    } catch (err) {
        console.error('DIALER ENGINE: Reconciliation error:', err.message);
    }
}

async function claimNextLeadAtomic(campaignId) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [leads] = await conn.query(`
            SELECT l.id, l.phone_number, l.first_name, l.last_name, l.company, l.custom_data
            FROM \`asterisk\`.\`dialer_leads\` l
            LEFT JOIN \`asterisk\`.\`dialer_dnc\` d ON d.phone_number = l.phone_number
            WHERE l.campaign_id = ? AND l.status = 'pending' AND d.phone_number IS NULL
            ORDER BY l.id ASC
            LIMIT 1
            FOR UPDATE
        `, [campaignId]);

        if (leads.length === 0) {
            await conn.rollback();
            return null;
        }

        const lead = leads[0];
        const attemptUuid = 'att_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);

        await conn.query('UPDATE `asterisk`.`dialer_leads` SET status = "dialing", attempts = attempts + 1, last_called_at = NOW() WHERE id = ?', [lead.id]);

        await conn.query(`
            INSERT INTO \`asterisk\`.\`dialer_call_attempts\`
            (attempt_uuid, action_id, campaign_id, lead_id, active_flag, status, lease_expires_at)
            VALUES (?, ?, ?, ?, 1, 'originated', NOW() + INTERVAL 2 MINUTE)
        `, [attemptUuid, attemptUuid, campaignId, lead.id]);

        await conn.commit();
        return { attemptUuid, lead };
    } catch (err) {
        await conn.rollback();
        console.error('DIALER ENGINE: Lead claim error:', err.message);
        return null;
    } finally {
        conn.release();
    }
}

/**
 * Extract extension number from a queue member string.
 * "SIP/101" → "101", "Local/101@from-queue/n" → "101", "PJSIP/200" → "200"
 */
function extractExtFromQueueMember(memberData) {
    if (!memberData) return null;
    const m = memberData.trim();
    let match = m.match(/^Local\/(\d+)@/);
    if (match) return match[1];
    match = m.match(/^(?:SIP|PJSIP)\/(\d+)/);
    if (match) return match[1];
    match = m.match(/^(\d+)$/);
    if (match) return match[1];
    return null;
}
async function runDialerPacerCycle() {
    if (!isDialerLeader) return;

    try {
        const [campaigns] = await pool.query("SELECT * FROM `asterisk`.`dialer_campaigns` WHERE status = 'running'");
        if (campaigns.length === 0) return;

        for (const camp of campaigns) {
            const campId = camp.id;
            const mode = camp.mode || 'progressive';
            const queueName = camp.queue_name || 'autodialer-queue';
            const maxCap = camp.max_concurrent_dials || 5;

            const [roster] = await pool.query('SELECT extension, name FROM `asterisk`.`users` ORDER BY CAST(extension AS UNSIGNED) ASC');
            let availableAgents = [];
            for (const emp of roster) {
                const ext = emp.extension;
                const isOnline = peerStatus[ext] || false;
                const isCall = activeCalls[ext] || false;

                const [astates] = await pool.query('SELECT state, wrapup_until FROM `asterisk`.`dialer_agent_states` WHERE extension = ?', [ext]);
                const astate = astates[0] ? astates[0].state : 'idle';
                const wrapupUntil = astates[0]?.wrapup_until ? new Date(astates[0].wrapup_until).getTime() : 0;

                let isWrapupExpired = false;
                if (astate === 'wrapup' && wrapupUntil > 0 && Date.now() >= wrapupUntil) {
                    await pool.query("UPDATE `asterisk`.`dialer_agent_states` SET state = 'idle', wrapup_until = NULL WHERE extension = ?", [ext]);
                    isWrapupExpired = true;
                }

                const currentEffectiveState = isWrapupExpired ? 'idle' : astate;

                if (isOnline && !isCall && currentEffectiveState === 'idle') {
                    availableAgents.push(ext);
                }
            }

            // Filter to queue members only for predictive mode
            if (mode === 'predictive' && queueName) {
                const [qMembers] = await pool.query(
                    "SELECT keyword, data FROM `asterisk`.`queues_details` WHERE id = ? AND (keyword = 'member' OR keyword = 'dynmembers')",
                    [queueName]
                );
                const memberExts = new Set();
                for (const row of qMembers) {
                    if (row.keyword === 'member') {
                        const ext = extractExtFromQueueMember(row.data);
                        if (ext) memberExts.add(ext);
                    } else if (row.keyword === 'dynmembers') {
                        // dynmembers is a comma-separated list: "101, 103"
                        const parts = row.data.split(',').map(s => s.trim()).filter(Boolean);
                        for (const p of parts) memberExts.add(p);
                    }
                }
                // Always replace availableAgents with intersection (may become empty = no queue agents free)
                availableAgents = availableAgents.filter(e => memberExts.has(e));
            }

            const [inflightRows] = await pool.query('SELECT COUNT(*) AS cnt FROM `asterisk`.`dialer_call_attempts` WHERE campaign_id = ? AND active_flag = 1', [campId]);
            const countInflight = inflightRows[0]?.cnt || 0;

            let freeDonglesCount = maxCap;
            if (camp.outbound_route_id) {
                const [rTrunks] = await pool.query(`
                    SELECT rt.trunk_id, t.channelid, t.name AS trunk_name
                    FROM \`asterisk\`.\`outbound_route_trunks\` rt
                    LEFT JOIN \`asterisk\`.\`trunks\` t ON t.trunkid = rt.trunk_id
                    WHERE rt.route_id = ?
                    ORDER BY rt.seq ASC
                `, [camp.outbound_route_id]);

                const liveChannels = await getLiveAsteriskChannelNames();
                let totalFreeTrunkChannels = 0;

                for (const tRow of rTrunks) {
                    const trunkInfo = parseTrunkIdentifier(tRow.channelid, tRow.trunk_name);
                    const tId = trunkInfo ? trunkInfo.id : `trunk_${tRow.trunk_id}`;

                    let isOccupied = false;
                    if (trunkInfo) {
                        for (const chan of liveChannels) {
                            const cLower = chan.toLowerCase();
                            if (trunkInfo.tech === 'dongle') {
                                if (cLower.startsWith(`dongle/${tId}-`)) { isOccupied = true; break; }
                            } else if (trunkInfo.tech === 'sip' || trunkInfo.tech === 'pjsip') {
                                if (cLower.startsWith(`sip/${tId}-`) || cLower.startsWith(`pjsip/${tId}-`)) { isOccupied = true; break; }
                            }
                        }
                    }

                    const [activeOnTrunk] = await pool.query(`
                        SELECT COUNT(*) AS cnt
                        FROM \`asterisk\`.\`dialer_call_attempts\`
                        WHERE active_flag = 1 AND (dongle_id = ? OR (dongle_id IS NULL AND campaign_id = ?))
                    `, [tId, campId]);

                    const ledgerInUse = activeOnTrunk[0]?.cnt || 0;
                    const maxTrunkChans = 1; // 1 max channel per GSM dongle
                    const available = (isOccupied || ledgerInUse >= maxTrunkChans) ? 0 : 1;
                    totalFreeTrunkChannels += available;
                }
                freeDonglesCount = Math.min(totalFreeTrunkChannels, maxCap);
            }

            let incrementalLaunches = 0;
            if (mode === 'progressive') {
                const unreservedAgents = availableAgents.length - countInflight;
                if (unreservedAgents > 0) {
                    incrementalLaunches = Math.min(unreservedAgents, freeDonglesCount, maxCap);
                }
            } else {
                const answerRate = 0.35;
                const targetInflight = Math.round(availableAgents.length / answerRate);
                const needed = targetInflight - countInflight;
                if (needed > 0) {
                    incrementalLaunches = Math.min(needed, freeDonglesCount, maxCap);
                }
            }

            if (incrementalLaunches <= 0) continue;

            for (let i = 0; i < incrementalLaunches; i++) {
                const claim = await claimNextLeadAtomic(campId);
                if (!claim) break;

                const { attemptUuid, lead } = claim;
                const assignedAgent = availableAgents[i] || availableAgents[0] || '';

                if (assignedAgent) {
                    await pool.query(`
                        INSERT INTO \`asterisk\`.\`dialer_agent_states\` (extension, state, current_lead_id, current_attempt_uuid)
                        VALUES (?, 'reserved', ?, ?)
                        ON DUPLICATE KEY UPDATE state = 'reserved', current_lead_id = VALUES(current_lead_id), current_attempt_uuid = VALUES(current_attempt_uuid)
                    `, [assignedAgent, lead.id, attemptUuid]);
                }

                if (amiClient) {
                    const outboundContext = camp.outbound_route_id ? `outrt-${camp.outbound_route_id}` : 'from-internal';
                    const cidNum = sanitizeAmiValue(camp.origination_caller_id || '101');
                    const cleanPhone = sanitizeAmiValue(lead.phone_number);
                    const cleanAttemptUuid = sanitizeAmiValue(attemptUuid);
                    const cleanQueue = sanitizeAmiValue(queueName);
                    const cleanFallback = sanitizeAmiValue(camp.fallback_destination || 'app-blackhole,hangup,1');
                    const cleanAgent = sanitizeAmiValue(assignedAgent);

                    if (mode === 'progressive') {
                        // Progressive / Agent-First: Originate agent extension first, then dial lead upon answer
                        const agentChannel = `SIP/${cleanAgent}`;
                        const callerIdHeader = `"${cleanPhone}" <${cleanPhone}>`;
                        const varHeaders = [
                            `Variable: ATTEMPT_UUID=${cleanAttemptUuid}`,
                            `Variable: LEAD_ID=${lead.id}`,
                            `Variable: LEAD_PHONE=${cleanPhone}`,
                            `Variable: OUTBOUND_CONTEXT=${outboundContext}`,
                            `Variable: ORIGINATION_CALLER_ID=${cidNum}`,
                            `Variable: TARGET_AGENT=${cleanAgent}`
                        ].join('\r\n');

                        amiClient.write(`Action: Originate\r\nActionID: ${cleanAttemptUuid}\r\nChannel: ${agentChannel}\r\nContext: from-autodialer-progressive\r\nExten: s\r\nPriority: 1\r\nCallerID: ${callerIdHeader}\r\n${varHeaders}\r\n\r\n`);
                    } else {
                        // Predictive / Lead-First: Originate outbound lead first, run AMD, hand off to Queue
                        const callerIdHeader = `"${cidNum}" <${cidNum}>`;
                        const varHeaders = [
                            `Variable: ATTEMPT_UUID=${cleanAttemptUuid}`,
                            `Variable: LEAD_ID=${lead.id}`,
                            `Variable: LEAD_PHONE=${cleanPhone}`,
                            `Variable: TARGET_QUEUE=${cleanQueue}`,
                            `Variable: MAX_QUEUE_WAIT=${camp.max_queue_wait_sec || 5}`,
                            `Variable: FALLBACK_DEST=${cleanFallback}`,
                            `Variable: AMD_ENABLE=${camp.amd_enabled ? '1' : '0'}`,
                            `Variable: TARGET_AGENT=${cleanAgent}`
                        ].join('\r\n');

                        amiClient.write(`Action: Originate\r\nActionID: ${cleanAttemptUuid}\r\nChannel: Local/${cleanPhone}@${outboundContext}/n\r\nContext: from-autodialer-amd\r\nExten: s\r\nPriority: 1\r\nCallerID: ${callerIdHeader}\r\n${varHeaders}\r\n\r\n`);
                    }
                }
            }
        }
    } catch (err) {
        console.error('DIALER PACER CYCLE ERROR:', err.message);
    }
}

function handleDialerAmiEvents(event) {
    if (!event) return;

    const dId = extractDongleIdFromChannel(event.Channel || event.Channel1 || event.Channel2 || '');
    const aUuid = event.AttemptUUID || (event.ActionID && event.ActionID.startsWith('att_') ? event.ActionID : null);
    if (dId && aUuid) {
        pool.query('UPDATE `asterisk`.`dialer_call_attempts` SET dongle_id = ? WHERE attempt_uuid = ? AND active_flag = 1', [dId, aUuid]).catch(() => {});
    }
    if (event.Event === 'OriginateResponse' && event.ActionID && event.ActionID.startsWith('att_')) {
        const attemptUuid = event.ActionID;
        const responseStatus = event.Response || '';
        const reason = parseInt(event.Reason || '0', 10);

        if (responseStatus !== 'Success') {
            const terminalStatus = (reason === 5 || reason === 3) ? 'busy' : (reason === 4 ? 'no_answer' : 'failed');
            finalizeAttempt(attemptUuid, terminalStatus, reason);
        }
    }

    if (event.Event === 'UserEvent' && event.UserEvent === 'AutoDialerEvent') {
        const attemptUuid = event.AttemptUUID;
        const status = event.Status;
        if (!attemptUuid) return;

        if (status === 'LeadAnswered') {
            updateAttemptStatus(attemptUuid, 'lead_answered', event.Uniqueid, event.Linkedid, event.Channel);
        } else if (status === 'AmdPassed') {
            updateAttemptStatus(attemptUuid, 'amd_passed', event.Uniqueid, event.Linkedid, event.Channel);
        } else if (status === 'AgentAnswered') {
            updateAttemptStatus(attemptUuid, 'agent_bridged', event.Uniqueid, event.Linkedid, event.Channel, event.Agent);
        } else if (status === 'ProgressiveCompleted') {
            const dialStatus = String(event.DialStatus || '').toUpperCase();
            const termStatus = dialStatus === 'ANSWER' ? 'completed' : (dialStatus === 'BUSY' ? 'busy' : (dialStatus === 'NOANSWER' ? 'no_answer' : 'failed'));
            finalizeAttempt(attemptUuid, termStatus, 0);
        } else if (status === 'Abandoned') {
            finalizeAttempt(attemptUuid, 'abandoned', 0);
        } else if (status === 'Machine') {
            finalizeAttempt(attemptUuid, 'machine', 0);
        }
    }

    if (event.Event === 'QueueCallerJoin') {
        const uniqueid = event.Uniqueid;
        if (uniqueid) {
            pool.query('UPDATE `asterisk`.`dialer_call_attempts` SET status = "queued" WHERE uniqueid = ? AND active_flag = 1', [uniqueid]).catch(() => {});
        }
    }

    if (event.Event === 'Bridge' || event.Event === 'AgentConnect') {
        const uniqueid = event.Uniqueid1 || event.Uniqueid || event.ChannelStateDesc;
        const agentExt = getExtensionFromChannel(event.Channel2 || event.MemberName || event.Agent || '');

        if (uniqueid) {
            pool.query(`
                SELECT attempt_uuid, lead_id, campaign_id FROM \`asterisk\`.\`dialer_call_attempts\` WHERE (uniqueid = ? OR linkedid = ?) AND active_flag = 1
            `, [uniqueid, uniqueid]).then(([rows]) => {
                if (rows.length > 0) {
                    const att = rows[0];
                    updateAttemptStatus(att.attempt_uuid, 'agent_bridged', uniqueid, null, null, agentExt);

                    if (agentExt) {
                        pool.query(`
                            INSERT INTO \`asterisk\`.\`dialer_agent_states\` (extension, state, current_lead_id, current_attempt_uuid)
                            VALUES (?, 'in_call', ?, ?)
                            ON DUPLICATE KEY UPDATE state = 'in_call', current_lead_id = VALUES(current_lead_id), current_attempt_uuid = VALUES(current_attempt_uuid)
                        `, [agentExt, att.lead_id, att.attempt_uuid]).catch(() => {});
                    }

                    pool.query('SELECT * FROM `asterisk`.`dialer_leads` WHERE id = ?', [att.lead_id]).then(([lRows]) => {
                        if (lRows.length > 0) {
                            io.emit('dialerLeadPop', {
                                agentExtension: agentExt,
                                attemptUuid: att.attempt_uuid,
                                lead: lRows[0]
                            });
                        }
                    }).catch(() => {});
                }
            }).catch(() => {});
        }
    }

    if (event.Event === 'Hangup') {
        const uniqueid = event.Uniqueid;
        const cause = parseInt(event.Cause || '0', 10);
        if (uniqueid) {
            pool.query(`
                SELECT attempt_uuid, status FROM \`asterisk\`.\`dialer_call_attempts\` WHERE (uniqueid = ? OR linkedid = ?) AND active_flag = 1
            `, [uniqueid, uniqueid]).then(([rows]) => {
                if (rows.length > 0) {
                    const att = rows[0];
                    if (att.status === 'agent_bridged' || att.status === 'queued' || att.status === 'amd_passed') {
                        finalizeAttempt(att.attempt_uuid, att.status === 'agent_bridged' ? 'completed' : 'failed', cause);
                    }
                }
            }).catch(() => {});
        }
    }
}

async function updateAttemptStatus(attemptUuid, status, uniqueid = null, linkedid = null, channel = null, agentExt = null) {
    try {
        const updates = ['status = ?', 'lease_expires_at = NOW() + INTERVAL 2 MINUTE'];
        const params = [status];
        if (uniqueid) { updates.push('uniqueid = ?'); params.push(uniqueid); }
        if (linkedid) { updates.push('linkedid = ?'); params.push(linkedid); }
        if (channel) { updates.push('channel = ?'); params.push(channel); }
        if (agentExt) { updates.push('agent_extension = ?'); params.push(agentExt); }
        params.push(attemptUuid);

        await pool.query(`UPDATE \`asterisk\`.\`dialer_call_attempts\` SET ${updates.join(', ')} WHERE attempt_uuid = ? AND active_flag = 1`, params);
    } catch (err) {
        console.error('updateAttemptStatus error:', err.message);
    }
}

async function finalizeAttempt(attemptUuid, terminalStatus, causeCode = 0) {
    try {
        const [rows] = await pool.query('SELECT lead_id, campaign_id, agent_extension FROM `asterisk`.`dialer_call_attempts` WHERE attempt_uuid = ?', [attemptUuid]);
        if (rows.length === 0) return;

        const att = rows[0];

        await pool.query(`
            UPDATE \`asterisk\`.\`dialer_call_attempts\`
            SET active_flag = NULL, status = ?, cause_code = ?
            WHERE attempt_uuid = ? AND active_flag = 1
        `, [terminalStatus, causeCode, attemptUuid]);

        const [attCountRow] = await pool.query('SELECT COUNT(*) AS cnt FROM `asterisk`.`dialer_call_attempts` WHERE lead_id = ?', [att.lead_id]);
        const totalAttempts = attCountRow[0]?.cnt || 1;
        let leadStatus = 'failed';
        if (terminalStatus === 'completed') leadStatus = 'connected';
        else if (terminalStatus === 'machine') leadStatus = 'machine';
        else if (terminalStatus === 'busy') leadStatus = 'busy';
        else if (terminalStatus === 'no_answer') leadStatus = 'no_answer';
        else if (totalAttempts < 3) leadStatus = 'pending';

        await pool.query('UPDATE `asterisk`.`dialer_leads` SET status = ?, attempts = ? WHERE id = ?', [leadStatus, totalAttempts, att.lead_id]);

        if (att.agent_extension) {
            const [cRows] = await pool.query('SELECT wrapup_time_sec FROM `asterisk`.`dialer_campaigns` WHERE id = ?', [att.campaign_id]);
            const wrapupSec = cRows[0]?.wrapup_time_sec || 15;
            const wrapupUntil = new Date(Date.now() + wrapupSec * 1000);

            await pool.query(`
                INSERT INTO \`asterisk\`.\`dialer_agent_states\` (extension, state, wrapup_until)
                VALUES (?, 'wrapup', ?)
                ON DUPLICATE KEY UPDATE state = 'wrapup', wrapup_until = VALUES(wrapup_until), current_lead_id = NULL, current_attempt_uuid = NULL
            `, [att.agent_extension, wrapupUntil]);
        }
    } catch (err) {
        console.error('finalizeAttempt error:', err.message);
    }
}
// GET /api/dialer/campaigns
app.get('/api/dialer/campaigns', async (req, res) => {
    try {
        const [campaigns] = await pool.query('SELECT * FROM `asterisk`.`dialer_campaigns` ORDER BY id DESC');
        for (const c of campaigns) {
            const [stats] = await pool.query(`
                SELECT 
                    COUNT(*) AS total_leads,
                    SUM(status = 'pending') AS pending_leads,
                    SUM(status = 'connected') AS connected_leads,
                    SUM(status = 'dialing') AS dialing_leads,
                    SUM(status IN ('no_answer','busy','failed','machine')) AS failed_leads
                FROM \`asterisk\`.\`dialer_leads\` WHERE campaign_id = ?
            `, [c.id]);
            c.stats = stats[0];
        }
        res.json({ success: true, campaigns });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/dialer/campaigns
app.post('/api/dialer/campaigns', async (req, res) => {
    try {
        const { name, mode, outbound_route_id, origination_caller_id, queue_name, pacing_ratio, max_concurrent_dials, wrapup_time_sec, max_queue_wait_sec, amd_enabled } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Campaign name is required' });

        const cidNum = origination_caller_id ? sanitizeAmiValue(origination_caller_id) : '101';
        if (cidNum && !/^\d{2,10}$/.test(cidNum)) {
            return res.status(400).json({ success: false, error: 'Origination Caller ID / Extension must be 2-10 numeric digits' });
        }
        if (cidNum) {
            const [uCheck] = await pool.query('SELECT extension FROM `asterisk`.`users` WHERE extension = ?', [cidNum]);
            if (uCheck.length === 0) {
                return res.status(400).json({ success: false, error: `Origination Extension ${cidNum} does not exist on PBX` });
            }
        }

        const qName = queue_name ? sanitizeAmiValue(queue_name).trim() : '';
        if ((mode || 'progressive') === 'predictive') {
            if (!qName) {
                return res.status(400).json({ success: false, error: 'Queue Name is required for Predictive mode.' });
            }
            const [qCheck] = await pool.query('SELECT extension FROM `asterisk`.`queues_config` WHERE extension = ?', [qName]);
            if (qCheck.length === 0) {
                return res.status(400).json({ success: false, error: `Queue '${qName}' does not exist on PBX. Create it in PBX Config -> Queues first.` });
            }
        }

        const [r] = await pool.query(`
            INSERT INTO \`asterisk\`.\`dialer_campaigns\`
            (name, mode, outbound_route_id, origination_caller_id, queue_name, pacing_ratio, max_concurrent_dials, wrapup_time_sec, max_queue_wait_sec, amd_enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            name.trim(),
            mode || 'progressive',
            outbound_route_id ? parseInt(outbound_route_id, 10) : null,
            cidNum,
            qName || 'autodialer-queue',
            parseFloat(pacing_ratio) || 1.0,
            parseInt(max_concurrent_dials, 10) || 5,
            parseInt(wrapup_time_sec, 10) || 15,
            parseInt(max_queue_wait_sec, 10) || 5,
            amd_enabled ? 1 : 0
        ]);

        res.json({ success: true, id: r.insertId, message: 'Campaign created successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// POST /api/dialer/campaigns/:id/control
app.post('/api/dialer/campaigns/:id/control', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { action } = req.body;
        if (!['start', 'pause', 'stop'].includes(action)) {
            return res.status(400).json({ success: false, error: 'Invalid action' });
        }

        if (action === 'start') {
            const [camp] = await pool.query('SELECT mode, queue_name FROM `asterisk`.`dialer_campaigns` WHERE id = ?', [id]);
            if (camp.length > 0 && camp[0].mode === 'predictive') {
                const qName = (camp[0].queue_name || '').trim();
                if (!qName) {
                    return res.status(400).json({ success: false, error: 'ACD Queue not configured. Set a Queue Name in campaign settings for Predictive mode.' });
                }
                const [qCheck] = await pool.query('SELECT extension FROM `asterisk`.`queues_config` WHERE extension = ?', [qName]);
                if (qCheck.length === 0) {
                    return res.status(400).json({ success: false, error: `ACD Queue '${qName}' does not exist on PBX. Create it in PBX Config -> Queues first.` });
                }
            }
        }

        const status = action === 'start' ? 'running' : (action === 'pause' ? 'paused' : 'completed');
        await pool.query('UPDATE `asterisk`.`dialer_campaigns` SET status = ? WHERE id = ?', [status, id]);
        res.json({ success: true, message: `Campaign status updated to ${status}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/dialer/leads/template - Download CSV Template (MUST be before :campaignId or Express shadows it)
app.get('/api/dialer/leads/template', (req, res) => {
    const csvHeaders = ['phone_number', 'first_name', 'last_name', 'company'];
    const sampleRow = ['01001111111', 'Ahmed', 'Ali', 'Acme Corp'];
    let csvContent = '\ufeff';
    csvContent += csvHeaders.join(',') + '\n';
    csvContent += sampleRow.join(',') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_template.csv"');
    res.send(csvContent);
});

// GET /api/dialer/leads/:campaignId
app.get('/api/dialer/leads/:campaignId', async (req, res) => {
    try {
        const campaignId = parseInt(req.params.campaignId, 10);
        if (!Number.isInteger(campaignId) || campaignId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid campaign ID' });
        }
        const [leads] = await pool.query('SELECT * FROM `asterisk`.`dialer_leads` WHERE campaign_id = ? ORDER BY id DESC LIMIT 500', [campaignId]);
        res.json({ success: true, leads });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/dialer/disposition
app.post('/api/dialer/disposition', async (req, res) => {
    try {
        const { attemptUuid, leadId, disposition, agentExtension } = req.body;
        if (!leadId || !disposition) {
            return res.status(400).json({ success: false, error: 'Lead ID and Disposition are required' });
        }

        await pool.query('UPDATE `asterisk`.`dialer_leads` SET disposition = ?, status = "connected" WHERE id = ?', [disposition, leadId]);

        if (attemptUuid) {
            await finalizeAttempt(attemptUuid, 'completed', 0);
        }

        if (agentExtension) {
            const wrapupUntil = new Date(Date.now() + 15 * 1000);
            await pool.query(`
                INSERT INTO \`asterisk\`.\`dialer_agent_states\` (extension, state, wrapup_until)
                VALUES (?, 'wrapup', ?)
                ON DUPLICATE KEY UPDATE state = 'wrapup', wrapup_until = VALUES(wrapup_until), current_lead_id = NULL, current_attempt_uuid = NULL
            `, [agentExtension, wrapupUntil]);
        }

        res.json({ success: true, message: 'Disposition logged successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/dialer/dispositions
app.get('/api/dialer/dispositions', async (req, res) => {
    try {
        const [dispositions] = await pool.query('SELECT * FROM `asterisk`.`dialer_dispositions` ORDER BY name ASC');
        res.json({ success: true, dispositions });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/dialer/dnc
app.get('/api/dialer/dnc', async (req, res) => {
    try {
        const [dnc] = await pool.query('SELECT * FROM `asterisk`.`dialer_dnc` ORDER BY created_at DESC');
        res.json({ success: true, dnc });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/dialer/dnc
app.post('/api/dialer/dnc', async (req, res) => {
    try {
        const { phone_number, reason } = req.body;
        if (!phone_number) return res.status(400).json({ success: false, error: 'Phone number is required' });
        const cleanPhone = String(phone_number).trim();

        await pool.query('INSERT IGNORE INTO `asterisk`.`dialer_dnc` (phone_number, reason) VALUES (?, ?)', [cleanPhone, reason || null]);
        await pool.query('UPDATE `asterisk`.`dialer_leads` SET status = "dnc" WHERE phone_number = ?', [cleanPhone]);

        res.json({ success: true, message: 'Phone number added to DNC list' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// DELETE /api/dialer/dnc/:phone
app.delete('/api/dialer/dnc/:phone', async (req, res) => {
    try {
        const phone = String(req.params.phone || '').trim();
        await pool.query('DELETE FROM `asterisk`.`dialer_dnc` WHERE phone_number = ?', [phone]);
        res.json({ success: true, message: 'Phone number removed from DNC list' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
const csvUpload = multer({
    dest: '/tmp/',
    limits: { fileSize: 10 * 1024 * 1024 }
});

// POST /api/dialer/leads/import
app.post('/api/dialer/leads/import', csvUpload.single('file'), async (req, res) => {
    try {
        const campaignId = parseInt(req.body.campaign_id, 10);
        if (!campaignId) {
            if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, error: 'Campaign ID is required' });
        }
        if (!req.file || !fs.existsSync(req.file.path)) {
            return res.status(400).json({ success: false, error: 'No CSV file uploaded' });
        }

        const lines = fs.readFileSync(req.file.path, 'utf8').split(/\r?\n/);
        try { fs.unlinkSync(req.file.path); } catch (_) {}

        if (lines.length < 2) {
            return res.status(400).json({ success: false, error: 'CSV file is empty or missing data' });
        }

        const header = lines[0].toLowerCase().split(',').map(s => s.trim().replace(/^"|"$/g, ''));
        const phoneIdx = header.findIndex(h => h.includes('phone') || h.includes('mobile') || h.includes('tel') || h.includes('number'));
        const fnIdx = header.findIndex(h => h.includes('first') || h.includes('name'));
        const lnIdx = header.findIndex(h => h.includes('last'));
        const compIdx = header.findIndex(h => h.includes('company') || h.includes('org'));

        let imported = 0;
        let skippedDnc = 0;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cols = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
            const rawPhone = phoneIdx >= 0 ? cols[phoneIdx] : cols[0];
            const cleanPhone = normalizeDidNumber(rawPhone);
            if (!cleanPhone) continue;

            const [dncCheck] = await pool.query('SELECT phone_number FROM `asterisk`.`dialer_dnc` WHERE phone_number = ?', [cleanPhone]);
            if (dncCheck.length > 0) {
                skippedDnc++;
                continue;
            }

            const firstName = fnIdx >= 0 ? cols[fnIdx] : null;
            const lastName = lnIdx >= 0 ? cols[lnIdx] : null;
            const company = compIdx >= 0 ? cols[compIdx] : null;

            await pool.query(`
                INSERT INTO \`asterisk\`.\`dialer_leads\` (campaign_id, phone_number, first_name, last_name, company, status)
                VALUES (?, ?, ?, ?, ?, 'pending')
            `, [campaignId, cleanPhone, firstName, lastName, company]);
            imported++;
        }

        res.json({ success: true, imported, skippedDnc, message: `Imported ${imported} lead(s) successfully (${skippedDnc} skipped by DNC).` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


app.post('/api/contacts/csv-import', csvUpload.single('file'), async (req, res) => {
    if (!isSuperAdmin(req)) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
        
        const lines = fs.readFileSync(req.file.path, 'utf8').split(/\r?\n/);
        const values = [];
        for (let line of lines) {
            if (!line.trim()) continue;
            const cells = line.split(',').map(c => {
                let cleaned = c.trim();
                if (cleaned.startsWith('="') && cleaned.endsWith('"')) {
                    cleaned = cleaned.substring(2, cleaned.length - 1);
                }
                cleaned = cleaned.replace(/^["']|["']$/g, '');
                return cleaned.trim();
            });
            if (cells.length < 3) continue;
            
            const first = cells[0];
            const last = cells[1];
            let phone = cells[2];
            
            // Skip headers
            if (first.toLowerCase() === 'name' || first.toLowerCase() === 'first name' || (phone && phone.toLowerCase() === 'phone')) {
                continue;
            }
            
            if (first && phone) {
                // Clean spaces, dashes, and parentheses
                phone = phone.replace(/[\s\-\(\)]/g, '');
                
                // Auto-recover leading zero if stripped by Excel (starts with 1-9, is purely numeric, and is at least 7 digits long)
                if (/^\d+$/.test(phone) && !phone.startsWith('0') && phone.length >= 7) {
                    phone = '0' + phone;
                }
                
                values.push(`('${escapeSql(first)}', '${escapeSql(last)}', '${escapeSql(phone)}', 1, 'isPublic', 'external')`);
            }
        }
        
        if (values.length > 0) {
            const sql = `INSERT INTO contact (name, last_name, telefono, iduser, status, directory) VALUES ${values.join(',')};`;
            await runSqlite(sql);
            fs.unlinkSync(req.file.path);
            res.json({ success: true, message: `${values.length} contacts imported successfully.` });
        } else {
            fs.unlinkSync(req.file.path);
            res.status(400).json({ success: false, error: 'No valid contacts found in CSV.' });
        }
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, error: err.message });
    }
});
// POST /api/blacklist/import — CSV upload for importing multiple blocked numbers
app.post('/api/blacklist/import', csvUpload.single('file'), async (req, res) => {
    if (!isSuperAdmin(req)) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No CSV file uploaded' });

        const csvContent = fs.readFileSync(req.file.path, 'utf8');
        fs.unlinkSync(req.file.path);

        const lines = csvContent.split(/\r?\n/);
        let imported = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, ''));
            const firstCell = parts[0] || '';
            if (i === 0 && (firstCell.toLowerCase().includes('phone') || firstCell.toLowerCase().includes('number'))) {
                continue;
            }
            const phone = firstCell.replace(/[\s\-\(\)\.]/g, '');
            if (!phone || phone.length < 3) continue;

            const desc = parts[1] || 'CSV Import';
            const action = parts[2] && ['zapateller', 'hangup', 'congestion'].includes(parts[2].toLowerCase()) ? parts[2].toLowerCase() : 'zapateller';

            await pool.query(`
                INSERT INTO \`asterisk\`.\`dashboard_inbound_blacklist\` (phone_number, description, action, enabled)
                VALUES (?, ?, ?, 1)
                ON DUPLICATE KEY UPDATE description = VALUES(description), action = VALUES(action), enabled = 1
            `, [phone, desc, action]);

            await syncBlacklistEntryToAstDB(phone, true);
            imported++;
        }

        res.json({ success: true, message: `Successfully imported ${imported} number(s) into inbound blacklist.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// --- RECORDING UPLOAD ---
const STAGING_DIR = '/tmp/dashboard-staging';
if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });

const recordingStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_TMP),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext);
    }
});
const upload = multer({
    storage: recordingStorage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.mp3', '.m4a', '.wav', '.ogg', '.wma', '.flac', '.aac', '.mpeg', '.mpg'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) return cb(null, true);
        cb(new Error('Unsupported audio format: ' + ext));
    }
});

// --- EMPLOYEE PHOTO UPLOAD ---
const PHOTOS_DIR = path.join(__dirname, 'public', 'photos');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const EMPLOYEE_PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const EMPLOYEE_PHOTO_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp'
]);

function removeEmployeePhoto(photoUrl) {
    if (!photoUrl || !photoUrl.startsWith('/photos/')) return;
    const filename = path.basename(photoUrl);
    if (filename !== photoUrl.slice('/photos/'.length)) return;
    const photoPath = path.join(PHOTOS_DIR, filename);
    try {
        if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
    } catch (error) {
        console.warn('Could not remove employee photo:', error.message);
    }
}

const photoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTOS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `emp_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`);
    }
});
const photoUpload = multer({
    storage: photoStorage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (EMPLOYEE_PHOTO_EXTENSIONS.has(ext) && EMPLOYEE_PHOTO_MIME_TYPES.has(file.mimetype)) {
            return cb(null, true);
        }
        cb(new Error('Only JPG, PNG, GIF, WebP, and BMP images are allowed'));
    }
});

app.post('/api/employee/photo', requireAuth, (req, res) => {
    photoUpload.single('photo')(req, res, function(err) {
        if (err) {
            const message = err.code === 'LIMIT_FILE_SIZE'
                ? 'Employee photo must be 50 MB or smaller'
                : err.message;
            return res.status(400).json({ success: false, error: message });
        }
        if (!req.file) return res.status(400).json({ success: false, error: 'No photo uploaded' });
        res.json({ success: true, url: '/photos/' + req.file.filename });
    });
});

function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioCodec('pcm_s16le')
            .audioFrequency(8000)
            .audioChannels(1)
            .format('wav')
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
}

async function saveRecordingToFS(wavPath, recordingName) {
    const safeName = recordingName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const destDir = '/var/lib/asterisk/sounds/custom';
    const destPath = destDir + '/' + safeName + '.wav';
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(wavPath, destPath);
    fs.unlinkSync(wavPath);

    // Insert into recordings table
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || 'admin',
        database: ASTERISK_DB
    });
    const displayName = recordingName.replace(/[_]/g, ' ');
    await conn.execute(
        'INSERT INTO recordings (displayname, filename) VALUES (?, ?)',
        [displayName, 'custom/' + safeName]
    );
    await conn.end();

    // Reload Asterisk so it picks up the new sound
    require('child_process').exec('/usr/sbin/asterisk -rx "module reload sounds"', () => {});

    return destPath;
}

app.post('/api/settings/recordings/upload', (req, res) => {
    upload.single('file')(req, res, async (err) => {
        if (err) {
            if (err instanceof multer.MulterError) {
                return res.status(400).json({ success: false, error: 'Upload error: ' + err.message });
            }
            return res.status(400).json({ success: false, error: err.message });
        }
        if (!req.file) return res.status(400).json({ success: false, error: 'No file provided' });
        const recordingName = req.body.name || path.basename(req.file.originalname, path.extname(req.file.originalname));

        const rawPath = req.file.path;
        const safeName = recordingName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const wavPath = path.join(STAGING_DIR, safeName + '.wav');

        try {
            // Convert to strict WAV format
            await convertToWav(rawPath, wavPath);
            // Delete raw upload
            fs.unlinkSync(rawPath);

            // Save to Issabel filesystem + DB
            await saveRecordingToFS(wavPath, recordingName);

            res.json({ success: true, message: 'Recording "' + recordingName + '" uploaded successfully.' });
        } catch (convErr) {
            // Cleanup on failure
            if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
            if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
            console.error('Recording upload failed:', convErr);
            res.status(500).json({ success: false, error: 'Conversion or upload failed: ' + (convErr.message || convErr) });
        }
    });
});

// --- VOICEMAIL GREETING UPLOAD ---
const VM_SOUNDS_DIR = '/var/lib/asterisk/sounds/en';
const VM_BACKUP_DIR = path.join(VM_SOUNDS_DIR, 'backups');
const VM_MAILBOX_ROOT = '/var/spool/asterisk/voicemail/default';

const VM_AUDIO_EXTS = ['.gsm', '.wav', '.wav49', '.sln', '.slin', '.ulaw', '.alaw', '.g722', '.sln16', '.slin16'];

function removeVmFile(dir, name) {
    VM_AUDIO_EXTS.forEach(ext => {
        const p = path.join(dir, name + ext);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    });
}

function writeSilentWav(path) {
    const sr = 8000, bits = 16, channels = 1, samples = sr;
    const dataSize = samples * channels * (bits / 8);
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(sr, 24);
    buf.writeUInt32LE(sr * channels * (bits / 8), 28);
    buf.writeUInt16LE(channels * (bits / 8), 32); buf.writeUInt16LE(bits, 34);
    buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
    fs.writeFileSync(path, buf);
}

function ensureVmBackups() {
    if (!fs.existsSync(VM_BACKUP_DIR)) fs.mkdirSync(VM_BACKUP_DIR, { recursive: true });
    ['unavailable', 'vm-leavemsg', 'vm-intro'].forEach(name => {
        const bak = path.join(VM_BACKUP_DIR, name + '.gsm.orig');
        const src = path.join(VM_SOUNDS_DIR, name + '.gsm');
        if (!fs.existsSync(bak) && fs.existsSync(src)) fs.copyFileSync(src, bak);
    });
}

function writeVmSound(name, wavPath) {
    removeVmFile(VM_SOUNDS_DIR, name);
    fs.copyFileSync(wavPath, path.join(VM_SOUNDS_DIR, name + '.wav'));
}

function removeVmSound(name) {
    removeVmFile(VM_SOUNDS_DIR, name);
}

function getVoicemailMailboxes() {
    const mailboxes = new Set();
    try {
        const vmconf = fs.readFileSync('/etc/asterisk/voicemail.conf', 'utf8');
        let inSection = false;
        for (const line of vmconf.split('\n')) {
            const t = line.trim();
            if (t.startsWith('[') && t.endsWith(']')) { inSection = !t.startsWith('[general]') && !t.startsWith('[') || (t.startsWith('[general]') ? false : true); inSection = t !== '[general]' && !t.startsWith('[template') && !t.startsWith(';;'); continue; }
            if (inSection && t && !t.startsWith(';') && !t.startsWith('#')) {
                const m = t.match(/^\s*(\d+)\s*=>/);
                if (m) mailboxes.add(m[1]);
            }
        }
    } catch {}
    try {
        if (fs.existsSync(VM_MAILBOX_ROOT)) {
            fs.readdirSync(VM_MAILBOX_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).forEach(d => mailboxes.add(d.name));
        }
    } catch {}
    return [...mailboxes].sort();
}

function convertToGsm(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioCodec('pcm_s16le')
            .audioFrequency(8000)
            .audioChannels(1)
            .format('wav')
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
}



// --- TIME SETTINGS API ---

const TIMEZONE_CACHE = { list: null, fetched: 0 };

function getTimezoneList() {
    return new Promise((resolve, reject) => {
        if (TIMEZONE_CACHE.list && Date.now() - TIMEZONE_CACHE.fetched < 60000) {
            return resolve(TIMEZONE_CACHE.list);
        }
        const { execFile } = require('child_process');
        execFile('timedatectl', ['list-timezones'], { timeout: 10000 }, (err, stdout) => {
            if (err) return reject(err);
            const list = stdout.trim().split('\n').filter(Boolean);
            TIMEZONE_CACHE.list = list;
            TIMEZONE_CACHE.fetched = Date.now();
            resolve(list);
        });
    });
}

app.get('/api/settings/time', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) {
            return res.status(403).json({ success: false, error: 'Forbidden: Super Admin access required' });
        }
        const { execFile } = require('child_process');
        
        const [tdOut, tzList] = await Promise.all([
            new Promise((resolve, reject) => {
                execFile('timedatectl', [], { timeout: 10000 }, (err, stdout) => {
                    if (err) reject(err);
                    else resolve(stdout);
                });
            }),
            getTimezoneList()
        ]);

        let timezone = '';
        let ntpActive = false;
        let rtcInLocalTZ = false;
        let localTime = '';

        for (const line of tdOut.split('\n')) {
            const tzMatch = line.match(/^\s*Time zone:\s+(\S+)/);
            if (tzMatch) timezone = tzMatch[1];
            const ntpMatch = line.match(/^\s*NTP service:\s+(\S+)/);
            if (ntpMatch) ntpActive = ntpMatch[1] === 'active';
            const rtcMatch = line.match(/^\s*RTC in local TZ:\s+(\S+)/);
            if (rtcMatch) rtcInLocalTZ = rtcMatch[1] === 'yes';
            const localMatch = line.match(/^\s*Local time:\s+(.+)/);
            if (localMatch) localTime = localMatch[1];
        }

        res.json({
            success: true,
            timezone,
            timezoneList: tzList,
            ntpActive,
            rtcInLocalTZ,
            localTime,
            timestamp: Date.now()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/settings/time', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) {
            return res.status(403).json({ success: false, error: 'Forbidden: Super Admin access required' });
        }
        const { timezone, ntp, manualDate, manualTime } = req.body;
        const { execFile } = require('child_process');
        const run = (cmd, args) => new Promise((resolve, reject) => {
            execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || err.message));
                else resolve(stdout);
            });
        });

        // Set NTP on/off (must be done before manual time changes)
        if (typeof ntp === 'boolean') {
            await run('timedatectl', ['set-ntp', ntp ? 'true' : 'false']);
        }

        // Set timezone
        if (timezone) {
            await run('timedatectl', ['set-timezone', timezone]);
        }

        // Set manual date/time (only when NTP is off)
        if (manualDate && manualTime) {
            await run('timedatectl', ['set-time', `${manualDate} ${manualTime}`]);
        } else if (manualTime) {
            await run('timedatectl', ['set-time', manualTime]);
        }

        // Refresh and return current state
        const [tdOut] = await Promise.all([
            new Promise((resolve, reject) => {
                execFile('timedatectl', [], { timeout: 10000 }, (err, stdout) => {
                    if (err) reject(err);
                    else resolve(stdout);
                });
            })
        ]);

        let timezoneNew = '';
        let ntpActiveNew = false;
        let localTimeNew = '';

        for (const line of tdOut.split('\n')) {
            const tzMatch = line.match(/^\s*Time zone:\s+(\S+)/);
            if (tzMatch) timezoneNew = tzMatch[1];
            const ntpMatch = line.match(/^\s*NTP service:\s+(\S+)/);
            if (ntpMatch) ntpActiveNew = ntpMatch[1] === 'active';
            const localMatch = line.match(/^\s*Local time:\s+(.+)/);
            if (localMatch) localTimeNew = localMatch[1];
        }

        res.json({
            success: true,
            message: 'Time settings updated successfully',
            timezone: timezoneNew,
            ntpActive: ntpActiveNew,
            localTime: localTimeNew,
            timestamp: Date.now()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
let isSystemUpdateInProgress = false;

// POST /api/system/update - Trigger dashboard system update (Super Admin Only)
app.post('/api/system/update', requireAuth, (req, res) => {
    if (!isSuperAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Access denied. Super Admin authorization required.' });
    }

    if (isSystemUpdateInProgress) {
        return res.status(409).json({ success: false, error: 'A system update is already in progress.' });
    }

    isSystemUpdateInProgress = true;

    res.json({
        success: true,
        message: 'Dashboard update initiated. The system will pull the latest version and restart.'
    });

    setTimeout(() => {
        const cmd = 'cd /opt/sokrat-voip && git fetch origin main && git reset --hard origin/main && npm ci --omit=dev && systemctl restart sokrat-voip';
        exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            isSystemUpdateInProgress = false;
            if (error) {
                console.error('System Update Error:', error.message, stderr);
            } else {
                console.log('System Update Output:', stdout);
            }
        });
    }, 500);
});

// --- NETWORK INFO ROUTE ---
app.get('/api/network-info', async (req, res) => {
    try {
        const { execFile } = require('child_process');
        let interfaces = {};
        let gateway = '';
        let errors = [];

        const run = (cmd, args) => new Promise((resolve, reject) => {
            execFile(cmd, args, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });

        try {
            const [ip4Out, ip6Out, linkOut, routeOut] = await Promise.all([
                run('ip', ['-o', '-4', 'a']),
                run('ip', ['-o', '-6', 'a']),
                run('ip', ['link']),
                run('ip', ['route', 'show', 'default'])
            ]);

            // Parse IPv4
            for (const line of ip4Out.trim().split('\n')) {
                const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\S+)/);
                if (m) {
                    const name = m[1].replace(/@.*$/, '');
                    if (!interfaces[name]) interfaces[name] = { name, ip4: '', ip6: '', mac: '', state: 'unknown' };
                    interfaces[name].ip4 = m[2].replace(/\/\d+$/, '');
                }
            }

            // Parse IPv6 (exclude fe80::/10 link-local)
            for (const line of ip6Out.trim().split('\n')) {
                const m = line.match(/^\d+:\s+(\S+)\s+inet6\s+(\S+)/);
                if (m) {
                    const name = m[1].replace(/@.*$/, '');
                    const addr = m[2].replace(/\/\d+$/, '');
                    if (addr.startsWith('fe80')) continue;
                    if (!interfaces[name]) interfaces[name] = { name, ip4: '', ip6: '', mac: '', state: 'unknown' };
                    interfaces[name].ip6 = addr;
                }
            }

            // Parse link info (MAC + state)
            let currentIface = '';
            for (const line of linkOut.split('\n')) {
                const ifaceMatch = line.match(/^\d+:\s+(\S+):\s+<.*>\s+.*state\s+(\S+)/);
                if (ifaceMatch) {
                    currentIface = ifaceMatch[1].replace(/@.*$/, '');
                    if (!interfaces[currentIface]) interfaces[currentIface] = { name: currentIface, ip4: '', ip6: '', mac: '', state: 'unknown' };
                    interfaces[currentIface].state = ifaceMatch[2].toLowerCase();
                }
                const macMatch = line.match(/link\/(\S+)\s+([0-9a-fA-F:]{17})/);
                if (macMatch && currentIface) {
                    interfaces[currentIface].mac = macMatch[2];
                }
            }

            // Parse default gateway
            const gwMatch = routeOut.match(/^default\s+via\s+(\S+)/m);
            if (gwMatch) gateway = gwMatch[1];

        } catch (e) {
            errors.push(e.message);
        }

        res.json({ success: true, interfaces: Object.values(interfaces), gateway, errors: errors.length ? errors : undefined });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- BROWSER ERROR LOGGER ---
app.post('/log_error', (req, res) => {
    console.error('[BROWSER-ERROR]', req.body.error);
    res.json({ success: true });
});
// --- SOKRAT SUPER ADMIN CRM INTEGRATION MANAGEMENT ROUTES ---
app.get('/integrations/crm', requireAuth, async (req, res) => {
    if (!req.session || (!req.session.isRoot && req.session.username !== ROOT_USER)) return res.redirect('/');
    try {
        const [clients] = await pool.query('SELECT id, client_id, name, allowed_origin, default_country_code, allowed_scopes, created_at, last_used_at, revoked_at FROM `asterisk`.`dashboard_crm_clients` ORDER BY id DESC');
        const [auditLogs] = await pool.query('SELECT id, client_id, crm_user_id, supervisor_extension, target_extension, action, success, details, created_at FROM `asterisk`.`dashboard_crm_audit_logs` ORDER BY id DESC LIMIT 100');
        res.render('crm-admin', { clients, auditLogs, moment, currentLang: req.session.lang || 'en' });
    } catch (err) {
        res.status(500).send('CRM Admin Error: ' + err.message);
    }
});

app.post('/integrations/crm/pairing-code', requireAuth, async (req, res) => {
    if (!req.session || (!req.session.isRoot && req.session.username !== ROOT_USER)) {
        return res.status(403).json({ success: false, error: 'Unauthorized: Only the root user can generate pairing codes.' });
    }
    try {
        const codeData = await createPairingCode(pool, req.session.username || 'root');
        res.json({
            success: true,
            pairing_code: codeData.rawCode,
            expires_at: codeData.expiresAt.toISOString()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/integrations/crm/clients/:id/revoke', requireAuth, async (req, res) => {
    if (!req.session || (!req.session.isRoot && req.session.username !== ROOT_USER)) {
        return res.status(403).json({ success: false, error: 'Unauthorized: Only the root user can revoke integration clients.' });
    }
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid client ID' });

        const [clientRows] = await pool.query('SELECT client_id FROM `asterisk`.`dashboard_crm_clients` WHERE id = ? AND revoked_at IS NULL', [id]);
        if (clientRows.length === 0) return res.status(404).json({ success: false, error: 'Client not found or already revoked' });

        const clientId = clientRows[0].client_id;
        await pool.query('UPDATE `asterisk`.`dashboard_crm_clients` SET revoked_at = NOW() WHERE id = ?', [id]);

        if (crmLiveBroadcaster && typeof crmLiveBroadcaster.disconnectClient === 'function') {
            crmLiveBroadcaster.disconnectClient(clientId);
        }

        const { logCrmAudit } = require('./lib/integration-auth');
        await logCrmAudit(pool, {
            clientId,
            crmUserId: req.session.username,
            supervisorExtension: null,
            targetExtension: null,
            action: 'client_revoked',
            success: true,
            details: 'Client revoked by Root User'
        });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/integrations/crm/clients/:id/rotate', requireAuth, async (req, res) => {
    if (!req.session || (!req.session.isRoot && req.session.username !== ROOT_USER)) {
        return res.status(403).json({ success: false, error: 'Unauthorized: Only the root user can rotate client secrets.' });
    }
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid client ID' });

        const [clientRows] = await pool.query('SELECT client_id FROM `asterisk`.`dashboard_crm_clients` WHERE id = ? AND revoked_at IS NULL', [id]);
        if (clientRows.length === 0) return res.status(404).json({ success: false, error: 'Active client not found' });

        const clientId = clientRows[0].client_id;
        const newRawSecret = crypto.randomBytes(32).toString('hex');
        const secretHash = hashSecret(newRawSecret);

        await pool.query('UPDATE `asterisk`.`dashboard_crm_clients` SET secret_hash = ? WHERE id = ?', [secretHash, id]);

        if (crmLiveBroadcaster && typeof crmLiveBroadcaster.disconnectClient === 'function') {
            crmLiveBroadcaster.disconnectClient(clientId);
        }

        const { logCrmAudit } = require('./lib/integration-auth');
        await logCrmAudit(pool, {
            clientId,
            crmUserId: req.session.username,
            supervisorExtension: null,
            targetExtension: null,
            action: 'client_secret_rotated',
            success: true,
            details: 'Secret rotated by Root User'
        });

        const newBearerToken = `${clientId}.${newRawSecret}`;
        res.json({ success: true, new_secret: newBearerToken });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/integrations/crm/clients/:id/update', requireAuth, async (req, res) => {
    if (!req.session || (!req.session.isRoot && req.session.username !== ROOT_USER)) {
        return res.status(403).json({ success: false, error: 'Unauthorized: Only the root user can update integration configuration.' });
    }
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid client ID' });

        const { allowed_origin, default_country_code, allowed_scopes } = req.body || {};
        const { validateOriginUrl, SUPPORTED_SCOPES, logCrmAudit } = require('./lib/integration-auth');

        const validOrigin = validateOriginUrl(allowed_origin);
        if (!validOrigin) {
            return res.status(400).json({ success: false, error: 'Invalid origin URL. Must be http:// or https:// without path/query/wildcards.' });
        }

        const [clientRows] = await pool.query('SELECT client_id FROM `asterisk`.`dashboard_crm_clients` WHERE id = ? AND revoked_at IS NULL', [id]);
        if (clientRows.length === 0) return res.status(404).json({ success: false, error: 'Active client not found' });

        const clientId = clientRows[0].client_id;
        const cc = String(default_country_code || '20').replace(/\D/g, '') || '20';
        const rawScopes = Array.isArray(allowed_scopes) ? allowed_scopes : [];
        const validatedScopes = rawScopes.filter(s => SUPPORTED_SCOPES.has(s));

        await pool.query(
            'UPDATE `asterisk`.`dashboard_crm_clients` SET allowed_origin = ?, default_country_code = ?, allowed_scopes = ? WHERE id = ?',
            [validOrigin, cc, JSON.stringify(validatedScopes), id]
        );

        if (crmLiveBroadcaster && typeof crmLiveBroadcaster.disconnectClient === 'function') {
            crmLiveBroadcaster.disconnectClient(clientId);
        }

        await logCrmAudit(pool, {
            clientId,
            crmUserId: req.session.username,
            supervisorExtension: null,
            targetExtension: null,
            action: 'client_configuration_update',
            success: true,
            details: { origin: validOrigin, country_code: cc, scopes: validatedScopes }
        });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- EMBEDDED CRM LIVE PANEL VIEW ---
app.get('/embed/crm/live', async (req, res) => {
    const { ticket } = req.query;
    if (!ticket) {
        return res.status(400).send('Embed ticket is required');
    }

    try {
        const result = await consumeEmbedTicket(pool, ticket);
        if (!result) {
            return res.status(403).send('Invalid, expired, or already consumed embed ticket');
        }

        const { sessionToken, ticket: embedSession } = result;

        const { validateOriginUrl, safeJsonSerialize } = require('./lib/integration-auth');
        const allowedOrigin = validateOriginUrl(embedSession.allowed_origin);
        if (!allowedOrigin) {
            return res.status(403).send('Invalid or untrusted parent client allowed origin');
        }

        res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${allowedOrigin}`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');

        res.render('embed-live', {
            sessionToken,
            session: embedSession,
            moment,
            currentLang: req.query.lang || 'en',
            safeJsonSerialize
        });
    } catch (err) {
        res.status(500).send('Embed Error: ' + err.message);
    }
});
server.listen(PORT, () => console.log(`Real-Time Enterprise Engine active on port ${PORT}`));
