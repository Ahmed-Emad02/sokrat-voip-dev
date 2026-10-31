#!/usr/bin/env python3
"""Compile exact WebRTC extension wake entries; never override shared dial macros.

Dry-run by default. --apply changes only managed files and an additive include
in the already active override file. Standard SIP and non-WebRTC PJSIP routes,
generated FreePBX source and existing custom content are never rewritten.
"""
import argparse
import datetime
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

MARKER = '; Managed by Sokrat WebRTC wake v1'
INCLUDE_BEGIN = '; BEGIN SOKRAT WEBRTC WAKE INCLUDE v1'
INCLUDE_END = '; END SOKRAT WEBRTC WAKE INCLUDE v1'
NAME = 'extensions_sokrat_webrtc_wake.conf'
DISPATCHER_MARKER = 'Authenticated WebRTC wake dispatcher v1.'
WAKE = r'''
[sub-sokrat-webrtc-wake]
exten => s,1,GotoIf($["${DB(DEVICE/${ARG1}/tech)}"!="pjsip"]?done)
 same => n,GotoIf($["${DB(DND/${ARG1})}"!=""]?done)
 same => n,GotoIf($["${DB(CF/${ARG1})}"!=""]?done)
 same => n,GotoIf($["${DB(CFU/${ARG1})}"!="" & ("${EXTENSION_STATE(${ARG1})}"="UNAVAILABLE" | "${EXTENSION_STATE(${ARG1})}"="UNKNOWN")]?done)
 same => n,GotoIf($["${SOKRAT_WAKE_SENT_${ARG1}}"="1"]?done)
 same => n,Set(__SOKRAT_WAKE_SENT_${ARG1}=1)
 same => n,GotoIf($["${SOKRAT_CALL_ID}"!=""]?identified)
 same => n,Set(__SOKRAT_CALL_ID=${FILTER(0-9a-f-,${SHELL(/usr/bin/uuidgen)})})
 same => n(identified),Set(HASH(__SIPHEADERS,X-Sokrat-Call-ID)=${SOKRAT_CALL_ID})
 same => n,Set(__SOKRAT_PUSH_SENT=1)
 same => n,Set(__SOKRAT_WAKE_CALLEE=${ARG1})
 same => n,Set(CHANNEL(hangup_handler_push)=sub-sokrat-webrtc-wake-cancel,s,1)
 same => n,Set(SOKRAT_BEFORE_DIAL=${PJSIP_DIAL_CONTACTS(${ARG1})})
 same => n,Set(SOKRAT_BEFORE_COUNT=${FIELDQTY(SOKRAT_BEFORE_DIAL,&)})
 same => n,Set(SOKRAT_WAKE_WAIT=${SHELL(/usr/bin/python3 /usr/local/bin/sokrat-webrtc-wake-dispatch.py "${URIENCODE(${ARG1})}" "${URIENCODE(${CALLERID(num)})}" "${URIENCODE(${CALLERID(name)})}" "${SOKRAT_CALL_ID}")})
 same => n,GotoIf($["${SOKRAT_WAKE_WAIT}"!="1"]?done)
 same => n,Ringing()
 same => n,Set(SOKRAT_WAKE_ITER=0)
 same => n(wait),Set(SOKRAT_AFTER_DIAL=${PJSIP_DIAL_CONTACTS(${ARG1})})
 same => n,GotoIf($[${FIELDQTY(SOKRAT_AFTER_DIAL,&)}>${SOKRAT_BEFORE_COUNT}]?done)
 same => n,Wait(0.2)
 same => n,Set(SOKRAT_WAKE_ITER=$[${SOKRAT_WAKE_ITER}+1])
 same => n,GotoIf($[${SOKRAT_WAKE_ITER}<60]?wait)
 same => n(done),Return()

[sub-sokrat-webrtc-wake-cancel]
exten => s,1,GotoIf($["${SOKRAT_PUSH_SENT}"!="1"]?done)
 same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?done)
 same => n,System(/usr/bin/python3 /usr/local/bin/sokrat-webrtc-wake-dispatch.py "${SOKRAT_WAKE_CALLEE}" "${SOKRAT_CALL_ID}" &)
 same => n(done),Return()
'''


