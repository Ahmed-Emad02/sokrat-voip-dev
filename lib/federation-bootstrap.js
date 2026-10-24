'use strict';

const { execFile, exec } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const {
    generateIaxConfig,
    generateDialplanConfig,
    ensureAsteriskIncludes,
    syncFederationAsteriskConfig
} = require('./federation-engine');
const { normalizeFederationBaseUrl } = require('./federation-auth');

function resolveBinary(name, fallbackPaths) {
    for (const p of fallbackPaths) {
        if (fs.existsSync(p)) return p;
    }
    try {
        const { execSync } = require('child_process');
        const found = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (found && fs.existsSync(found)) return found;
    } catch (_) {}
    return fallbackPaths[0];
}

const SSHPASS_BIN = resolveBinary('sshpass', ['/usr/bin/sshpass', '/usr/local/bin/sshpass', 'sshpass']);
const SSH_BIN = resolveBinary('ssh', ['/usr/bin/ssh', '/usr/local/bin/ssh', 'ssh']);
const SCP_BIN = resolveBinary('scp', ['/usr/bin/scp', '/usr/local/bin/scp', 'scp']);

/**
 * Execute a remote command via SSH with sshpass.
 */
function execRemoteSsh(host, port, user, password, command, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(SSHPASS_BIN)) {
            return reject(new Error('sshpass binary not found. Please install sshpass to perform automated SSH bootstrap.'));
        }
        const portStr = String(port || 22);
        const args = [
            '-p', password,
            SSH_BIN,
            '-p', portStr,
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'LogLevel=ERROR',
            '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
            `${user}@${host}`,
            command
        ];

        execFile(SSHPASS_BIN, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
            if (err) {
                const msg = stderr ? stderr.trim() : (err.message || 'SSH execution error');
                return reject(new Error(`SSH to ${host}:${portStr} failed: ${msg}`));
            }
            resolve(stdout ? stdout.trim() : '');
        });
    });
}

/**
 * Copy a file or directory to the remote server via SCP with sshpass.
 */
function scpToRemote(host, port, user, password, localPath, remotePath, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(SSHPASS_BIN)) {
            return reject(new Error('sshpass binary not found. Please install sshpass to perform automated SCP transfer.'));
        }
        const portStr = String(port || 22);
        const args = [
            '-p', password,
            SCP_BIN,
            '-P', portStr,
            '-r',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'LogLevel=ERROR',
            '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
            localPath,
            `${user}@${host}:${remotePath}`
        ];

        execFile(SSHPASS_BIN, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
            if (err) {
                const msg = stderr ? stderr.trim() : (err.message || 'SCP transfer error');
                return reject(new Error(`SCP to ${host}:${portStr} failed: ${msg}`));
            }
            resolve(true);
        });
    });
}

const LOCAL_APP_DIR = path.join(__dirname, '..');

// Files whose checksums prove the remote node runs the same federation code.
const CODE_SYNC_FILES = [
    'server.js',
    'package.json',
    'lib/federation-auth.js',
    'lib/federation-client.js',
    'lib/federation-engine.js',
    'lib/federation-bootstrap.js',
    'lib/federation-hub.js'
];

function hashLocalCodeFile(relativePath) {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(path.join(LOCAL_APP_DIR, relativePath))).digest('hex');
    } catch (_) {
        return null;
    }
}

/**
 * Read checksums and the package version from the remote app directory.
 * Missing files are reported as null instead of failing the bootstrap.
 */
async function inspectRemoteCode(host, port, user, password) {
    const fileList = CODE_SYNC_FILES.map(f => `/opt/sokrat-voip/${f}`).join(' ');
    const cmd = `sha256sum ${fileList} 2>/dev/null || true; echo '---VERSION---'; node -e "try{process.stdout.write(require('/opt/sokrat-voip/package.json').version)}catch(e){process.stdout.write('unknown')}" 2>/dev/null || echo unknown`;
    const output = await execRemoteSsh(host, port, user, password, cmd);
    const hashes = {};
    let version = 'unknown';
    const sections = String(output || '').split('---VERSION---');
    for (const line of sections[0].split('\n')) {
        const match = line.trim().match(/^([a-f0-9]{64})\s+(\/opt\/sokrat-voip\/.+)$/i);
        if (!match) continue;
        const rel = match[2].replace('/opt/sokrat-voip/', '');
        hashes[rel] = match[1].toLowerCase();
    }
    if (sections[1]) version = sections[1].trim() || 'unknown';
    return { hashes, version };
}

