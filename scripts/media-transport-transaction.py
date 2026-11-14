#!/usr/bin/env python3
"""Stage, apply, verify or roll back one explicitly selected direct-UDP media link.

Run on each host from a reviewed root-owned bundle. Gateway prepare writes a
private peer-bundle.json; transfer it over SSH and feed it to PBX prepare. No
credentials are printed. Only the existing per-PBX media unit is restarted.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import time

from tunnel_media import validate_plan, validate_transport
from tunnel_media_material import for_role, new_material
import importlib.util

BACKUPS = Path('/var/backups/sokrat-media')
ENROLLMENT = Path('/etc/sokrat/tunnel-enrollment')
SETTINGS = Path('/etc/sokrat/gateway-tunnel-v2.json')
ID_RE = re.compile(r'^pbx_[a-f0-9]{16}$')
TX_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')


def installer():
    spec = importlib.util.spec_from_file_location('media_installer', Path(__file__).with_name('install-media-link.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def transaction_path(pbx_id, transaction_id):
    if not isinstance(pbx_id, str) or not ID_RE.fullmatch(pbx_id):
        raise ValueError('Invalid PBX identity')
    if not isinstance(transaction_id, str) or not TX_RE.fullmatch(transaction_id):
        raise ValueError('Invalid transaction identity')
    return BACKUPS / pbx_id / transaction_id


def private_read(path):
    installer().private_directory(path.parent)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 2 * 1024 * 1024:
        raise ValueError('Untrusted or oversized transaction input')
    return path.read_text()


def read_json(path):
    return json.loads(private_read(path))


def save_json(path, value):
    installer().write(path, json.dumps(value, sort_keys=True) + '\n', 0o600)


def selected_entry(registry, pbx_id):
    matches = [(key, value) for key, value in registry.items() if value.get('pbxId') == pbx_id]
    if len(matches) != 1:
        raise ValueError('Exactly one enrolled PBX must match')
    return matches[0]


def replace_entry(registry, pbx_id, expected, replacement):
    """Never replace another tenant or overwrite a concurrent identity change."""
    key, current = selected_entry(registry, pbx_id)
    if current != expected:
        raise ValueError('Enrolled installation changed; automatic overwrite refused')
    result = dict(registry)
    result[key] = replacement
    return result


@contextlib.contextmanager
def lock(role):
    # The gateway shares its exact lock with enrollment/reconciliation.
    if role == 'gateway':
        config = read_json(Path('/etc/sokrat/gateway-provisioning.json'))
        directory = Path(config.get('lockDir', '/run/sokrat-tenant-provisioning'))
    else:
        directory = Path('/run/sokrat-media-transaction')
    installer().private_directory(directory)
    fd = os.open(str(directory / 'lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, 'r+b') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise ValueError('Untrusted transaction lock')
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def run(args, check=True):
    return subprocess.run(args, check=check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)


def media_paths(pbx_id):
    return Path('/etc/sokrat/media') / pbx_id, Path('/etc/systemd/system') / ('sokrat-media-' + pbx_id + '.service')


def reconcile_media_firewall(role, check=True):
    """Open/record the gateway UDP endpoint; never touches a PBX host firewall."""
    if role != 'gateway':
        return
    helper = Path(__file__).with_name('media-udp-firewall.py')
    if not helper.is_file():
        if check:
            raise ValueError('Gateway media UDP firewall helper is missing')
        return
    try:
        run([sys.executable, str(helper), '--apply'], check=check)
    except (OSError, subprocess.SubprocessError):
        if check:
            raise ValueError('Gateway media UDP firewall reconcile failed') from None


def fingerprint(directory, unit):
    digest = hashlib.sha256()
    for path in [*sorted(directory.iterdir()), unit]:
        content = private_read(path)
        digest.update(path.name.encode() + b'\0' + content.encode() + b'\0')
        digest.update(str(stat.S_IMODE(path.stat().st_mode)).encode())
    return digest.hexdigest()


def snapshot(pbx_id, destination):
    directory, unit = media_paths(pbx_id)
    if not private_read(unit).startswith(installer().MARKER):
        raise ValueError('Unmanaged media service refused')
    # Refuse arbitrary/symlink entries before copying any live material.
    before = fingerprint(directory, unit)
    if run(['systemctl', 'is-active', '--quiet', unit.name], check=False).returncode:
        raise ValueError('An active enrolled media link is required for cutover')
    installer().private_directory(destination)
    shutil.copytree(directory, destination / 'old-media')
    shutil.copy2(unit, destination / 'old-unit')
    return before


def check_gateway_endpoint(registry, pbx_id, transport, bind_port=True):
    """Recheck tenant ownership and, when requested, that the UDP port is free."""
    for other in registry.values():
        assigned = other.get('mediaTransport')
        if (other.get('pbxId') != pbx_id and isinstance(assigned, dict)
                and assigned.get('port') == transport['port']):
            raise ValueError('Media UDP port is assigned to another tenant')
    if bind_port:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as listener:
            listener.bind(('0.0.0.0', transport['port']))


def gateway_media_port_unchanged(state):
    old_transport = (state.get('oldEntry') or {}).get('mediaTransport')
    new_transport = (state.get('document') or {}).get('transport')
    return (state.get('role') == 'gateway'
            and isinstance(old_transport, dict)
            and isinstance(new_transport, dict)
            and old_transport.get('port') == new_transport.get('port'))


def prepare(role, pbx_id, transaction_id, peer_document=None, transport_mode='direct-udp', transport_port=None):
    directory, _ = media_paths(pbx_id)
    destination = transaction_path(pbx_id, transaction_id)
    if destination.exists():
        raise ValueError('Transaction already exists; use status/apply/rollback or a new identity')
    plan = validate_plan(read_json(directory / 'plan.json'))
    if plan['pbxId'] != pbx_id:
        raise ValueError('Installed media identity differs')
    state = {'role': role, 'pbxId': pbx_id, 'transactionId': transaction_id, 'state': 'prepared'}
    if role == 'gateway':
        config = read_json(ENROLLMENT / 'config.json')
        registry = read_json(ENROLLMENT / 'installations.json')
        _, entry = selected_entry(registry, pbx_id)
        if entry['plan'] != plan:
            raise ValueError('Installed media plan differs from the enrolled plan')
        old_transport = validate_transport(entry.get('mediaTransport'), plan)
        port = 26000 + plan['slot'] if transport_port is None else transport_port
        transport = validate_transport({'mode': transport_mode, 'host': config['publicHost'], 'port': port}, plan)
        if old_transport == transport:
            raise ValueError('Selected media endpoint is already active')
        # A prepare is allowed to leave the tenant's own existing listener in
        # place. Only a validated same-port self-endpoint may skip the bind;
        # every other target (legacy, foreign or cross-tenant) is checked now.
        own_port = old_transport is not None and old_transport['port'] == transport['port']
        check_gateway_endpoint(registry, pbx_id, transport, bind_port=not own_port)
        old_material = read_json(ENROLLMENT / pbx_id / 'material.json')
        material = new_material(plan, transport=transport)
        material['readinessKey'] = old_material['readinessKey']
        state.update(oldEntry=entry, oldMaterial=old_material, newMaterial=material)
        document = {'plan': plan, 'transport': transport, 'material': for_role(material, role)}
        peer_document = {'transactionId': transaction_id, 'plan': plan, 'transport': transport, 'material': for_role(material, 'pbx')}
    else:
        if not isinstance(peer_document, dict) or peer_document.get('transactionId') != transaction_id or peer_document.get('plan') != plan:
            raise ValueError('Peer bundle does not match this transaction and installed PBX')
        document = {key: peer_document[key] for key in ('plan', 'transport', 'material')}
        settings = read_json(SETTINGS)
        if settings.get('pbxId') != pbx_id or settings.get('plan') != plan:
            raise ValueError('Saved PBX installation identity differs')
        if document['transport'].get('host') != settings.get('serverHost'):
            raise ValueError('Direct endpoint must match the enrolled gateway')
        state['oldSettings'] = settings
    transport = validate_transport(document['transport'], plan)
    if transport is None:
        raise ValueError('Direct UDP transport required')
    install = installer()
    install.validate_material(document['material'], plan, role, transport=transport)
    # The plaintext daemon does not require or execute OpenVPN.
    options = {'transport': transport}
    if transport['mode'] != 'plain-udp':
        options['version'] = install.version()
    install.media_config(plan, role, str(directory), **options)
    state['fingerprint'] = snapshot(pbx_id, destination)
    state['document'] = document
    if role == 'gateway':
        save_json(destination / 'peer-bundle.json', peer_document)
    save_json(destination / 'state.json', state)
    return state


def recoverable_temporary(name, info):
    """Only the installer's private mkstemp files may be removed on recovery."""
    return (re.fullmatch(r'\.media-[a-z0-9_]{8}', name) is not None
            and stat.S_ISREG(info.st_mode) and info.st_uid == 0
            and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1)


