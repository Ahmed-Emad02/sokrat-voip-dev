'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const installer = path.join(root, 'scripts/install-webrtc-wake.py');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webrtc-wake-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const put = (name, text) => {
        const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text, { mode: 0o600 });
    };
    const route = extension => [
        `exten => ${extension},1,Set(__RINGTIMER=10)`,
        `exten => ${extension},n,Macro(exten-vm,novm,${extension},0,0,0)`,
        `exten => ${extension},n(dest),Set(__PICKUPMARK=)`,
        `exten => ${extension},n,Goto(\${IVR_CONTEXT},return,1)`,
        `exten => ${extension},hint,PJSIP/${extension},CustomPresence:${extension}`,
    ].join('\n');
    put('etc/asterisk/extensions_additional.conf', '[ext-local]\n' + route('404') + '\n' + route('405') + '\n[macro-dial-one]\nexten => s,1,NoOp(desktop preserved)\n');
    put('etc/asterisk/pjsip_custom_post.conf', '[404](+)\nwebrtc=yes\n[405](+)\nwebrtc=no\n');
    put('etc/asterisk/extensions.conf', '#include extensions_override_issabelpbx.conf\n#include extensions_additional.conf\n');
    put('etc/asterisk/extensions_override_issabelpbx.conf', '; operator anchor\n#include extensions_override_issabel.conf\n');
    put('etc/asterisk/extensions_override_issabel.conf', '[custom-context]\nexten => 9,1,NoOp(unchanged)\n');
    put('etc/sokrat/gateway-hook.json', JSON.stringify({ pbxId: 'pbx_' + 'a'.repeat(16), gatewayUrl: 'https://gateway.example:7443', caFile: '/etc/frp/gateway-ca.crt' }));
    put('etc/sokrat/gateway-tunnel-v2.json', JSON.stringify({ pbxId: 'pbx_' + 'a'.repeat(16) }));
    const run = (apply = true) => spawnSync('python3', [installer, '--root', dir, '--no-reload', ...(apply ? ['--apply'] : [])], { encoding: 'utf8' });
    const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
    return { dir, put, run, read, route, output: path.join(dir, 'etc/asterisk/extensions_sokrat_webrtc_wake.conf') };
}

