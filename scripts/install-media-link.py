#!/usr/bin/env python3
"""Install one reviewed host-to-host media link from a private stdin bundle.

Used by both gateway and PBX installers. Does not accept paths, commands, routes
or scripts from the caller. Must be promoted to a root-owned bundle before use.
The bundle's optional ``transport`` selects the media path: absent/null keeps
the legacy reverse-TLS FRP link, ``{'mode': 'direct-udp', 'host': ..., 'port':
...}`` installs the gateway as the public UDP TLS server, and ``mode:
'plain-udp'`` installs the HMAC-authenticated UDP daemon instead of OpenVPN.
The effective choice is written to ``transport.json`` beside plan.json for
operational inspection.
No secret is printed. Does not alter FRP, Asterisk, TURN or existing call paths.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

from tunnel_media import link_script, media_config, validate_plan, validate_transport

ROOT = Path('/etc/sokrat/media')
UNIT_ROOT = Path('/etc/systemd/system')
MARKER = '# Managed by Sokrat install-media-link.py\n'


def private_directory(path):
    for ancestor in reversed([path, *path.parents]):
        if not ancestor.exists():
            ancestor.mkdir(mode=0o700)
        info = ancestor.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Untrusted media installation directory')
    if path == ROOT or path.parent == ROOT:
        os.chmod(path, 0o700)


def write(path, data, mode):
    if path.is_symlink():
        raise ValueError('Symlink refused')
    if path.exists():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Untrusted media installation file')
        if path.read_text() == data and stat.S_IMODE(info.st_mode) == mode:
            return False
    fd, temporary = tempfile.mkstemp(prefix='.media-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            os.fchmod(out.fileno(), mode)
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


def openvpn_binary():
    # Resolve the packaged binary for both the version probe and media unit.
    for candidate in ('/usr/sbin/openvpn', '/usr/bin/openvpn', '/usr/local/sbin/openvpn'):
        if os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which('openvpn')
    if found:
        return found
    raise ValueError('Supported OpenVPN package required')


def version():
    result = subprocess.run([openvpn_binary(), '--version'], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, universal_newlines=True, timeout=10)
    text = result.stdout
    match = re.search(r'^OpenVPN (2)\.(\d+)', text)
    if not match:
        raise ValueError('Supported OpenVPN package required')
    return tuple(map(int, match.groups()))


def link_daemon():
    daemon = Path(__file__).absolute().with_name('udp-media-link.py')
    try:
        for parent in daemon.parents:
            info = parent.lstat()
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
                    or info.st_mode & 0o022):
                raise ValueError('Trusted plain media daemon directory required')
        info = daemon.lstat()
    except FileNotFoundError:
        raise ValueError('Trusted plain media daemon required') from None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('Trusted plain media daemon required')
    return daemon


def daemon_digest(daemon):
    """Content digest of the trusted plain-udp renderer."""
    return hashlib.sha256(daemon.read_bytes()).hexdigest()


def validate_material(material, plan, role, transport=None):
    validate_plan(plan)
    if role not in ('gateway', 'pbx'):
        raise ValueError('Invalid media role')
    transport = validate_transport(transport, plan)
    if transport is not None and transport['mode'] == 'plain-udp':
        # One shared key, exact syntax, checked before any directory or unit
        # change. Plain material must never be parsed as a certificate bundle.
        if not isinstance(material, dict) or set(material) != {'udp.key'}:
            raise ValueError('Invalid plain media material')
        key = material['udp.key']
        if not isinstance(key, str) or not re.fullmatch(r'[a-f0-9]{64}\n', key):
            raise ValueError('Invalid plain media key')
        return
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
    names = {'ca.crt', role + '.crt', role + '.key', 'tls-crypt.key'}
    if not isinstance(material, dict) or set(material) != names:
        raise ValueError('Invalid role-specific TLS material')
    if any(not isinstance(value, str) or len(value) > 16384 for value in material.values()):
        raise ValueError('Invalid TLS material')
    cert = x509.load_pem_x509_certificate(material[role + '.crt'].encode())
    ca = x509.load_pem_x509_certificate(material['ca.crt'].encode())
    key = serialization.load_pem_private_key(material[role + '.key'].encode(), password=None)
    if not isinstance(ca.public_key(), ec.EllipticCurvePublicKey) or not isinstance(key, ec.EllipticCurvePrivateKey):
        raise ValueError('Unsupported media key type')
    # Subject/issuer equality alone does not verify a certificate signature.
    ca.public_key().verify(ca.signature, ca.tbs_certificate_bytes, ec.ECDSA(ca.signature_hash_algorithm))
    ca.public_key().verify(cert.signature, cert.tbs_certificate_bytes, ec.ECDSA(cert.signature_hash_algorithm))
    now = datetime.datetime.utcnow()
    for item in (ca, cert):
        if not item.not_valid_before <= now < item.not_valid_after:
            raise ValueError('Expired or future media certificate')
    if (not ca.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
            or cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca):
        raise ValueError('Invalid media certificate constraints')
    encode = lambda public: public.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    if encode(key.public_key()) != encode(cert.public_key()) or cert.issuer != ca.subject:
        raise ValueError('Mismatched media certificate')
    if cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value != plan['pbxId'] + '-' + role:
        raise ValueError('Wrong media identity')
    # The presented role follows the transport: direct-udp makes the gateway
    # the TLS server, so a certificate from the other mode is refused here.
    server = (role == 'gateway') == (transport is not None)
    usage = ExtendedKeyUsageOID.SERVER_AUTH if server else ExtendedKeyUsageOID.CLIENT_AUTH
    if list(cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value) != [usage]:
        raise ValueError('Wrong media certificate role')
    if not re.fullmatch(r'-----BEGIN OpenVPN Static key V1-----\n(?:[a-f0-9]{32}\n){16}-----END OpenVPN Static key V1-----\n', material['tls-crypt.key']):
        raise ValueError('Invalid tls-crypt key')


def install(document, role, start=False):
    if os.geteuid() != 0:
        raise ValueError('Root is required')
    plan = validate_plan(document['plan'])
    # Transport is checked before any directory, key, unit or service change.
    transport = validate_transport(document.get('transport'), plan)
    plain = transport is not None and transport['mode'] == 'plain-udp'
    material = document['material']
    validate_material(material, plan, role, transport)
    directory = ROOT / plan['pbxId']
    daemon = link_daemon() if plain else None
    # A plain host needs no OpenVPN package or version probe at all.
    if plain:
        config = media_config(plan, role, str(directory), transport=transport)
        execute = f'{sys.executable} {daemon} --config {directory}/media.conf'
    else:
        binary = openvpn_binary()
        config = media_config(plan, role, str(directory), version(), transport)
        execute = f'{binary} --config {directory}/media.conf'
    private_directory(directory)
    private_directory(UNIT_ROOT)
    unit = UNIT_ROOT / ('sokrat-media-' + plan['pbxId'] + '.service')
    if unit.exists() and (unit.is_symlink() or not unit.read_text().startswith(MARKER)):
        raise ValueError('Unmanaged media service already exists')
    changed = False
    for name, value in material.items():
        changed = write(directory / name, value, 0o600) or changed
    changed = write(directory / 'link-up', link_script(plan, role, True), 0o700) or changed
    changed = write(directory / 'link-down', link_script(plan, role, False), 0o700) or changed
    changed = write(directory / 'media.conf', config, 0o600) or changed
    changed = write(directory / 'plan.json', json.dumps(plan, sort_keys=True) + '\n', 0o600) or changed
    changed = write(directory / 'transport.json', json.dumps(transport, sort_keys=True) + '\n', 0o600) or changed
    kind = 'plain UDP' if plain else ('direct UDP' if transport is not None else 'reverse TLS')
    # The plain renderer is a host file, not unit content. Recording its digest
    # here makes an upgrade that only replaces udp-media-link.py change
    # generated state, so convergence restarts the running link instead of
    # leaving stale code in place.
    renderer = ('# renderer-sha256=' + daemon_digest(daemon) + '\n') if plain else ''
    content = MARKER + renderer + f'''[Unit]
Description=Sokrat isolated {kind} media {plan['pbxId']}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={execute}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW
RestrictAddressFamilies=AF_INET AF_UNIX AF_NETLINK

[Install]
WantedBy=multi-user.target
'''
    changed = write(unit, content, 0o644) or changed
    if start:
        subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=20)
        subprocess.run(['systemctl', 'enable', unit.name], check=True, timeout=20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['systemctl', 'restart' if changed else 'start', unit.name],
                       check=True, timeout=30)
    return {'pbxId': plan['pbxId'], 'role': role, 'configured': True,
            'started': start, 'transport': transport}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', required=True, choices=['gateway', 'pbx'])
    parser.add_argument('--start', action='store_true')
    args = parser.parse_args()
    raw = sys.stdin.read(65537)
    if len(raw) > 65536:
        raise ValueError('Media bundle too large')
    result = install(json.loads(raw), args.role, args.start)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never expose input bundles, private keys or subprocess environment.
        sys.stderr.write('Media link installation failed; check packages, permissions and private bundle\n')
        sys.exit(1)
