'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { normalizeFederationBaseUrl } = require('./federation-auth');

const ASTERISK_BIN = process.env.ASTERISK_BIN || '/usr/sbin/asterisk';
const ASTERISK_CONF_DIR = process.env.ASTERISK_CONF_DIR || '/etc/asterisk';

/**
 * Initialize federation database schema idempotently.
 */
async function initFederationDb(conn) {
    if (!conn) return;

    // 1. Singleton federation settings
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`sokrat_federation_settings\` (
            \`id\` TINYINT PRIMARY KEY DEFAULT 1,
            \`local_site_code\` VARCHAR(10) NOT NULL DEFAULT '10',
            \`local_node_name\` VARCHAR(100) NOT NULL DEFAULT 'Main PBX',
            \`panel_role\` ENUM('local', 'central') NOT NULL DEFAULT 'local',
            \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        INSERT IGNORE INTO \`sokrat_federation_settings\` (\`id\`, \`local_site_code\`, \`local_node_name\`, \`panel_role\`)
        VALUES (1, '10', 'Main PBX', 'local')
    `);
    try {
        await conn.execute('ALTER TABLE `sokrat_federation_settings` ADD COLUMN `local_node_uuid` VARCHAR(36) DEFAULT NULL');
    } catch (_) {}
    try {
        await conn.execute("UPDATE `sokrat_federation_settings` SET `local_node_uuid` = UUID() WHERE `local_node_uuid` IS NULL OR `local_node_uuid` = ''");
    } catch (_) {}

    // 2. Connected federation peers
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`sokrat_federation_peers\` (
            \`id\` INT AUTO_INCREMENT PRIMARY KEY,
            \`node_name\` VARCHAR(100) NOT NULL,
            \`host\` VARCHAR(255) NOT NULL,
            \`site_code\` VARCHAR(10) NOT NULL UNIQUE,
            \`iax_port\` SMALLINT UNSIGNED NOT NULL DEFAULT 4569,
            \`iax_user_inbound\` VARCHAR(80) NOT NULL,
            \`iax_peer_outbound\` VARCHAR(80) NOT NULL,
            \`iax_secret_enc\` TEXT NOT NULL,
            \`api_base_url\` VARCHAR(255) NOT NULL,
            \`api_key_enc\` TEXT NOT NULL,
            \`tls_cert_fingerprint\` VARCHAR(128) DEFAULT NULL,
            \`allow_internal_dialing\` TINYINT(1) NOT NULL DEFAULT 1,
            \`allow_outbound_egress\` TINYINT(1) NOT NULL DEFAULT 1,
            \`status\` ENUM('online', 'offline', 'error', 'unreachable') NOT NULL DEFAULT 'offline',
            \`last_sync_at\` DATETIME DEFAULT NULL,
            \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 2b. Peer identity, protocol version, and per-resource write policy.
    // Existing installs created the peer table without these columns.
    const peerColumns = [
        ['node_uuid', 'VARCHAR(36) DEFAULT NULL'],
        ['api_version', 'SMALLINT UNSIGNED NOT NULL DEFAULT 1'],
        ['node_version', 'VARCHAR(50) DEFAULT NULL'],
        ['allow_report_read', 'TINYINT(1) NOT NULL DEFAULT 1'],
        ['allow_contact_write', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['allow_dongle_control', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['allow_campaign_control', 'TINYINT(1) NOT NULL DEFAULT 0']
    ];
    for (const [col, def] of peerColumns) {
        try {
            await conn.execute(`ALTER TABLE \`sokrat_federation_peers\` ADD COLUMN \`${col}\` ${def}`);
        } catch (_) {}
    }

    // 2c. Node health / sync state, one row per peer.
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`sokrat_federation_node_status\` (
            \`peer_id\` INT PRIMARY KEY,
            \`status\` ENUM('online', 'degraded', 'offline', 'error', 'unreachable') NOT NULL DEFAULT 'offline',
            \`last_seen_at\` DATETIME DEFAULT NULL,
            \`last_error\` VARCHAR(255) DEFAULT NULL,
            \`latency_ms\` INT DEFAULT NULL,
            \`api_version\` SMALLINT UNSIGNED DEFAULT NULL,
            \`node_version\` VARCHAR(50) DEFAULT NULL,
            \`asterisk_version\` VARCHAR(64) DEFAULT NULL,
            \`uptime_sec\` BIGINT DEFAULT NULL,
            \`load1\` DECIMAL(6,2) DEFAULT NULL,
            \`disk_pct\` TINYINT DEFAULT NULL,
            \`extensions_total\` INT NOT NULL DEFAULT 0,
            \`extensions_online\` INT NOT NULL DEFAULT 0,
            \`dongles_total\` INT NOT NULL DEFAULT 0,
            \`dongles_free\` INT NOT NULL DEFAULT 0,
            \`active_calls\` INT NOT NULL DEFAULT 0,
            \`calls_today\` INT NOT NULL DEFAULT 0,
            \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY \`idx_status\` (\`status\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const nodeStatusColumns = [
        ['asterisk_version', 'VARCHAR(64) DEFAULT NULL'],
        ['uptime_sec', 'BIGINT DEFAULT NULL'],
        ['load1', 'DECIMAL(6,2) DEFAULT NULL'],
        ['disk_pct', 'TINYINT DEFAULT NULL'],
        ['extensions_total', 'INT NOT NULL DEFAULT 0'],
        ['extensions_online', 'INT NOT NULL DEFAULT 0'],
        ['dongles_total', 'INT NOT NULL DEFAULT 0'],
        ['dongles_free', 'INT NOT NULL DEFAULT 0'],
        ['active_calls', 'INT NOT NULL DEFAULT 0'],
        ['calls_today', 'INT NOT NULL DEFAULT 0']
    ];
    for (const [col, def] of nodeStatusColumns) {
        try {
            await conn.execute(`ALTER TABLE \`sokrat_federation_node_status\` ADD COLUMN \`${col}\` ${def}`);
        } catch (_) {}
    }
    try {
        await conn.execute("ALTER TABLE `sokrat_federation_node_status` MODIFY COLUMN `status` ENUM('online', 'degraded', 'offline', 'error', 'unreachable') NOT NULL DEFAULT 'offline'");
    } catch (_) {}

    // 2e. Per-resource sync state and audited remote actions.
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`sokrat_federation_sync_state\` (
            \`peer_id\` INT NOT NULL,
            \`resource\` VARCHAR(32) NOT NULL,
            \`status\` ENUM('idle', 'syncing', 'ok', 'error') NOT NULL DEFAULT 'idle',
            \`last_sync_at\` DATETIME DEFAULT NULL,
            \`last_success_at\` DATETIME DEFAULT NULL,
            \`cursor_value\` VARCHAR(255) DEFAULT NULL,
            \`rows_synced\` INT NOT NULL DEFAULT 0,
            \`last_error\` VARCHAR(500) DEFAULT NULL,
            PRIMARY KEY (\`peer_id\`, \`resource\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`sokrat_federation_action_log\` (
            \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
            \`peer_id\` INT NOT NULL,
            \`actor\` VARCHAR(64) DEFAULT NULL,
            \`action\` VARCHAR(64) NOT NULL,
            \`target\` VARCHAR(128) DEFAULT NULL,
            \`payload\` JSON DEFAULT NULL,
            \`status\` ENUM('pending', 'ok', 'error') NOT NULL DEFAULT 'pending',
            \`response\` TEXT DEFAULT NULL,
            \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY \`idx_peer_created\` (\`peer_id\`, \`created_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 2f. Mirrored CDR from peers, plus the union view used by reports.
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`asteriskcdrdb\`.\`sokrat_federation_remote_cdr\` (
            \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
            \`peer_id\` INT NOT NULL,
            \`uniqueid\` VARCHAR(150) NOT NULL,
            \`linkedid\` VARCHAR(150) DEFAULT NULL,
            \`global_call_id\` VARCHAR(150) DEFAULT NULL,
            \`calldate\` DATETIME NOT NULL,
            \`clid\` VARCHAR(120) DEFAULT NULL,
            \`src\` VARCHAR(80) DEFAULT NULL,
            \`dst\` VARCHAR(80) DEFAULT NULL,
            \`dcontext\` VARCHAR(80) DEFAULT NULL,
            \`channel\` VARCHAR(120) DEFAULT NULL,
            \`dstchannel\` VARCHAR(120) DEFAULT NULL,
            \`lastapp\` VARCHAR(80) DEFAULT NULL,
            \`lastdata\` VARCHAR(255) DEFAULT NULL,
            \`duration\` INT DEFAULT 0,
            \`billsec\` INT DEFAULT 0,
            \`disposition\` VARCHAR(45) DEFAULT NULL,
            \`amaflags\` INT DEFAULT NULL,
            \`accountcode\` VARCHAR(80) DEFAULT NULL,
            \`userfield\` VARCHAR(255) DEFAULT NULL,
            \`did\` VARCHAR(80) DEFAULT NULL,
            \`recordingfile\` VARCHAR(255) DEFAULT NULL,
            \`cnum\` VARCHAR(80) DEFAULT NULL,
            \`cnam\` VARCHAR(80) DEFAULT NULL,
            \`outbound_cnum\` VARCHAR(80) DEFAULT NULL,
            \`outbound_cnam\` VARCHAR(80) DEFAULT NULL,
            \`dst_cnam\` VARCHAR(80) DEFAULT NULL,
            \`peeraccount\` VARCHAR(80) DEFAULT NULL,
            \`sequence\` INT DEFAULT 0,
            \`direction\` ENUM('INBOUND','OUTBOUND','INTERNAL','UNKNOWN') DEFAULT 'UNKNOWN',
            \`call_scope\` ENUM('INTERNAL','EXTERNAL','UNKNOWN') DEFAULT 'UNKNOWN',
            \`fed_leg\` TINYINT(1) NOT NULL DEFAULT 0,
            \`synced_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY \`uq_peer_uniqueid\` (\`peer_id\`, \`uniqueid\`),
            KEY \`idx_calldate\` (\`calldate\`),
            KEY \`idx_src\` (\`src\`),
            KEY \`idx_dst\` (\`dst\`),
            KEY \`idx_gclid\` (\`global_call_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const remoteCdrColumns = [
        ['cnum', 'VARCHAR(80) DEFAULT NULL'],
        ['cnam', 'VARCHAR(80) DEFAULT NULL'],
        ['outbound_cnum', 'VARCHAR(80) DEFAULT NULL'],
        ['outbound_cnam', 'VARCHAR(80) DEFAULT NULL'],
        ['dst_cnam', 'VARCHAR(80) DEFAULT NULL'],
        ['peeraccount', 'VARCHAR(80) DEFAULT NULL'],
        ['sequence', 'INT DEFAULT 0']
    ];
    for (const [col, def] of remoteCdrColumns) {
        try {
            await conn.execute(`ALTER TABLE \`asteriskcdrdb\`.\`sokrat_federation_remote_cdr\` ADD COLUMN \`${col}\` ${def}`);
        } catch (_) {}
    }

    try {
        await conn.execute(`
            CREATE OR REPLACE VIEW \`asteriskcdrdb\`.\`sokrat_cdr_all\` AS
            SELECT c.\`calldate\`, c.\`clid\`, c.\`src\`, c.\`dst\`, c.\`dcontext\`, c.\`channel\`,
                   c.\`dstchannel\`, c.\`lastapp\`, c.\`lastdata\`, c.\`duration\`, c.\`billsec\`,
                   c.\`disposition\`, c.\`amaflags\`, c.\`accountcode\`, c.\`uniqueid\`, c.\`userfield\`,
                   c.\`did\`, c.\`recordingfile\`, c.\`cnum\`, c.\`cnam\`, c.\`outbound_cnum\`,
                   c.\`outbound_cnam\`, c.\`dst_cnam\`, c.\`linkedid\`, c.\`peeraccount\`, c.\`sequence\`,
                   s.\`local_site_code\` AS \`node_site_code\`, s.\`local_node_name\` AS \`node_name\`,
                   1 AS \`is_local\`
            FROM \`asteriskcdrdb\`.\`cdr\` c
            JOIN \`asterisk\`.\`sokrat_federation_settings\` s ON s.\`id\` = 1
            UNION ALL
            SELECT r.\`calldate\`, r.\`clid\`, r.\`src\`, r.\`dst\`, r.\`dcontext\`, r.\`channel\`,
                   r.\`dstchannel\`, r.\`lastapp\`, r.\`lastdata\`, r.\`duration\`, r.\`billsec\`,
                   r.\`disposition\`, r.\`amaflags\`, r.\`accountcode\`, r.\`uniqueid\`, r.\`userfield\`,
                   r.\`did\`, r.\`recordingfile\`, r.\`cnum\`, r.\`cnam\`, r.\`outbound_cnum\`,
                   r.\`outbound_cnam\`, r.\`dst_cnam\`, r.\`linkedid\`, r.\`peeraccount\`, r.\`sequence\`,
                   p.\`site_code\` AS \`node_site_code\`, p.\`node_name\` AS \`node_name\`,
                   0 AS \`is_local\`
            FROM \`asteriskcdrdb\`.\`sokrat_federation_remote_cdr\` r
            JOIN \`asterisk\`.\`sokrat_federation_peers\` p ON p.\`id\` = r.\`peer_id\`
        `);
    } catch (viewErr) {
        console.error('[Federation] CDR union view init failed:', viewErr.message);
    }

    // 2d. Legacy peers stored the softphone vhost (https://host:8443), which
    // does not serve /api/federation/v1. Normalize to the real API origin.
    try {
        const [legacyPeers] = await conn.query(
            'SELECT id, api_base_url FROM `sokrat_federation_peers` WHERE api_base_url LIKE ?',
            ['%:8443%']
        );
        for (const row of (legacyPeers || [])) {
            const fixed = normalizeFederationBaseUrl(row.api_base_url);
            if (fixed && fixed !== row.api_base_url) {
                await conn.execute(
                    'UPDATE `sokrat_federation_peers` SET api_base_url = ? WHERE id = ?',
                    [fixed, row.id]
                );
            }
        }
    } catch (_) {}

    // 3. Remote extensions synced from peers
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`sokrat_federation_remote_extensions\` (
            \`id\` INT AUTO_INCREMENT PRIMARY KEY,
            \`peer_id\` INT NOT NULL,
            \`native_extension\` VARCHAR(20) NOT NULL,
            \`dial_alias\` VARCHAR(30) NOT NULL UNIQUE,
            \`display_name\` VARCHAR(100) NOT NULL,
            \`status\` ENUM('online', 'offline', 'ringing', 'in_call', 'unknown') NOT NULL DEFAULT 'unknown',
            \`last_seen_at\` DATETIME DEFAULT NULL,
            UNIQUE KEY \`idx_peer_ext\` (\`peer_id\`, \`native_extension\`),
            KEY \`idx_peer_id\` (\`peer_id\`),
            KEY \`idx_dial_alias\` (\`dial_alias\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 4. Remote dongles synced from peers
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`sokrat_federation_remote_dongles\` (
            \`id\` INT AUTO_INCREMENT PRIMARY KEY,
            \`peer_id\` INT NOT NULL,
            \`dongle_name\` VARCHAR(50) NOT NULL,
            \`phone_number\` VARCHAR(50) DEFAULT NULL,
            \`provider\` VARCHAR(50) DEFAULT NULL,
            \`status\` VARCHAR(50) DEFAULT 'Unknown',
            \`state\` VARCHAR(32) DEFAULT NULL,
            \`signal_pct\` TINYINT DEFAULT NULL,
            \`operator_name\` VARCHAR(64) DEFAULT NULL,
            \`imsi\` VARCHAR(32) DEFAULT NULL,
            \`imei\` VARCHAR(32) DEFAULT NULL,
            \`sim_number\` VARCHAR(32) DEFAULT NULL,
            \`active_call\` VARCHAR(128) DEFAULT NULL,
            \`last_seen_at\` DATETIME DEFAULT NULL,
            \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY \`idx_peer_dongle\` (\`peer_id\`, \`dongle_name\`),
            KEY \`idx_peer_id\` (\`peer_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const remoteDongleColumns = [
        ['state', 'VARCHAR(32) DEFAULT NULL'],
        ['signal_pct', 'TINYINT DEFAULT NULL'],
        ['operator_name', 'VARCHAR(64) DEFAULT NULL'],
        ['imsi', 'VARCHAR(32) DEFAULT NULL'],
        ['imei', 'VARCHAR(32) DEFAULT NULL'],
        ['sim_number', 'VARCHAR(32) DEFAULT NULL'],
        ['active_call', 'VARCHAR(128) DEFAULT NULL'],
        ['last_seen_at', 'DATETIME DEFAULT NULL'],
        ['updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP']
    ];
    for (const [col, def] of remoteDongleColumns) {
        try {
            await conn.execute(`ALTER TABLE \`sokrat_federation_remote_dongles\` ADD COLUMN \`${col}\` ${def}`);
        } catch (_) {}
    }

    // 5. Cached address book from every peer
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`sokrat_federation_remote_contacts\` (
            \`id\` INT AUTO_INCREMENT PRIMARY KEY,
            \`peer_id\` INT NOT NULL,
            \`source_id\` VARCHAR(64) NOT NULL,
            \`name\` VARCHAR(150) DEFAULT NULL,
            \`last_name\` VARCHAR(150) DEFAULT NULL,
            \`telefono\` VARCHAR(50) NOT NULL,
            \`synced_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY \`idx_peer_source\` (\`peer_id\`, \`source_id\`),
            KEY \`idx_peer_id\` (\`peer_id\`),
            KEY \`idx_phone\` (\`telefono\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 6. Ensure dashboard_user_extensions supports peer_id
    try {
        await conn.execute('ALTER TABLE `dashboard_user_extensions` ADD COLUMN `peer_id` INT DEFAULT NULL');
    } catch (_) {}
    try {
        await conn.execute('ALTER TABLE `dashboard_user_extensions` ADD KEY `idx_peer_id` (`peer_id`)');
    } catch (_) {}
}

/**
 * Generate Asterisk IAX2 peer and user configuration content.
 */
function generateIaxConfig(peers, localSettings, decryptFn) {
    const lines = [
        '; ====================================================================',
        '; Sokrat IAX2 Multi-Server PBX Federation Configuration',
        '; Auto-generated by Sokrat VoIP - Do not edit manually',
        '; ====================================================================',
        ''
    ];

    const localSiteCode = (localSettings && localSettings.local_site_code) || '10';

    for (const peer of (peers || [])) {
        if (!peer.site_code) continue;
        const siteCode = String(peer.site_code).trim();
        const host = String(peer.host || '').trim();
        const port = Number(peer.iax_port) || 4569;
        const inboundUser = peer.iax_user_inbound || `fed_in_site${siteCode}`;
        const outboundPeer = peer.iax_peer_outbound || `fed_out_site${siteCode}`;
        const remoteExpectedInbound = `fed_in_site${localSiteCode}`;

        let secret = '';
        if (typeof decryptFn === 'function' && peer.iax_secret_enc) {
            secret = decryptFn(peer.iax_secret_enc) || '';
        } else if (peer.iax_secret) {
            secret = peer.iax_secret;
        }

        // 1. Inbound User (Incoming calls from remote peer)
        lines.push(`; --- Inbound User from Peer: ${peer.node_name || siteCode} (Site ${siteCode}) ---`);
        lines.push(`[${inboundUser}]`);
        lines.push(`type=user`);
        lines.push(`auth=md5`);
        if (secret) {
            lines.push(`secret=${secret}`);
        }
        lines.push(`context=from-federation-site${siteCode}`);
        if (host && host !== 'dynamic') {
            lines.push(`deny=0.0.0.0/0.0.0.0`);
            lines.push(`permit=${host}/255.255.255.255`);
        }
        lines.push(`requirecalltoken=yes`);
        lines.push(`encryption=aes128`);
        lines.push(`forceencryption=yes`);
        lines.push(`disallow=all`);
        lines.push(`allow=alaw`);
        lines.push(`allow=ulaw`);
        lines.push(``);

        // 2. Outbound Peer (Outgoing calls to remote peer)
        lines.push(`; --- Outbound Peer to: ${peer.node_name || siteCode} (Site ${siteCode}) ---`);
        lines.push(`[${outboundPeer}]`);
        lines.push(`type=peer`);
        lines.push(`host=${host}`);
        lines.push(`port=${port}`);
        lines.push(`username=${remoteExpectedInbound}`);
        lines.push(`auth=md5`);
        if (secret) {
            lines.push(`secret=${secret}`);
        }
        lines.push(`qualify=yes`);
        lines.push(`qualifyfreqok=10000`);
        lines.push(`qualifyfreqnotok=2000`);
        lines.push(`encryption=aes128`);
        lines.push(`forceencryption=yes`);
        lines.push(`disallow=all`);
        lines.push(`allow=alaw`);
        lines.push(`allow=ulaw`);
        lines.push(`trunk=no`);
        lines.push(``);
    }

    return lines.join('\n') + '\n';
}

/**
 * Generate Asterisk dialplan configuration for multi-server federation.
 */
function generateDialplanConfig(peers, localSettings, remoteExtensions) {
    const lines = [
        '; ====================================================================',
        '; Sokrat IAX2 Multi-Server Federation Dialplan Contexts',
        '; Auto-generated by Sokrat VoIP - Do not edit manually',
        '; ====================================================================',
        '',
        '[sokrat-federation-out]',
        '; Multi-server federation outbound dispatch (isolated to configured peer site prefixes)'
    ];

    const activePeers = (peers || []).filter(p => p && p.site_code);

    if (activePeers.length === 0) {
        lines.push('; No active federation peers configured');
    }

    // Dynamic isolated routing per site code
    for (const peer of activePeers) {
        const siteCode = String(peer.site_code).trim();
        const codeLen = siteCode.length;
        const prefixLen = codeLen + 1; // '9' + siteCode
        const patternSuffix = codeLen <= 2 ? 'XX.' : 'X.';

        if (Number(peer.allow_internal_dialing) !== 0) {
            lines.push(`; Route to Site ${siteCode} internal extensions (${siteCode}XXX -> peer_${siteCode})`);
            lines.push(`exten => _${siteCode}${patternSuffix},1,NoOp(=== Sokrat Federation Dispatch to Site ${siteCode}: \${EXTEN} ===)`);
            lines.push(`same => n,Set(FED_HOPS=\${IF($["\${IAXVAR(FED_HOPS)}" = ""]?0:\${IAXVAR(FED_HOPS)})})`);
            lines.push(`same => n,GotoIf($[\${FED_HOPS} >= 2]?loop_detected)`);
            lines.push(`same => n,Set(IAXVAR(FED_HOPS)=$[\${FED_HOPS} + 1])`);
            lines.push(`same => n,Set(IAXVAR(FED_CALLER)=\${IF($["\${IAXVAR(FED_CALLER)}" = ""]?\${CALLERID(num)}:\${IAXVAR(FED_CALLER)})})`);
            lines.push(`same => n,Goto(peer_${siteCode},\${EXTEN:${codeLen}},1)`);
            lines.push(`same => n(loop_detected),Verbose(1, [FEDERATION-LOOP-ABORT] Max hops exceeded for \${EXTEN} from \${CALLERID(num)})`);
            lines.push(`same => n,Playtones(congestion)`);
            lines.push(`same => n,Congestion(10)`);
            lines.push(`same => n,Hangup()`);
            lines.push(``);
        }

        if (Number(peer.allow_outbound_egress) !== 0) {
            lines.push(`; Route to Site ${siteCode} remote egress PSTN/Dongle (9${siteCode}XXX -> peer_${siteCode} egress)`);
            lines.push(`exten => _9${siteCode}.,1,NoOp(=== Sokrat Federation Remote Egress via Site ${siteCode}: \${EXTEN} ===)`);
            lines.push(`same => n,Set(FED_HOPS=\${IF($["\${IAXVAR(FED_HOPS)}" = ""]?0:\${IAXVAR(FED_HOPS)})})`);
            lines.push(`same => n,GotoIf($[\${FED_HOPS} >= 2]?loop_detected)`);
            lines.push(`same => n,Set(IAXVAR(FED_HOPS)=$[\${FED_HOPS} + 1])`);
            lines.push(`same => n,Set(IAXVAR(FED_CALLER)=\${IF($["\${IAXVAR(FED_CALLER)}" = ""]?\${CALLERID(num)}:\${IAXVAR(FED_CALLER)})})`);
            lines.push(`same => n,Goto(peer_${siteCode},OUT_\${EXTEN:${prefixLen}},1)`);
            lines.push(`same => n(loop_detected),Verbose(1, [FEDERATION-LOOP-ABORT] Max hops exceeded for \${EXTEN} from \${CALLERID(num)})`);
            lines.push(`same => n,Playtones(congestion)`);
            lines.push(`same => n,Congestion(10)`);
            lines.push(`same => n,Hangup()`);
            lines.push(``);
        }
    }

    // Per-Peer Outbound Routing Contexts & Inbound Handling Contexts
    for (const peer of activePeers) {
        const siteCode = String(peer.site_code).trim();
        const outboundPeer = peer.iax_peer_outbound || `fed_out_site${siteCode}`;

        // 1. Outbound context [peer_<siteCode>]
        lines.push(`[peer_${siteCode}]`);
        lines.push(`; Direct extension dialing (e.g. 101 -> IAX2/${outboundPeer}/101)`);
        lines.push(`exten => _X.,1,NoOp(--- Routing to Peer Site ${siteCode} Native Exten: \${EXTEN} ---)`);
        lines.push(`same => n,Gosub(sub-record-check,s,1(out,\${EXTEN},dontcare))`);
        lines.push(`same => n,Dial(IAX2/${outboundPeer}/\${EXTEN},45,Ttr)`);
        lines.push(`same => n,Hangup()`);
        lines.push(``);
        lines.push(`; Remote Egress PSTN/Dongle Dialing (e.g. OUT_01011111111 -> routes via Site ${siteCode} Outbound Routes)`);
        lines.push(`exten => _OUT_X.,1,NoOp(--- Remote Egress via Peer Site ${siteCode}: \${EXTEN:4} ---)`);
        lines.push(`same => n,Gosub(sub-record-check,s,1(out,\${EXTEN:4},dontcare))`);
        lines.push(`same => n,Set(IAXVAR(FED_EGRESS)=1)`);
        lines.push(`same => n,Dial(IAX2/${outboundPeer}/\${EXTEN},60,Ttr)`);
        lines.push(`same => n,Hangup()`);
        lines.push(``);

        // 2. Inbound handling context [from-federation-site<siteCode>]
        lines.push(`[from-federation-site${siteCode}]`);
        lines.push(`; Check if call is for remote egress (calls outbound-allroutes on this PBX)`);
        lines.push(`exten => _OUT_X.,1,NoOp(--- Inbound Federation Egress Request from Site ${siteCode}: \${EXTEN:4} ---)`);
        lines.push(`same => n,GotoIf($["\${DB(FEDERATION/PEER_${siteCode}_EGRESS_ALLOWED)}" != "1"]?reject_egress)`);
        lines.push(`same => n,Goto(outbound-allroutes,\${EXTEN:4},1)`);
        lines.push(`same => n(reject_egress),Verbose(1, [FED-EGRESS-DENIED] Peer ${siteCode} is not permitted to use local outbound routes)`);
        lines.push(`same => n,Congestion(5)`);
        lines.push(`same => n,Hangup()`);
        lines.push(``);
        lines.push(`; Standard Inbound Extension Dialing: dispatch into from-internal-additional (bypasses outbound federation loop)`);
        lines.push(`exten => _X.,1,NoOp(--- Inbound Federation Call from Site ${siteCode} to Local Exten: \${EXTEN} ---)`);
        lines.push(`same => n,Goto(from-internal-additional,\${EXTEN},1)`);
        lines.push(``);
    }

    return lines.join('\n') + '\n';
}

/**
 * Ensure the custom Asterisk config files include Sokrat federation configs.
 */
function ensureAsteriskIncludes() {
    const extCustomPath = path.join(ASTERISK_CONF_DIR, 'extensions_custom.conf');
    const iaxCustomPath = path.join(ASTERISK_CONF_DIR, 'iax_custom.conf');

    try {
        if (fs.existsSync(extCustomPath)) {
            let content = fs.readFileSync(extCustomPath, 'utf8');
            let modified = false;

            if (!content.includes('#include sokrat_federation.conf')) {
                content += '\n; Sokrat IAX2 Federation Custom Dialplan Contexts\n#include sokrat_federation.conf\n';
                modified = true;
            }

            // Ensure include => sokrat-federation-out is inside [from-internal-custom]
            if (content.includes('[from-internal-custom]') && !content.includes('include => sokrat-federation-out')) {
                content = content.replace(
                    '[from-internal-custom]',
                    '[from-internal-custom]\n; === Sokrat IAX2 VoIP Multi-Server Federation Outbound Hook ===\ninclude => sokrat-federation-out\n'
                );
                modified = true;
            }

            if (modified) {
                fs.writeFileSync(extCustomPath, content, 'utf8');
            }
        }
    } catch (err) {
        console.error('Error updating extensions_custom.conf for federation:', err.message);
    }

    try {
        if (fs.existsSync(iaxCustomPath)) {
            let content = fs.readFileSync(iaxCustomPath, 'utf8');
            if (!content.includes('#include sokrat_federation_iax.conf')) {
                content += '\n; Sokrat IAX2 Federation Inbound/Outbound Peer Definitions\n#include sokrat_federation_iax.conf\n';
                fs.writeFileSync(iaxCustomPath, content, 'utf8');
            }
        }
    } catch (err) {
        console.error('Error updating iax_custom.conf for federation:', err.message);
    }
}

/**
 * Synchronize database peers into Asterisk IAX and dialplan config files and reload Asterisk.
 */
async function syncFederationAsteriskConfig(pool, decryptFn, execFileFn = execFile) {
    if (!pool) return { success: false, error: 'Database pool not provided' };

    try {
        const [settingsRows] = await pool.query('SELECT * FROM `asterisk`.`sokrat_federation_settings` WHERE id = 1');
        const localSettings = (settingsRows && settingsRows[0]) || { local_site_code: '10', local_node_name: 'Main PBX', panel_role: 'local' };

        const [peers] = await pool.query('SELECT * FROM `asterisk`.`sokrat_federation_peers` ORDER BY site_code ASC');
        const [remoteExts] = await pool.query('SELECT * FROM `asterisk`.`sokrat_federation_remote_extensions` ORDER BY dial_alias ASC');

        const iaxConfContent = generateIaxConfig(peers, localSettings, decryptFn);
        const dialplanConfContent = generateDialplanConfig(peers, localSettings, remoteExts);

        const iaxConfPath = path.join(ASTERISK_CONF_DIR, 'sokrat_federation_iax.conf');
        const dialplanConfPath = path.join(ASTERISK_CONF_DIR, 'sokrat_federation.conf');

        fs.writeFileSync(iaxConfPath, iaxConfContent, 'utf8');
        fs.writeFileSync(dialplanConfPath, dialplanConfContent, 'utf8');

        try {
            fs.chmodSync(iaxConfPath, 0o644);
            fs.chmodSync(dialplanConfPath, 0o644);
        } catch (_) {}

        ensureAsteriskIncludes();

        // Update AstDB egress permissions
        for (const peer of (peers || [])) {
            if (!peer.site_code) continue;
            const siteCode = String(peer.site_code).trim();
            const allowed = Number(peer.allow_outbound_egress) !== 0 ? '1' : '0';
            execFileFn(ASTERISK_BIN, ['-rx', `database put FEDERATION PEER_${siteCode}_EGRESS_ALLOWED ${allowed}`], () => {});
        }
        // Maintain custom federation trunks in asterisk.trunks so they can be selected in Outbound Routes
        try {
            const activeSiteCodes = new Set();
            for (const peer of (peers || [])) {
                if (!peer.site_code) continue;
                const siteCode = String(peer.site_code).trim();
                activeSiteCodes.add(siteCode);
                const trunkName = `[Fed] ${peer.node_name || 'Site ' + siteCode} (#${siteCode})`;
                const channelId = `Local/9${siteCode}$OUTNUM$@sokrat-federation-out`;

                const [existingTrunk] = await pool.query(
                    "SELECT trunkid FROM `asterisk`.`trunks` WHERE channelid LIKE ?",
                    [`Local/9${siteCode}%`]
                );

                if (existingTrunk && existingTrunk.length > 0) {
                    await pool.query(
                        "UPDATE `asterisk`.`trunks` SET name = ?, tech = 'custom', disabled = 'off' WHERE trunkid = ?",
                        [trunkName, existingTrunk[0].trunkid]
                    );
                } else {
                    const [maxRows] = await pool.query(
                        'SELECT COALESCE(MAX(trunkid), 0) + 1 AS nextId FROM `asterisk`.`trunks`'
                    );
                    const nextTrunkId = Number(maxRows[0]?.nextId || 1);
                    await pool.query(
                        "INSERT INTO `asterisk`.`trunks` (trunkid, name, tech, outcid, keepcid, maxchans, failscript, dialoutprefix, channelid, usercontext, provider, disabled, `continue`) VALUES (?, ?, 'custom', '', 'off', '', '', '', ?, '', NULL, 'off', 'off')",
                        [nextTrunkId, trunkName, channelId]
                    );
                }
            }

            // Clean up removed federation trunks
            const [allFedTrunks] = await pool.query(
                "SELECT trunkid, channelid FROM `asterisk`.`trunks` WHERE channelid LIKE 'Local/9%@sokrat-federation-out'"
            );
            for (const ft of (allFedTrunks || [])) {
                const match = String(ft.channelid).match(/Local\/9([0-9]+)\$OUTNUM\$/);
                if (match && !activeSiteCodes.has(match[1])) {
                    await pool.query("DELETE FROM `asterisk`.`trunks` WHERE trunkid = ?", [ft.trunkid]);
                    await pool.query("DELETE FROM `asterisk`.`outbound_route_trunks` WHERE trunk_id = ?", [ft.trunkid]);
                }
            }
        } catch (trunkErr) {
            console.error('Error syncing federation custom trunks:', trunkErr.message);
        }
        // Trigger Asterisk IAX2 & Dialplan reload
        await new Promise((resolve) => {
            execFileFn(ASTERISK_BIN, ['-rx', 'iax2 reload && dialplan reload'], (err, stdout, stderr) => {
                if (err) {
                    console.error('Asterisk federation reload notice:', err.message);
                }
                resolve();
            });
        });

        return { success: true, peersCount: peers.length };
    } catch (err) {
        console.error('syncFederationAsteriskConfig error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Format remote dial alias for FreePBX dial string (e.g. Ring Groups, Queues, Follow-Me).
 */
function formatRemoteDestination(dialAlias) {
    if (!dialAlias) return '';
    const clean = String(dialAlias).trim();
    return clean.endsWith('#') ? clean : `${clean}#`;
}

module.exports = {
    initFederationDb,
    generateIaxConfig,
    generateDialplanConfig,
    ensureAsteriskIncludes,
    syncFederationAsteriskConfig,
    formatRemoteDestination
};
