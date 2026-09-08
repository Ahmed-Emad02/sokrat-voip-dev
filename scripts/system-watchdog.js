#!/usr/bin/env node
/**
 * Sokrat VoIP - Standalone System Watchdog & Alert Daemon
 * Monitors core PBX services, host resources, sends Telegram & Email alerts,
 * and maintains outbound heartbeats to Healthchecks.io.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');
const crypto = require('crypto');
const axios = require('axios');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');

require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });

// Encryption setup matching server.js
const rawEncryptionKey = process.env.ENCRYPTION_KEY || 'sokrat-voip-default-encryption-key-fallback';
const encKey = crypto.createHash('sha256').update(String(rawEncryptionKey)).digest();

function decrypt(text) {
    if (!text) return null;
    try {
        const parts = text.split(':');
        if (parts.length < 2) return text; // Unencrypted plain text fallback
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (_) {
        return text;
    }
}

// Database Connection Config
const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'asteriskuser',
    password: process.env.DB_PASS || 'admin',
    database: process.env.DB_NAME || 'asterisk',
    waitForConnections: true,
    connectionLimit: 3
};

// Default Alert Settings
const DEFAULT_CONFIG = {
    telegramEnabled: true,
    telegramBotToken: '8742498784:AAF49-2KCi7kT24ZnGpdKuxO4CweqyqHELc',
    telegramChatId: '8996079391',
    emailEnabled: false,
    emailRecipients: '',
    healthchecksUrl: 'https://hc-ping.com/b8b5b103-e272-4666-bb37-561780de64f3',
    autoRestart: true,
    checkIntervalSec: 30,
    monitoredServices: ['asterisk', 'database', 'sokrat-voip', 'httpd'],
    smtpEmail: '',
    smtpPassword: '',
    clientName: ''
};

// In-Memory State for Debouncing & Transitions
// Structure: { [serviceId]: { state: 'active' | 'failed', lastAlertTime: number, failCount: number } }
const serviceStates = {};
const REPEAT_ALERT_THROTTLE_MS = 30 * 60 * 1000; // 30 minutes throttle for repeated alerts

function getHostInfo() {
    const hostname = os.hostname() || 'pbx-node';
    let ip = '127.0.0.1';
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (!iface.internal && iface.family === 'IPv4') {
                    ip = iface.address;
                    break;
                }
            }
            if (ip !== '127.0.0.1') break;
        }
    } catch (_) {}
    return { hostname, ip };
}

async function loadConfigFromDb() {
    const cfg = { ...DEFAULT_CONFIG };
    let pool = null;
    try {
        pool = mysql.createPool(DB_CONFIG);
        const [rows] = await pool.query(
            "SELECT setting_key, setting_value FROM dashboard_settings WHERE setting_key LIKE 'alert_%' OR setting_key IN ('smtp_email', 'smtp_password', 'client_name')"
        );
        for (const r of rows) {
            if (r.setting_key === 'alert_telegram_enabled') cfg.telegramEnabled = r.setting_value === 'true';
            if (r.setting_key === 'alert_telegram_bot_token' && r.setting_value) cfg.telegramBotToken = r.setting_value.trim();
            if (r.setting_key === 'alert_telegram_chat_id' && r.setting_value) cfg.telegramChatId = r.setting_value.trim();
            if (r.setting_key === 'alert_email_enabled') cfg.emailEnabled = r.setting_value === 'true';
            if (r.setting_key === 'alert_email_recipients' && r.setting_value) cfg.emailRecipients = r.setting_value.trim();
            if (r.setting_key === 'alert_healthchecks_url' && r.setting_value) cfg.healthchecksUrl = r.setting_value.trim();
            if (r.setting_key === 'alert_auto_restart') cfg.autoRestart = r.setting_value !== 'false';
            if (r.setting_key === 'alert_check_interval_sec') {
                const parsed = parseInt(r.setting_value, 10);
                if (!isNaN(parsed) && parsed >= 10 && parsed <= 300) cfg.checkIntervalSec = parsed;
            }
            if (r.setting_key === 'alert_monitored_services' && r.setting_value) {
                try {
                    const parsedServices = JSON.parse(r.setting_value);
                    if (Array.isArray(parsedServices)) cfg.monitoredServices = parsedServices;
                } catch (_) {}
            }
            if (r.setting_key === 'smtp_email' && r.setting_value) cfg.smtpEmail = r.setting_value.trim();
            if (r.setting_key === 'smtp_password' && r.setting_value) cfg.smtpPassword = decrypt(r.setting_value.trim());
            if (r.setting_key === 'client_name' && r.setting_value) cfg.clientName = r.setting_value.trim();
        }
    } catch (err) {
        // Use defaults if DB is temporarily down
    } finally {
        if (pool) {
            try { await pool.end(); } catch (_) {}
        }
    }
    return cfg;
}

function getServiceSystemdStatus(unitName, fallbackUnit = null) {
    let activeUnit = unitName;
    let state = 'unknown';
    let subState = 'unknown';
    let pid = 0;

    try {
        let out = execSync(`systemctl show ${unitName} --property=ActiveState,SubState,MainPID 2>/dev/null`, {
            encoding: 'utf8',
            timeout: 3000
        });
        const props = {};
        for (const line of out.trim().split('\n')) {
            const [k, ...v] = line.split('=');
            if (k) props[k.trim()] = v.join('=').trim();
        }
        state = props.ActiveState || 'unknown';
        subState = props.SubState || 'unknown';
        pid = parseInt(props.MainPID, 10) || 0;

        if (state === 'inactive' && fallbackUnit) {
            const fbOut = execSync(`systemctl show ${fallbackUnit} --property=ActiveState,SubState,MainPID 2>/dev/null`, {
                encoding: 'utf8',
                timeout: 3000
            });
            const fbProps = {};
            for (const line of fbOut.trim().split('\n')) {
                const [k, ...v] = line.split('=');
                if (k) fbProps[k.trim()] = v.join('=').trim();
            }
            if (fbProps.ActiveState === 'active') {
                activeUnit = fallbackUnit;
                state = fbProps.ActiveState;
                subState = fbProps.SubState || 'unknown';
                pid = parseInt(fbProps.MainPID, 10) || 0;
            }
        }
    } catch (_) {}

    return { activeUnit, state, subState, pid };
}

function getServiceRecentLogs(unitName, lines = 10) {
    try {
        const out = execSync(`journalctl -u ${unitName} -n ${lines} --no-pager 2>/dev/null`, {
            encoding: 'utf8',
            timeout: 4000
        });
        return out.trim();
    } catch (_) {
        return 'No logs available via journalctl.';
    }
}

async function checkServiceHealth(serviceId) {
    if (serviceId === 'asterisk') {
        const s = getServiceSystemdStatus('asterisk.service');
        if (s.state !== 'active') {
            return {
                id: 'asterisk',
                name: 'Asterisk PBX Core',
                unit: 'asterisk.service',
                healthy: false,
                state: s.state,
                error: `Asterisk systemd unit is ${s.state} (${s.subState})`,
                logs: getServiceRecentLogs('asterisk.service')
            };
        }
        // Verify CLI responsiveness to catch silent deadlocks
        try {
            execSync('asterisk -rx "core show version" 2>/dev/null', { encoding: 'utf8', timeout: 4000 });
        } catch (e) {
            return {
                id: 'asterisk',
                name: 'Asterisk PBX Core',
                unit: 'asterisk.service',
                healthy: false,
                state: 'frozen',
                error: 'Asterisk process is active but unresponsive to CLI ping (potential deadlock)',
                logs: getServiceRecentLogs('asterisk.service')
            };
        }
        return { id: 'asterisk', name: 'Asterisk PBX Core', unit: 'asterisk.service', healthy: true, state: 'active' };
    }

    if (serviceId === 'database') {
        const s = getServiceSystemdStatus('mariadb.service', 'mysqld.service');
        if (s.state !== 'active') {
            return {
                id: 'database',
                name: 'MariaDB / MySQL',
                unit: s.activeUnit,
                healthy: false,
                state: s.state,
                error: `Database unit ${s.activeUnit} is ${s.state} (${s.subState})`,
                logs: getServiceRecentLogs(s.activeUnit)
            };
        }
        // Test query responsiveness
        try {
            const conn = await mysql.createConnection({
                host: DB_CONFIG.host,
                user: DB_CONFIG.user,
                password: DB_CONFIG.password,
                database: DB_CONFIG.database,
                connectTimeout: 4000
            });
            await conn.query('SELECT 1');
            await conn.end();
        } catch (dbErr) {
            return {
                id: 'database',
                name: 'MariaDB / MySQL',
                unit: s.activeUnit,
                healthy: false,
                state: 'unresponsive',
                error: `Database is active but rejecting SQL connections: ${dbErr.message}`,
                logs: getServiceRecentLogs(s.activeUnit)
            };
        }
        return { id: 'database', name: 'MariaDB / MySQL', unit: s.activeUnit, healthy: true, state: 'active' };
    }

    if (serviceId === 'sokrat-voip') {
        const s = getServiceSystemdStatus('sokrat-voip.service');
        if (s.state !== 'active') {
            return {
                id: 'sokrat-voip',
                name: 'Sokrat VoIP Dashboard',
                unit: 'sokrat-voip.service',
                healthy: false,
                state: s.state,
                error: `Sokrat VoIP service is ${s.state} (${s.subState})`,
                logs: getServiceRecentLogs('sokrat-voip.service')
            };
        }
        return { id: 'sokrat-voip', name: 'Sokrat VoIP Dashboard', unit: 'sokrat-voip.service', healthy: true, state: 'active' };
    }

    if (serviceId === 'httpd') {
        const s = getServiceSystemdStatus('httpd.service', 'nginx.service');
        if (s.state !== 'active') {
            return {
                id: 'httpd',
                name: 'HTTP Web Server',
                unit: s.activeUnit,
                healthy: false,
                state: s.state,
                error: `HTTP server ${s.activeUnit} is ${s.state} (${s.subState})`,
                logs: getServiceRecentLogs(s.activeUnit)
            };
        }
        return { id: 'httpd', name: 'HTTP Web Server', unit: s.activeUnit, healthy: true, state: 'active' };
    }

    if (serviceId === 'stt-worker') {
        const s = getServiceSystemdStatus('stt-worker.service');
        if (s.state !== 'active') {
            return {
                id: 'stt-worker',
                name: 'STT AI Worker',
                unit: 'stt-worker.service',
                healthy: false,
                state: s.state,
                error: `STT AI Worker is ${s.state} (${s.subState})`,
                logs: getServiceRecentLogs('stt-worker.service')
            };
        }
        return { id: 'stt-worker', name: 'STT AI Worker', unit: 'stt-worker.service', healthy: true, state: 'active' };
    }

    return { id: serviceId, name: serviceId, unit: `${serviceId}.service`, healthy: true, state: 'active' };
}

function checkHostResources(options = {}) {
    const issues = [];
    // 1. Root disk check
    try {
        const dfOut = execSync("df -Pk / | awk 'NR==2 {print $5}' 2>/dev/null", { encoding: 'utf8', timeout: 3000 }).trim();
        const diskPct = parseInt(dfOut.replace('%', ''), 10);
        const diskThreshold = options.diskThreshold != null ? options.diskThreshold : 90;
        if (!isNaN(diskPct) && diskPct >= diskThreshold) {
            issues.push({
                type: 'disk',
                name: 'Disk Space Exhaustion',
                error: `Root filesystem (/) is at ${diskPct}% capacity (threshold: ${diskThreshold}%)`
            });
        }
    } catch (_) {}

    // 2. CPU load check
    try {
        const cpus = os.cpus().length || 1;
        const load1 = os.loadavg()[0] || 0;
        const cpuPct = parseFloat(((load1 / cpus) * 100).toFixed(1));
        const cpuThreshold = options.cpuThreshold != null ? options.cpuThreshold : 90;
        if (cpuPct >= cpuThreshold) {
            issues.push({
                type: 'cpu',
                name: 'High CPU Utilization',
                error: `Host CPU load is critically high at ${cpuPct}% (${load1.toFixed(2)} on ${cpus} cores; threshold: ${cpuThreshold}%)`
            });
        }
    } catch (_) {}

    // 3. RAM check
    try {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
        let totalKb = 0;
        let availKb = 0;
        for (const line of meminfo.split('\n')) {
            if (line.startsWith('MemTotal:')) totalKb = parseInt(line.replace(/\D/g, ''), 10);
            if (line.startsWith('MemAvailable:')) availKb = parseInt(line.replace(/\D/g, ''), 10);
        }
        if (totalKb > 0 && availKb >= 0) {
            const freePct = parseFloat(((availKb / totalKb) * 100).toFixed(1));
            const ramThreshold = options.ramThreshold != null ? options.ramThreshold : 5.0;
            if (freePct <= ramThreshold) {
                issues.push({
                    type: 'ram',
                    name: 'RAM Depletion Warning',
                    error: `Available host RAM is critically low at ${freePct}% (${(availKb / 1024).toFixed(0)}MB free of ${(totalKb / 1024).toFixed(0)}MB; threshold: ${ramThreshold}%)`
                });
            }
        }
    } catch (_) {}

    // 4. PBX Extension Collision Check
    try {
        const q = `
            SELECT u.extension, u.name as entity1, q.descr as entity2, 'Extension vs Queue' as conflict_type 
            FROM users u 
            INNER JOIN queues_config q ON u.extension = q.extension
            UNION
            SELECT u.extension, u.name as entity1, r.description as entity2, 'Extension vs Ring Group' as conflict_type
            FROM users u 
            INNER JOIN ringgroups r ON u.extension = r.grpnum
            UNION
            SELECT q.extension, q.descr as entity1, r.description as entity2, 'Queue vs Ring Group' as conflict_type
            FROM queues_config q
            INNER JOIN ringgroups r ON q.extension = r.grpnum;
        `;
        const out = execSync(`mysql -u ${DB_CONFIG.user} -p${DB_CONFIG.password} ${DB_CONFIG.database} -e "${q.replace(/\n/g, ' ')}" 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
        const lines = out.split('\n');
        if (lines.length > 1) {
            const conflictRows = lines.slice(1);
            for (const cRow of conflictRows) {
                const parts = cRow.split('\t');
                if (parts.length >= 4) {
                    const [ext, e1, e2, cType] = parts;
                    issues.push({
                        type: 'conflict_' + ext,
                        name: 'PBX Extension Conflict',
                        error: `Number ${ext} collision: assigned to "${e1 || ext}" AND "${e2 || ext}" (${cType}) in Asterisk dialplan.`
                    });
                }
            }
        }
    } catch (_) {}

    return issues;
}

async function attemptServiceRestart(unitName) {
    return new Promise((resolve) => {
        exec(`systemctl restart ${unitName}`, { timeout: 15000 }, (err) => {
            if (err) {
                return resolve({ success: false, message: `Auto-restart command failed: ${err.message}` });
            }
            setTimeout(() => {
                try {
                    const out = execSync(`systemctl is-active ${unitName} 2>/dev/null`, { encoding: 'utf8' }).trim();
                    if (out === 'active') {
                        resolve({ success: true, message: `Auto-restart succeeded. Service ${unitName} is now active.` });
                    } else {
                        resolve({ success: false, message: `Service restarted but state is '${out}' (not active).` });
                    }
                } catch (_) {
                    resolve({ success: false, message: `Failed to confirm service state after restart.` });
                }
            }, 5000);
        });
    });
}

async function sendTelegramAlert(cfg, messageText) {
    if (!cfg.telegramEnabled || !cfg.telegramBotToken || !cfg.telegramChatId) {
        return { success: false, error: 'Telegram alerting disabled or missing token/chatId' };
    }
    const url = `https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`;
    try {
        const res = await axios.post(url, {
            chat_id: cfg.telegramChatId,
            text: messageText,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        }, { timeout: 10000 });
        return { success: true, data: res.data };
    } catch (err) {
        const errDetail = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
        return { success: false, error: `Telegram dispatch failed: ${errDetail}` };
    }
}

async function sendEmailAlert(cfg, subject, htmlBody) {
    if (!cfg.emailEnabled || !cfg.emailRecipients || !cfg.smtpEmail || !cfg.smtpPassword) {
        return { success: false, error: 'Email alerting disabled or missing SMTP credentials/recipients' };
    }
    const transporterConfig = cfg.smtpEmail.endsWith('@gmail.com')
        ? {
            service: 'gmail',
            auth: { user: cfg.smtpEmail, pass: cfg.smtpPassword }
        }
        : {
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: process.env.SMTP_SECURE === 'true',
            auth: { user: cfg.smtpEmail, pass: cfg.smtpPassword },
            tls: { rejectUnauthorized: false }
        };

    try {
        const transporter = nodemailer.createTransport(transporterConfig);
        await transporter.sendMail({
            from: `"Sokrat VoIP Monitor" <${cfg.smtpEmail}>`,
            to: cfg.emailRecipients,
            subject: subject,
            html: htmlBody
        });
        return { success: true };
    } catch (err) {
        return { success: false, error: `Email dispatch failed: ${err.message}` };
    }
}

async function pingHealthchecks(url, isFail = false, failBody = '') {
    if (!url || !url.startsWith('http')) return;
    try {
        const target = isFail ? (url.endsWith('/') ? `${url}fail` : `${url}/fail`) : url;
        if (isFail) {
            await axios.post(target, String(failBody).slice(0, 10000), {
                timeout: 8000,
                headers: { 'Content-Type': 'text/plain' }
            });
        } else {
            await axios.get(target, { timeout: 8000 });
        }
    } catch (_) {}
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function runWatchdogCycle() {
    const cfg = await loadConfigFromDb();
    const { hostname, ip } = getHostInfo();
    const now = Date.now();
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const clientLabel = cfg.clientName ? cfg.clientName : hostname;

    const failures = [];
    const recoveries = [];

    // 1. Check monitored services
    for (const serviceId of cfg.monitoredServices) {
        const check = await checkServiceHealth(serviceId);
        const prev = serviceStates[serviceId] || { state: 'active', lastAlertTime: 0, failCount: 0 };

        if (!check.healthy) {
            check.failCount = prev.failCount + 1;
            const timeSinceLastAlert = now - prev.lastAlertTime;
            const isFirstFailure = prev.state === 'active';
            const shouldAlert = isFirstFailure || timeSinceLastAlert >= REPEAT_ALERT_THROTTLE_MS;

            // Attempt auto-restart if configured
            let restartResult = null;
            if (cfg.autoRestart && check.unit) {
                restartResult = await attemptServiceRestart(check.unit);
            }

            serviceStates[serviceId] = {
                state: 'failed',
                lastAlertTime: shouldAlert ? now : prev.lastAlertTime,
                failCount: check.failCount
            };

            if (shouldAlert) {
                failures.push({
                    ...check,
                    restartResult,
                    isFirstFailure
                });
            }
        } else {
            if (prev.state === 'failed') {
                // Recovery transition!
                recoveries.push(check);
            }
            serviceStates[serviceId] = {
                state: 'active',
                lastAlertTime: 0,
                failCount: 0
            };
        }
    }

    // 2. Check host resources
    const resourceIssues = checkHostResources();
    for (const issue of resourceIssues) {
        const prev = serviceStates[issue.type] || { state: 'active', lastAlertTime: 0 };
        const timeSince = now - prev.lastAlertTime;
        if (prev.state === 'active' || timeSince >= REPEAT_ALERT_THROTTLE_MS) {
            failures.push({
                id: issue.type,
                name: issue.name,
                unit: 'Host System',
                error: issue.error,
                logs: '',
                restartResult: null,
                isFirstFailure: prev.state === 'active'
            });
            serviceStates[issue.type] = { state: 'failed', lastAlertTime: now, failCount: 1 };
        }
    }

    // 3. Dispatch failure notifications
    if (failures.length > 0) {
        for (const f of failures) {
            // Format Telegram message
            const isResource = ['cpu', 'ram', 'disk'].includes(f.id);
            let tgMsg = isResource
                ? `⚠️ <b>[Sokrat VoIP Alert] System Resource Warning</b>\n\n`
                : `🚨 <b>[Sokrat VoIP Alert] Service Failure</b>\n\n`;
            tgMsg += `<b>Client:</b> ${escapeHtml(clientLabel)}\n`;
            tgMsg += `<b>Server:</b> ${escapeHtml(hostname)} (<code>${escapeHtml(ip)}</code>)\n`;
            tgMsg += isResource
                ? `<b>Resource:</b> ${escapeHtml(f.name)}\n`
                : `<b>Service:</b> ${escapeHtml(f.name)} (<code>${escapeHtml(f.unit)}</code>)\n`;
            tgMsg += isResource
                ? `<b>Status:</b> ⚠️ Warning (Threshold Exceeded)\n`
                : `<b>Status:</b> ❌ Failed\n`;
            tgMsg += `<b>Time:</b> ${escapeHtml(timestamp)}\n`;
            tgMsg += `<b>Diagnostic:</b> ${escapeHtml(f.error)}\n`;
            if (f.restartResult) {
                tgMsg += `<b>Auto-Recovery:</b> ${f.restartResult.success ? '✅ ' : '⚠️ '}${escapeHtml(f.restartResult.message)}\n`;
            }
            if (f.logs) {
                const truncatedLogs = f.logs.slice(-600);
                tgMsg += `\n<b>Recent Journal Logs:</b>\n<pre>${escapeHtml(truncatedLogs)}</pre>`;
            }

            // Format Email body
            const emailSubject = `🚨 [CRITICAL ALERT] [${clientLabel}] ${f.name} Failed on ${hostname} (${ip})`;
            let emailHtml = `
                <div style="font-family: Arial, sans-serif; background-color: #f8fafc; padding: 24px; color: #1e293b;">
                    <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
                        <div style="background-color: #dc2626; color: #ffffff; padding: 18px 24px;">
                            <h2 style="margin: 0; font-size: 18px; font-weight: bold;">🚨 Sokrat VoIP System Alert</h2>
                            <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">Service Failure Detected</p>
                        </div>
                        <div style="padding: 24px;">
                            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                                <tr><td style="padding: 8px 0; font-weight: bold; width: 130px;">Client:</td><td><strong style="color: #0284c7; font-size: 14px;">${escapeHtml(clientLabel)}</strong></td></tr>
                                <tr><td style="padding: 8px 0; font-weight: bold;">Server Host:</td><td>${escapeHtml(hostname)} (${escapeHtml(ip)})</td></tr>
                                <tr><td style="padding: 8px 0; font-weight: bold;">Affected Service:</td><td><strong>${escapeHtml(f.name)}</strong> (${escapeHtml(f.unit)})</td></tr>
                                <tr><td style="padding: 8px 0; font-weight: bold;">Detection Time:</td><td>${escapeHtml(timestamp)}</td></tr>
                                <tr><td style="padding: 8px 0; font-weight: bold;">Error Detail:</td><td style="color: #dc2626;">${escapeHtml(f.error)}</td></tr>
                                ${f.restartResult ? `<tr><td style="padding: 8px 0; font-weight: bold;">Auto-Recovery:</td><td>${f.restartResult.success ? '✅' : '❌'} ${escapeHtml(f.restartResult.message)}</td></tr>` : ''}
                            </table>
                            ${f.logs ? `<div style="background: #0f172a; color: #f1f5f9; padding: 14px; border-radius: 8px; font-family: monospace; font-size: 12px; overflow-x: auto; white-space: pre-wrap;">${escapeHtml(f.logs.slice(-1000))}</div>` : ''}
                        </div>
                        <div style="background: #f1f5f9; padding: 12px 24px; font-size: 12px; color: #64748b; text-align: center;">
                            Sokrat VoIP Autonomous System Watchdog &bull; Outbound Private-NAT Architecture
                        </div>
                    </div>
                </div>
            `;

            await sendTelegramAlert(cfg, tgMsg);
            await sendEmailAlert(cfg, emailSubject, emailHtml);
        }

        // Send fail signal to Healthchecks.io
        const combinedErrors = failures.map(x => `[Client: ${clientLabel}] [${x.name}] ${x.error}`).join('\n');
        await pingHealthchecks(cfg.healthchecksUrl, true, combinedErrors);
    } else {
        // All healthy: send successful heartbeat ping to Healthchecks.io
        await pingHealthchecks(cfg.healthchecksUrl, false);
    }

    // 4. Dispatch recovery notifications
    if (recoveries.length > 0) {
        for (const r of recoveries) {
            let tgMsg = `✅ <b>[Sokrat VoIP Alert] Service Restored</b>\n\n`;
            tgMsg += `<b>Client:</b> ${escapeHtml(clientLabel)}\n`;
            tgMsg += `<b>Server:</b> ${escapeHtml(hostname)} (<code>${escapeHtml(ip)}</code>)\n`;
            tgMsg += `<b>Service:</b> ${escapeHtml(r.name)} (<code>${escapeHtml(r.unit)}</code>)\n`;
            tgMsg += `<b>Status:</b> 🟢 Active &amp; Operational\n`;
            tgMsg += `<b>Time:</b> ${escapeHtml(timestamp)}\n`;
            const emailSubject = `✅ [RESTORED] [${clientLabel}] ${r.name} Operating Normally on ${hostname}`;
            const emailHtml = `
                <div style="font-family: Arial, sans-serif; background-color: #f8fafc; padding: 24px; color: #1e293b;">
                    <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden;">
                        <div style="background-color: #16a34a; color: #ffffff; padding: 18px 24px;">
                            <h2 style="margin: 0; font-size: 18px; font-weight: bold;">✅ Service Restored</h2>
                        </div>
                        <div style="padding: 24px;">
                            <p><strong>${escapeHtml(r.name)}</strong> for client <strong>${escapeHtml(clientLabel)}</strong> on server <strong>${escapeHtml(hostname)} (${escapeHtml(ip)})</strong> has returned to active and operational state at ${escapeHtml(timestamp)}.</p>
                        </div>
                    </div>
                </div>
            `;

            await sendTelegramAlert(cfg, tgMsg);
            await sendEmailAlert(cfg, emailSubject, emailHtml);
        }
    }

    return { failures, recoveries };
}

// Command Line Test Runners
async function handleCliCommands() {
    const args = process.argv.slice(2);
    if (args.includes('--once')) {
        console.log('[Sokrat Watchdog] Running single evaluation cycle...');
        const res = await runWatchdogCycle();
        console.log('[Sokrat Watchdog] Cycle complete:', res);
        process.exit(0);
    }

    if (args.includes('--test-telegram')) {
        const cfg = await loadConfigFromDb();
        const { hostname, ip } = getHostInfo();
        const clientLabel = cfg.clientName ? cfg.clientName : hostname;
        const msg = `🔔 <b>[Sokrat VoIP] Test Telegram Notification</b>\n\n`
            + `<b>Client:</b> ${escapeHtml(clientLabel)}\n`
            + `<b>Server:</b> ${escapeHtml(hostname)} (${escapeHtml(ip)})\n`;
            + `<b>Time:</b> ${new Date().toISOString()}\n`
            + `<b>Status:</b> ✅ Telegram alert integration is working properly!`;
        console.log('[Sokrat Watchdog] Sending test Telegram alert...');
        const res = await sendTelegramAlert(cfg, msg);
        console.log('Result:', res);
        process.exit(res.success ? 0 : 1);
    }

    if (args.includes('--test-cpu')) {
        const cfg = await loadConfigFromDb();
        const { hostname, ip } = getHostInfo();
        const clientLabel = cfg.clientName ? cfg.clientName : hostname;
        const cpus = os.cpus().length || 1;
        const load1 = os.loadavg()[0] || 0;
        const curPct = parseFloat(((load1 / cpus) * 100).toFixed(1));

        const msg = `⚠️ <b>[Sokrat VoIP Alert] System Resource Warning</b>\n\n`
            + `<b>Client:</b> ${escapeHtml(clientLabel)}\n`
            + `<b>Server:</b> ${escapeHtml(hostname)} (<code>${escapeHtml(ip)}</code>)\n`
            + `<b>Resource:</b> High CPU Utilization\n`
            + `<b>Status:</b> ⚠️ Warning (Threshold Exceeded)\n`
            + `<b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)}\n`
            + `<b>Diagnostic:</b> Host CPU load is critically high at 94.2% (current load: ${curPct}%, ${load1.toFixed(2)} on ${cpus} cores; threshold: 90%)`;

        console.log('[Sokrat Watchdog] Sending simulated High CPU Telegram alert...');
        const res = await sendTelegramAlert(cfg, msg);
        console.log('Result:', res);
        process.exit(res.success ? 0 : 1);
    }

    if (args.includes('--test-ram')) {
        const cfg = await loadConfigFromDb();
        const { hostname, ip } = getHostInfo();
        const clientLabel = cfg.clientName ? cfg.clientName : hostname;

        let totalKb = 0, availKb = 0;
        try {
            const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
            for (const line of meminfo.split('\n')) {
                if (line.startsWith('MemTotal:')) totalKb = parseInt(line.replace(/\D/g, ''), 10);
                if (line.startsWith('MemAvailable:')) availKb = parseInt(line.replace(/\D/g, ''), 10);
            }
        } catch (_) {}
        const curFreePct = totalKb > 0 ? parseFloat(((availKb / totalKb) * 100).toFixed(1)) : 50.0;

        const msg = `⚠️ <b>[Sokrat VoIP Alert] System Resource Warning</b>\n\n`
            + `<b>Client:</b> ${escapeHtml(clientLabel)}\n`
            + `<b>Server:</b> ${escapeHtml(hostname)} (<code>${escapeHtml(ip)}</code>)\n`
            + `<b>Resource:</b> RAM Depletion Warning\n`
            + `<b>Status:</b> ⚠️ Warning (Threshold Exceeded)\n`
            + `<b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)}\n`
            + `<b>Diagnostic:</b> Available host RAM is critically low at 4.1% (${(availKb / 1024).toFixed(0)}MB free of ${(totalKb / 1024).toFixed(0)}MB, current: ${curFreePct}%; threshold: 5%)`;

        console.log('[Sokrat Watchdog] Sending simulated High RAM Telegram alert...');
        const res = await sendTelegramAlert(cfg, msg);
        console.log('Result:', res);
        process.exit(res.success ? 0 : 1);
    }

    if (args.includes('--test-email')) {
        const clientLabel = cfg.clientName ? cfg.clientName : hostname;
        const subject = `🔔 [TEST] [${clientLabel}] Sokrat VoIP Email Notification from ${hostname}`;
        const body = `<h3>Sokrat VoIP Test Alert</h3><p>This is a test notification for client <strong>${escapeHtml(clientLabel)}</strong> confirming that Email alerts are properly configured on ${hostname} (${ip}).</p>`;
        console.log('[Sokrat Watchdog] Sending test Email alert...');
        const res = await sendEmailAlert(cfg, subject, body);
        console.log('Result:', res);
        process.exit(res.success ? 0 : 1);
    }

    if (args.includes('--test-heartbeat')) {
        const cfg = await loadConfigFromDb();
        console.log(`[Sokrat Watchdog] Pinging Healthchecks URL: ${cfg.healthchecksUrl}...`);
        await pingHealthchecks(cfg.healthchecksUrl, false);
        console.log('Ping sent successfully.');
        process.exit(0);
    }
}

async function main() {
    await handleCliCommands();

    console.log('[Sokrat Watchdog] Starting persistent system monitoring daemon...');
    const initialCfg = await loadConfigFromDb();
    console.log(`[Sokrat Watchdog] Monitored services: ${initialCfg.monitoredServices.join(', ')}`);
    console.log(`[Sokrat Watchdog] Telegram alerts: ${initialCfg.telegramEnabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`[Sokrat Watchdog] Healthchecks heartbeat: ${initialCfg.healthchecksUrl ? 'CONFIGURED' : 'NONE'}`);

    // Initial cycle
    await runWatchdogCycle().catch(err => console.error('[Sokrat Watchdog] Error in cycle:', err.message));

    // Periodic loop
    setInterval(async () => {
        try {
            await runWatchdogCycle();
        } catch (err) {
            console.error('[Sokrat Watchdog] Error in cycle:', err.message);
        }
    }, (initialCfg.checkIntervalSec || 30) * 1000);
}

// Prevent unhandled rejections from terminating the daemon
process.on('uncaughtException', (err) => {
    console.error('[Sokrat Watchdog] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[Sokrat Watchdog] Unhandled rejection:', reason);
});

if (require.main === module) {
    main();
}

module.exports = {
    loadConfigFromDb,
    checkServiceHealth,
    checkHostResources,
    sendTelegramAlert,
    sendEmailAlert,
    pingHealthchecks,
    runWatchdogCycle,
    DEFAULT_CONFIG
};