/**
 * Decide whether the remote node needs a code push.
 * mode: true = always, false = never, 'auto' (default) = only when files differ.
 */
function decideCodeSync(localHashes, remoteInfo, mode = 'auto') {
    if (mode === false) return { sync: false, reason: 'disabled', changed: [], missing: [] };
    if (mode === true) return { sync: true, reason: 'forced', changed: [], missing: [] };

    const missing = [];
    const changed = [];
    for (const [file, hash] of Object.entries(localHashes)) {
        if (!hash) continue;
        if (!remoteInfo.hashes[file]) missing.push(file);
        else if (remoteInfo.hashes[file] !== hash) changed.push(file);
    }
    if (missing.length || changed.length) {
        return { sync: true, reason: missing.length ? 'missing-files' : 'checksum-mismatch', changed, missing };
    }
    return { sync: false, reason: 'up-to-date', changed: [], missing: [] };
}

/**
 * Check IAX peer qualify status via Asterisk CLI.
 */
function qualifyIaxPeer(peerName, execFileFn = execFile) {
    return new Promise((resolve) => {
        execFileFn('/usr/sbin/asterisk', ['-rx', `iax2 show peer ${peerName}`], (err, stdout) => {
            if (err || !stdout) {
                return resolve({ status: 'unreachable', latencyMs: null, raw: '' });
            }
            const output = stdout.toString();
            // Look for Status: OK (X ms) or UNREACHABLE or UNMONITORED
            const statusMatch = output.match(/Status\s*:\s*([^\r\n]+)/i);
            const statusStr = statusMatch ? statusMatch[1].trim() : 'UNKNOWN';

            let status = 'offline';
            let latencyMs = null;

            if (/OK/i.test(statusStr)) {
                status = 'online';
                const latencyMatch = statusStr.match(/(\d+)\s*ms/i);
                if (latencyMatch) {
                    latencyMs = parseInt(latencyMatch[1], 10);
                }
            } else if (/UNREACHABLE/i.test(statusStr)) {
                status = 'unreachable';
            } else if (/UNKNOWN/i.test(statusStr)) {
                status = 'unknown';
            }

            resolve({ status, statusDescription: statusStr, latencyMs, raw: output });
        });
    });
}

/**
 * Automated One-Click SSH Federation Bootstrap.
 */
