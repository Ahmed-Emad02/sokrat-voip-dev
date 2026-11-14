'use strict';
// Behavioral coverage for scripts/wireguard-server.sh. The helper writes to
// fixed /etc paths, so each case runs in a private user+mount namespace with a
// tmpfs over /etc; no host state is read or changed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'scripts/wireguard-server.sh');

const KEY_A = 'A'.repeat(43) + '=';
const KEY_B = 'B'.repeat(43) + '=';
const PUB_A = 'C'.repeat(43) + '=';
const PUB_B = 'D'.repeat(43) + '=';
const ADMISSION = '{"token":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","interface":"wg0","allowedCidr":"10.66.0.0/24"}\n';
const PROFILE = '[Interface]\nAddress = 10.66.0.1/24\nListenPort = 51830\nPrivateKey = ' + KEY_B + '\n\n[Peer]\nPublicKey = ' + 'E'.repeat(43) + '=\nAllowedIPs = 10.66.0.2/32\n';

const namespacesAvailable = spawnSync('unshare', ['--map-root-user', '--mount', 'true']).status === 0;

function makeShims(dir) {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // /usr/bin/awk normally resolves through /etc/alternatives, hidden by tmpfs.
    fs.symlinkSync(fs.realpathSync('/usr/bin/awk'), path.join(bin, 'awk'));
    const shims = {
        wg: `#!/bin/bash
case "$1" in
    genkey) printf '%s\\n' "$KEY_A" ;;
    pubkey)
        IFS= read -r key || true
        case "$key" in
            "$KEY_A") printf '%s\\n' "$PUB_A" ;;
            "$KEY_B") printf '%s\\n' "$PUB_B" ;;
            *) exit 1 ;;
        esac
        ;;
    show)
        if [ -n "\${RUNNING_PUB:-}" ]; then printf '%s\\n' "$RUNNING_PUB"; fi
        exit 0
        ;;
    *) exit 0 ;;
esac
`,
        'wg-quick': '#!/bin/bash\nexit 0\n',
        systemctl: '#!/bin/bash\nexit 0\n',
        'firewall-cmd': '#!/bin/bash\nexit 1\n',
        ufw: '#!/bin/bash\nexit 1\n',
    };
    for (const [name, body] of Object.entries(shims)) {
        const file = path.join(bin, name);
        fs.writeFileSync(file, body);
        fs.chmodSync(file, 0o755);
    }
    return bin;
}

function runInSandbox(dir, body, extraEnv = {}) {
    const bin = makeShims(dir);
    const script = `set -eu
mount -t tmpfs -o mode=0755 tmpfs /etc
mkdir -p /etc/sokrat /etc/wireguard /etc/systemd/system
${body}
`;
    const env = {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        SCRIPT: helper,
        KEY_A,
        KEY_B,
        PUB_A,
        PUB_B,
        ...extraEnv,
    };
    return spawnSync('unshare', ['--map-root-user', '--mount', 'bash', '-c', script], {
        env,
        encoding: 'utf8',
    });
}

function expectSuccess(result) {
    assert.equal(result.status, 0, `helper failed:\n${result.stdout}\n${result.stderr}`);
}