def restore_files(state, destination):
    directory, unit = media_paths(state['pbxId'])
    original = destination / 'old-media'
    old_names = {path.name for path in original.iterdir()}
    # Only material the selected role's installer generated for this document
    # may be removed; unknown files still fail closed.
    added_names = {'transport.json'}
    material = state['document'].get('material')
    if isinstance(material, dict):
        added_names.update(material)
    # Only files generated by the media installer may have appeared at apply.
    for path in directory.iterdir():
        private_read(path)
        if path.name not in old_names:
            if path.name not in added_names and not recoverable_temporary(path.name, path.lstat()):
                raise ValueError('Unexpected media file; rollback refuses deletion')
            path.unlink()
    for path in original.iterdir():
        installer().write(directory / path.name, private_read(path), stat.S_IMODE(path.stat().st_mode))
    installer().write(unit, private_read(destination / 'old-unit'), stat.S_IMODE((destination / 'old-unit').stat().st_mode))


def rollback(state, destination):
    if state['state'] == 'rolled-back':
        return state
    if state['state'] not in ('applying', 'applied', 'verified'):
        raise ValueError('Transaction has not been applied')
    _, unit = media_paths(state['pbxId'])
    # Validate all external identity state before stopping the live link.
    if state['role'] == 'gateway':
        registry = read_json(ENROLLMENT / 'installations.json')
        expected = dict(state['oldEntry'], mediaTransport=state['document']['transport'])
        _, current = selected_entry(registry, state['pbxId'])
        if current not in (state['oldEntry'], expected):
            raise ValueError('Installation changed after cutover; rollback refused')
    else:
        current = read_json(SETTINGS)
        expected = dict(state['oldSettings'], mediaTransport=state['document']['transport'])
        if current not in (state['oldSettings'], expected):
            raise ValueError('PBX settings changed after cutover; rollback refused')
    run(['systemctl', 'stop', unit.name])
    restore_files(state, destination)
    if state['role'] == 'gateway':
        save_json(ENROLLMENT / 'installations.json', replace_entry(registry, state['pbxId'], current, state['oldEntry']))
        save_json(ENROLLMENT / state['pbxId'] / 'material.json', state['oldMaterial'])
    else:
        save_json(SETTINGS, state['oldSettings'])
    if not gateway_media_port_unchanged(state):
        reconcile_media_firewall(state['role'], check=False)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'start', unit.name])
    state['state'] = 'rolled-back'
    save_json(destination / 'state.json', state)
    return state