async function bootstrapPeer({
    pool,
    encryptFn,
    decryptFn,
    host,
    sshPort = 22,
    sshUser = 'root',
    sshPassword,
    siteCode,
    nodeName,
    localIp,
    localSiteCode: customLocalSiteCode,
    localNodeName: customLocalNodeName,
    allowInternalDialing = 1,
    allowOutboundEgress = 1,
    codeSync = 'auto'
}) {
    if (!host || !sshPassword || !siteCode) {
        throw new Error('Host, SSH password, and remote site code are required.');
    }

    const cleanSiteCode = String(siteCode).trim().replace(/\D/g, '');
    if (!cleanSiteCode) {
        throw new Error('Site code must contain valid numeric digits.');
    }

    // 1. Get or initialize local settings
    const [settingsRows] = await pool.query('SELECT * FROM `asterisk`.`sokrat_federation_settings` WHERE id = 1');
    const localSettings = (settingsRows && settingsRows[0]) || {
        local_site_code: customLocalSiteCode || '10',
        local_node_name: customLocalNodeName || 'Main PBX',
        panel_role: 'local'
    };

    const localSiteCode = localSettings.local_site_code || '10';
    const localNodeName = localSettings.local_node_name || 'Main PBX';
    let localNodeUuid = localSettings.local_node_uuid || null;
    if (!localNodeUuid) {
        localNodeUuid = crypto.randomUUID();
        try {
            await pool.query(
                'UPDATE `asterisk`.`sokrat_federation_settings` SET `local_node_uuid` = ? WHERE `id` = 1',
                [localNodeUuid]
            );
        } catch (_) {}
    }

    if (cleanSiteCode === String(localSiteCode).trim()) {
        throw new Error(`Remote site code (${cleanSiteCode}) cannot be the same as local site code (${localSiteCode}).`);
    }

    const resolvedLocalIp = localIp || (await getLocalIpAddress(host, sshPort, sshUser, sshPassword)) || '127.0.0.1';

    // 2. Test SSH Connection to remote PBX
    const remoteUname = await execRemoteSsh(host, sshPort, sshUser, sshPassword, 'uname -a');
    if (!remoteUname) {
        throw new Error(`Could not verify remote system at ${host}:${sshPort}`);
    }

    // 3. Inspect remote PBX MySQL credentials
    const findMysqlCredsCmd = `
        AMP_USER=$(grep -E '^AMPDBUSER=' /etc/amportal.conf 2>/dev/null | cut -d= -f2 | tr -d ' "')
        AMP_PASS=$(grep -E '^AMPDBPASS=' /etc/amportal.conf 2>/dev/null | cut -d= -f2 | tr -d ' "')
        if [ -n "$AMP_USER" ] && [ -n "$AMP_PASS" ]; then
            echo "$AMP_USER:$AMP_PASS"
        else
            echo "asteriskuser:admin"
        fi
    `;
    const remoteMysqlCreds = (await execRemoteSsh(host, sshPort, sshUser, sshPassword, findMysqlCredsCmd)) || 'asteriskuser:admin';
    const [rDbUser, rDbPass] = remoteMysqlCreds.split(':');

    // 4. Compare federation code on the remote node before copying anything.
    // A previous bootstrap pushed local files unconditionally, silently
    // overwriting remote changes. Only sync when checksums differ (or when the
    // caller explicitly forces it), and report the decision back to the UI.
    const localHashes = {};
    for (const file of CODE_SYNC_FILES) {
        const hash = hashLocalCodeFile(file);
        if (hash) localHashes[file] = hash;
    }
    const remoteCode = await inspectRemoteCode(host, sshPort, sshUser, sshPassword);
    const syncDecision = decideCodeSync(localHashes, remoteCode, codeSync);
    const codeSyncResult = {
        synced: false,
        reason: syncDecision.reason,
        changedFiles: syncDecision.changed,
        missingFiles: syncDecision.missing,
        remoteVersion: remoteCode.version,
        localVersion: require('../package.json').version
    };

    if (syncDecision.sync) {
        const appDir = LOCAL_APP_DIR;
        await scpToRemote(host, sshPort, sshUser, sshPassword, path.join(appDir, 'lib'), '/opt/sokrat-voip/');
        if (fs.existsSync(path.join(appDir, 'routes'))) {
            await scpToRemote(host, sshPort, sshUser, sshPassword, path.join(appDir, 'routes'), '/opt/sokrat-voip/');
        }
        await scpToRemote(host, sshPort, sshUser, sshPassword, path.join(appDir, 'server.js'), '/opt/sokrat-voip/server.js');
        await scpToRemote(host, sshPort, sshUser, sshPassword, path.join(appDir, 'views'), '/opt/sokrat-voip/');
        await scpToRemote(host, sshPort, sshUser, sshPassword, path.join(appDir, 'package.json'), '/opt/sokrat-voip/package.json');
        codeSyncResult.synced = true;
    } else {
        console.log(`[FederationBootstrap] Skipping code sync to ${host}: ${syncDecision.reason}`);
    }

    // 5. Initialize MySQL schema and ensure includes on remote PBX
    const remoteInitSql = `
        MYSQL_PWD='${rDbPass}' mysql -u ${rDbUser} asterisk -e "
        CREATE TABLE IF NOT EXISTS sokrat_federation_settings (
            id TINYINT PRIMARY KEY DEFAULT 1,
            local_site_code VARCHAR(10) NOT NULL DEFAULT '${cleanSiteCode}',
            local_node_name VARCHAR(100) NOT NULL DEFAULT '${nodeName || `Site ${cleanSiteCode}`}',
            local_node_uuid VARCHAR(36) DEFAULT NULL,
            panel_role ENUM('local', 'central') NOT NULL DEFAULT 'local',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        INSERT INTO sokrat_federation_settings (id, local_site_code, local_node_name, panel_role, local_node_uuid)
        VALUES (1, '${cleanSiteCode}', '${nodeName || `Site ${cleanSiteCode}`}', 'local', UUID())
        ON DUPLICATE KEY UPDATE local_site_code='${cleanSiteCode}', local_node_name='${nodeName || `Site ${cleanSiteCode}`}';

        UPDATE sokrat_federation_settings
        SET local_node_uuid = UUID()
        WHERE id = 1 AND (local_node_uuid IS NULL OR local_node_uuid = '');

        CREATE TABLE IF NOT EXISTS sokrat_federation_peers (
            id INT AUTO_INCREMENT PRIMARY KEY,
            node_name VARCHAR(100) NOT NULL,
            node_uuid VARCHAR(36) DEFAULT NULL,
            host VARCHAR(255) NOT NULL,
            site_code VARCHAR(10) NOT NULL UNIQUE,
            iax_port SMALLINT UNSIGNED NOT NULL DEFAULT 4569,
            iax_user_inbound VARCHAR(80) NOT NULL,
            iax_peer_outbound VARCHAR(80) NOT NULL,
            iax_secret_enc TEXT NOT NULL,
            api_base_url VARCHAR(255) NOT NULL,
            api_key_enc TEXT NOT NULL,
            api_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
            node_version VARCHAR(50) DEFAULT NULL,
            tls_cert_fingerprint VARCHAR(128) DEFAULT NULL,
            allow_internal_dialing TINYINT(1) NOT NULL DEFAULT 1,
            allow_outbound_egress TINYINT(1) NOT NULL DEFAULT 1,
            allow_report_read TINYINT(1) NOT NULL DEFAULT 1,
            allow_contact_write TINYINT(1) NOT NULL DEFAULT 0,
            allow_dongle_control TINYINT(1) NOT NULL DEFAULT 0,
            allow_campaign_control TINYINT(1) NOT NULL DEFAULT 0,
            status ENUM('online', 'offline', 'error', 'unreachable') NOT NULL DEFAULT 'offline',
            last_sync_at DATETIME DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS sokrat_federation_remote_extensions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            peer_id INT NOT NULL,
            native_extension VARCHAR(20) NOT NULL,
            dial_alias VARCHAR(30) NOT NULL UNIQUE,
            display_name VARCHAR(100) NOT NULL,
            status ENUM('online', 'offline', 'ringing', 'in_call', 'unknown') NOT NULL DEFAULT 'unknown',
            last_seen_at DATETIME DEFAULT NULL,
            UNIQUE KEY idx_peer_ext (peer_id, native_extension),
            KEY idx_peer_id (peer_id),
            KEY idx_dial_alias (dial_alias)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS sokrat_federation_remote_dongles (
            id INT AUTO_INCREMENT PRIMARY KEY,
            peer_id INT NOT NULL,
            dongle_name VARCHAR(50) NOT NULL,
            phone_number VARCHAR(50) DEFAULT NULL,
            provider VARCHAR(50) DEFAULT NULL,
            status VARCHAR(50) DEFAULT 'Unknown',
            UNIQUE KEY idx_peer_dongle (peer_id, dongle_name),
            KEY idx_peer_id (peer_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

        CREATE TABLE IF NOT EXISTS sokrat_federation_node_status (
            peer_id INT PRIMARY KEY,
            status ENUM('online', 'offline', 'error', 'unreachable') NOT NULL DEFAULT 'offline',
            last_seen_at DATETIME DEFAULT NULL,
            last_error VARCHAR(255) DEFAULT NULL,
            latency_ms INT DEFAULT NULL,
            api_version SMALLINT UNSIGNED DEFAULT NULL,
            node_version VARCHAR(50) DEFAULT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        "
    `;
    await execRemoteSsh(host, sshPort, sshUser, sshPassword, remoteInitSql);

    // 5b. Add columns that older remote installs are missing. Each statement is
    // independent so one already-present column cannot abort the migration.
    const remoteAlters = [
        'ALTER TABLE sokrat_federation_settings ADD COLUMN local_node_uuid VARCHAR(36) DEFAULT NULL',
        'ALTER TABLE sokrat_federation_peers ADD COLUMN node_uuid VARCHAR(36) DEFAULT NULL',
        'ALTER TABLE sokrat_federation_peers ADD COLUMN api_version SMALLINT UNSIGNED NOT NULL DEFAULT 1',
        'ALTER TABLE sokrat_federation_peers ADD COLUMN node_version VARCHAR(50) DEFAULT NULL',
        'ALTER TABLE sokrat_federation_peers ADD COLUMN allow_report_read TINYINT(1) NOT NULL DEFAULT 1',
        'ALTER TABLE sokrat_federation_peers ADD COLUMN allow_contact_write TINYINT(1) NOT NULL DEFAULT 0',
        'ALTER TABLE sokrat_federation_peers ADD COLUMN allow_dongle_control TINYINT(1) NOT NULL DEFAULT 0',
        'ALTER TABLE sokrat_federation_peers ADD COLUMN allow_campaign_control TINYINT(1) NOT NULL DEFAULT 0'
    ];
    const remoteAlterScript = remoteAlters
        .map(stmt => `MYSQL_PWD='${rDbPass}' mysql -u ${rDbUser} asterisk -e "${stmt}" 2>/dev/null || true`)
        .join('\n');
    await execRemoteSsh(host, sshPort, sshUser, sshPassword, remoteAlterScript);

    const remoteNodeUuid = (await execRemoteSsh(
        host, sshPort, sshUser, sshPassword,
        `MYSQL_PWD='${rDbPass}' mysql -u ${rDbUser} asterisk -Nse "SELECT local_node_uuid FROM sokrat_federation_settings WHERE id = 1" 2>/dev/null || true`
    )).trim() || null;

    // 6. Generate cryptographically strong shared IAX secret and API keys
    const sharedIaxSecret = crypto.randomBytes(24).toString('hex');
    const remoteApiKey = crypto.randomBytes(32).toString('hex');

    const encryptedSecretLocal = typeof encryptFn === 'function' ? encryptFn(sharedIaxSecret) : sharedIaxSecret;
    const encryptedApiKeyLocal = typeof encryptFn === 'function' ? encryptFn(remoteApiKey) : remoteApiKey;

    // Fetch remote encryption key from remote .env to ensure bilateral secret decryption
    const remoteEncKey = (await execRemoteSsh(host, sshPort, sshUser, sshPassword, "grep -E '^ENCRYPTION_KEY=' /opt/sokrat-voip/.env 2>/dev/null | cut -d= -f2 | tr -d ' \"'")) || '';
    let encryptedSecretRemote = encryptedSecretLocal;
    let encryptedApiKeyRemote = encryptedApiKeyLocal;
    if (remoteEncKey && remoteEncKey.length >= 32) {
        const rKey = crypto.createHash('sha256').update(String(remoteEncKey)).digest();
        const iv1 = crypto.randomBytes(16);
        const c1 = crypto.createCipheriv('aes-256-cbc', rKey, iv1);
        let e1 = c1.update(sharedIaxSecret, 'utf8', 'hex');
        e1 += c1.final('hex');
        encryptedSecretRemote = iv1.toString('hex') + ':' + e1;

        const iv2 = crypto.randomBytes(16);
        const c2 = crypto.createCipheriv('aes-256-cbc', rKey, iv2);
        let e2 = c2.update(remoteApiKey, 'utf8', 'hex');
        e2 += c2.final('hex');
        encryptedApiKeyRemote = iv2.toString('hex') + ':' + e2;
    }
    const inboundUserLocal = `fed_in_site${cleanSiteCode}`;
    const outboundPeerLocal = `fed_out_site${cleanSiteCode}`;

    const inboundUserRemote = `fed_in_site${localSiteCode}`;
    const outboundPeerRemote = `fed_out_site${localSiteCode}`;

    // 7. Save Peer record in Local MySQL
    const peerApiBaseUrl = normalizeFederationBaseUrl(`https://${host}`);
    const [existingPeerRows] = await pool.query('SELECT id FROM `asterisk`.`sokrat_federation_peers` WHERE site_code = ?', [cleanSiteCode]);
    let localPeerId;
    if (existingPeerRows && existingPeerRows.length > 0) {
        localPeerId = existingPeerRows[0].id;
        await pool.query(`
            UPDATE asterisk.sokrat_federation_peers SET
                node_name = ?,
                node_uuid = ?,
                node_version = ?,
                api_version = 1,
                host = ?,
                iax_port = 4569,
                iax_user_inbound = ?,
                iax_peer_outbound = ?,
                iax_secret_enc = ?,
                api_base_url = ?,
                api_key_enc = ?,
                allow_internal_dialing = ?,
                allow_outbound_egress = ?,
                status = 'offline'
            WHERE id = ?
        `, [
            nodeName || `Site ${cleanSiteCode}`,
            remoteNodeUuid,
            remoteCode.version || null,
            host,
            inboundUserLocal,
            outboundPeerLocal,
            encryptedSecretLocal,
            peerApiBaseUrl,
            encryptedApiKeyLocal,
            allowInternalDialing ? 1 : 0,
            allowOutboundEgress ? 1 : 0,
            localPeerId
        ]);
    } else {
        const [insertRes] = await pool.query(`
            INSERT INTO asterisk.sokrat_federation_peers (
                node_name, node_uuid, node_version, api_version, host, site_code, iax_port,
                iax_user_inbound, iax_peer_outbound, iax_secret_enc, api_base_url, api_key_enc,
                allow_internal_dialing, allow_outbound_egress, status
            ) VALUES (?, ?, ?, 1, ?, ?, 4569, ?, ?, ?, ?, ?, ?, ?, 'offline')
        `, [
            nodeName || `Site ${cleanSiteCode}`,
            remoteNodeUuid,
            remoteCode.version || null,
            host,
            cleanSiteCode,
            inboundUserLocal,
            outboundPeerLocal,
            encryptedSecretLocal,
            peerApiBaseUrl,
            encryptedApiKeyLocal,
            allowInternalDialing ? 1 : 0,
            allowOutboundEgress ? 1 : 0
        ]);
        localPeerId = insertRes.insertId;
    }

    // 8. Save Peer record in Remote MySQL (Local server as seen by Remote server)
    const localApiBaseUrl = normalizeFederationBaseUrl(`https://${resolvedLocalIp}`);
    const remotePeerInsertSql = `
        MYSQL_PWD='${rDbPass}' mysql -u ${rDbUser} asterisk -e "
        INSERT INTO sokrat_federation_peers (
            node_name, node_uuid, node_version, api_version, host, site_code, iax_port,
            iax_user_inbound, iax_peer_outbound, iax_secret_enc, api_base_url, api_key_enc,
            allow_internal_dialing, allow_outbound_egress, status
        ) VALUES (
            '${localNodeName.replace(/'/g, "\\'")}', '${localNodeUuid}', '${require('../package.json').version}', 1,
            '${resolvedLocalIp}', '${localSiteCode}', 4569,
            '${inboundUserRemote}', '${outboundPeerRemote}', '${encryptedSecretRemote}',
            '${localApiBaseUrl}', '${encryptedApiKeyRemote}', 1, 1, 'online'
        ) ON DUPLICATE KEY UPDATE
            node_name='${localNodeName.replace(/'/g, "\\'")}',
            node_uuid='${localNodeUuid}',
            node_version='${require('../package.json').version}',
            api_version=1,
            host='${resolvedLocalIp}',
            iax_user_inbound='${inboundUserRemote}',
            iax_peer_outbound='${outboundPeerRemote}',
            iax_secret_enc='${encryptedSecretRemote}',
            api_base_url='${localApiBaseUrl}',
            api_key_enc='${encryptedApiKeyRemote}',
            status='online',
            last_sync_at=NOW();
        "
    `;
    await execRemoteSsh(host, sshPort, sshUser, sshPassword, remotePeerInsertSql);

    // 9. Sync Asterisk configs on Local Node
    await syncFederationAsteriskConfig(pool, decryptFn);

    // 10. Sync Asterisk configs on Remote Node
    const remoteSyncScript = `
        cd /opt/sokrat-voip && node -e "
        const mysql = require('mysql2/promise');
        const { syncFederationAsteriskConfig } = require('/opt/sokrat-voip/lib/federation-engine');
        (async () => {
            const pool = mysql.createPool({ host: 'localhost', user: '${rDbUser}', password: '${rDbPass}', database: 'asterisk' });
            const res = await syncFederationAsteriskConfig(pool, () => '${sharedIaxSecret}');
            console.log(JSON.stringify(res));
            process.exit(0);
        })();
        " 2>&1
    `;
    await execRemoteSsh(host, sshPort, sshUser, sshPassword, remoteSyncScript);

    // Restart the remote service only when new code was actually copied;
    // restarting on every bootstrap drops active calls for no reason.
    if (codeSyncResult.synced) {
        await execRemoteSsh(host, sshPort, sshUser, sshPassword, 'systemctl restart sokrat-voip.service 2>/dev/null || true');
        codeSyncResult.restarted = true;
    }

    // 11. Bilateral entity sync: sync remote entities into local DB & push local entities into remote DB
    const syncRes = await syncRemotePeerEntities(pool, localPeerId, cleanSiteCode, host, sshPort, sshUser, sshPassword, rDbUser, rDbPass);

    // Push local entities into remote node so remote server also has full directory for Central Live Panel
    try {
        const [localExtRows] = await pool.query('SELECT extension, name FROM `asterisk`.`users`');
        const [localDongleRows] = await pool.query('SELECT dongle_name, phone_number FROM `asterisk`.`gsm_dongles`');

        const getRemotePeerIdCmd = `MYSQL_PWD='${rDbPass}' mysql -u ${rDbUser} asterisk -Nse "SELECT id FROM sokrat_federation_peers WHERE site_code='${localSiteCode}' LIMIT 1"`;
        const remotePeerId = (await execRemoteSsh(host, sshPort, sshUser, sshPassword, getRemotePeerIdCmd)) || '1';

        const extInserts = [];
        for (const le of (localExtRows || [])) {
            const dAlias = `${localSiteCode}${le.extension}`;
            const dName = (le.name || le.extension).replace(/'/g, "\\'");
            extInserts.push(`(${remotePeerId}, '${le.extension}', '${dAlias}', '${dName}', 'offline', NOW())`);
        }

        if (extInserts.length > 0) {
            const pushExtSql = `
                MYSQL_PWD='${rDbPass}' mysql -u ${rDbUser} asterisk -e "
                DELETE FROM sokrat_federation_remote_extensions WHERE peer_id=${remotePeerId};
                INSERT INTO sokrat_federation_remote_extensions (peer_id, native_extension, dial_alias, display_name, status, last_seen_at)
                VALUES ${extInserts.join(', ')}
                ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), last_seen_at=NOW();
                "
            `;
            await execRemoteSsh(host, sshPort, sshUser, sshPassword, pushExtSql);
        }
        const dongleInserts = [];
        for (const ld of (localDongleRows || [])) {
            const pNum = (ld.phone_number || '').replace(/'/g, "\\'");
            dongleInserts.push(`(${remotePeerId}, '${ld.dongle_name}', '${pNum}', '', 'Available')`);
        }
        if (dongleInserts.length > 0) {
            const pushDongleSql = `
                MYSQL_PWD='${rDbPass}' mysql -u ${rDbUser} asterisk -e "
                DELETE FROM sokrat_federation_remote_dongles WHERE peer_id=${remotePeerId};
                INSERT INTO sokrat_federation_remote_dongles (peer_id, dongle_name, phone_number, provider, status)
                VALUES ${dongleInserts.join(', ')}
                ON DUPLICATE KEY UPDATE phone_number=VALUES(phone_number);
                "
            `;
            await execRemoteSsh(host, sshPort, sshUser, sshPassword, pushDongleSql);
        }
    } catch (pushErr) {
        console.error('Bilateral push error to remote node:', pushErr.message);
    }

    // 12. Verify qualify on both nodes
    await new Promise(r => setTimeout(r, 1200));

    const qualifyRes = await qualifyIaxPeer(outboundPeerLocal);

    if (qualifyRes.status === 'online') {
        await pool.query('UPDATE `asterisk`.`sokrat_federation_peers` SET status = "online", last_sync_at = NOW() WHERE id = ?', [localPeerId]);
    } else {
        await pool.query('UPDATE `asterisk`.`sokrat_federation_peers` SET status = ?, last_sync_at = NOW() WHERE id = ?', [qualifyRes.status, localPeerId]);
    }
    return {
        success: true,
        peerId: localPeerId,
        siteCode: cleanSiteCode,
        status: qualifyRes.status,
        latencyMs: qualifyRes.latencyMs,
        statusDescription: qualifyRes.statusDescription,
        extensionsSynced: syncRes.extensionsCount,
        donglesSynced: syncRes.donglesCount,
        codeSync: codeSyncResult
    };
}

/**
 * Synchronize remote extensions and GSM dongles directly via MySQL/SSH or REST.
 */
async function syncRemotePeerEntities(pool, peerId, siteCode, host, sshPort, sshUser, sshPassword, rDbUser = 'asteriskuser', rDbPass = 'admin') {
    try {
        // Query remote extensions
        const extQueryCmd = `MYSQL_PWD='${rDbPass}' mysql -u ${rDbUser} asterisk -Nse "SELECT extension, name FROM users"`;
        const extOutput = await execRemoteSsh(host, sshPort, sshUser, sshPassword, extQueryCmd);

        const extensions = [];
        if (extOutput) {
            const lines = extOutput.split('\n');
            for (const line of lines) {
                const parts = line.trim().split('\t');
                if (parts[0]) {
                    extensions.push({
                        native_extension: parts[0].trim(),
                        display_name: (parts[1] || parts[0]).trim()
                    });
                }
            }
        }

        // Query remote GSM dongles. `gsm_dongles` has no provider column; the
        // provider lives in live dongle state, so keep it NULL here instead of
        // reading a non-existent third field.
        const dongleQueryCmd = `MYSQL_PWD='${rDbPass}' mysql -u ${rDbUser} asterisk -Nse "SELECT dongle_name, phone_number FROM gsm_dongles" 2>/dev/null || true`;
        const dongleOutput = await execRemoteSsh(host, sshPort, sshUser, sshPassword, dongleQueryCmd);

        const dongles = [];
        if (dongleOutput) {
            const lines = dongleOutput.split('\n');
            for (const line of lines) {
                const parts = line.trim().split('\t');
                if (parts[0] && parts[0].startsWith('dongle')) {
                    dongles.push({
                        dongle_name: parts[0].trim(),
                        phone_number: (parts[1] && parts[1] !== 'NULL') ? parts[1].trim() : null,
                        provider: null
                    });
                }
            }
        }

        // Persist extensions in local DB
        await pool.query('DELETE FROM `asterisk`.`sokrat_federation_remote_extensions` WHERE peer_id = ?', [peerId]);
        for (const ext of extensions) {
            const dialAlias = `${siteCode}${ext.native_extension}`;
            await pool.query(`
                INSERT INTO asterisk.sokrat_federation_remote_extensions (peer_id, native_extension, dial_alias, display_name, status, last_seen_at)
                VALUES (?, ?, ?, ?, 'offline', NOW())
                ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), last_seen_at = NOW()
            `, [peerId, ext.native_extension, dialAlias, ext.display_name]);
        }

        // Persist dongles in local DB
        await pool.query('DELETE FROM asterisk.sokrat_federation_remote_dongles WHERE peer_id = ?', [peerId]);
        for (const d of dongles) {
            await pool.query(`
                INSERT INTO asterisk.sokrat_federation_remote_dongles (peer_id, dongle_name, phone_number, provider, status)
                VALUES (?, ?, ?, ?, 'Available')
                ON DUPLICATE KEY UPDATE phone_number = VALUES(phone_number), provider = VALUES(provider)
            `, [peerId, d.dongle_name, d.phone_number, d.provider]);
        }

        return {
            extensionsCount: extensions.length,
            donglesCount: dongles.length
        };
    } catch (err) {
        console.error('syncRemotePeerEntities error:', err.message);
        return { extensionsCount: 0, donglesCount: 0, error: err.message };
    }
}

/**
 * Helper to determine the local IP address routable to the remote peer.
 */
function getLocalIpAddress(targetHost, targetPort, user, password) {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        exec(`ip route get ${targetHost} 2>/dev/null | grep -oP 'src \\K[0-9.]+'`, (err, stdout) => {
            if (!err && stdout && stdout.trim()) {
                return resolve(stdout.trim());
            }
            try {
                const os = require('os');
                const ifaces = os.networkInterfaces();
                for (const iface of Object.values(ifaces)) {
                    for (const alias of iface) {
                        if (alias.family === 'IPv4' && !alias.internal) {
                            return resolve(alias.address);
                        }
                    }
                }
            } catch (_) {}
            resolve('127.0.0.1');
        });
    });
}

