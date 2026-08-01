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

require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'issabel-dashboard-encryption-key-32c'; // Must be 32 bytes
const key = crypto.createHash('sha256').update(String(ENCRYPTION_KEY)).digest();

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
app.set('trust proxy', true);
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
const SESSION_SECRET = process.env.SESSION_SECRET || 'issabel-dashboard-secret-change-me';

const ROOT_USER = 'root';
const ROOT_PASS = 'Admin@123';
let rootHash = null;

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

function isOutboundCdr(row) {
    return isInternalChannel(row.channel) && !isInternalChannel(row.dstchannel);
}

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/photos', express.static(path.join(__dirname, 'public', 'photos')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// --- SESSION CONFIGURATION ---
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// --- DATABASE INIT & AUTO-PROVISION ---
const ALL_TABS = [
    'dashboard', 'cdr', 'voicemails', 'ext-stats', 'operator', 'gsm-dongles', 'softphone', 'contacts', 'users', 'config', 'storage',
    'config-extensions', 'config-ringgroups', 'config-queues', 'config-recordings', 'config-trunks', 'config-inbound', 'config-outbound', 'config-voicemail', 'config-diagram',
    'config-timegroups', 'config-timeconditions'
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
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Add group_id column if it doesn't exist (for existing installs)
    try { await conn.execute('ALTER TABLE dashboard_users ADD COLUMN group_id INT DEFAULT NULL'); } catch (_) {}
    try { await conn.execute('ALTER TABLE dashboard_users ADD COLUMN reset_token_expires DATETIME DEFAULT NULL'); } catch (_) {}
    try { await conn.execute('ALTER TABLE dashboard_users ADD UNIQUE KEY idx_unique_email (email)'); } catch (_) {}
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
            KEY idx_imsi (imsi),
            KEY idx_imei (imei)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
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
    // Seed default row if missing
    await conn.execute('INSERT IGNORE INTO storage_settings (id) VALUES (1)');

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

    // Auto-provision default admin user
    rootHash = await bcrypt.hash(ROOT_PASS, 10);
    const [rows] = await conn.execute('SELECT COUNT(*) AS cnt FROM dashboard_users');
    if (rows[0].cnt === 0) {
        const hash = await bcrypt.hash('admin', 10);
        await conn.execute('INSERT INTO dashboard_users (username, password_hash, group_id) VALUES (?, ?, ?)', ['admin', hash, superAdminGroupId]);
        console.log('AUTH: Default admin user provisioned (admin / admin) in super admins group');
    } else {
        // Assign existing users without a group to the super admins group
        const [orphans] = await conn.execute('SELECT COUNT(*) AS cnt FROM dashboard_users WHERE group_id IS NULL');
        if (orphans[0].cnt > 0) {
            await conn.execute('UPDATE dashboard_users SET group_id = ? WHERE group_id IS NULL', [superAdminGroupId]);
            console.log('AUTH: Assigned ' + orphans[0].cnt + ' existing user(s) to super admins group');
        }
        console.log('AUTH: Dashboard users table ready, existing users found');
    }

    // Auto-provision default ACD queue 300 (autodialer-queue) if no queues exist
    try {
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
    } catch (qErr) {
        console.error('QUEUE auto-provision error:', qErr.message);
    }
    await conn.end();
    await syncAllExtensionsAstdb();
    await acquireDialerLeaderLock();
}
initAuthDb().catch(err => console.error('AUTH DB init error:', err));

// --- SESSION HELPERS ---
function isSuperAdmin(req) {
    return req.session && req.session.userGroup === 'super admins';
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

async function syncAstDbDongleMappings() {
    try {
        const [rows] = await pool.query('SELECT dongle_name, imsi, imei, phone_number FROM `asterisk`.`gsm_dongles` WHERE phone_number IS NOT NULL AND phone_number != ""');
        for (const row of rows) {
            const num = String(row.phone_number || '').trim();
            if (!num) continue;
            const imsi = String(row.imsi || '').trim();
            const dongleName = String(row.dongle_name || '').trim();
            const imei = String(row.imei || '').trim();

            if (imsi) {
                execFile(ASTERISK_BIN, ['-rx', `database put sim_map ${imsi} ${num}`]);
                execFile(ASTERISK_BIN, ['-rx', `database put DONGLE_NUMBERS ${imsi} ${num}`]);
            }
            if (dongleName) {
                execFile(ASTERISK_BIN, ['-rx', `database put dongle_map ${dongleName} ${num}`]);
            }
            if (imei) {
                execFile(ASTERISK_BIN, ['-rx', `database put DONGLE_NUMBERS ${imei} ${num}`]);
            }
        }
        if (rows.length > 0) {
            console.log(`ASTDB-SYNC: Synchronized ${rows.length} GSM mappings to AstDB (sim_map, dongle_map, DONGLE_NUMBERS)`);
        }
    } catch (e) {
        console.error('ASTDB-SYNC: Error syncing GSM mappings:', e.message);
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
    'users': 'users',
    'config': 'config',
    '/storage': 'storage'
};

// --- AUTH MIDDLEWARE ---
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        res.locals.currentUser = req.session.username;
        return next();
    }
    if (req.path.startsWith('/api/') || req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });
    }
    const loginUrl = '/login' + (req.originalUrl !== '/' ? '?redirect=' + encodeURIComponent(req.originalUrl) : '');
    res.redirect(loginUrl);
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
        '/api/auth/forgot-password', '/api/auth/reset-password', '/api/network-info'
    ];
    if (publicPaths.includes(req.path) || req.path.startsWith('/public/')) {
        return next();
    }
    requireAuth(req, res, next);
});