test('preserved key/profile/token keep their bytes, tighten to root 0600, and advertise the configured key', (t) => {
    if (!namespacesAvailable) {
        t.skip('user namespaces are unavailable');
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-wg-'));
    try {
        const result = runInSandbox(dir, `
chmod 0777 /etc/sokrat
chmod 0755 /etc/wireguard
printf '%s' "$ADMISSION" > /etc/sokrat/wg-admission.json
printf '%s\\n' "$KEY_A" > /etc/wireguard/sokrat-server.key
printf '%s' "$PROFILE" > /etc/wireguard/wg0.conf
chmod 0644 /etc/sokrat/wg-admission.json /etc/wireguard/sokrat-server.key /etc/wireguard/wg0.conf

out="$(bash -c 'source "$SCRIPT"; install_wireguard_server' 2>&1)"

printf '%s' "$ADMISSION" | cmp -s - /etc/sokrat/wg-admission.json || { echo "admission token changed" >&2; exit 1; }
printf '%s' "$PROFILE" | cmp -s - /etc/wireguard/wg0.conf || { echo "profile changed" >&2; exit 1; }
[ "$(cat /etc/wireguard/sokrat-server.key)" = "$KEY_A" ] || { echo "server key changed" >&2; exit 1; }

[ "$(stat -c %a /etc/sokrat)" = 755 ] || { echo "wrong /etc/sokrat mode" >&2; exit 1; }
[ "$(stat -c %u /etc/sokrat)" = 0 ] || { echo "wrong /etc/sokrat owner" >&2; exit 1; }
[ "$(stat -c %a /etc/wireguard)" = 700 ] || { echo "wrong /etc/wireguard mode" >&2; exit 1; }
[ "$(stat -c %u /etc/wireguard)" = 0 ] || { echo "wrong /etc/wireguard owner" >&2; exit 1; }
for f in /etc/sokrat/wg-admission.json /etc/wireguard/sokrat-server.key /etc/wireguard/wg0.conf; do
    [ "$(stat -c %a "$f")" = 600 ] || { echo "wrong mode on $f" >&2; exit 1; }
    [ "$(stat -c %u "$f")" = 0 ] || { echo "wrong owner on $f" >&2; exit 1; }
done
case "$out" in
    *"$PUB_B"*) ;;
    *) echo "configured public key not advertised: $out" >&2; exit 1 ;;
esac
case "$out" in
    *"$PUB_A"*) echo "advertised public key of the unused sokrat-server.key" >&2; exit 1 ;;
esac
case "$out" in
    *"$KEY_A"*|*"$KEY_B"*) echo "private key appeared in output" >&2; exit 1 ;;
esac
`, { ADMISSION, PROFILE });
        expectSuccess(result);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a fresh profile and key are created root-owned 0600 with their real public key', (t) => {
    if (!namespacesAvailable) {
        t.skip('user namespaces are unavailable');
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-wg-fresh-'));
    try {
        const result = runInSandbox(dir, `
out="$(bash -c 'source "$SCRIPT"; install_wireguard_server' 2>&1)"
for f in /etc/sokrat/wg-admission.json /etc/wireguard/sokrat-server.key /etc/wireguard/wg0.conf; do
    [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
    [ "$(stat -c %a "$f")" = 600 ] || { echo "wrong mode on $f" >&2; exit 1; }
    [ "$(stat -c %u "$f")" = 0 ] || { echo "wrong owner on $f" >&2; exit 1; }
done
[ "$(cat /etc/wireguard/sokrat-server.key)" = "$KEY_A" ] || { echo "wrong generated key" >&2; exit 1; }
grep -q "PrivateKey = $KEY_A" /etc/wireguard/wg0.conf || { echo "profile did not use the generated key" >&2; exit 1; }
[ -z "$(find /etc/sokrat /etc/wireguard -name '.*' -print)" ] || { echo "temporary secret left behind" >&2; exit 1; }
case "$out" in
    *"$PUB_A"*) ;;
    *) echo "generated public key not advertised: $out" >&2; exit 1 ;;
esac
case "$out" in
    *"$KEY_A"*) echo "private key appeared in output" >&2; exit 1 ;;
esac
`, { SOKRAT_WG_ADMISSION_TOKEN: 'f'.repeat(64) });
        expectSuccess(result);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a preserved symlinked key is refused instead of followed or chmodded', (t) => {
    if (!namespacesAvailable) {
        t.skip('user namespaces are unavailable');
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-wg-link-'));
    try {
        const result = runInSandbox(dir, `
printf '%s\\n' "$KEY_A" > /etc/sokrat/key-target
chmod 0644 /etc/sokrat/key-target
ln -s /etc/sokrat/key-target /etc/wireguard/sokrat-server.key
printf '%s' "$ADMISSION" > /etc/sokrat/wg-admission.json

out="$(bash -c 'source "$SCRIPT"; install_wireguard_server' 2>&1)"
case "$out" in
    *"symlinks are refused"*) ;;
    *) echo "symlink was not refused: $out" >&2; exit 1 ;;
esac
[ -L /etc/wireguard/sokrat-server.key ] || { echo "symlink was replaced" >&2; exit 1; }
[ "$(stat -c %a /etc/sokrat/key-target)" = 644 ] || { echo "symlink target was chmodded" >&2; exit 1; }
[ ! -e /etc/wireguard/wg0.conf ] || { echo "profile created from an unsafe key" >&2; exit 1; }
`, { ADMISSION });
        expectSuccess(result);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an injected interface address is rejected before a profile is written', t => {
    if (!namespacesAvailable) {
        t.skip('private user/mount namespaces are unavailable');
        return;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-wg-address-'));
    try {
        expectSuccess(runInSandbox(directory, `
. "$SCRIPT"
if install_wireguard_server; then
    echo "injected address was accepted" >&2
    exit 1
fi
test ! -e /etc/wireguard/wg0.conf
`, { SOKRAT_WG_ADDRESS: '10.66.0.1/24\nPostUp = /bin/false' }));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