def read(path, missing=''):
    if not path.exists() and not path.is_symlink():
        return missing
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > 4 * 1024 * 1024:
        raise ValueError('Expected bounded regular file: ' + path.name)
    return path.read_text()


def contexts(text):
    result = {}
    name = None
    for line in text.splitlines():
        header = re.fullmatch(r'\s*\[([^\]]+)\](?:\([^)]*\))?\s*(?:;.*)?', line)
        if header:
            name = header.group(1)
            if name in result:
                raise ValueError('Duplicate context/section: ' + name)
            result[name] = []
        elif name:
            result[name].append(line)
    return result


def endpoint_ids(text):
    return sorted(name for name, lines in contexts(text).items()
                  if re.fullmatch(r'[0-9]{1,12}', name)
                  and any(re.fullmatch(r'\s*webrtc\s*=\s*yes\s*(?:;.*)?', line, re.I) for line in lines))


def render(generated, extensions):
    if not extensions:
        return MARKER + '\n; No paired WebRTC extensions; normal routing unchanged.\n'
    local = contexts(generated).get('ext-local')
    if local is None:
        raise ValueError('Missing generated ext-local context')
    output = [MARKER, '; Exact provisioned WebRTC entries only. Original FreePBX applications are preserved.', '[ext-local]']
    for extension in extensions:
        rows = []
        for line in local:
            match = re.match(r'\s*exten\s*=>\s*' + re.escape(extension) + r'\s*,\s*([^,]+),(.*)$', line)
            if match and match.group(1).strip() != 'hint':
                rows.append((match.group(1).strip(), match.group(2).strip()))
        # Recognize only the two exact FreePBX templates we have reviewed: the
        # standard IVR return and the voicemail-enabled variant. Do not
        # approximate custom numeric jumps, extra applications or custom routes.
        if (len(rows) < 4 or rows[0][0] != '1' or not rows[0][1].startswith('Set(__RINGTIMER=')
                or rows[1][0] != 'n' or not rows[1][1].startswith('Macro(exten-vm,')
                or (',' + extension + ',') not in rows[1][1]
                or rows[2] != ('n(dest)', 'Set(__PICKUPMARK=)')):
            raise ValueError('Unsupported generated WebRTC route template: ' + extension)
        standard_tail = len(rows) == 4 and rows[3] == ('n', 'Goto(${IVR_CONTEXT},return,1)')
        voicemail_tail = (len(rows) == 5
                and rows[3] == ('n', 'Macro(vm,' + extension + ',${DIALSTATUS},${IVR_RETVM})')
                and rows[4] == ('n', 'Goto(vmret,1)'))
        if not (standard_tail or voicemail_tail):
            raise ValueError('Unsupported generated WebRTC route template: ' + extension)
        output.append('exten => ' + extension + ',1,' + rows[0][1])
        output.append('exten => ' + extension + ',n,Gosub(sub-sokrat-webrtc-wake,s,1(${EXTEN}))')
        output.extend('exten => ' + extension + ',' + priority + ',' + application for priority, application in rows[1:])
    return '\n'.join(output) + '\n' + WAKE


def trusted_parent(path, root, executable=False):
    for parent in [path.parent] + list(path.parent.parents):
        if not parent.exists() and not parent.is_symlink():
            continue
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError('Symlink/non-directory parent refused')
        if executable and (info.st_uid != os.geteuid() or info.st_mode & 0o022):
            raise ValueError('Untrusted executable installation directory')
        if parent == root:
            break