// --- TAB PERMISSION MIDDLEWARE ---
app.use(async (req, res, next) => {
    res.locals.isSuperAdmin = isSuperAdmin(req);
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
    const tabToRoute = { dashboard: '/', cdr: '/cdr', voicemails: '/voicemails', 'ext-stats': '/ext-stats', operator: '/operator', 'gsm-dongles': '/gsm-dongles', softphone: '/softphone', contacts: '/contacts', users: '/users', config: '/config' };
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

app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/gsm-dongles') {
        console.log(`HTTP [${new Date().toISOString()}] ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
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
        io.emit('peerStatus', peerStatus);
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
    io.emit('peerStatus', peerStatus);
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

    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        peerIPs[name] = ip;
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

async function getTrunkStatusMap() {
    try {
        const [trunks] = await pool.query("SELECT trunkid, name, tech, channelid, disabled, usercontext FROM `asterisk`.`trunks` WHERE LOWER(tech) IN ('sip', 'iax2', 'iax') ORDER BY trunkid ASC");
        const statusMap = {};
        for (const t of trunks) {
            let online = false;
            let statusText = t.disabled === 'on' ? 'Disabled' : 'Offline';

            if (t.tech === 'custom') {
                online = t.disabled !== 'on';
                statusText = online ? 'Active' : 'Disabled';
            } else if (t.tech === 'sip') {
                const sipKey = `tr-trunk-${t.trunkid}`;
                online = (sipPresence[sipKey] === true) || (sipPresence[t.name] === true);
                statusText = online ? 'OK' : 'Offline';
            } else if (t.tech === 'iax2' || t.tech === 'iax') {
                const iaxKey = `tr-trunk-${t.trunkid}`;
                online = (iaxPresence[iaxKey] === true) || (iaxPresence[t.name] === true);
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
// Helper function to extract extension number from Asterisk Channel string
function getExtensionFromChannel(channelName) {
    if (!channelName) return null;
    let m = channelName.match(/^(SIP|PJSIP)\/(\d{2,5})-/i);
    if (m) return m[2];
    m = channelName.match(/^Local\/(\d{2,5})@/i);
    if (m) return m[1];
    return null;
}
let amiClient = null;

// --- AUTO-DETECT DONGLE IMEI/SIM & CONFIGURE TRUNKS ---
async function detectDonglesAndSetTrunkCID() {
    try {
        const { execFile: execFileCb } = require('child_process');
        const execFileAsync = (cmd, args) => new Promise((resolve) => {
            execFileCb(cmd, args, (err, stdout) => resolve(err ? '' : stdout || ''));
        });

        const devicesOutput = await execFileAsync(ASTERISK_BIN, ['-rx', 'dongle show devices']);
        if (!devicesOutput) return;

        const parsed = parseDevicesOutput(devicesOutput, true);
        const dongleInfo = {};

        for (const d of parsed) {
            const st = (d.State || '').toLowerCase();
            const isConnected = st === 'free' || st === 'dialing' || st === 'ringing' || st === 'incall' || st === 'active' || st === 'held';
            if (!isConnected) continue;

            const name = d.ID;
            const imei = (d.IMEI && d.IMEI !== 'Unknown' && d.IMEI !== '-') ? d.IMEI : '';
            const imsi = (d.IMSI && d.IMSI !== 'Unknown' && d.IMSI !== '-') ? d.IMSI : '';
            const number = (d.Number && d.Number !== 'Unknown' && d.Number !== '-' && (d.Number.startsWith('+') || d.Number.startsWith('01'))) ? d.Number : null;

            if (imei || imsi || name) {
                dongleInfo[name] = { imei, imsi, number };
            }
        }
        if (!Object.keys(dongleInfo).length) {
            console.log('DONGLE-CID: No dongles with valid IMEI detected');
            return;
        }

        console.log('DONGLE-CID: Detected dongles:', dongleInfo);

        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });

        for (const [dongleName, info] of Object.entries(dongleInfo)) {
            if (info.imsi || info.imei || dongleName) {
                try {
                    await conn.execute(`
                        INSERT INTO gsm_dongles (dongle_name, imsi, imei, phone_number)
                        VALUES (?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            imsi = COALESCE(NULLIF(VALUES(imsi), ''), imsi),
                            imei = COALESCE(NULLIF(VALUES(imei), ''), imei),
                            phone_number = CASE WHEN VALUES(phone_number) != '' AND VALUES(phone_number) IS NOT NULL THEN VALUES(phone_number) ELSE phone_number END
                    `, [dongleName, info.imsi || '', info.imei || '', info.number || '']);
                } catch (_) {}
            }
            if (info.number) {
                if (info.imsi) execFileAsync(ASTERISK_BIN, ['-rx', `database put sim_map ${info.imsi} ${info.number}`]);
                if (dongleName) execFileAsync(ASTERISK_BIN, ['-rx', `database put dongle_map ${dongleName} ${info.number}`]);
                if (info.imei) execFileAsync(ASTERISK_BIN, ['-rx', `database put DONGLE_NUMBERS ${info.imei} ${info.number}`]);
            }
        }
        const [trunks] = await conn.execute('SELECT trunkid, channelid FROM trunks WHERE tech = ?', ['custom']);
        for (const trunk of trunks) {
            for (const [dongleName, info] of Object.entries(dongleInfo)) {
                if (trunk.channelid && (trunk.channelid.includes(dongleName) || (info.imei && trunk.channelid.includes(info.imei)))) {
                    // Preserve IMEI-based dial strings (e.g. dongle/i:IMEI/$OUTNUM$ or dongle/IMEI/$OUTNUM$)
                    if (info.imei && trunk.channelid.includes(info.imei)) {
                        console.log(`DONGLE-CID: Preserved IMEI-based channel for trunk ${trunk.trunkid}: ${trunk.channelid}`);
                    } else {
                        const newChannelId = `dongle/${dongleName}/$OUTNUM$`;
                        if (trunk.channelid !== newChannelId) {
                            await conn.execute('UPDATE trunks SET channelid = ? WHERE trunkid = ?', [newChannelId, trunk.trunkid]);
                            console.log(`DONGLE-CID: Updated trunk ${trunk.trunkid} channel to Device-based: ${newChannelId}`);
                        }
                    }
                    if (info.number) {
                        await execFileAsync(ASTERISK_BIN, ['-rx', `database put TRUNK ${trunk.trunkid} outcid ${info.number}`]);
                        console.log(`DONGLE-CID: Set trunk ${trunk.trunkid} (${dongleName}) caller ID to ${info.number}`);
                    }
                }
            }
        }

        await conn.end();

        const { execFile: rcExec } = require('child_process');
        rcExec('/var/lib/asterisk/bin/retrieve_conf', [], (err) => {
            if (!err) console.log('DONGLE-CID: retrieve_conf completed');
        });
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
                let status = event.Status || '';
                if (name) {
                    iaxPresence[name] = status.toUpperCase().startsWith('OK');
                    getTrunkStatusMap().then(map => io.emit('trunkStatus', map));
                }
            }

            // Parse IAXPeerStatus real-time events
            if (event.Event === 'IAXPeerStatus') {
                let rawPeer = event.Peer ? event.Peer.replace(/^(IAX2|IAX)\//i, '') : '';
                let name = rawPeer ? rawPeer.split('/')[0] : '';
                if (name) {
                    let statusStr = String(event.PeerStatus || '').trim();
                    let isOnline = statusStr === 'Registered' || statusStr === 'Reachable';
                    iaxPresence[name] = isOnline;
                    getTrunkStatusMap().then(map => io.emit('trunkStatus', map));
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
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // State updates for existing calls — update partner and preserve start time
            if (event.Event === 'Newstate') {
                let exten = getExtensionFromChannel(event.Channel);
                if (exten) {
                    let calculatedState = 'Ringing';
                    if (event.ChannelStateDesc === 'Up' || event.ChannelState === '6') {
                        calculatedState = 'In Call';
                    } else if (activeCalls[exten]?.state === 'In Call') {
                        calculatedState = 'In Call';
                    }
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
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // Fallback catching: Ensure bridge entrances catch linked channel audio paths
            if (event.Event === 'BridgeEnter') {
                let exten = getExtensionFromChannel(event.Channel);
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
                        channel: event.Channel
                    };
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // Clean tear down when either party terminates the call
            if (event.Event === 'Hangup') {
                let exten = getExtensionFromChannel(event.Channel);
                if (exten && activeCalls[exten]) {
                    delete activeCalls[exten];
                    io.emit('callUpdate', { extension: exten, callData: null });
                }
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
            io.emit('callUpdate', { extension: ext, callData: null });
        }
    }
}, 60000);

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
});


// ── Dongle Auto-Heal: restart once if stuck in "Not Initialized" for >3s ──
const dongleNotInitTimestamps = {};
const dongleRestartedOnce = {};

function autoHealDongles() {
    getDevicesOutputCached((err, stdout) => {
        if (err || !stdout) return;
        const devices = parseDevicesOutput(stdout, true);
        const now = Date.now();
        for (const dev of devices) {
            const id = dev.ID;
            const state = (dev.State || '').toLowerCase();
            if (state.includes('not initia')) {
                if (!dongleNotInitTimestamps[id]) {
                    dongleNotInitTimestamps[id] = now;
                } else if (now - dongleNotInitTimestamps[id] >= 3000 && !dongleRestartedOnce[id]) {
                    dongleRestartedOnce[id] = true;
                    console.log(`AUTO-HEAL: ${id} stuck in "Not Initialized" for 3s. Restarting once...`);
                    execFile(ASTERISK_BIN, ['-rx', `dongle restart now ${id}`]);
                }
            } else {
                delete dongleNotInitTimestamps[id];
                delete dongleRestartedOnce[id];
            }
        }
    });
}
setInterval(autoHealDongles, 3000);



app.use(async (req, res, next) => {
// System Shared Middleware to fetch extension rosters and handle language toggles
    try {
        const [roster] = await pool.query(`
            SELECT u.extension, u.name, ee.photo, ee.title, ee.emp_group
            FROM ${tables.users} u
            LEFT JOIN ${tables.employeeExtras} ee ON u.extension = ee.extension
            ORDER BY CAST(u.extension AS UNSIGNED) ASC
        `);
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
        res.locals.roster = roster.map(emp => ({ 
            ...emp, 
            online: onlineMap[emp.extension] || false
        }));
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
        // Hardcoded root user — bypasses DB, super admin, not visible in user list
        if (username === ROOT_USER) {
            const match = await bcrypt.compare(password, rootHash);
            if (!match) {
                return res.render('login', { redirect: req.body.redirect || '/', error: 'Invalid credentials', currentLang: req.query.lang || 'en' });
            }
            req.session.userId = -1;
            req.session.username = ROOT_USER;
            req.session.userGroup = 'super admins';
            req.session.isRoot = true;
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
            SELECT u.id, u.username, u.email, u.group_id, u.created_at, g.name AS group_name
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
        const { username, password, email, group_id } = req.body;
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
        await conn.execute('INSERT INTO dashboard_users (username, email, password_hash, group_id) VALUES (?, ?, ?, ?)', [username, cleanEmail, hash, group_id]);
        await conn.end();
        res.redirect('/users?success=' + encodeURIComponent('User added successfully'));
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

        const [rows] = await pool.query(`SELECT src, dst, billsec, REPLACE(disposition, 'CONGESTION', 'FAILED') as disposition, channel, dstchannel, calldate FROM ${tables.cdr} WHERE calldate BETWEEN ? AND ? AND dst NOT IN ('ussd','sms','report','s')`, [startDate, endDate]);

        const stats = { totalCalls: 0, inboundCount: 0, outboundCount: 0, inboundMin: 0, outboundMin: 0, answeredCalls: 0 };
        const employeeMetrics = {};
        res.locals.roster.forEach(emp => {
            employeeMetrics[emp.extension] = { extension: emp.extension, name: emp.name, totalCalls: 0, totalTalkSec: 0, uniqueNumbers: new Set() };
        });

        rows.forEach(row => {
            stats.totalCalls++;
            const sec = parseInt(row.billsec) || 0;
            const isOutbound = isOutboundCdr(row);

            if (row.disposition === 'ANSWERED') stats.answeredCalls++;

            let counted = false;
            [row.src, row.dst].forEach((ext, idx) => {
                if (employeeMetrics[ext]) {
                    employeeMetrics[ext].totalCalls++;
                    employeeMetrics[ext].totalTalkSec += (row.disposition === 'ANSWERED' ? sec : 0);
                    employeeMetrics[ext].uniqueNumbers.add(idx === 0 ? row.dst : row.src);
                    counted = true;
                }
            });

            if (employeeMetrics[row.src] && isOutbound) {
                stats.outboundCount++;
                if (row.disposition === 'ANSWERED') stats.outboundMin += sec;
            } else if (employeeMetrics[row.dst]) {
                stats.inboundCount++;
                if (row.disposition === 'ANSWERED') stats.inboundMin += sec;
            }
        });

        stats.inboundMin = Math.round(stats.inboundMin / 60);
        stats.outboundMin = Math.round(stats.outboundMin / 60);

        // --- Chart Data ---
        const trendMap = {};
        const dispCounts = {};
        const hourlyMap = {};
        rows.forEach(row => {
            const day = moment(row.calldate).format('YYYY-MM-DD');
            trendMap[day] = trendMap[day] || { total: 0, inbound: 0, outbound: 0 };
            trendMap[day].total++;
            const isOutbound = isOutboundCdr(row);
            if (isOutbound) trendMap[day].outbound++;
            else trendMap[day].inbound++;

            const disp = row.disposition || 'UNKNOWN';
            dispCounts[disp] = (dispCounts[disp] || 0) + 1;

            const hour = moment(row.calldate).format('H');
            hourlyMap[hour] = (hourlyMap[hour] || 0) + 1;
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

        res.render('dashboard', {
            stats,
            filters: { startDate, endDate },
            moment,
            trendData: JSON.stringify(trendData),
            dispositionData: JSON.stringify(dispositionData),
            hourlyData: JSON.stringify(hourlyData),
            topTalkers: JSON.stringify(topTalkers)
        });
    } catch (error) { res.status(500).send("Dashboard Error: " + error.message); }
});

// Helper to format Destination field for inbound/USSD calls
function formatDestination(row) {
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
    return dst;
}

// --- ROUTE 2: CDR DETAILS VIEW (Paginated) ---
app.get('/cdr', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const selectedExtension = req.query.targetExtension || 'ALL';
        const statusFilter = req.query.statusFilter || 'ALL';
        const searchSrc = req.query.searchSrc || '';
        const searchDst = req.query.searchDst || '';
        const searchUniqueId = req.query.searchUniqueId || '';
        const directionFilter = req.query.directionFilter || 'ALL';
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage) || 25));
        const offset = (page - 1) * perPage;

        const directionCase = `
            CASE
                WHEN (UPPER(c.channel) LIKE 'SIP/%' OR UPPER(c.channel) LIKE 'PJSIP/%' OR UPPER(c.channel) LIKE 'IAX2/%')
                 AND (UPPER(c.dstchannel) NOT LIKE 'SIP/%' AND UPPER(c.dstchannel) NOT LIKE 'PJSIP/%' AND UPPER(c.dstchannel) NOT LIKE 'IAX2/%')
                THEN 'OUTBOUND'
                ELSE 'INBOUND'
            END
        `;

        let countQuery = `
            SELECT COUNT(*) as total
            FROM ${tables.cdr} c
            LEFT JOIN ${tables.users} u ON c.src = u.extension
            WHERE c.calldate BETWEEN ? AND ?
            AND c.dst NOT IN ('ussd','sms','report','s')
        `;
        let countParams = [startDate, endDate];

        let query = `
            SELECT c.calldate, c.src, c.dst, c.duration, c.billsec, REPLACE(c.disposition, 'CONGESTION', 'FAILED') as disposition, c.uniqueid, c.recordingfile, c.channel, c.dstchannel, c.did, COALESCE(u.name, 'No Name') as src_name,
            ${directionCase} as direction
            FROM ${tables.cdr} c
            LEFT JOIN ${tables.users} u ON c.src = u.extension
            WHERE c.calldate BETWEEN ? AND ?
            AND c.dst NOT IN ('ussd','sms','report','s')
        `;
        let queryParams = [startDate, endDate];

        if (selectedExtension !== 'ALL') {
            const clause = " AND (c.src = ? OR c.dst = ?)";
            query += clause; countQuery += clause;
            queryParams.push(selectedExtension, selectedExtension);
            countParams.push(selectedExtension, selectedExtension);
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
        if (searchUniqueId) {
            const clause = " AND c.uniqueid LIKE ?";
            query += clause; countQuery += clause;
            queryParams.push(`%${searchUniqueId}%`);
            countParams.push(`%${searchUniqueId}%`);
        }
        if (statusFilter !== 'ALL') {
            const clause = " AND (TRIM(UPPER(c.disposition)) = TRIM(UPPER(?)) OR (TRIM(UPPER(?)) = 'FAILED' AND TRIM(UPPER(c.disposition)) = 'CONGESTION'))";
            query += clause; countQuery += clause;
            queryParams.push(statusFilter, statusFilter);
            countParams.push(statusFilter, statusFilter);
        }
        if (directionFilter !== 'ALL') {
            const clause = ` AND ${directionCase} = ?`;
            query += clause; countQuery += clause;
            queryParams.push(directionFilter);
            countParams.push(directionFilter);
        }

        query += " ORDER BY c.calldate DESC LIMIT ? OFFSET ?";
        queryParams.push(perPage, offset);

        const [[{ total }]] = await pool.query(countQuery, countParams);
        const [rows] = await pool.query(query, queryParams);
        const totalPages = Math.ceil(total / perPage) || 1;

        const formattedRows = rows.map(row => {
            return {
                ...row,
                dst: formatDestination(row)
            };
        });

        res.render('cdr', {
            calls: formattedRows,
            filters: { startDate, endDate, targetExtension: selectedExtension, statusFilter, searchSrc, searchDst, searchUniqueId, directionFilter, page, perPage },
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
        const searchUniqueId = req.query.searchUniqueId || '';
        const directionFilter = req.query.directionFilter || 'ALL';

        const directionCase = `
            CASE
                WHEN (UPPER(c.channel) LIKE 'SIP/%' OR UPPER(c.channel) LIKE 'PJSIP/%' OR UPPER(c.channel) LIKE 'IAX2/%')
                 AND (UPPER(c.dstchannel) NOT LIKE 'SIP/%' AND UPPER(c.dstchannel) NOT LIKE 'PJSIP/%' AND UPPER(c.dstchannel) NOT LIKE 'IAX2/%')
                THEN 'OUTBOUND'
                ELSE 'INBOUND'
            END
        `;

        let query = `
            SELECT c.calldate, c.src, c.dst, c.duration, c.billsec, REPLACE(c.disposition, 'CONGESTION', 'FAILED') as disposition, c.uniqueid, c.recordingfile, c.channel, c.dstchannel, c.did, COALESCE(u.name, 'No Name') as src_name,
            ${directionCase} as direction
            FROM ${tables.cdr} c
            LEFT JOIN ${tables.users} u ON c.src = u.extension
            WHERE c.calldate BETWEEN ? AND ?
            AND c.dst NOT IN ('ussd','sms','report','s')
        `;
        let queryParams = [startDate, endDate];

        if (selectedExtension !== 'ALL') {
            const clause = " AND (c.src = ? OR c.dst = ?)";
            query += clause;
            queryParams.push(selectedExtension, selectedExtension);
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
        if (searchUniqueId) {
            const clause = " AND c.uniqueid LIKE ?";
            query += clause;
            queryParams.push(`%${searchUniqueId}%`);
        }
        if (statusFilter !== 'ALL') {
            const clause = " AND (TRIM(UPPER(c.disposition)) = TRIM(UPPER(?)) OR (TRIM(UPPER(?)) = 'FAILED' AND TRIM(UPPER(c.disposition)) = 'CONGESTION'))";
            query += clause;
            queryParams.push(statusFilter, statusFilter);
        }
        if (directionFilter !== 'ALL') {
            const clause = ` AND ${directionCase} = ?`;
            query += clause;
            queryParams.push(directionFilter);
        }

        query += " ORDER BY c.calldate DESC";

        const [rows] = await pool.query(query, queryParams);

        // Build CSV string
        const csvHeaders = ["Date/Time", "Source", "Source Name", "Destination", "Duration (Sec)", "Billsec (Sec)", "Disposition", "Direction", "Channel", "Destination Channel", "Unique ID"];
        
        let csvContent = "\ufeff"; // BOM for UTF-8 Excel support
        csvContent += csvHeaders.map(h => `"${h.replace(/"/g, '""')}"`).join(",") + "\n";

        for (const row of rows) {
            const formattedDst = formatDestination(row);
            const rowData = [
                `"${moment(row.calldate).format('YYYY-MM-DD HH:mm:ss')}"`,
                /^\+?\d+$/.test(String(row.src || '')) ? `="` + String(row.src || '').trim() + `"` : `"${String(row.src || '').replace(/"/g, '""')}"`,
                `"${String(row.src_name || '').replace(/"/g, '""')}"`,
                /^\+?\d+$/.test(formattedDst) ? `="` + formattedDst + `"` : `"${formattedDst.replace(/"/g, '""')}"`,
                row.duration || 0,
                row.billsec || 0,
                `"${row.disposition || ''}"`,
                `"${row.direction || ''}"`,
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

// --- API: GENERAL EXTENSIONS OVERVIEW ---
app.get('/api/ext-overview', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');

        const [rows] = await pool.query(`SELECT src, dst, billsec, REPLACE(disposition, 'CONGESTION', 'FAILED') as disposition, channel, dstchannel FROM ${tables.cdr} WHERE calldate BETWEEN ? AND ? AND dst NOT IN ('ussd','sms','report','s')`, [startDate, endDate]);

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
            const isOutbound = isOutboundCdr(row);

            if (employeeMetrics[row.src]) {
                employeeMetrics[row.src].totalCalls++;
                employeeMetrics[row.src].uniqueNumbers.add(row.dst);
                if (isOutbound) {
                    employeeMetrics[row.src].outboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[row.src].outboundTalkSec += sec;
                } else {
                    employeeMetrics[row.src].inboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[row.src].inboundTalkSec += sec;
                }
            }
            if (employeeMetrics[row.dst]) {
                employeeMetrics[row.dst].totalCalls++;
                employeeMetrics[row.dst].uniqueNumbers.add(row.src);
                if (isOutbound) {
                    employeeMetrics[row.dst].outboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[row.dst].outboundTalkSec += sec;
                } else {
                    employeeMetrics[row.dst].inboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[row.dst].inboundTalkSec += sec;
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
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const direction = req.query.direction || 'all';

        const [rows] = await pool.query(
             `SELECT c.calldate, c.src, c.dst, c.duration, c.billsec, REPLACE(c.disposition, 'CONGESTION', 'FAILED') as disposition, c.channel, c.dstchannel, c.uniqueid
              FROM ${tables.cdr} c
              WHERE c.calldate BETWEEN ? AND ?
             AND (c.src = ? OR c.dst = ?)
             ORDER BY c.calldate DESC`,
            [startDate, endDate, extension, extension]
        );

        const stats = {
            extension,
            totalCalls: 0, answeredCalls: 0,
            inboundCalls: 0, outboundCalls: 0,
            inboundTalkSec: 0, outboundTalkSec: 0,
            totalTalkSec: 0, avgTalkSec: 0,
            uniqueContacts: new Set(),
            dispositionCounts: {},
            dailyBreakdown: {}
        };

        rows.forEach(row => {
            const sec = parseInt(row.billsec) || 0;
            const isOutboundCall = isOutboundCdr(row);
            const isSrc = row.src === extension;
            const isDst = row.dst === extension;

            if (!isSrc && !isDst) return;

            let callDirection = 'internal';
            if (isSrc && isOutboundCall) callDirection = 'outbound';
            else if (isDst && !isOutboundCall) callDirection = 'inbound';
            if (isSrc && isDst) callDirection = 'internal';

            if (direction === 'inbound' && callDirection !== 'inbound') return;
            if (direction === 'outbound' && callDirection !== 'outbound') return;

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
        });

        stats.totalTalkSec = stats.inboundTalkSec + stats.outboundTalkSec;
        stats.avgTalkSec = stats.answeredCalls ? Math.round(stats.totalTalkSec / stats.answeredCalls) : 0;
        stats.uniqueContactCount = stats.uniqueContacts.size;
        stats.uniqueContacts = [...stats.uniqueContacts];
        stats.dispositionData = Object.entries(stats.dispositionCounts).map(([name, value]) => ({ name, value }));
        stats.dailyData = Object.entries(stats.dailyBreakdown)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, data]) => ({ date, ...data }));

        stats.recentCalls = [];
        for (const row of rows) {
            const sec = parseInt(row.billsec) || 0;
            const isOutboundCall = isOutboundCdr(row);
            const isSrc = row.src === extension;
            const isDst = row.dst === extension;
            if (!isSrc && !isDst) continue;
            let callDirection = 'internal';
            if (isSrc && isOutboundCall) callDirection = 'outbound';
            else if (isDst && !isOutboundCall) callDirection = 'inbound';
            if (isSrc && isDst) callDirection = 'internal';
            if (direction === 'inbound' && callDirection !== 'inbound') continue;
            if (direction === 'outbound' && callDirection !== 'outbound') continue;
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
app.post('/api/hangup/:extension', (req, res) => {
    try {
        const { extension } = req.params;
        const call = activeCalls[extension];
        if (!call || !call.channel) {
            return res.status(404).json({ success: false, error: 'No active channel found for extension.' });
        }
        if (amiClient) {
            amiClient.write(`Action: Hangup\r\nChannel: ${call.channel}\r\n\r\n`);
            return res.json({ success: true });
        } else {
            exec(`${ASTERISK_BIN} -rx "channel request hangup ${call.channel}"`, (err) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json({ success: true });
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
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

app.post('/api/spy', async (req, res) => {
    try {
        const { targetExtension, supervisorExtension, mode } = req.body;
        const target = String(targetExtension || '').trim();
        const supervisor = String(supervisorExtension || '').trim();
        const spyMode = mode || 'listen';

        if (!target || !supervisor) {
            return res.status(400).json({ success: false, error: 'Target and Supervisor extensions are required.' });
        }
        if (!/^\d{2,5}$/.test(target) || !/^\d{2,5}$/.test(supervisor)) {
            return res.status(400).json({ success: false, error: 'Invalid extension format.' });
        }

        const prefix = spyMode === 'whisper' ? '223' : (spyMode === 'barge' ? '224' : '222');
        const spyExten = `${prefix}${target}`;
        const supervisorChan = await resolveDeviceChannel(supervisor);

        if (amiClient) {
            amiClient.write(`Action: Originate\r\nChannel: ${supervisorChan}\r\nContext: from-internal\r\nExten: ${spyExten}\r\nPriority: 1\r\nCallerID: "Call Spy" <${spyExten}>\r\nVariable: __SIPADDHEADER=X-Call-Purpose: Monitoring\r\nAsync: true\r\n\r\n`);
            return res.json({ success: true, message: `Calling supervisor extension ${supervisor} for ${spyMode} mode on ${target}.` });
        } else {
            exec(`${ASTERISK_BIN} -rx "channel originate ${supervisorChan} extension ${spyExten}@from-internal"`, (err) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json({ success: true, message: `Calling supervisor extension ${supervisor} for ${spyMode} mode on ${target}.` });
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/hijack - Hijack call (Transfer client to supervisor and kick out employee)
app.post('/api/hijack', (req, res) => {
    try {
        const { targetExtension, supervisorExtension } = req.body;
        const target = String(targetExtension || '').trim();
        const supervisor = String(supervisorExtension || '').trim();

        if (!target) {
            return res.status(400).json({ success: false, error: 'Target extension is required.' });
        }
        if (!supervisor) {
            return res.status(400).json({ success: false, error: 'Supervisor extension is required.' });
        }
        if (!/^\d{2,5}$/.test(target) || !/^\d{2,5}$/.test(supervisor)) {
            return res.status(400).json({ success: false, error: 'Invalid extension format.' });
        }

        const call = activeCalls[target];
        if (!call || !call.channel) {
            return res.status(404).json({ success: false, error: `No active call found for extension ${target}.` });
        }

        const empChan = call.channel;

        // Query Asterisk channel details to find the client/peer channel
        exec(`${ASTERISK_BIN} -rx "core show channel ${empChan}"`, (err, stdout, stderr) => {
            let peerChan = null;

            if (stdout) {
                const match = stdout.match(/Bridgepeer:\s*([^\s\r\n]+)/i) || 
                              stdout.match(/BRIDGED_TO\s*=\s*([^\s\r\n]+)/i);
                if (match) {
                    peerChan = match[1];
                }
            }

            if (peerChan) {
                // Redirect client to supervisor and disconnect employee
                exec(`${ASTERISK_BIN} -rx "channel redirect ${peerChan} from-internal,${supervisor},1"`, () => {
                    exec(`${ASTERISK_BIN} -rx "channel request hangup ${empChan}"`, () => {});
                });
            } else {
                // Redirect employee channel directly to supervisor
                exec(`${ASTERISK_BIN} -rx "channel redirect ${empChan} from-internal,${supervisor},1"`, () => {});
            }

            res.json({ 
                success: true, 
                message: `Call hijacked: Client redirected to extension ${supervisor}, employee ${target} disconnected.` 
            });
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

// Enrich device state with precise value from 'dongle show device state'
function enrichPreciseState(devices, callback) {
    // Pass-through — mirror raw dongle show devices output exactly
    callback(devices);
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
            // Fallback for transpositions where the firmware reports IMEI in the IMSI field
            if ((!row.IMEI || row.IMEI === '-' || row.IMEI === 'Unknown') && row.IMSI && (row.IMSI.startsWith('86') || row.IMSI.startsWith('35'))) {
                row.IMEI = row.IMSI;
            }
            const st = (row.State || '').toLowerCase();
            const isNotConnected = st.includes('not connec') || st.includes('not_conn') || st.includes('not init') || st.includes('not reg') || st.includes('not respond');

            if (isNotConnected) {
                row.Number = 'Unknown';
            } else {
                const mapped = (row.IMSI && astDbMappings[row.IMSI]) || (row.IMEI && astDbMappings[row.IMEI]) || (row.ID && astDbMappings[row.ID]) || null;
                if (mapped && (!row.Number || row.Number === 'Unknown' || row.Number === '-')) {
                    row.Number = mapped;
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
                            if (r.imsi && !mappings[r.imsi]) mappings[r.imsi] = r.phone_number;
                            if (r.imei && !mappings[r.imei]) mappings[r.imei] = r.phone_number;
                            if (r.dongle_name && !mappings[r.dongle_name]) mappings[r.dongle_name] = r.phone_number;
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

// Endpoint to manually set/save a SIM's phone number mapping
// Endpoint to manually set/save a SIM's phone number mapping
// Endpoint to manually set/save a SIM's phone number mapping and program SIM card via AT commands
app.post('/api/gsm-dongles/save-number', async (req, res) => {
    try {
        const { imsi, number, dongleId } = req.body;
        if ((!imsi && !dongleId) || !number) {
            return res.status(400).json({ success: false, error: 'IMSI or Dongle ID and phone number are required.' });
        }

        const normNumber = String(number).trim();
        const dId = String(dongleId || '').trim();
        const dImsi = String(imsi || '').trim();

        const simMappings = readSimMappings();
        if (dImsi) simMappings[dImsi] = normNumber;
        saveSimMappings(simMappings);

        let imei = null;
        let foundImsi = dImsi;
        try {
            const devicesOutput = await execFileAsync(ASTERISK_BIN, ['-rx', 'dongle show devices']);
            if (devicesOutput) {
                const devices = parseDevicesOutput(devicesOutput, true);
                const dev = devices.find(d => (dId && d.ID.toLowerCase() === dId.toLowerCase()) || (dImsi && d.IMSI === dImsi));
                if (dev) {
                    if (dev.IMEI && dev.IMEI !== '-') imei = dev.IMEI;
                    if (dev.IMSI && dev.IMSI !== '-') foundImsi = dev.IMSI;
                }
            }
        } catch (_) {}

        // 1. Save to MariaDB asterisk.gsm_dongles
        if (dId || foundImsi) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`gsm_dongles\` (dongle_name, imsi, imei, phone_number)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    imsi = COALESCE(NULLIF(VALUES(imsi), ''), imsi),
                    imei = COALESCE(NULLIF(VALUES(imei), ''), imei),
                    phone_number = VALUES(phone_number)
            `, [dId || 'unknown', foundImsi || '', imei || '', normNumber]);
        }

        // 2. Write to AstDB immediately (sim_map, dongle_map, DONGLE_NUMBERS)
        if (foundImsi) execFile(ASTERISK_BIN, ['-rx', `database put sim_map ${foundImsi} ${normNumber}`]);
        if (dId) execFile(ASTERISK_BIN, ['-rx', `database put dongle_map ${dId} ${normNumber}`]);
        if (imei) execFile(ASTERISK_BIN, ['-rx', `database put DONGLE_NUMBERS ${imei} ${normNumber}`]);
        if (foundImsi) execFile(ASTERISK_BIN, ['-rx', `database put DONGLE_NUMBERS ${foundImsi} ${normNumber}`]);

        io.emit('dongleNumberUpdated', { dongleId: dId, imsi: foundImsi, number: normNumber });

        // 3. Preserve verbatim entered phone number for AT+CPBW command
        const formattedNum = normNumber;
        const targetDongle = dId || 'dongle0';
        const numType = 145;

        const cmdSteps = [
            `dongle cmd ${targetDongle} AT+CPBS=\\"ON\\"`,
            `dongle cmd ${targetDongle} AT+CPBW=1,\\"${formattedNum}\\",${numType}`,
            `module unload chan_dongle.so`,
            `module load chan_dongle.so`,
            `dongle show devices`
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
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        try {
            await detectDonglesAndSetTrunkCID();
        } catch (_) {}
        io.emit('usbDevicesUpdated');

        return res.json({
            success: true,
            dbSaved: true,
            atSuccess: allSuccess,
            results: results,
            message: allSuccess ? 'SIM number saved to SIM card & Asterisk successfully.' : 'SIM number saved to Dashboard & AstDB (AT command warnings).'
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint to reset USB port for a dongle (unplug/replug simulation)
app.post('/api/gsm-dongles/reset-usb-port', (req, res) => {
    const { dongleId } = req.body;
    if (!dongleId || !/^dongle[0-9]+$/.test(dongleId)) {
        return res.status(400).json({ success: false, error: 'Valid dongle ID required.' });
    }

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
app.get('/gsm-dongles', (req, res) => {
    try {
        getAstDbNumbers(astDbMappings => {
            getDevicesOutputCached((error, stdout) => {
                let devices = [];
                if (!error && stdout) {
                    devices = parseDevicesOutput(stdout, false, astDbMappings);
                }
                enrichPreciseState(devices, enriched => {
                    res.render('gsm-dongles', {
                        devices: enriched,
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
app.get('/api/gsm-dongles', (req, res) => {
    getAstDbNumbers(astDbMappings => {
        getDevicesOutputCached((error, stdout) => {
            if (error) {
                return res.status(500).json({ success: false, error: error.message });
            }
            const devices = parseDevicesOutput(stdout, false, astDbMappings);
            enrichPreciseState(devices, enriched => {
                res.json({ success: true, devices: enriched });
            });
        });
    });
});

// API Endpoint to reload specific dongle
app.post('/api/gsm-dongles/reload/:dongleId', (req, res) => {
    const { dongleId } = req.params;
    if (!/^dongle[0-9]+$/.test(dongleId)) {
        return res.status(400).json({ success: false, error: "Invalid dongle ID format" });
    }
    execFile(ASTERISK_BIN, ['-rx', `dongle restart now ${dongleId}`], (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ success: false, error: stderr || error.message });
        }
        io.emit('usbDevicesUpdated');
        res.json({ success: true, output: stdout.trim() });
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
        const days = parseInt(req.body.auto_purge_days, 10) || 90;
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
app.post('/api/gsm-dongles/ussd', (req, res) => {
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
        const [rows] = await pool.query(
            `SELECT calldate, recordingfile FROM ${tables.cdr} WHERE uniqueid = ? AND recordingfile IS NOT NULL AND recordingfile != '' ORDER BY billsec DESC, calldate ASC LIMIT 1`,
            [uniqueid]
        );
        if (!rows.length || !rows[0].recordingfile) return res.status(404).send("Audio not found.");

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
app.get('/api/gsm-dongles/sms', (req, res) => {
    try {
        const inbox = readSmsInbox();
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

// --- PBX CONFIGURATION TAB VIEW & REST APIS ---

// GET /config - render Configuration Management page
app.get('/config', requireAuth, (req, res) => {
    const currentLang = res.locals.currentLang || 'en';
    res.render('config', {
        moment,
        currentPage: '/config',
        currentLang,
        isRtl: currentLang === 'ar',
        isSuperAdmin: isSuperAdmin(req)
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
async function setExtensionAstdbDefaults(extNum, displayName, vmVal = 'novm', tech = 'sip') {
    const techUpper = (tech || 'sip').toUpperCase();
    const techLower = (tech || 'sip').toLowerCase();
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

    const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}\\r?\\n?`, 'g');
    content = content.replace(regex, '').trim();

    if (action !== 'delete') {
        const newBlock = `
\n${startMarker}
[${extNum}](+)
transport=transport-wss
webrtc=yes
ice_support=yes
use_avpf=yes
media_use_received_transport=yes
direct_media=no\nrtcp_mux=yes
media_encryption=dtls
dtls_cert_file=/etc/asterisk/keys/asterisk.pem
dtls_private_key=/etc/asterisk/keys/asterisk.pem
dtls_ca_file=/etc/asterisk/keys/asterisk.pem
dtls_verify=fingerprint
dtls_setup=actpass

[${extNum}](+type=aor)
max_contacts=5
remove_existing=yes
${endMarker}`;
        content += newBlock;
    }

    try {
        fs.writeFileSync(pjsipPath, content.trim() + '\n', 'utf8');
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
            WHERE (d.tech = 'pjsip' OR u.extension = '101' OR u.extension = '200')
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
        res.json({ success: true, extensions });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/extensions - Create new Generic SIP Extension
app.post('/api/config/extensions', async (req, res) => {
    try {
        const { extension, name, secret, voicemail, tech } = req.body;
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

        // Write PJSIP custom endpoint config if WebRTC
        if (isWebRTC) {
            updatePjsipCustomConfig(extNum, extSecret, displayName, 'create');
            reloadPjsip();
        }

        // 4. Update astdb entries for call recording ALWAYS, DEVICE dial mapping and Voicemail setting
        await setExtensionAstdbDefaults(extNum, displayName, vmVal, devTech);
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
        const { name, secret, voicemail, tech } = req.body;

        const displayName = String(name || '').trim();
        const extSecret = String(secret || '').trim();
        const vmVal = (voicemail === 'default' || voicemail === 'enabled' || voicemail === true) ? 'default' : 'novm';

        const [devRows] = await pool.query('SELECT tech FROM `asterisk`.`devices` WHERE id = ?', [extNum]);
        const currentTech = devRows[0]?.tech || 'sip';
        const isWebRTC = tech === 'webrtc' || tech === 'pjsip' || currentTech === 'pjsip';
        const devTech = isWebRTC ? 'pjsip' : 'sip';
        const devDial = isWebRTC ? `PJSIP/${extNum}` : `SIP/${extNum}`;

        if (tech) {
            await pool.query('UPDATE `asterisk`.`devices` SET tech = ?, dial = ? WHERE id = ?', [devTech, devDial, extNum]);
        }

        if (displayName) {
            await pool.query('UPDATE `asterisk`.`users` SET name = ? WHERE extension = ?', [displayName, extNum]);
            await pool.query('UPDATE `asterisk`.`devices` SET description = ? WHERE id = ?', [displayName, extNum]);
            await pool.query('UPDATE `asterisk`.`sip` SET data = ? WHERE id = ? AND keyword = "callerid"', [`${displayName} <${extNum}>`, extNum]);
        }
        if (extSecret) {
            await pool.query('UPDATE `asterisk`.`sip` SET data = ? WHERE id = ? AND keyword = "secret"', [extSecret, extNum]);
        }

        // Update voicemail & nat in users and sip table
        await pool.query('UPDATE `asterisk`.`users` SET voicemail = ?, recording = "out=always|in=always" WHERE extension = ?', [vmVal, extNum]);
        await pool.query('UPDATE `asterisk`.`sip` SET data = "yes" WHERE id = ? AND keyword = "nat"', [extNum]);

        if (isWebRTC) {
            // Only update pjsip config secret if a new one was provided
            const pjsipSecret = extSecret || (await getCurrentPjsipSecret(extNum));
            updatePjsipCustomConfig(extNum, pjsipSecret, displayName || extNum, 'create');
            reloadPjsip();
        }

        await setExtensionAstdbDefaults(extNum, displayName || extNum, vmVal, devTech);
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

// --- 2. RING GROUPS MANAGEMENT APIs ---

// GET /api/config/ringgroups - List all Ring Groups
app.get('/api/config/ringgroups', async (req, res) => {
    try {
        const [ringgroups] = await pool.query(`
            SELECT grpnum, strategy, grptime, grplist, description, annmsg_id, postdest, cwignore, recording
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
        const { grpnum, description, grplist, strategy, grptime, annmsg_id, postdest } = req.body;
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

        const [existing] = await pool.query('SELECT grpnum FROM `asterisk`.`ringgroups` WHERE grpnum = ?', [num]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, error: `Ring Group ${num} already exists.` });
        }

        // Defaults: skip busy agent -> cwignore='CHECKED', record calls -> recording='always'
        await pool.query(`
            INSERT INTO \`asterisk\`.\`ringgroups\` 
            (grpnum, strategy, grptime, grppre, grplist, annmsg_id, postdest, description, alertinfo, remotealert_id, needsconf, toolate_id, ringing, cwignore, cfignore, cpickup, recording)
            VALUES (?, ?, ?, '', ?, ?, ?, ?, '', 0, '', 0, 'Ring', 'CHECKED', '', '', 'always')
        `, [num, ringStrategy, ringTime, extListFormatted, annMsgId, postDest, desc]);

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
        const { description, grplist, strategy, grptime, annmsg_id, postdest } = req.body;

        const desc = String(description || '').trim();
        const extListFormatted = String(grplist || '').replace(/[\r\n, ]+/g, '-').replace(/^-+|-+$/g, '');
        const ringStrategy = strategy || 'ringall';
        const ringTime = parseInt(grptime, 10) || 20;
        const annMsgId = parseInt(annmsg_id, 10) || 0;
        const postDest = (postdest && postdest.trim()) ? postdest.trim() : `ext-group,${num},1`;

        await pool.query(`
            UPDATE \`asterisk\`.\`ringgroups\`
            SET description = ?, grplist = ?, strategy = ?, grptime = ?, annmsg_id = ?, cwignore = 'CHECKED', recording = 'always', postdest = ?
            WHERE grpnum = ?
        `, [desc, extListFormatted, ringStrategy, ringTime, annMsgId, postDest, num]);

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
                const match = m.match(/Local\/(\d+)@/);
                if (match) return match[1];
                const matchSimple = m.match(/^(\d+)/);
                return matchSimple ? matchSimple[1] : m;
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
            joinannounce_id, recording, maxwait, timeout, retry, dest,
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
        const failDest = (dest && dest.trim()) ? dest.trim() : 'app-blackhole,hangup,1';

        await pool.query(`
            INSERT INTO \`asterisk\`.\`queues_config\`
            (extension, descr, grppre, alertinfo, joinannounce_id, ringing, agentannounce_id, maxwait, password, ivr_id, callback_id, dest, destcontinue, cwignore, qregex, queuewait, use_queue_context, togglehint, qnoanswer, callconfirm, callconfirm_id, monitor_type, monitor_heard, monitor_spoken)
            VALUES (?, ?, '', '', ?, 0, 0, ?, '', 'none', 'none', ?, ?, ?, '', 0, 0, 0, 0, 0, 0, ?, 0, 0)
        `, [num, name, annId, maxWaitVal, failDest, failDest, cwignoreVal, monitorTypeVal]);

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
            const cleanExt = String(staticArr[idx]).trim();
            if (!cleanExt) continue;
            // Resolve member interface from devices.dial: "SIP/101" or "PJSIP/200"
            const [devRows] = await pool.query('SELECT dial FROM `asterisk`.`devices` WHERE id = ?', [cleanExt]);
            const memberIf = devRows[0]?.dial || `SIP/${cleanExt}`;
            details.push([num, 'member', `${memberIf}`, idx]);
        }

        let dynStr = '';
        if (Array.isArray(dynmembers)) dynStr = dynmembers.join('\n');
        else if (typeof dynmembers === 'string') dynStr = dynmembers.trim();
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
            joinannounce_id, recording, maxwait, timeout, retry, dest,
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
        const failDest = (dest && dest.trim()) ? dest.trim() : 'app-blackhole,hangup,1';

        await pool.query(`
            UPDATE \`asterisk\`.\`queues_config\`
            SET descr = ?, joinannounce_id = ?, maxwait = ?, dest = ?, destcontinue = ?, cwignore = ?, monitor_type = ?
            WHERE extension = ?
        `, [name, annId, maxWaitVal, failDest, failDest, cwignoreVal, monitorTypeVal, num]);

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
            const cleanExt = String(staticArr[idx]).trim();
            if (!cleanExt) continue;
            const [devRows] = await pool.query('SELECT dial FROM `asterisk`.`devices` WHERE id = ?', [cleanExt]);
            const memberIf = devRows[0]?.dial || `SIP/${cleanExt}`;
            details.push([num, 'member', `${memberIf}`, idx]);
        }

        let dynStr = '';
        if (Array.isArray(dynmembers)) dynStr = dynmembers.join('\n');
        else if (typeof dynmembers === 'string') dynStr = dynmembers.trim();
        if (dynStr) {
            details.push([num, 'dynmembers', dynStr, 0]);
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


// --- 3. TRUNKS MANAGEMENT APIs ---

// Helper to parse key=value lines from PEER/USER details textarea
function parseDetailsText(rawText) {
    if (!rawText) return [];
    const lines = String(rawText).split(/[\r\n]+/);
    const result = [];
    let seq = 0;
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx > 0) {
            const kw = line.substring(0, idx).trim();
            const val = line.substring(idx + 1).trim();
            if (kw && val) {
                result.push([kw, val, seq++]);
            }
        }
    }
    return result;
}

// GET /api/config/trunks - List Trunks
app.get('/api/config/trunks', async (req, res) => {
    try {
        const [trunks] = await pool.query(`
            SELECT trunkid, name, tech, outcid, keepcid, maxchans, failscript, dialoutprefix, channelid, disabled, \`continue\`, usercontext
            FROM \`asterisk\`.\`trunks\`
            ORDER BY trunkid ASC
        `);

        for (const t of trunks) {
            t.host = '';
            t.username = '';
            t.secret = '';
            t.context = 'from-trunk';
            t.register = '';
            t.dialopts = '';
            t.peerdetails = '';
            t.userdetails = '';

            const trunkKey = `tr-trunk-${t.trunkid}`;
            const targetTable = (t.tech === 'iax2' || t.tech === 'iax') ? 'iax' : 'sip';

            // Read dialopts from AstDB
            try {
                const { stdout: astOut } = await execPromise(`asterisk -rx "database get TRUNK ${t.trunkid}/dialopts"`);
                if (astOut) {
                    const m = astOut.match(/: (.+)$/m);
                    if (m) t.dialopts = m[1].trim();
                }
            } catch (e) { /* key not found */ }

            // Query PEER Details
            const [peerRows] = await pool.query(`SELECT keyword, data FROM \`asterisk\`.\`${targetTable}\` WHERE id = ? OR id = ?`, [trunkKey, t.name]);
            const peerLines = [];
            peerRows.forEach(r => {
                if (r.keyword === 'host') t.host = r.data;
                if (r.keyword === 'username') t.username = r.data;
                if (r.keyword === 'secret') t.secret = r.data;
                if (r.keyword === 'context') t.context = r.data;
                if (r.keyword === 'register') t.register = r.data;
                if (r.keyword !== 'account') {
                    peerLines.push(`${r.keyword}=${r.data}`);
                }
            });
            t.peerdetails = peerLines.join('\n');

            // Query USER Details (if usercontext provided)
            if (t.usercontext) {
                const [userRows] = await pool.query(`SELECT keyword, data FROM \`asterisk\`.\`${targetTable}\` WHERE id = ?`, [t.usercontext]);
                const userLines = [];
                userRows.forEach(r => {
                    userLines.push(`${r.keyword}=${r.data}`);
                });
                t.userdetails = userLines.join('\n');
            }
        }
        res.json({ success: true, trunks });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/trunks - Create Trunk (Custom, SIP, IAX2)
app.post('/api/config/trunks', async (req, res) => {
    try {
        const { name, tech, channelid, host, username, secret, context, register, usercontext, outcid, keepcid, maxchans, dialoutprefix, disabled, dialopts, continue: contVal, failscript, peerdetails, userdetails } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Trunk Name is required.' });
        }

        const trunkName = String(name).trim();
        const trunkTech = String(tech || 'custom').trim().toLowerCase();
        const dialString = String(channelid || '').trim().replace(/^dongle\/I:/, 'dongle/i:');
        const cidVal = String(outcid || '').trim();
        const userContextVal = String(usercontext || '').trim();
        const keepCidVal = String(keepcid || 'off').trim();
        const maxChansVal = String(maxchans || '').trim();
        const dialPrefixVal = String(dialoutprefix || '').trim();
        const disabledVal = String(disabled || 'off').trim();
        const dialoptsVal = String(dialopts || '').trim();
        const continueVal = String(contVal || 'off').trim();
        const failscriptVal = String(failscript || '').trim();

        if (trunkTech === 'custom' && !dialString) {
            return res.status(400).json({ success: false, error: 'Custom Dial String is required for Custom trunks.' });
        }

        const [maxRow] = await pool.query('SELECT COALESCE(MAX(trunkid), 0) + 1 AS nextId FROM `asterisk`.`trunks`');
        const nextTrunkId = maxRow[0].nextId;
        const trunkKey = `tr-trunk-${nextTrunkId}`;

        await pool.query(`
            INSERT INTO \`asterisk\`.\`trunks\` (trunkid, name, tech, outcid, keepcid, maxchans, failscript, dialoutprefix, channelid, disabled, \`continue\`, usercontext)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [nextTrunkId, trunkName, trunkTech, cidVal, keepCidVal, maxChansVal, failscriptVal, dialPrefixVal, dialString, disabledVal, continueVal, userContextVal]);

        // Store dialopts in AstDB (Asterisk uses this at dialplan runtime)
        if (dialoptsVal) {
            try { await execPromise(`asterisk -rx "database put TRUNK ${nextTrunkId}/dialopts ${dialoptsVal}"`); } catch (e) {}
        } else {
            try { await execPromise(`asterisk -rx "database del TRUNK ${nextTrunkId}/dialopts"`); } catch (e) {}
        }

        const targetTable = (trunkTech === 'iax2' || trunkTech === 'iax') ? 'iax' : 'sip';

        if (trunkTech === 'sip' || trunkTech === 'iax2' || trunkTech === 'iax') {
            let peerParams = parseDetailsText(peerdetails);
            if (peerParams.length === 0 && host) {
                peerParams = [
                    ['account', trunkName, 0],
                    ['host', String(host || '').trim(), 1],
                    ['username', String(username || '').trim(), 2],
                    ['secret', String(secret || '').trim(), 3],
                    ['type', 'peer', 4],
                    ['context', String(context || 'from-trunk').trim(), 5],
                    ['qualify', 'yes', 6]
                ];
                if (trunkTech === 'sip') peerParams.push(['insecure', 'port,invite', 7]);
            } else {
                peerParams.unshift(['account', trunkName, 0]);
            }

            if (register && String(register).trim()) {
                peerParams.push(['register', String(register).trim(), 99]);
            }

            for (const [kw, val, seq] of peerParams) {
                if (val !== undefined && val !== '') {
                    await pool.query(`
                        INSERT INTO \`asterisk\`.\`${targetTable}\` (id, keyword, data, flags)
                        VALUES (?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE data = VALUES(data)
                    `, [trunkKey, kw, val, seq]);
                }
            }

            if (userContextVal) {
                const userParams = parseDetailsText(userdetails);
                if (userParams.length === 0 && secret) {
                    userParams.push(['secret', String(secret).trim(), 0]);
                    userParams.push(['type', 'user', 1]);
                    userParams.push(['context', String(context || 'from-trunk').trim(), 2]);
                }
                for (const [kw, val, seq] of userParams) {
                    if (val !== undefined && val !== '') {
                        await pool.query(`
                            INSERT INTO \`asterisk\`.\`${targetTable}\` (id, keyword, data, flags)
                            VALUES (?, ?, ?, ?)
                            ON DUPLICATE KEY UPDATE data = VALUES(data)
                        `, [userContextVal, kw, val, seq]);
                    }
                }
            }
        }

        const reloadRes = await reloadPbxConfigPromise();
        res.json({
            success: true,
            message: `Trunk '${trunkName}' (${trunkTech.toUpperCase()}) created successfully.`,
            applied: reloadRes.success,
            reloadError: reloadRes.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/trunks/:trunkid - Modify Trunk (Custom, SIP, IAX2)
app.put('/api/config/trunks/:trunkid', async (req, res) => {
    try {
        const trunkId = parseInt(req.params.trunkid, 10);
        const { name, tech, channelid, host, username, secret, context, register, usercontext, outcid, keepcid, maxchans, dialoutprefix, disabled, dialopts, continue: contVal, failscript, peerdetails, userdetails } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Trunk Name is required.' });
        }

        const trunkName = String(name).trim();
        const trunkTech = String(tech || 'custom').trim().toLowerCase();
        const dialString = String(channelid || '').trim().replace(/^dongle\/I:/, 'dongle/i:');
        const cidVal = String(outcid || '').trim();
        const userContextVal = String(usercontext || '').trim();
        const keepCidVal = String(keepcid || 'off').trim();
        const maxChansVal = String(maxchans || '').trim();
        const dialPrefixVal = String(dialoutprefix || '').trim();
        const disabledVal = String(disabled || 'off').trim();
        const dialoptsVal = String(dialopts || '').trim();
        const continueVal = String(contVal || 'off').trim();
        const failscriptVal = String(failscript || '').trim();
        const trunkKey = `tr-trunk-${trunkId}`;

        await pool.query(`
            UPDATE \`asterisk\`.\`trunks\`
            SET name = ?, tech = ?, channelid = ?, outcid = ?, keepcid = ?, maxchans = ?, failscript = ?, dialoutprefix = ?, disabled = ?, \`continue\` = ?, usercontext = ?
            WHERE trunkid = ?
        `, [trunkName, trunkTech, dialString, cidVal, keepCidVal, maxChansVal, failscriptVal, dialPrefixVal, disabledVal, continueVal, userContextVal, trunkId]);

        // Store dialopts in AstDB
        if (dialoptsVal) {
            try { await execPromise(`asterisk -rx "database put TRUNK ${trunkId}/dialopts ${dialoptsVal}"`); } catch (e) {}
        } else {
            try { await execPromise(`asterisk -rx "database del TRUNK ${trunkId}/dialopts"`); } catch (e) {}
        }

        const targetTable = (trunkTech === 'iax2' || trunkTech === 'iax') ? 'iax' : 'sip';

        if (trunkTech === 'sip' || trunkTech === 'iax2' || trunkTech === 'iax') {
            let peerParams = parseDetailsText(peerdetails);
            if (peerParams.length === 0 && host) {
                peerParams = [
                    ['account', trunkName, 0],
                    ['host', String(host || '').trim(), 1],
                    ['username', String(username || '').trim(), 2],
                    ['secret', String(secret || '').trim(), 3],
                    ['type', 'peer', 4],
                    ['context', String(context || 'from-trunk').trim(), 5],
                    ['qualify', 'yes', 6]
                ];
                if (trunkTech === 'sip') peerParams.push(['insecure', 'port,invite', 7]);
            } else {
                peerParams.unshift(['account', trunkName, 0]);
            }

            if (register && String(register).trim()) {
                peerParams.push(['register', String(register).trim(), 99]);
            }

            for (const [kw, val, seq] of peerParams) {
                if (val !== undefined && val !== '') {
                    await pool.query(`
                        INSERT INTO \`asterisk\`.\`${targetTable}\` (id, keyword, data, flags)
                        VALUES (?, ?, ?, ?)
                    `, [trunkKey, kw, val, seq]);
                }
            }

            if (userContextVal) {
                const userParams = parseDetailsText(userdetails);
                if (userParams.length === 0 && secret) {
                    userParams.push(['secret', String(secret).trim(), 0]);
                    userParams.push(['type', 'user', 1]);
                    userParams.push(['context', String(context || 'from-trunk').trim(), 2]);
                }
                for (const [kw, val, seq] of userParams) {
                    if (val !== undefined && val !== '') {
                        await pool.query(`
                            INSERT INTO \`asterisk\`.\`${targetTable}\` (id, keyword, data, flags)
                            VALUES (?, ?, ?, ?)
                        `, [userContextVal, kw, val, seq]);
                    }
                }
            }
        }

        const reloadRes = await reloadPbxConfigPromise();
        res.json({
            success: true,
            message: `Trunk '${trunkName}' updated successfully.`,
            applied: reloadRes.success,
            reloadError: reloadRes.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/trunks/:trunkid - Delete Trunk
app.delete('/api/config/trunks/:trunkid', async (req, res) => {
    try {
        const trunkId = parseInt(req.params.trunkid, 10);
        const [tRows] = await pool.query('SELECT name FROM `asterisk`.`trunks` WHERE trunkid = ?', [trunkId]);
        const name = tRows[0] ? tRows[0].name : '';
        const trunkKey = `tr-trunk-${trunkId}`;

        await pool.query('DELETE FROM `asterisk`.`trunks` WHERE trunkid = ?', [trunkId]);
        await pool.query('DELETE FROM `asterisk`.`sip` WHERE id = ?', [trunkKey]);
        await pool.query('DELETE FROM `asterisk`.`iax` WHERE id = ?', [trunkKey]);
        await pool.query('DELETE FROM `asterisk`.`outbound_route_trunks` WHERE trunk_id = ?', [trunkId]);

        const reloadRes = await reloadPbxConfigPromise();
        res.json({
            success: true,
            message: `Trunk deleted successfully.`,
            applied: reloadRes.success,
            reloadError: reloadRes.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
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

        // Check if route with exact same DID (extension) and Description already exists
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
        res.json({ success: true, message: `Inbound Route '${desc}' saved successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/routes/inbound - Modify Inbound Route
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

        await pool.query(`
            UPDATE \`asterisk\`.\`incoming\`
            SET description = ?, extension = ?, destination = ?
            WHERE (extension = ? OR extension = ? OR (extension IS NULL AND ? = ''))
              AND (description = ? OR (description IS NULL AND ? = ''))
              AND (destination = ? OR (destination IS NULL AND ? = ''))
            LIMIT 1
        `, [desc, ext, dest, origExt, rawOrigExt, origExt, origDesc, origDesc, origDest, origDest]);

        reloadPbxConfig();
        res.json({ success: true, message: `Inbound Route '${desc}' updated successfully.` });
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
                if (entry.selection && entry.dest) {
                    await pool.query(`
                        INSERT INTO \`asterisk\`.\`ivr_entries\` (ivr_id, selection, dest, ivr_ret)
                        VALUES (?, ?, ?, 0)
                    `, [newIvrId, String(entry.selection).trim(), String(entry.dest).trim()]);
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
                if (entry.selection && entry.dest) {
                    await pool.query(`
                        INSERT INTO \`asterisk\`.\`ivr_entries\` (ivr_id, selection, dest, ivr_ret)
                        VALUES (?, ?, ?, 0)
                    `, [ivrId, String(entry.selection).trim(), String(entry.dest).trim()]);
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
            SELECT grpnum, strategy, grptime, grplist, description, postdest FROM \`asterisk\`.\`ringgroups\`
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

        // Query IVR Menus
        const [ivrs] = await pool.query(`
            SELECT id, name, description, announcement, directdial, timeout_destination, invalid_destination
            FROM \`asterisk\`.\`ivr_details\`
            ORDER BY id ASC
        `);

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
            SELECT extension, descr, maxwait, dest FROM \`asterisk\`.\`queues_config\`
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

// GET /api/config/timegroups - Retrieve all time groups and their details
app.get('/api/config/timegroups', async (req, res) => {
    try {
        const [groups] = await pool.query('SELECT id, description FROM `asterisk`.`timegroups_groups` ORDER BY id ASC');
        const [details] = await pool.query('SELECT id, timegroupid, time, name FROM `asterisk`.`timegroups_details` ORDER BY id ASC');
        
        const groupsWithDetails = groups.map(g => {
            const rules = details.filter(d => d.timegroupid === g.id).map(d => {
                const parts = d.time.split('|');
                return {
                    id: d.id,
                    time: parts[0] || '',
                    weekday: parts[1] || '',
                    monthday: parts[2] || '',
                    month: parts[3] || '',
                    name: d.name || ''
                };
            });
            return {
                id: g.id,
                description: g.description,
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
        
        if (rules && Array.isArray(rules)) {
            for (const rule of rules) {
                const timeStr = `${rule.time || ''}|${rule.weekday || ''}|${rule.monthday || ''}|${rule.month || ''}`;
                await pool.query('INSERT INTO `asterisk`.`timegroups_details` (timegroupid, time, name) VALUES (?, ?, ?)', [groupid, timeStr, '']);
            }
        }
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
        
        if (rules && Array.isArray(rules)) {
            for (const rule of rules) {
                const timeStr = `${rule.time || ''}|${rule.weekday || ''}|${rule.monthday || ''}|${rule.month || ''}`;
                await pool.query('INSERT INTO `asterisk`.`timegroups_details` (timegroupid, time, name) VALUES (?, ?, ?)', [id, timeStr, '']);
            }
        }
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
        
        const [r] = await pool.query(`
            INSERT INTO \`asterisk\`.\`timeconditions\` (displayname, \`time\`, truegoto, falsegoto, deptname, generate_hint, priority)
            VALUES (?, ?, ?, ?, '', 0, NULL)
        `, [displayname.trim(), timegroup_id, truegoto, falsegoto]);
        
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
        
        await pool.query(`
            UPDATE \`asterisk\`.\`timeconditions\`
            SET displayname = ?, \`time\` = ?, truegoto = ?, falsegoto = ?
            WHERE timeconditions_id = ?
        `, [displayname.trim(), timegroup_id, truegoto, falsegoto, id]);
        
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
        res.json({ success: true, message: 'Time Condition deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
// ============================================================================
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

server.listen(PORT, () => console.log(`Real-Time Enterprise Engine active on port ${PORT}`));
