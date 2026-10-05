#!/usr/bin/env python3
"""
Sokrat VoIP - Camp-On (Callback When Free) AGI Integration
Invoked by Asterisk dialplan when an extension requests or cancels an automatic callback.
"""
import sys
import json
import urllib.request
import urllib.error

# Read standard AGI environment headers until blank line
while True:
    try:
        line = sys.stdin.readline()
        if not line or line.strip() == '':
            break
    except Exception:
        break

action = sys.argv[1].strip() if len(sys.argv) > 1 else 'register'
caller_ext = sys.argv[2].strip() if len(sys.argv) > 2 else ''
target_ext = sys.argv[3].strip() if len(sys.argv) > 3 else ''

if not caller_ext:
    sys.exit(0)

payload = {
    'action': action,
    'callerExt': caller_ext,
    'targetExt': target_ext
}

try:
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        'http://127.0.0.1:8080/api/telephony/camp-on/dialplan-trigger',
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        pass
except Exception:
    pass

sys.exit(0)
