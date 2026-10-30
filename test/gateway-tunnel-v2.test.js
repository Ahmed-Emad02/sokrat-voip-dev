'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const tunnel = require('../lib/gateway-tunnel');

const certificate = execFileSync('python3', ['-B', '-c', `
import sys
sys.path.insert(0,${JSON.stringify(path.resolve(__dirname,'../scripts'))})
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
import datetime
k=ec.generate_private_key(ec.SECP256R1());n=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'gateway.example.test')]);now=datetime.datetime.utcnow()
c=x509.CertificateBuilder().subject_name(n).issuer_name(n).public_key(k.public_key()).serial_number(1).not_valid_before(now-datetime.timedelta(minutes=1)).not_valid_after(now+datetime.timedelta(days=1)).sign(k,hashes.SHA256())
print(c.public_bytes(serialization.Encoding.PEM).decode())`],{encoding:'utf8'}).trim()+'\n';
const code = { v: 2, host: 'gateway.example.test', port: 7443, ca: certificate, secret: 'a'.repeat(43) };
const installation = { installationId: 'a'.repeat(32), installationSecret: 'b'.repeat(43) };
const result = { pbxId: 'pbx_0123456789abcdef', installationId: installation.installationId,
    serverHost: code.host, serverName: code.host, serverCa: certificate, tunnelPort: 7000,
    frpToken: 'c'.repeat(43), hookToken: 'd'.repeat(43), readinessKey: 'e'.repeat(43),
    ports: { ws: 23006, api: 23007, media: 22003 }, plan: { slot: 3, pbxId: 'pbx_0123456789abcdef' },
    gatewayUrl: 'https://gateway.example.test:7443' };

test('secure pairing validates the pinned certificate and refuses legacy or malformed codes', () => {
    const encode = value => 'sk_pair_v2_'+Buffer.from(JSON.stringify(value)).toString('base64url');
    assert.deepEqual(tunnel.pairing(encode(code)), code);
    for (const bad of ['legacy-token', 'sk_pair_v2_bad', encode({...code,host:'gateway;command'}),
        encode({...code,ca:'not-a-certificate'}), encode({...code,port:0})]) {
        assert.throws(() => tunnel.pairing(bad));
    }
});

test('response cannot downgrade push TLS, change its pinned identity or mix tenant allocations', () => {
    tunnel.validateResponse(result,code,installation);
    for (const patch of [{serverCa:'different'}, {installationId:'b'.repeat(32)},
        {gatewayUrl:'http://gateway.example.test'}, {gatewayUrl:'https://gateway.example.test:443'},
        {ports:{...result.ports,ws:23008}}, {plan:{...result.plan,slot:true}}]) {
        assert.throws(() => tunnel.validateResponse({...result,...patch},code,installation));
    }
});

test('FRPC always verifies pinned TLS and creates exactly three scoped loopback proxies', () => {
    const config = tunnel.frpcConfig(result,installation);
    assert.match(config,/transport.tls.trustedCaFile = "\/etc\/frp\/gateway-ca.crt"/);
    assert.match(config,/transport.tls.serverName = "gateway.example.test"/);
    assert.equal((config.match(/\[\[proxies\]\]/g)||[]).length,3);
    assert.equal((config.match(/localIP = "127.0.0.1"/g)||[]).length,3);
    assert.doesNotMatch(config,/rejectUnauthorized|insecure|tailscale|zerotier/i);
});

test('readiness endpoint rejects unauthenticated calls without opening a socket', () => {
    const res = { statusCode:0, status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;} };
    tunnel.readiness({get:()=>'',body:{nonce:crypto.randomBytes(16).toString('hex')}},res);
    assert.equal(res.statusCode,403);
    assert.deepEqual(res.body,{ready:false});
});

test('OpenVPN preflight accepts Rocky 2.4 version exit 1, but not failed or unsupported binaries', () => {
    for (const status of [0, 1]) tunnel.verifyOpenvpn({ status, stdout: 'OpenVPN 2.4.12 x86_64-redhat-linux-gnu' });
    tunnel.verifyOpenvpn({ status: 0, stdout: 'OpenVPN 2.6.14 x86_64' });
    for (const result of [{ status: 2, stdout: 'OpenVPN 2.4.12' },
        { status: 1, stdout: 'permission denied' }, { status: 0, stdout: 'OpenVPN 2.3.18' },
        { status: 0, stdout: 'OpenVPN 3.1.0' }, { status: null, error: new Error('ENOENT') },
        { status: 1, signal: 'SIGTERM', stdout: 'OpenVPN 2.6.14' }]) {
        assert.throws(() => tunnel.verifyOpenvpn(result), /Supported OpenVPN/);
    }
});