def atomic(path, text, mode, group=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.sokrat-wake-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists():
            info = path.lstat()
            os.chown(temp, info.st_uid, info.st_gid)
        if group is not None:
            os.chown(temp, os.geteuid(), group)
        os.replace(temp, str(path))
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def plan(root):
    etc = root / 'etc/asterisk'
    hook_path = root / 'etc/sokrat/gateway-hook.json'
    settings_path = root / 'etc/sokrat/gateway-tunnel-v2.json'
    output_path = etc / NAME
    existing = read(output_path)
    if existing and not existing.startswith(MARKER + '\n'):
        raise ValueError('Refusing unmanaged WebRTC wake file')
    if not hook_path.exists() or not settings_path.exists():
        if not existing:
            return [], []
        extensions = []
    else:
        for config_path in (hook_path, settings_path):
            info = config_path.lstat()
            if info.st_uid != os.geteuid() or info.st_mode & 0o037:
                raise ValueError('Private root-owned enrollment files required')
            trusted_parent(config_path, root, executable=True)
        hook = json.loads(read(hook_path)); settings = json.loads(read(settings_path))
        if (not re.fullmatch(r'pbx_[a-f0-9]{16}', settings.get('pbxId', ''))
                or hook.get('pbxId') != settings['pbxId'] or not hook.get('gatewayUrl', '').startswith('https://')
                or hook.get('caFile') != '/etc/frp/gateway-ca.crt'):
            raise ValueError('Matching pinned gateway enrollment required')
        extensions = endpoint_ids(read(etc / 'pjsip_custom_post.conf'))
    generated = read(etc / 'extensions_additional.conf')
    # A stale post-config section is not proof that the extension is still
    # WebRTC. The generated normal route must also identify this exact PJSIP
    # endpoint; never intercept a converted standard SIP extension.
    local = contexts(generated).get('ext-local', [])
    extensions = [ext for ext in extensions if any(re.match(r'\s*exten\s*=>\s*' + re.escape(ext)
                  + r'\s*,\s*hint\s*,\s*PJSIP/' + re.escape(ext) + r'(?:,|\s*$)', line) for line in local)]
    rendered = render(generated, extensions)
    core = read(etc / 'extensions.conf')
    candidates = re.findall(r'^\s*#include\s+(extensions_override_(?:issabelpbx|freepbx)\.conf)\s*$', core, re.M)
    if len(candidates) != 1:
        raise ValueError('Expected one active FreePBX/Issabel override include')
    anchor = etc / candidates[0]
    original = read(anchor)
    block = INCLUDE_BEGIN + '\n#include ' + NAME + '\n' + INCLUDE_END
    if original.count(INCLUDE_BEGIN) != original.count(INCLUDE_END) or original.count(INCLUDE_BEGIN) > 1:
        raise ValueError('Ambiguous managed include')
    clean = re.sub(re.escape(INCLUDE_BEGIN) + r'\n.*?\n' + re.escape(INCLUDE_END) + r'\n?', '', original, flags=re.S)
    visited = set()
    def inspect_override(path):
        if path in visited:
            return
        if len(visited) >= 32:
            raise ValueError('Override include depth exceeded')
        visited.add(path)
        text = clean if path == anchor else read(path)
        for name, lines in contexts(text).items():
            if name in ('sub-sokrat-webrtc-wake',):
                raise ValueError('Unmanaged WebRTC wake context already exists')
            if name == 'ext-local':
                for line in lines:
                    if any(re.match(r'\s*exten\s*=>\s*' + re.escape(ext) + r'\s*,', line) for ext in extensions):
                        raise ValueError('Existing custom route owns a WebRTC extension')
        for line in text.splitlines():
            # Asterisk accepts both #include file.conf and #include "file.conf".
            # Only plain local .conf names are inspected; globs, absolute paths
            # and substitutions remain refused.
            match = re.match(r'^\s*#(?:try)?include\s+(?:"([A-Za-z0-9_.-]+\.conf)"|([A-Za-z0-9_.-]+\.conf))\s*$', line)
            if match:
                name = match.group(1) or match.group(2)
                if name == NAME:
                    raise ValueError('Unmanaged/complex override include refused')
                inspect_override(etc / name)
    inspect_override(anchor)
    amended = clean.rstrip('\n') + '\n' + block + '\n'
    source = Path(__file__).with_name('webrtc-wake-dispatch.py')
    dispatcher = read(source)
    if DISPATCHER_MARKER not in dispatcher:
        raise ValueError('Reviewed dispatcher source missing')
    compile(dispatcher, str(source), 'exec')
    target = root / 'usr/local/bin/sokrat-webrtc-wake-dispatch.py'
    previous = read(target)
    if previous and DISPATCHER_MARKER not in previous:
        raise ValueError('Refusing unmanaged dispatcher')
    if previous and (target.stat().st_uid != os.geteuid() or target.stat().st_mode & 0o022):
        raise ValueError('Untrusted installed dispatcher')
    changes = [(target, dispatcher, 0o755), (output_path, rendered, 0o640),
               (anchor, amended, anchor.stat().st_mode & 0o777)]
    for path, _, _ in changes:
        trusted_parent(path, root, executable=(path == target))
    group = grp.getgrnam('asterisk').gr_gid if root == Path('/') else etc.stat().st_gid
    return [(path, text, mode) for path, text, mode in changes if read(path) != text or
            (path in (target, output_path) and path.exists() and
             (path.stat().st_mode & 0o777 != mode or
              (path == output_path and path.stat().st_gid != group)))], extensions


def verify_access(root, extensions, runner=subprocess.run):
    """Exercise real service-user access without sending a push or placing a call."""
    if not extensions:
        return 'not-required'
    if root != Path('/'):
        raise ValueError('Service-user verification requires the real PBX root')
    # Credential contents and child stderr must never be emitted to installer
    # logs. Merely running the dispatcher with no arguments is insufficient:
    # it intentionally returns 0 even if its private hook config is unreadable.
    probe = '''import subprocess,sys
from pathlib import Path
for name in ('/usr/local/bin/sokrat-webrtc-wake-dispatch.py',
             '/etc/sokrat/gateway-hook.json', '/etc/frp/gateway-ca.crt',
             '/etc/asterisk/extensions_sokrat_webrtc_wake.conf'):
    with open(name, 'rb') as stream:
        stream.read(1)
result = subprocess.run(['/usr/bin/python3', '/usr/local/bin/sokrat-webrtc-wake-dispatch.py'],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
if result.returncode != 0 or result.stdout != b'0' or result.stderr:
    sys.exit(1)
sys.stdout.write('0')
'''
    try:
        result = runner(['runuser', '-u', 'asterisk', '--', '/usr/bin/python3', '-c', probe],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('Asterisk-user wake access check could not run; check runuser/Python availability')
    if result.returncode != 0 or result.stdout != b'0' or result.stderr:
        raise ValueError('Asterisk-user wake access check failed; verify dispatcher, hook, CA and managed dialplan permissions')
    return 'passed'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--no-reload', action='store_true')
    parser.add_argument('--verify-access', action='store_true',
                        help='verify dispatcher/config access as Asterisk without sending a push')
    parser.add_argument('--root', default='/', help='isolated fixture root; production uses /')
    args = parser.parse_args()
    root = Path(args.root).absolute()
    if root == Path('/') and args.apply and os.geteuid() != 0:
        raise ValueError('Root required')
    changes, extensions = plan(root)
    if not args.apply:
        result = {'mode': 'dry-run', 'extensions': extensions, 'changedFiles': [p.name for p, _, _ in changes]}
        if args.verify_access:
            result['accessVerification'] = verify_access(root, extensions)
        print(json.dumps(result))
        return
    lock_path = root / 'run/sokrat-webrtc-wake.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    trusted_parent(lock_path, root, executable=True)
    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, 'r+b') as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise ValueError('Unsafe wake lock')
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        changes, extensions = plan(root)
        if changes:
            stamp = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%S%fZ')
            backup = root / 'var/backups/sokrat-voip' / ('webrtc-wake-' + stamp)
            backup.mkdir(parents=True, mode=0o700)
            for path, _, _ in changes:
                if path.exists():
                    (backup / path.name).write_text(read(path))
                    (backup / path.name).chmod(0o600)
            for path, text, mode in changes:
                group = None
                if path.name == NAME:
                    group = grp.getgrnam('asterisk').gr_gid if root == Path('/') else path.parent.stat().st_gid
                atomic(path, text, mode, group)
        verification = verify_access(root, extensions) if args.verify_access else None
        if changes and not args.no_reload and root == Path('/'):
            subprocess.run(['asterisk', '-rx', 'dialplan reload'], check=True, timeout=15, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        result = {'mode': 'apply', 'changed': bool(changes), 'extensions': extensions,
                  'sourceDigest': hashlib.sha256(read(root / 'etc/asterisk/extensions_additional.conf').encode()).hexdigest()}
        if args.verify_access:
            result['accessVerification'] = verification
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('WebRTC wake refused: ' + str(error), file=__import__('sys').stderr)
        raise SystemExit(2)
