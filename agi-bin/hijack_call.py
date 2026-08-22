#!/usr/bin/env python3
import sys
import subprocess
import threading
import time

def agi_cmd(cmd):
    sys.stdout.write(cmd + "\n")
    sys.stdout.flush()
    return sys.stdin.readline()

def get_channel_var(chan, var_expr):
    try:
        res = agi_cmd(f'GET FULL VARIABLE "${{{var_expr}}}" "{chan}"')
        if 'result=1' in res and '(' in res and ')' in res:
            val = res[res.find('(') + 1 : res.rfind(')')].strip()
            if val and val not in ('(None)', 'None', 'none'):
                return val
    except Exception:
        pass
    return ''

def terminate_employee_async(chan):
    def _do():
        time.sleep(0.15)
        try:
            subprocess.run(
                ['/usr/sbin/asterisk', '-rx', f'channel request hangup {chan}'],
                timeout=2,
                capture_output=True
            )
        except Exception:
            pass
    t = threading.Thread(target=_do)
    t.daemon = True
    t.start()

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
    out = subprocess.check_output(
        ['/usr/sbin/asterisk', '-rx', 'core show channels concise'],
        timeout=3
    ).decode('utf-8', errors='ignore')
except Exception:
    out = ''

emp_chan = ''
bridge_id = ''
direct_peer = ''
peer_chan = ''

lines = [ln for ln in out.splitlines() if ln.strip()]

# 1. Identify employee channel and bridge metadata
for line in lines:
    parts = line.split('!')
    if len(parts) >= 8:
        chan = parts[0].strip()
        cid = parts[7].strip()
        # Match target extension against channel name or caller ID
        is_target = (
            chan.startswith(f'PJSIP/{target_ext}-') or
            chan.startswith(f'SIP/{target_ext}-') or
            chan.startswith(f'IAX2/{target_ext}-') or
            chan.startswith(f'Local/{target_ext}@') or
            f'/{target_ext}-' in chan or
            f'/{target_ext}@' in chan or
            cid == target_ext
        )
        if is_target and chan != supervisor_chan:
            emp_chan = chan
            # In Asterisk 18 concise output: index 12 is bridge_id, index 11 is bridged_channel
            if len(parts) >= 13:
                bridge_id = parts[12].strip()
            if len(parts) >= 12:
                dp = parts[11].strip()
                if dp and dp not in ('(None)', 'None', 'none'):
                    direct_peer = dp
            break

# 2. Resolve peer channel using Bridge ID (primary)
if bridge_id:
    for line in lines:
        parts = line.split('!')
        if len(parts) >= 13:
            chan = parts[0].strip()
            bid = parts[12].strip()
            if bid == bridge_id and chan != emp_chan and chan != supervisor_chan:
                peer_chan = chan
                break

# 3. Fallback to direct bridged channel from concise output
if not peer_chan and direct_peer and direct_peer != emp_chan and direct_peer != supervisor_chan:
    peer_chan = direct_peer

# 4. Fallback to AGI channel variables (BRIDGEPEER / CHANNEL(peername))
if not peer_chan and emp_chan:
    bp = get_channel_var(emp_chan, 'BRIDGEPEER')
    if bp and bp != emp_chan and bp != supervisor_chan:
        peer_chan = bp
    else:
        pn = get_channel_var(emp_chan, 'CHANNEL(peername)')
        if pn and pn != emp_chan and pn != supervisor_chan:
            peer_chan = pn

# 5. Fallback to CLI dialplan show chanvar
if not peer_chan and emp_chan:
    try:
        c_out = subprocess.check_output(
            ['/usr/sbin/asterisk', '-rx', f'dialplan show chanvar {emp_chan}'],
            timeout=2
        ).decode('utf-8', errors='ignore')
        for cline in c_out.splitlines():
            if 'BRIDGEPEER=' in cline:
                bp = cline.split('BRIDGEPEER=', 1)[1].strip()
                if bp and bp not in ('(None)', 'None', 'none') and bp != emp_chan and bp != supervisor_chan:
                    peer_chan = bp
                    break
    except Exception:
        pass

# 6. Execution: Terminate employee channel asynchronously and bridge supervisor to peer
if emp_chan:
    terminate_employee_async(emp_chan)

if peer_chan:
    agi_cmd(f'EXEC Bridge "{peer_chan},p"')

if emp_chan:
    try:
        agi_cmd(f'EXEC SoftHangup "{emp_chan}"')
    except Exception:
        pass