def apply(state, destination):
    if state['state'] in ('applied', 'verified'):
        return state
    if state['state'] != 'prepared':
        raise ValueError('Transaction is not prepared')
    directory, unit = media_paths(state['pbxId'])
    if fingerprint(directory, unit) != state['fingerprint']:
        raise ValueError('Media configuration changed since prepare')
    if state['role'] == 'gateway':
        registry = read_json(ENROLLMENT / 'installations.json')
        check_gateway_endpoint(registry, state['pbxId'], state['document']['transport'],
                               bind_port=not gateway_media_port_unchanged(state))
        replacement = dict(state['oldEntry'], mediaTransport=state['document']['transport'])
        registry = replace_entry(registry, state['pbxId'], state['oldEntry'], replacement)
        if read_json(ENROLLMENT / state['pbxId'] / 'material.json') != state['oldMaterial']:
            raise ValueError('Media certificates changed since prepare')
    elif read_json(SETTINGS) != state['oldSettings']:
        raise ValueError('PBX settings changed since prepare')
    state['state'] = 'applying'
    save_json(destination / 'state.json', state)
    try:
        run(['systemctl', 'stop', unit.name])
        if state['role'] == 'gateway':
            # The tenant's own listener is gone now; the target port must be
            # proven free before any registry/key commit or media start.
            check_gateway_endpoint(registry, state['pbxId'], state['document']['transport'])
            save_json(ENROLLMENT / 'installations.json', registry)
            save_json(ENROLLMENT / state['pbxId'] / 'material.json', state['newMaterial'])
        else:
            save_json(SETTINGS, dict(state['oldSettings'], mediaTransport=state['document']['transport']))
        if not gateway_media_port_unchanged(state):
            reconcile_media_firewall(state['role'])
        installer().install(state['document'], state['role'], start=True)
        state['state'] = 'applied'
        save_json(destination / 'state.json', state)
        return state
    except Exception:
        rollback(state, destination)
        raise


