#!/usr/bin/env python3
import sys
import subprocess

def agi_cmd(cmd):
    sys.stdout.write(cmd + "\n")
    sys.stdout.flush()
    return sys.stdin.readline()

# Read AGI env headers until blank line
agi_env = {}
while True:
    line = sys.stdin.readline().strip()
    if not line:
        break
    if ':' in line:
        k, v = line.split(':', 1)
        agi_env[k.strip()] = v.strip()

target_ext = sys.argv[1].strip() if len(sys.argv) > 1 else ''
supervisor_chan = agi_env.get('agi_channel', '')

if not target_ext:
    sys.exit(0)

try:
    out = subprocess.check_output(['/usr/sbin/asterisk', '-rx', 'core show channels concise']).decode('utf-8', errors='ignore')
except Exception:
    sys.exit(0)

emp_chan = ''
bridge_id = ''
peer_chan = ''

for line in out.splitlines():
    parts = line.split('!')
    if len(parts) >= 11:
        chan = parts[0].strip()
        bid = parts[10].strip()
        cid = parts[7].strip()
        if (f'/{target_ext}-' in chan or cid == target_ext or f'PJSIP/{target_ext}' in chan or f'SIP/{target_ext}' in chan) and chan != supervisor_chan:
            emp_chan = chan
            bridge_id = bid
            break

if bridge_id:
    for line in out.splitlines():
        parts = line.split('!')
        if len(parts) >= 11:
            chan = parts[0].strip()
            bid = parts[10].strip()
            if bid == bridge_id and chan != emp_chan and chan != supervisor_chan:
                peer_chan = chan
                break

# 1. FIRST: Bridge Supervisor active channel to Client channel while trunk is alive!
if peer_chan:
    agi_cmd(f'EXEC Bridge "{peer_chan},p"')

# 2. SECOND: Hangup Employee channel to kick employee out of call
if emp_chan:
    agi_cmd(f'EXEC SoftHangup "{emp_chan}"')
