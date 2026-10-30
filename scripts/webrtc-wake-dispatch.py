#!/usr/bin/env python3
"""Authenticated WebRTC wake dispatcher v1. Print only a bounded wait decision.

Called synchronously by the WebRTC-only dialplan. Credentials stay in the
existing root-owned hook config; no token, response body or provider error is
ever logged. Failure prints 0 so normal FreePBX routing remains available.
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


def dispatch(config, args, opener=urllib.request.urlopen):
    if len(args) != 4:
        return False
    callee, caller, name = [urllib.parse.unquote(value) for value in args[:3]]
    call_id = args[3]
    if (not re.fullmatch(r'[0-9]{1,12}', callee)
            or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', call_id, re.I)):
        return False
    url = urllib.parse.urlsplit(config['gatewayUrl'])
    if (url.scheme != 'https' or url.username or url.password or not url.hostname
            or url.path not in ('', '/') or url.query or url.fragment
            or config.get('caFile') != '/etc/frp/gateway-ca.crt'):
        return False
    if not re.fullmatch(r'pbx_[a-f0-9]{16}', config.get('pbxId', '')):
        return False
    token = config.get('token', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,200}', token):
        return False
    body = json.dumps({'callee': callee, 'caller': caller[:128], 'callerName': name[:256], 'callId': call_id}).encode()
    request = urllib.request.Request(config['gatewayUrl'].rstrip('/') + '/api/gateway/incoming-call', data=body,
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token,
                 'X-Sokrat-Pbx': config['pbxId'], 'X-Sokrat-Timestamp': str(int(time.time() * 1000)),
                 'X-Sokrat-Nonce': secrets.token_hex(16)}, method='POST')
    context = ssl.create_default_context(cafile=config['caFile'])
    with opener(request, timeout=3, context=context) as response:
        if response.status != 200:
            return False
        data = response.read(4097)
        if len(data) > 4096:
            return False
        result = json.loads(data)
        return (result.get('status') in ('dispatched', 'partial')
                and type(result.get('count')) is int and result['count'] > 0)


def main():
    try:
        file = Path('/etc/sokrat/gateway-hook.json')
        info = file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o007 or info.st_size > 16384:
            raise ValueError('Untrusted hook config')
        should_wait = dispatch(json.loads(file.read_text()), sys.argv[1:])
    except Exception:
        should_wait = False
    print('1' if should_wait else '0')


if __name__ == '__main__':
    main()