test('dry-run is read-only; apply compiles only exact WebRTC entries and preserves generated/desktop files', t => {
    const f = fixture(t);
    const generated = f.read('etc/asterisk/extensions_additional.conf');
    const custom = f.read('etc/asterisk/extensions_override_issabel.conf');
    const anchor = path.join(f.dir, 'etc/asterisk/extensions_override_issabelpbx.conf');
    fs.chmodSync(anchor, 0o664);
    let result = f.run(false);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(f.output), false);
    result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const text = fs.readFileSync(f.output, 'utf8');
    assert.match(text, /exten => 404,n,Gosub\(sub-sokrat-webrtc-wake,s,1\(\$\{EXTEN\}\)\)/);
    assert.doesNotMatch(text, /exten => 405|\[macro-|\[from-internal-custom\]|exten => _|Progress\(|VOLUME\(/);
    assert.match(text, /Macro\(exten-vm,novm,404,0,0,0\)/);
    assert.equal(f.read('etc/asterisk/extensions_additional.conf'), generated);
    assert.equal(f.read('etc/asterisk/extensions_override_issabel.conf'), custom);
    assert.equal(fs.statSync(anchor).mode & 0o777, 0o664, 'existing anchor permissions preserved');
    assert.equal(fs.statSync(f.output).mode & 0o777, 0o640);
    assert.equal(fs.statSync(f.output).gid, fs.statSync(path.dirname(f.output)).gid);
    assert.match(f.read('etc/asterisk/extensions_override_issabelpbx.conf'), /^; operator anchor\n#include extensions_override_issabel.conf\n/);
    assert.equal(JSON.parse(f.run().stdout).changed, false);
    assert.equal(fs.statSync(path.join(f.dir, 'usr/local/bin/sokrat-webrtc-wake-dispatch.py')).mode & 0o777, 0o755);
});

test('wake preparation preserves DND/forwarding and bounds a CRM-safe new-contact wait', t => {
    const f = fixture(t); assert.equal(f.run().status, 0);
    const text = fs.readFileSync(f.output, 'utf8');
    for (const term of ['DB(DND/${ARG1})', 'DB(CF/${ARG1})', 'DB(CFU/${ARG1})', 'HASH(__SIPHEADERS,X-Sokrat-Call-ID)',
        'URIENCODE(${CALLERID(num)})', 'SOKRAT_BEFORE_COUNT', '${FIELDQTY(SOKRAT_AFTER_DIAL,&)}>${SOKRAT_BEFORE_COUNT}',
        'Wait(0.2)', '${SOKRAT_WAKE_ITER}<25']) assert.ok(text.includes(term), term);
    assert.ok(text.indexOf('DB(DND/') < text.indexOf('sokrat-webrtc-wake-dispatch.py'));
    assert.match(text, /SOKRAT_WAKE_WAIT.*!="1"/);
    assert.doesNotMatch(text, /Dial\(|Answer\(|Hangup\(/);
});

test('removing/converting a WebRTC extension removes only its managed interception', t => {
    const f = fixture(t); assert.equal(f.run().status, 0);
    f.put('etc/asterisk/pjsip_custom_post.conf', '[404](+)\nwebrtc=no\n');
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(fs.readFileSync(f.output, 'utf8'), /\[ext-local\]|404|sub-sokrat-webrtc-wake/);
});

test('stale WebRTC post-config cannot intercept a standard SIP extension', t => {
    const f = fixture(t);
    f.put('etc/asterisk/extensions_additional.conf', f.read('etc/asterisk/extensions_additional.conf').replace('hint,PJSIP/404,', 'hint,SIP/404,'));
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(fs.readFileSync(f.output, 'utf8'), /exten => 404/);
    assert.deepEqual(JSON.parse(result.stdout).extensions, []);
});

test('unpaired PBX does not install or intercept any call path', t => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.dir, 'etc/sokrat/gateway-hook.json'));
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(f.output), false);
    assert.equal(JSON.parse(result.stdout).changed, false);
});

test('custom route conflicts, unsupported generated templates and unmanaged output refuse before writes', async t => {
    for (const scenario of ['custom', 'template', 'output', 'enrollment', 'symlink']) {
        await t.test(scenario, t => {
            const f = fixture(t);
            if (scenario === 'custom') f.put('etc/asterisk/extensions_override_issabel.conf', '[ext-local]\n' + f.route('404'));
            if (scenario === 'template') f.put('etc/asterisk/extensions_additional.conf', '[ext-local]\nexten => 404,1,Dial(PJSIP/404)\nexten => 404,hint,PJSIP/404,CustomPresence:404\n');
            if (scenario === 'output') f.put('etc/asterisk/extensions_sokrat_webrtc_wake.conf', '; operator-owned');
            if (scenario === 'enrollment') f.put('etc/sokrat/gateway-hook.json', JSON.stringify({ pbxId: 'pbx_' + 'b'.repeat(16) }));
            if (scenario === 'symlink') fs.symlinkSync(path.join(f.dir, 'etc/asterisk/extensions_additional.conf'), f.output);
            const anchor = f.read('etc/asterisk/extensions_override_issabelpbx.conf');
            assert.notEqual(f.run().status, 0);
            assert.equal(f.read('etc/asterisk/extensions_override_issabelpbx.conf'), anchor);
            assert.equal(fs.existsSync(path.join(f.dir, 'usr/local/bin/sokrat-webrtc-wake-dispatch.py')), false);
        });
    }
});

test('all installers, enrollment and post-retrieve_conf lifecycle include the scoped compiler', () => {
    for (const name of ['install.sh', 'installer-bundle/install-sokrat.sh', 'scripts/safe-upgrade.sh', 'lib/gateway-tunnel.js', 'server.js']) {
        assert.match(fs.readFileSync(path.join(root, name), 'utf8'), /install-webrtc-wake\.py/);
    }
    const readiness = fs.readFileSync(path.join(root, 'scripts/sokrat-gateway-readiness.sh'), 'utf8');
    assert.doesNotMatch(readiness, /^\[macro-dial(?:-one)?\]$/m);
});

test('dispatcher uses pinned authenticated HTTPS, a short deadline, and only waits for delivered mobile push', () => {
    const script = `import importlib.util,json,ssl,unittest.mock as mock
spec=importlib.util.spec_from_file_location('wake',${JSON.stringify(path.join(root, 'scripts/webrtc-wake-dispatch.py'))})
wake=importlib.util.module_from_spec(spec);spec.loader.exec_module(wake)
config={'gatewayUrl':'https://gateway.example:7443','caFile':'/etc/frp/gateway-ca.crt','pbxId':'pbx_'+'a'*16,'token':${JSON.stringify(crypto.randomBytes(32).toString('base64url'))}}
calls=[]
class Reply:
 status=200
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self,size):return json.dumps(result).encode()
def opener(request,**kwargs):
 calls.append((request,kwargs));return Reply()
args=['404','%2B442012345678','Caller%20Name','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
with mock.patch.object(ssl,'create_default_context',return_value='pinned-context') as tls:
 for result,expected in [({'status':'dispatched','count':1},True),({'status':'partial','count':1},True),({'status':'dispatched','count':0},False),({'status':'dispatched','count':True},False)]:
  assert wake.dispatch(config,args,opener)==expected
 request,options=calls[0]
 assert options=={'timeout':3,'context':'pinned-context'}
 assert request.headers['Authorization'].startswith('Bearer ')
 assert json.loads(request.data)['caller']=='+442012345678'
 assert 'token' not in request.full_url
 assert not wake.dispatch(dict(config,gatewayUrl='http://gateway.example'),args,opener)
 assert not wake.dispatch(config,['404','caller','name','invalid'],opener)
 tls.assert_called_with(cafile='/etc/frp/gateway-ca.crt')
print('PASS')
`;
    const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(result.status, 0, result.stderr);
});

test('dispatcher stdout is exactly one decision byte for Asterisk SHELL comparisons', () => {
    const script = `import contextlib,importlib.util,io,stat,types,unittest.mock as mock
spec=importlib.util.spec_from_file_location('wake',${JSON.stringify(path.join(root, 'scripts/webrtc-wake-dispatch.py'))})
wake=importlib.util.module_from_spec(spec);spec.loader.exec_module(wake)
info=types.SimpleNamespace(st_mode=stat.S_IFREG|0o640,st_uid=0,st_size=2)
with mock.patch.object(wake.Path,'lstat',return_value=info), mock.patch.object(wake.Path,'read_text',return_value='{}'):
 for decision,expected in [(True,'1'),(False,'0')]:
  output=io.StringIO()
  with mock.patch.object(wake,'dispatch',return_value=decision),contextlib.redirect_stdout(output):wake.main()
  assert output.getvalue()==expected,repr(output.getvalue())
 output=io.StringIO()
 with mock.patch.object(wake,'dispatch',side_effect=RuntimeError('private error')),contextlib.redirect_stdout(output):wake.main()
 assert output.getvalue()=='0',repr(output.getvalue())
print('PASS')
`;
    const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(result.status, 0, result.stderr);
});