def verify(state, destination):
    if state['role'] != 'gateway' or state['state'] not in ('applied', 'verified'):
        raise ValueError('Verify the applied gateway transaction after applying both hosts')
    config = read_json(ENROLLMENT / 'config.json')
    hooks = read_json(Path(config['trustedStateDir']) / 'hook-tokens.json')
    request = {'pbxId': state['pbxId'], 'enabled': True, 'peerIps': [state['document']['plan']['pbxIp']], 'token': hooks[state['pbxId']]}
    deadline = time.monotonic() + 45
    while True:
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('check-tunnel-readiness.py')), state['pbxId']], input=json.dumps(request), universal_newlines=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        if result.returncode == 0:
            state['state'] = 'verified'
            save_json(destination / 'state.json', state)
            return state
        if time.monotonic() >= deadline:
            raise ValueError('Direct UDP readiness failed; roll back BOTH hosts using this transaction identity')
        time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'apply', 'verify', 'rollback', 'status'))
    parser.add_argument('--role', choices=('gateway', 'pbx'), required=True)
    parser.add_argument('--pbx-id', required=True)
    parser.add_argument('--transaction-id', required=True)
    parser.add_argument('--transport', choices=('direct-udp', 'plain-udp'))
    parser.add_argument('--udp-port', type=int)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Root is required')
    if (args.transport is not None or args.udp_port is not None) and (args.action != 'prepare' or args.role != 'gateway'):
        raise ValueError('Select transport and UDP port only when preparing the gateway')
    destination = transaction_path(args.pbx_id, args.transaction_id)
    with lock(args.role):
        if args.action == 'prepare':
            peer = None
            if args.role == 'pbx':
                raw = sys.stdin.read(65537)
                if len(raw) > 65536:
                    raise ValueError('Peer bundle too large')
                peer = json.loads(raw)
            state = prepare(args.role, args.pbx_id, args.transaction_id, peer,
                            transport_mode=args.transport or 'direct-udp', transport_port=args.udp_port)
        else:
            state = read_json(destination / 'state.json')
            if state.get('role') != args.role or state.get('pbxId') != args.pbx_id or state.get('transactionId') != args.transaction_id:
                raise ValueError('Transaction identity differs')
            if args.action == 'apply':
                state = apply(state, destination)
            elif args.action == 'rollback':
                state = rollback(state, destination)
            elif args.action == 'verify':
                state = verify(state, destination)
        print(json.dumps({key: state[key] for key in ('pbxId', 'role', 'transactionId', 'state')}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never echo enrollment documents, private keys, subprocess output or secrets.
        detail = str(error) if isinstance(error, ValueError) else type(error).__name__
        print('Direct-media transaction refused: ' + detail, file=sys.stderr)
        sys.exit(1)
