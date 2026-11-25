#!/usr/bin/env python3
"""Authenticated WebRTC wake dispatcher v1. Print only a bounded wait decision.

The primary gateway is tried first. If it is unreachable or does not dispatch,
the loopback local gateway is tried as a fallback. Credentials stay in the
root-owned hook configs; no token, response body or provider error is logged.
Print 1 only when a push was dispatched but the gateway did not confirm a live
REGISTER-ed client; the dialplan then runs its bounded contact-count fallback.
A gateway-confirmed client prints 0 so Dial proceeds immediately.
"""
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import stat
import sys
import time
import urllib.parse
import urllib.request

CENTRAL_HOOK = Path('/etc/sokrat/gateway-hook.json')
LOCAL_HOOK = Path(os.environ.get('SOKRAT_LOCAL_HOOK_CONFIG', '/etc/sokrat/local-gateway-hook.json'))


def read_config(file, *, allow_http):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o007 or info.st_size > 16384:
        raise ValueError('Untrusted hook config')
    config = json.loads(file.read_text())
    url = urllib.parse.urlsplit(config['gatewayUrl'])
    schemes = ('http', 'https') if allow_http else ('https',)
    if (url.scheme not in schemes or url.username or url.password or not url.hostname
            or url.path not in ('', '/') or url.query or url.fragment):
        raise ValueError('Invalid gateway URL')
    if allow_http:
        if url.hostname not in ('127.0.0.1', 'localhost', '::1') or url.port != 18080:
            raise ValueError('Local gateway must be loopback:18080')
    elif config.get('caFile') != '/etc/frp/gateway-ca.crt':
        raise ValueError('Invalid pinned gateway TLS configuration')
    if not re.fullmatch(r'pbx_[a-f0-9]{16}', config.get('pbxId', '')):
        raise ValueError('Invalid PBX id')
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,200}', config.get('token', '')):
        raise ValueError('Invalid hook token')
    return config


def post(config, path, body, timeout, opener, read_body=True):
    url = urllib.parse.urlsplit(config['gatewayUrl'])
    request = urllib.request.Request(
        config['gatewayUrl'].rstrip('/') + path,
        data=json.dumps(body).encode(),
        headers={
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + config['token'],
            'X-Sokrat-Pbx': config['pbxId'],
            'X-Sokrat-Timestamp': str(int(time.time() * 1000)),
            'X-Sokrat-Nonce': secrets.token_hex(16),
        },
        method='POST',
    )
    context = None
    if url.scheme == 'https':
        context = ssl.create_default_context(cafile=config['caFile'])
    with opener(request, timeout=timeout, context=context) as response:
        return response.status, response.read(4097) if read_body else b''


def dispatch(config, args, opener=urllib.request.urlopen):
    if len(args) != 4:
        return False
    callee, caller, name = [urllib.parse.unquote(value) for value in args[:3]]
    call_id = args[3]
    if (not re.fullmatch(r'[0-9]{1,12}', callee)
            or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', call_id, re.I)):
        return False
    body = {'callee': callee, 'caller': caller[:128], 'callerName': name[:256], 'callId': call_id,
            'waitForSip': True}
    configs = []
    if isinstance(config, dict) and str(config.get('gatewayUrl', '')).startswith('https://'):
        configs.append(config)
    try:
        configs.append(read_config(LOCAL_HOOK, allow_http=True))
    except Exception:
        pass
    if not configs:
        return False
    dispatched = False
    sip_ready = False
    for candidate in configs:
        try:
            # The gateway sends the push first, then waits for a genuine
            # REGISTER-confirmed live client. A pre-existing PBX contact must
            # not let us skip that wait: it can be the retained WebSocket flow
            # of the app process that was just killed.
            status, data = post(candidate, '/api/gateway/incoming-call', body, 15, opener)
            if status != 200 or len(data) > 4096:
                continue
            result = json.loads(data)
            if (result.get('status') in ('dispatched', 'partial')
                    and type(result.get('count')) is int and result['count'] > 0):
                dispatched = True
                sip_ready = result.get('sipReady') is True
                break
        except Exception:
            continue
    # 1 asks the dialplan for its bounded contact-count fallback. A client the
    # gateway confirmed ready needs no fallback wait; an unconfirmed/legacy
    # response fails toward the PBX wait, never toward the dead old contact.
    return dispatched and not sip_ready


def cancel(config, args, opener=urllib.request.urlopen):
    try:
        if len(args) != 2:
            return False
        callee, call_id = args
        if (not re.fullmatch(r'[0-9]{1,12}', callee)
                or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', call_id, re.I)):
            return False
        body = {'callee': callee, 'callId': call_id}
        configs = []
        if isinstance(config, dict) and str(config.get('gatewayUrl', '')).startswith('https://'):
            configs.append(config)
        try:
            configs.append(read_config(LOCAL_HOOK, allow_http=True))
        except Exception:
            pass
        if not configs:
            return False
        delivered = False
        for candidate in configs:
            try:
                status, _ = post(candidate, '/api/gateway/cancel-call', body, 3, opener, read_body=False)
                if status == 200:
                    delivered = True
            except Exception:
                continue
        return delivered
    except Exception:
        pass
    return False


def main():
    try:
        try:
            config = read_config(CENTRAL_HOOK, allow_http=False)
        except Exception:
            config = None
        argv = sys.argv[1:]
        if len(argv) == 4:
            result = dispatch(config, argv)
        elif len(argv) == 2:
            result = cancel(config, argv)
        else:
            result = False
    except Exception:
        result = False
    # SHELL() preserves stdout, including newlines: the dialplan compares this
    # decision with the exact string "1". Emit one byte, not a printed line.
    sys.stdout.write('1' if result else '0')


if __name__ == '__main__':
    main()
