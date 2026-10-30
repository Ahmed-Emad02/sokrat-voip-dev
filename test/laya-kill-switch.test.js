const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const rootDir = path.resolve(__dirname, '..');

test('Schema & Multi-Installer Parity: laya_kill_switch_active is seeded across all installation scripts', () => {
    // 1. backend/install_db.sql
    const sql = fs.readFileSync(path.join(rootDir, 'backend', 'install_db.sql'), 'utf8');
    assert.match(sql, /laya_kill_switch_active/, 'install_db.sql must seed laya_kill_switch_active');
    assert.match(sql, /\('laya_kill_switch_active',\s*'true'\)/, 'install_db.sql must seed laya_kill_switch_active as true');

    // 2. scripts/safe-upgrade.sh
    const upgradeScript = fs.readFileSync(path.join(rootDir, 'scripts', 'safe-upgrade.sh'), 'utf8');
    assert.match(upgradeScript, /laya_kill_switch_active/, 'safe-upgrade.sh must seed laya_kill_switch_active');
    assert.match(upgradeScript, /\('laya_kill_switch_active',\s*'true'\)/, 'safe-upgrade.sh must seed laya_kill_switch_active as true');

    // 3. install.sh
    const installScript = fs.readFileSync(path.join(rootDir, 'install.sh'), 'utf8');
    assert.match(installScript, /laya_kill_switch_active/, 'install.sh must seed laya_kill_switch_active');
    assert.match(installScript, /\('laya_kill_switch_active',\s*'true'\)/, 'install.sh must seed laya_kill_switch_active as true');

    // 4. installer-bundle/install-sokrat.sh
    const bundleScript = fs.readFileSync(path.join(rootDir, 'installer-bundle', 'install-sokrat.sh'), 'utf8');
    assert.match(bundleScript, /laya_kill_switch_active/, 'install-sokrat.sh must seed laya_kill_switch_active');
    assert.match(bundleScript, /\('laya_kill_switch_active',\s*'true'\)/, 'install-sokrat.sh must seed laya_kill_switch_active as true');
});

test('UI Gating: Kill switch button in views/gsm-dongles.ejs is strictly wrapped in root-only check', () => {
    const ejsContent = fs.readFileSync(path.join(rootDir, 'views', 'gsm-dongles.ejs'), 'utf8');
    assert.match(ejsContent, /<% if \((?:typeof isRootUser !== 'undefined' && )?isRootUser\) \{\s*%>[\s\S]*?id="btn-laya-kill-switch"[\s\S]*?<% \}\s*%>/, 'Kill switch button must be strictly gated by isRootUser');
    assert.match(ejsContent, /id="laya-killed-banner"/, 'Must contain laya-killed-banner element');
    assert.match(ejsContent, /toggleLayaKillSwitch/, 'Must contain toggleLayaKillSwitch function');
});

test('API Security: POST /api/laya/kill-switch rejects unauthenticated and non-root users', async () => {
    // 1. Unauthenticated request -> 401
    const unauthRes = await makePostRequest('/api/laya/kill-switch', { action: 'kill' }, {});
    assert.strictEqual(unauthRes.statusCode, 401, 'Unauthenticated request must return 401');

    // 2. Non-root user session mock or mock check in server.js
    const serverCode = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
    assert.match(serverCode, /app\.post\('\/api\/laya\/kill-switch'/, 'server.js must define POST /api/laya/kill-switch');
    assert.match(serverCode, /req\.session\.username === 'root'/, 'Must verify root username');
    assert.match(serverCode, /res\.status\(403\)/, 'Must reject non-root users with 403 Forbidden');
    assert.match(serverCode, /systemctl stop sokrat-laya\.service/, 'Kill switch must stop service');
    assert.match(serverCode, /systemctl start sokrat-laya\.service/, 'Resume must start service');
    assert.match(serverCode, /laya_kill_switch_active/, 'Must persist kill switch state in DB');
});

test('Laya Sensors DB Driver: is_kill_switch_active safely exits cursor context before closing connection', () => {
    const dbCode = fs.readFileSync(path.join(rootDir, 'laya', 'sensors', 'db.py'), 'utf8');
    assert.match(dbCode, /def is_kill_switch_active\(\):/, 'db.py must define is_kill_switch_active');

    const fnMatch = dbCode.match(/def is_kill_switch_active\(\):[\s\S]*?(?=\ndef |\Z)/);
    assert.ok(fnMatch, 'must match is_kill_switch_active function body');
    const fnBody = fnMatch[0];

    // Ensure conn.close() is in finally block, not inside with block
    assert.match(fnBody, /finally:\s*[\s\S]*?conn\.close\(\)/, 'Connection must be closed in finally block');
    assert.doesNotMatch(
        fnBody,
        /cursor\.fetchone\(\)[\s\S]*?conn\.close\(\)[\s\S]*?return/,
        'conn.close() must not be called before cursor context exits'
    );
});

function makePostRequest(endpoint, body, headers = {}) {
    return new Promise((resolve) => {
        const postData = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1',
            port: 8080,
            path: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, body: data });
            });
        });

        req.on('error', (err) => {
            resolve({ statusCode: 500, error: err.message });
        });

        req.write(postData);
        req.end();
    });
}
