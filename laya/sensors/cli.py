"""
Laya Sensors — Asterisk CLI Interface
Executes safe non-blocking Asterisk queries and parses structured telemetry.
"""

import subprocess
import re
from laya.config import ASTERISK_BIN

def exec_asterisk_cmd(cmd_args, timeout=5):
    """
    Executes an Asterisk CLI command safely with a strict timeout.
    Returns (success: bool, stdout: str, stderr: str).
    """
    try:
        proc = subprocess.run(
            [ASTERISK_BIN, "-rx", cmd_args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            universal_newlines=True
        )
        return proc.returncode == 0, proc.stdout.strip(), proc.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, "", "Command timed out"
    except Exception as e:
        return False, "", str(e)

def parse_dongle_devices_summary():
    """
    Runs 'dongle show devices' and returns a list of dictionaries with device summary.
    """
    success, stdout, _ = exec_asterisk_cmd("dongle show devices", timeout=4)
    if not success or not stdout:
        return []

    lines = stdout.splitlines()
    devices = []
    
    # Header format: ID Group State RSSI Mode Submode Provider Name Model Firmware IMEI IMSI Number
    for line in lines:
        line_clean = line.strip()
        if not line_clean or line_clean.startswith("ID") or "Group" in line_clean and "State" in line_clean:
            continue
        parts = re.split(r'\s+', line_clean)
        if len(parts) >= 3 and parts[0].startswith("dongle"):
            dongle_id = parts[0]
            group = parts[1] if len(parts) > 1 else "0"
            state = parts[2] if len(parts) > 2 else "Unknown"
            
            # Handle multi-word state like "Not connected"
            offset = 0
            if state.lower() == "not" and len(parts) > 3 and parts[3].lower().startswith("connec"):
                state = "Not connected"
                offset = 1
            
            rssi = 0
            if len(parts) > (3 + offset):
                try:
                    rssi = int(parts[3 + offset])
                except ValueError:
                    rssi = 0
            
            number = parts[-1] if len(parts) > 4 else "Unknown"
            imsi = parts[-2] if len(parts) > 5 else ""
            imei = parts[-3] if len(parts) > 6 else ""
            
            devices.append({
                "id": dongle_id,
                "group": group,
                "state": state,
                "rssi": rssi,
                "number": number,
                "imsi": imsi,
                "imei": imei
            })
            
    return devices

def get_dongle_device_state(dongle_id):
    """
    Runs 'dongle show device state <dongle_id>' and extracts detailed diagnostics.
    """
    success, stdout, _ = exec_asterisk_cmd(f"dongle show device state {dongle_id}", timeout=4)
    if not success or not stdout:
        return None

    detail = {
        "id": dongle_id,
        "state": "Unknown",
        "audio_port": None,
        "data_port": None,
        "manufacturer": None,
        "model": None,
        "firmware": None,
        "imei": None,
        "imsi": None,
        "subscriber_number": None,
        "gsm_registration": "Unknown",
        "rssi_dbm": None,
        "rssi_raw": 0,
        "tasks_in_queue": 0,
        "commands_in_queue": 0,
        "active_calls": 0,
        "dialing_calls": 0,
        "alerting_calls": 0,
        "incoming_calls": 0,
        "waiting_calls": 0,
        "held_calls": 0
    }

    for line in stdout.splitlines():
        if ":" not in line:
            continue
        key, val = [p.strip() for p in line.split(":", 1)]
        k_lower = key.lower()
        
        if k_lower == "state":
            detail["state"] = val
        elif k_lower == "audio":
            detail["audio_port"] = val
        elif k_lower == "data":
            detail["data_port"] = val
        elif k_lower == "model":
            detail["model"] = val
        elif k_lower == "firmware":
            detail["firmware"] = val
        elif k_lower == "imei":
            detail["imei"] = val
        elif k_lower == "imsi":
            detail["imsi"] = val
        elif k_lower == "subscriber number":
            detail["subscriber_number"] = val
        elif k_lower == "gsm registration status":
            detail["gsm_registration"] = val
        elif k_lower == "rssi":
            # format: "14, -85 dBm"
            m = re.match(r'(\d+)(?:,\s*(-?\d+)\s*dBm)?', val)
            if m:
                detail["rssi_raw"] = int(m.group(1))
                if m.group(2):
                    detail["rssi_dbm"] = int(m.group(2))
        elif k_lower == "tasks in queue":
            detail["tasks_in_queue"] = int(val) if val.isdigit() else 0
        elif k_lower == "commands in queue":
            detail["commands_in_queue"] = int(val) if val.isdigit() else 0
        elif k_lower == "active":
            detail["active_calls"] = int(val) if val.isdigit() else 0
        elif k_lower == "dialing":
            detail["dialing_calls"] = int(val) if val.isdigit() else 0
        elif k_lower == "alerting":
            detail["alerting_calls"] = int(val) if val.isdigit() else 0
        elif k_lower == "incoming":
            detail["incoming_calls"] = int(val) if val.isdigit() else 0
        elif k_lower == "waiting":
            detail["waiting_calls"] = int(val) if val.isdigit() else 0
        elif k_lower == "held":
            detail["held_calls"] = int(val) if val.isdigit() else 0

    return detail

def parse_active_channels():
    """
    Runs 'core show channels concise' and returns a list of active channels mapped to their technology.
    """
    success, stdout, _ = exec_asterisk_cmd("core show channels concise", timeout=4)
    if not success or not stdout:
        return []

    channels = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line or "!" not in line:
            continue
        parts = line.split("!")
        if len(parts) >= 11:
            chan_name = parts[0]
            exten = parts[2]
            state = parts[4]
            app = parts[5]
            app_data = parts[6]
            caller_id = parts[7]
            duration = int(parts[10]) if parts[10].isdigit() else 0
            bridged = parts[11] if len(parts) > 11 else ""
            
            dongle_id = None
            if chan_name.lower().startswith("dongle/"):
                d_match = re.match(r'Dongle/([a-zA-Z0-9]+)-', chan_name, re.IGNORECASE)
                if d_match:
                    dongle_id = d_match.group(1).lower()

            channels.append({
                "channel": chan_name,
                "dongle_id": dongle_id,
                "state": state,
                "app": app,
                "app_data": app_data,
                "caller_id": caller_id,
                "duration": duration,
                "bridged": bridged
            })
    return channels

def send_dongle_at_command(dongle_id, at_cmd):
    """
    Sends an AT command to a dongle via Asterisk 'dongle cmd <id> <cmd>'.
    Returns (success: bool, response_str: str).
    """
    return exec_asterisk_cmd(f"dongle cmd {dongle_id} {at_cmd}", timeout=5)

def hangup_asterisk_channel(channel_name):
    """
    Requests a hangup for a specific Asterisk channel.
    """
    return exec_asterisk_cmd(f"channel request hangup {channel_name}", timeout=4)

def restart_dongle_module(dongle_id):
    """
    Restarts a single dongle in chan_dongle: 'dongle restart now <dongle_id>'.
    """
    return exec_asterisk_cmd(f"dongle restart now {dongle_id}", timeout=6)

def get_total_active_calls():
    """
    Returns the total number of active calls across Asterisk.
    """
    success, stdout, _ = exec_asterisk_cmd("core show channels count", timeout=4)
    if success and stdout:
        for line in stdout.splitlines():
            if "active call" in line.lower():
                parts = line.strip().split()
                if parts and parts[0].isdigit():
                    return int(parts[0])
    # Fallback to parsing active channels list
    channels = parse_active_channels()
    return len(channels)

def is_any_dongle_call_active():
    """
    Checks if there is ANY active voice/ringing channel on ANY GSM dongle.
    """
    channels = parse_active_channels()
    for ch in channels:
        if ch.get("dongle_id") or ch.get("channel", "").lower().startswith("dongle/"):
            return True
    return False

