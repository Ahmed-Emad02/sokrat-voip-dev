#!/usr/bin/env python3
"""Isolated Asterisk routing harness for the Sokrat WebRTC wake hook.

Safety:
- Import-only: never runs install-webrtc-wake.py --apply and never writes the
  global dispatcher. The generated wake file is rendered into a private temp
  root with the real busy/CW/CF/DND expressions.
- Starts its own `asterisk -f` with autoload=no, temp config/AstDB/run/log/spool,
  a unique systemname, no transports/listeners, and terminates only its own PID.
- Before any AstDB write it verifies the CLI reports this run's systemname and
  temp AstDB/run directories. On mismatch it kills its own Popen only.
- PJSIP contact/endpoint guards are the only stubbed expressions; eligibility
  policy (DND/CF/CFU/CW/CWIGNORE/CFB and extension state) executes for real.

Run on a host with Asterisk modules and an empty temp-friendly environment:
  python3 test/wake-routing-harness.py --asterisk /usr/sbin/asterisk
The Node wrapper skips unless WAKE_ASTERISK_BIN is set.
The --serve mode emits the validated private config as JSON and keeps only that
fixture alive until stdin closes; conversion tests use it for real AstDB reads.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
INSTALLER = ROOT / 'scripts' / 'install-webrtc-wake.py'
CALL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
CALLS = 'calls.log'
HASHES = 'hash.log'


def load_installer():
    spec = importlib.util.spec_from_file_location('sokrat_wake_installer', INSTALLER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def generated_fixture():
    rows = []
    for extension in ('101', '102'):
        rows.extend([
            f'exten => {extension},1,Set(__RINGTIMER=10)',
            f'exten => {extension},n,Macro(exten-vm,novm,{extension},0,0,0)',
            f'exten => {extension},n(dest),Set(__PICKUPMARK=)',
            f'exten => {extension},n,Goto(${{IVR_CONTEXT}},return,1)',
            f'exten => {extension},hint,PJSIP/{extension},CustomPresence:{extension}',
        ])
    return '[ext-local]\n' + '\n'.join(rows) + '\n'


def render_wake():
    installer = load_installer()
    text = installer.render(generated_fixture(), ['101', '102'])
    # Only provider-specific contact checks are stubbed. The busy/CW/CF/DND
    # eligibility expressions and the call-id hash stay real.
    for argument in ('${ARG1}', '${SOKRAT_GROUP_MEMBER}'):
        text = text.replace('${PJSIP_DIAL_CONTACTS(' + argument + ')}', '')
    text = text.replace('${PJSIP_ENDPOINT(${SOKRAT_GROUP_MEMBER},webrtc)}', 'yes')
    return text


def write_text(path, text, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


def build_root(root):
    etc = root / 'etc/asterisk'
    dirs = {
        'astetcdir': etc,
        'astmoddir': os.environ.get('WAKE_ASTERISK_MODULE_DIR', '/usr/lib64/asterisk/modules'),
        'astvarlibdir': root / 'var/lib/asterisk',
        'astdbdir': root / 'var/lib/asterisk',
        'astkeydir': root / 'var/lib/asterisk',
        'astdatadir': root / 'usr/share/asterisk',
        'astagidir': root / 'var/lib/asterisk/agi-bin',
        'astspooldir': root / 'var/spool/asterisk',
        'astrundir': root / 'var/run/asterisk',
        'astlogdir': root / 'var/log/asterisk',
        'astsbindir': '/usr/sbin',
    }
    for directory in dirs.values():
        if isinstance(directory, Path):
            directory.mkdir(parents=True, exist_ok=True)
    shutil.copytree(os.environ.get('WAKE_ASTERISK_DOCUMENTATION_DIR',
                                  '/var/lib/asterisk/documentation'),
                    dirs['astdatadir'] / 'documentation')
    conf = '[directories]\n' + ''.join(f'{key} => {value}\n' for key, value in dirs.items())
    conf += f'\n[options]\nsystemname = {root.name}\n'
    write_text(etc / 'asterisk.conf', conf)
    modules = '''[modules]
autoload=no
load => pbx_config.so
load => app_stack.so
load => app_exec.so
load => app_system.so
load => res_clioriginate.so
load => app_ringing.so
load => func_db.so
load => func_devstate.so
load => func_logic.so
load => func_strings.so
load => func_cut.so
load => func_extstate.so
load => func_shell.so
load => func_uri.so
load => func_channel.so
load => func_callerid.so
'''
    write_text(etc / 'modules.conf', modules)
    write_text(etc / 'logger.conf', '[general]\n[logfiles]\n')
    write_text(etc / 'http.conf', '[general]\nenabled=no\n')
    write_text(etc / 'pjsip.conf', '; no transports, no endpoints: PJSIP guards are stubbed\n')

    stub = root / 'bin' / 'sokrat-webrtc-wake-dispatch.py'
    stub.parent.mkdir(parents=True, exist_ok=True)
    stub.write_text(
        '#!/usr/bin/python3\n'
        'import json, sys\n'
        'from pathlib import Path\n'
        f'with Path({str(root / CALLS)!r}).open("a") as output:\n'
        '    output.write(json.dumps(sys.argv[1:]) + "\\n")\n'
        'print(0)\n')
    stub.chmod(0o755)
    wake = render_wake().replace(
        '/usr/local/bin/sokrat-webrtc-wake-dispatch.py', str(stub))
    # Keep the fake provider synchronous so completion implies all calls logged.
    wake = re.sub(r'(System\([^\n]*?)\s*&\)', r'\1)', wake)
    write_text(etc / 'wake.conf', wake, 0o640)

    contexts = ['#include wake.conf', '[default]', 'include => test-hints', '[test-hints]',
                'exten => 101,hint,Custom:101',
                'exten => 102,hint,Custom:102']
    for case in CASES:
        contexts.append(f'[case-{case["id"]}]')
        contexts.append(f'exten => s,1,Set(DEVICE_STATE(Custom:101)={case["state101"]})')
        contexts.append(f' same => n,Set(DEVICE_STATE(Custom:102)={case["state102"]})')
        contexts.append(f' same => n,Set(CWIGNORE={case["cwignore"]})')
        contexts.append(f' same => n,Set(SOKRAT_CALL_ID={CALL_ID})')
        contexts.append(' same => n,Set(SOKRAT_WAKE_CALLEES=)')
        contexts.append(' same => n,Set(SOKRAT_PUSH_SENT=)')
        contexts.append(f' same => n,Set(DIALSTATUS={case["dialstatus"]})')
        fixture_db = {'DEVICE/101/tech': 'pjsip', 'DEVICE/102/tech': 'pjsip', **case['db']}
        for key, value in fixture_db.items():
            contexts.append(f' same => n,Set(DB({key})={value})')
        if case['mode'] == 'direct':
            contexts.append(' same => n,Gosub(sub-sokrat-webrtc-wake,s,1(102))')
        elif case['mode'] == 'group':
            contexts.append(f' same => n,Gosub(sub-sokrat-group-wake,s,1({case["group"]}))')
        else:
            contexts.append(f' same => n,Set(SOKRAT_PUSH_SENT=1)')
            contexts.append(f' same => n,Set(SOKRAT_WAKE_CALLEES={case["callees"]})')
            contexts.append(f' same => n,Set(SOKRAT_WAKE_CALLEE={case["callees"].split("-")[-1]})')
            contexts.append(' same => n,Gosub(sub-sokrat-webrtc-wake-cancel,s,1)')
        contexts.append(' same => n,Set(TEST_HASH=${HASH(SIPHEADERS,X-Sokrat-Call-ID)})')
        contexts.append(f' same => n,System(printf "%s\\n" "${{TEST_HASH}}" >> {root / HASHES})')
        contexts.append(' same => n,Set(DIALSTATUS=ANSWER)')
        contexts.append(' same => n,Hangup()')
    write_text(etc / 'extensions.conf', '\n'.join(contexts) + '\n')


def run_cli(asterisk, conf, command, timeout=30):
    return subprocess.run([asterisk, '-C', str(conf), '-rx', command],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          universal_newlines=True, timeout=timeout)


def start_asterisk(asterisk, root):
    conf = root / 'etc/asterisk/asterisk.conf'
    with (root / 'asterisk.log').open('w') as startup_log:
        process = subprocess.Popen([asterisk, '-C', str(conf), '-f', '-q'],
                                   stdout=startup_log, stderr=subprocess.STDOUT)
    try:
        info = ''
        for _ in range(40):
            time.sleep(0.1)
            if process.poll() is not None:
                raise RuntimeError('isolated Asterisk exited: ' + (root / 'asterisk.log').read_text())
            try:
                info = run_cli(asterisk, conf, 'core show settings', 5).stdout
            except Exception:
                continue
            if re.search(r'System name:\s*' + re.escape(root.name) + r'\s*$', info, re.M):
                astdb = re.search(r'ASTDB\s*:\s*(\S+)', info, re.I)
                rundir = re.search(r'Run/Sockets directory\s*:\s*(\S+)', info, re.I)
                if not astdb or not rundir:
                    break
                if any(root not in Path(match.group(1)).resolve().parents for match in (astdb, rundir)):
                    break
                return process, conf
        raise RuntimeError('isolated Asterisk settings verification failed: ' + info)
    except Exception:
        stop(process)
        raise


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(5)


def clear_db(asterisk, conf):
    for key in ('DEVICE/101/tech', 'DEVICE/102/tech', 'DND/102', 'CF/102',
                'CFU/102', 'CFB/102', 'CW/101', 'CW/102'):
        family, entry = key.split('/', 1)
        run_cli(asterisk, conf, f'database del {family} {entry}', 5).check_returncode()


def build_installer_hook_fixture(root):
    contexts = []
    cases = []
    matrix = [
        ('sip-special', '150', 'sip', False, False),
        ('pjsip-special', '150', 'pjsip', True, False),
        ('pjsip-other-special', '151', 'pjsip', True, False),
        ('pjsip-ordinary', '2401', 'pjsip', True, False),
        ('pjsip-renumbered', '5072', 'pjsip', True, False),
        ('pjsip-leading-zero', '0150', 'pjsip', True, False),
        ('sip-ordinary', '2401', 'sip', False, False),
        ('missing-metadata', '9999', None, False, False),
        ('empty-target', '', None, False, False),
        ('nonnumeric-target', 'agent', 'pjsip', False, False),
        ('duplicate', '5072', 'pjsip', False, True),
    ]
    for index, installer in enumerate(('install.sh', 'installer-bundle/install-sokrat.sh')):
        source = (ROOT / installer).read_text()
        # Execute the emitted priorities before UUID generation or provider I/O.
        prefix = source.split('\n[sub-sokrat-push-hook]\n', 1)[1].split(
            '\nsame => n,Set(SOKRAT_LINKEDID=', 1)[0]
        hook = f'installer-hook-{index}'
        contexts.extend([f'[{hook}]', prefix,
                         'same => n,Set(HOOK_ELIGIBLE=1)',
                         'same => n(done),Return()'])
        for name, target, tech, expected, duplicate in matrix:
            case_id = f'installer-{index}-{name}'
            result = root / (case_id + '.result')
            contexts.extend([f'[{case_id}]',
                             'exten => s,1,Set(HOOK_ELIGIBLE=0)',
                             f'same => n,Set(SOKRAT_PUSH_SENT={1 if duplicate else ""})'])
            if tech:
                contexts.append(f'same => n,Set(DB(DEVICE/{target}/tech)={tech})')
            contexts.extend([
                f'same => n,Gosub({hook},s,1({target}))',
                f'same => n,System(printf "%s\\n" "${{HOOK_ELIGIBLE}}" > {result})',
                'same => n,Hangup()',
            ])
            cases.append((installer, case_id, result, expected))
    write_text(root / 'etc/asterisk/extensions.conf', '\n'.join(contexts) + '\n')
    return cases


def check_installer_hooks(asterisk, conf, cases):
    failures = []
    for installer, case_id, result, expected in cases:
        run_cli(asterisk, conf, 'database deltree DEVICE', 5).check_returncode()
        run_cli(asterisk, conf,
                f'channel originate Local/s@{case_id} application Wait 1', 5).check_returncode()
        deadline = time.monotonic() + 5
        while not result.exists():
            if time.monotonic() >= deadline:
                raise RuntimeError(f'{case_id}: isolated hook fixture did not complete')
            time.sleep(0.02)
        actual = result.read_text().strip()
        if actual != str(int(expected)):
            failures.append(f'{installer} {case_id}: eligible={actual}, expected={int(expected)}')
    if failures:
        print('\n'.join(failures))
        return 1
    print(f'PASS ({len(cases)} installer eligibility cases)')
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--asterisk', default='/usr/sbin/asterisk')
    parser.add_argument('--keep', action='store_true')
    parser.add_argument('--installer-hooks', action='store_true')
    parser.add_argument('--serve', action='store_true')
    args = parser.parse_args()
    if not Path(args.asterisk).exists():
        raise SystemExit('asterisk executable not found: ' + args.asterisk)
    root = Path(tempfile.mkdtemp(prefix='sokrat-wake-routing-'))
    process = None
    failures = []
    try:
        build_root(root)
        installer_cases = build_installer_hook_fixture(root) if args.installer_hooks else None
        process, conf = start_asterisk(args.asterisk, root)
        if args.serve:
            print(json.dumps({'config': str(conf)}), flush=True)
            sys.stdin.read()
            return 0
        if installer_cases is not None:
            return check_installer_hooks(args.asterisk, conf, installer_cases)
        for case in CASES:
            clear_db(args.asterisk, conf)
            for name in (CALLS, HASHES):
                try:
                    (root / name).unlink()
                except FileNotFoundError:
                    pass
            started = time.monotonic()
            originated = run_cli(args.asterisk, conf,
                    f'channel originate Local/s@case-{case["id"]} application Wait 1', 30)
            originated.check_returncode()
            if 'No such command' in originated.stdout:
                raise RuntimeError(originated.stdout)
            while not (root / HASHES).exists():
                if time.monotonic() - started > 25:
                    raise RuntimeError(f'{case["id"]}: fixture never completed; see {root / "asterisk.log"}')
                time.sleep(0.05)
            elapsed = time.monotonic() - started
            calls = []
            calls_file = root / CALLS
            if calls_file.exists():
                for line in calls_file.read_text().splitlines():
                    fields = json.loads(line)
                    if fields:
                        calls.append(fields[0])
            expected = sorted(case['expect'])
            actual = sorted(calls)
            if actual != expected:
                failures.append(f'{case["id"]}: calls {actual} != {expected}')
            if case.get('expect_wait') and elapsed < 11.5:
                failures.append(f'{case["id"]}: group contact wait {elapsed:.1f}s < 11.5s')
            if not case.get('expect_wait') and elapsed > 5:
                failures.append(f'{case["id"]}: unexpected wait {elapsed:.1f}s')
            if case.get('hash'):
                hashes = (root / HASHES).read_text().splitlines() if (root / HASHES).exists() else []
                if not hashes or hashes[-1].strip() != CALL_ID:
                    failures.append(f'{case["id"]}: HASH {hashes[-1:]!r} != {CALL_ID}')
        if failures:
            print('FAIL')
            for failure in failures:
                print(' - ' + failure)
            return 1
        print('PASS')
        return 0
    finally:
        if process is not None:
            stop(process)
        if args.keep:
            print('kept ' + str(root), file=sys.stderr)
        else:
            shutil.rmtree(root, ignore_errors=True)


CASES = [
    {'id': 'direct_idle', 'mode': 'direct', 'state101': 'NOT_INUSE', 'state102': 'NOT_INUSE',
     'cwignore': '', 'dialstatus': '', 'db': {}, 'expect': ['102'], 'hash': True},
    {'id': 'direct_busy_no_cw', 'mode': 'direct', 'state101': 'NOT_INUSE', 'state102': 'INUSE',
     'cwignore': '', 'dialstatus': '', 'db': {}, 'expect': []},
    {'id': 'direct_busy_cw', 'mode': 'direct', 'state101': 'NOT_INUSE', 'state102': 'INUSE',
     'cwignore': '', 'dialstatus': '', 'db': {'CW/102': 'enabled'}, 'expect': ['102']},
    {'id': 'direct_busy_cwignore', 'mode': 'direct', 'state101': 'NOT_INUSE', 'state102': 'INUSE',
     'cwignore': 'TRUE', 'dialstatus': '', 'db': {'CW/102': 'enabled'}, 'expect': []},
    {'id': 'direct_busy_cfb_no_cw', 'mode': 'direct', 'state101': 'NOT_INUSE', 'state102': 'INUSE',
     'cwignore': '', 'dialstatus': '', 'db': {'CFB/102': '103'}, 'expect': []},
    {'id': 'direct_busy_cfb_cw', 'mode': 'direct', 'state101': 'NOT_INUSE', 'state102': 'INUSE',
     'cwignore': '', 'dialstatus': '', 'db': {'CW/102': 'enabled', 'CFB/102': '103'}, 'expect': ['102']},
    {'id': 'direct_dnd', 'mode': 'direct', 'state101': 'NOT_INUSE', 'state102': 'NOT_INUSE',
     'cwignore': '', 'dialstatus': '', 'db': {'DND/102': 'TRUE'}, 'expect': []},
    {'id': 'direct_cf', 'mode': 'direct', 'state101': 'NOT_INUSE', 'state102': 'NOT_INUSE',
     'cwignore': '', 'dialstatus': '', 'db': {'CF/102': '103'}, 'expect': []},
    {'id': 'direct_cfu_unavailable', 'mode': 'direct', 'state101': 'NOT_INUSE', 'state102': 'UNAVAILABLE',
     'cwignore': '', 'dialstatus': '', 'db': {'CFU/102': '103'}, 'expect': []},
    {'id': 'direct_cfu_idle', 'mode': 'direct', 'state101': 'NOT_INUSE', 'state102': 'NOT_INUSE',
     'cwignore': '', 'dialstatus': '', 'db': {'CFU/102': '103'}, 'expect': ['102']},
    {'id': 'group_mixed_no_cw', 'mode': 'group', 'state101': 'NOT_INUSE', 'state102': 'INUSE',
     'cwignore': '', 'dialstatus': '', 'db': {}, 'group': '101-102', 'expect': ['101'],
     'expect_wait': True, 'hash': True},
    {'id': 'group_busy_cw', 'mode': 'group', 'state101': 'INUSE', 'state102': 'INUSE',
     'cwignore': '', 'dialstatus': '', 'db': {'CW/101': 'enabled', 'CW/102': 'enabled'},
     'group': '101-102', 'expect': ['101', '102'], 'expect_wait': True},
    {'id': 'group_busy_cwignore', 'mode': 'group', 'state101': 'INUSE', 'state102': 'INUSE',
     'cwignore': 'TRUE', 'dialstatus': '', 'db': {},
     'group': '101-102', 'expect': []},
    {'id': 'cancel_multi_noanswer', 'mode': 'cancel', 'state101': 'NOT_INUSE',
     'state102': 'NOT_INUSE', 'cwignore': '', 'dialstatus': 'NOANSWER', 'db': {},
     'callees': '102-103', 'expect': ['102', '103']},
    {'id': 'cancel_single_noanswer', 'mode': 'cancel', 'state101': 'NOT_INUSE',
     'state102': 'NOT_INUSE', 'cwignore': '', 'dialstatus': 'NOANSWER', 'db': {},
     'callees': '102', 'expect': ['102']},
    {'id': 'cancel_answer_scope', 'mode': 'cancel', 'state101': 'NOT_INUSE',
     'state102': 'NOT_INUSE', 'cwignore': '', 'dialstatus': 'ANSWER', 'db': {},
     'callees': '102-103', 'expect': []},
]

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('HARNESS ERROR: ' + str(error), file=sys.stderr)
        sys.exit(2)