/**
 * Remove federation setup from remote server.
 */
async function removeRemoteFederationSetup(host, sshPort, sshUser, sshPassword) {
    const findMysqlCredsCmd = `
        AMP_USER=$(grep -E '^AMPDBUSER=' /etc/amportal.conf 2>/dev/null | cut -d= -f2 | tr -d ' "')
        AMP_PASS=$(grep -E '^AMPDBPASS=' /etc/amportal.conf 2>/dev/null | cut -d= -f2 | tr -d ' "')
        if [ -n "$AMP_USER" ] && [ -n "$AMP_PASS" ]; then
            echo "$AMP_USER:$AMP_PASS"
        else
            echo "asteriskuser:admin"
        fi
    `;
    const remoteMysqlCreds = (await execRemoteSsh(host, sshPort, sshUser, sshPassword, findMysqlCredsCmd)) || 'asteriskuser:admin';
    const [rDbUser, rDbPass] = remoteMysqlCreds.split(':');

    // Clean remote MySQL tables
    const cleanupSql = `
        MYSQL_PWD='${rDbPass}' mysql -u ${rDbUser} asterisk -e "
        TRUNCATE TABLE sokrat_federation_peers;
        TRUNCATE TABLE sokrat_federation_remote_extensions;
        TRUNCATE TABLE sokrat_federation_remote_dongles;
        UPDATE sokrat_federation_settings SET panel_role = 'local' WHERE id = 1;
        "
    `;
    await execRemoteSsh(host, sshPort, sshUser, sshPassword, cleanupSql);

    // Empty Asterisk federation config files and reload
    const cleanupAsterisk = `
        > /etc/asterisk/sokrat_federation_iax.conf
        > /etc/asterisk/sokrat_federation.conf
        /usr/sbin/asterisk -rx "iax2 reload && dialplan reload" 2>/dev/null || true
    `;
    await execRemoteSsh(host, sshPort, sshUser, sshPassword, cleanupAsterisk);

    return { success: true };
}

module.exports = {
    bootstrapPeer,
    qualifyIaxPeer,
    syncRemotePeerEntities,
    removeRemoteFederationSetup,
    execRemoteSsh,
    scpToRemote,
    getLocalIpAddress,
    inspectRemoteCode,
    decideCodeSync,
    CODE_SYNC_FILES
};
