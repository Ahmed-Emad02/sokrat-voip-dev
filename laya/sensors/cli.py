"""
Laya Sensors — Asterisk CLI Interface
Executes safe non-blocking Asterisk queries and parses structured telemetry.
"""

import subprocess
import re
import os
import select
import time
import termios
import datetime
from laya.config import ASTERISK_BIN

# Serial liveness verdicts
LIVENESS_ALIVE = "ALIVE"      # Modem answered AT (baseband firmware is responsive)
LIVENESS_DEAD = "DEAD"        # Port present but modem did not answer (firmware deadlock)
LIVENESS_ABSENT = "ABSENT"    # No such serial device node (hardware not enumerated)
LIVENESS_BUSY = "BUSY"        # Port held by another process (chan_dongle owns it)

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

    The Asterisk CLI always exits with status 0, so the response text must be
    inspected to detect a failure. The driver answers with either
        "[<id>] '<cmd>' AT command queued"      -> success
        "[<id>] '<cmd>' Device disconnected"     -> failure
        "[<id>] '<cmd>' <error text>"            -> failure

    Returns (success: bool, response_str: str, stderr: str).
    """
    success, stdout, stderr = exec_asterisk_cmd(f"dongle cmd {dongle_id} {at_cmd}", timeout=5)
    if not success:
        return False, stdout, stderr or "Asterisk CLI command failed"

    out = (stdout or "").strip()
    if not out:
        return False, "", "Empty response from Asterisk CLI"

    if "AT command queued" in out:
        return True, out, ""

    # Any other wording (e.g. "Device disconnected", "No such device") is a failure
    return False, out, out

def dongle_at_command_queued(dongle_id, at_cmd):
    """
    Convenience wrapper: returns only the boolean success flag of an AT command
    being accepted into the driver's command queue.
    """
    ok, _resp, _err = send_dongle_at_command(dongle_id, at_cmd)
    return ok

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

def _device_port_held_by(dev_node):
    """
    Returns the PID of the process currently holding dev_node open, or None.
    Used to avoid probing a serial port that chan_dongle already owns, because
    the driver consumes the AT reply and the probe would report a false DEAD.
    """
    target = os.path.realpath(dev_node)
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        fd_dir = f"/proc/{pid}/fd"
        try:
            fds = os.listdir(fd_dir)
        except Exception:
            continue
        for fd in fds:
            try:
                link = os.readlink(f"{fd_dir}/{fd}")
            except Exception:
                continue
            if link == target:
                try:
                    with open(f"/proc/{pid}/comm", "r") as f:
                        comm = f.read().strip()
                except Exception:
                    comm = "?"
                return int(pid), comm
    return None

def probe_dongle_serial_liveness(dongle_id, port=None, timeout=2.0):
    """
    Ground-truth liveness probe: writes a raw 'AT' command directly to the modem's
    PCUI/control serial port, bypassing Asterisk entirely.

    This is the ONLY signal that can distinguish a *dead modem baseband* from a
    *dormant but healthy modem*, because Asterisk's own view is the component that
    is broken in the exact scenario we need to detect.

    IMPORTANT: the probe refuses to run while chan_dongle still owns the port,
    because the driver would consume the 'OK' reply and produce a false DEAD.
    The port is only released by the driver when the dongle has been disconnected,
    which is precisely the state we need to interrogate.

    Returns a dict:
      {
        "verdict":   LIVENESS_ALIVE | LIVENESS_DEAD | LIVENESS_ABSENT | LIVENESS_BUSY,
        "port":      the serial device path used (or None),
        "response":  raw text returned by the modem (or ""),
        "holder":    "pid/comm" of the process owning the port (or None),
        "detail":    human readable explanation
      }
    """
    result = {
        "verdict": LIVENESS_ABSENT,
        "port": None,
        "response": "",
        "holder": None,
        "detail": "No serial port resolved"
    }

    # Resolve the control port for THIS dongle only (strict isolation)
    dev_node = port
    if not dev_node:
        try:
            from laya.sensors.sysfs import get_dongle_configured_ports_from_conf
            conf_ports = get_dongle_configured_ports_from_conf(dongle_id)
            dev_node = conf_ports.get("data") or conf_ports.get("audio")
        except Exception:
            dev_node = None

    if not dev_node:
        result["detail"] = "No data=/audio= port configured in dongle.conf"
        return result

    result["port"] = dev_node

    if not os.path.exists(dev_node):
        result["verdict"] = LIVENESS_ABSENT
        result["detail"] = f"{dev_node} does not exist (modem not enumerated on USB bus)"
        return result

    # Ownership guard: never race chan_dongle for the port
    holder = _device_port_held_by(dev_node)
    if holder:
        result["verdict"] = LIVENESS_BUSY
        result["holder"] = f"{holder[0]}/{holder[1]}"
        result["detail"] = f"{dev_node} is owned by {holder[0]}/{holder[1]} (chan_dongle active) - probe skipped"
        return result

    fd = None
    try:
        fd = os.open(dev_node, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as e:
        if e.errno in (11, 16):  # EAGAIN / EBUSY
            result["verdict"] = LIVENESS_BUSY
            result["detail"] = f"{dev_node} could not be opened (device busy)"
        else:
            result["verdict"] = LIVENESS_DEAD
            result["detail"] = f"{dev_node} could not be opened: {e}"
        return result

    try:
        # Standard 8N1 115200 raw serial configuration
        attr = termios.tcgetattr(fd)
        attr[0] = 0                      # iflag: raw
        attr[1] = 0                      # oflag: raw
        attr[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
        attr[3] = 0                      # lflag: raw
        attr[4] = termios.B115200
        attr[5] = termios.B115200
        attr[6][termios.VMIN] = 0
        attr[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, attr)

        try:
            termios.tcflush(fd, termios.TCIOFLUSH)
        except Exception:
            pass

        os.write(fd, b"AT\r\n")

        deadline = time.time() + timeout
        buf = b""
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    chunk = os.read(fd, 512)
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk
                if b"OK" in buf or b"ERROR" in buf:
                    break

        text = buf.decode(errors="ignore").strip()
        result["response"] = text

        if "OK" in text:
            result["verdict"] = LIVENESS_ALIVE
            result["detail"] = "Modem answered 'AT' with OK"
        elif text:
            result["verdict"] = LIVENESS_ALIVE
            result["detail"] = f"Modem responded: {text[:80]}"
        else:
            result["verdict"] = LIVENESS_DEAD
            result["detail"] = f"No response from {dev_node} within {timeout}s (firmware deadlock suspected)"
    except Exception as e:
        result["verdict"] = LIVENESS_DEAD
        result["detail"] = f"Serial probe error on {dev_node}: {e}"
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except Exception:
                pass

    return result

def scan_asterisk_log_for_dongle_faults(dongle_id, log_path="/var/log/asterisk/full", lookback_seconds=300):
    """
    Parses the Asterisk log for the driver's own failure signatures for a specific
    dongle within the recent past.

    These signatures are emitted by the Sokrat-patched chan_dongle and are the
    authoritative indicator that the modem baseband stopped answering AT commands:
      - PRIMARY  "timedout while waiting"  -> modem stopped answering AT entirely
      - PRIMARY  "Error initializing Dongle" -> init sequence could not complete
      - WEAK     "Dongle has disconnected" -> only meaningful when paired with a primary

    Timestamps embedded in the log lines are used to honour lookback_seconds, so
    stale historical faults never trigger a heal.

    Returns (found: bool, signature: str, occurrences: int).
    """
    primary_sigs = ["timedout while waiting", "Error initializing Dongle"]
    weak_sigs = ["Dongle has disconnected"]

    try:
        if not os.path.isfile(log_path):
            return False, "", 0
        size = os.path.getsize(log_path)
        read_size = min(size, 4 * 1024 * 1024)
        with open(log_path, "rb") as f:
            f.seek(size - read_size)
            raw = f.read().decode(errors="ignore")
    except Exception:
        return False, "", 0

    cutoff = time.time() - lookback_seconds
    now = datetime.datetime.now()
    found_sig = ""
    count = 0

    for line in raw.splitlines():
        if f"[{dongle_id}]" not in line and f"[{dongle_id.lower()}]" not in line:
            continue

        is_primary = any(s in line for s in primary_sigs)
        is_weak = any(s in line for s in weak_sigs)
        if not (is_primary or is_weak):
            continue

        # Honour the lookback window using the log's own timestamp
        ts_match = re.match(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]', line)
        if ts_match:
            try:
                line_ts = datetime.datetime.strptime(ts_match.group(1), "%Y-%m-%d %H:%M:%S")
            except Exception:
                line_ts = now
            if (now - line_ts).total_seconds() > lookback_seconds:
                continue
        else:
            # No parsable timestamp -> do not trust the line
            continue

        if is_primary:
            count += 1
            if not found_sig:
                for s in primary_sigs:
                    if s in line:
                        found_sig = s
                        break
        elif is_weak:
            # Weak signal only counts when a primary fault was already seen
            if count > 0:
                count += 1

    return (count > 0), found_sig, count

def scan_asterisk_log_for_sms_faults(dongle_id, log_path="/var/log/asterisk/full", lookback_seconds=300):
    """
    Parses the Asterisk log for SMS storage errors and full-memory warnings:
      - "SMS storage is full"
      - "+CMS ERROR: 322"
      - "Error parsing incoming message"
    """
    sms_sigs = ["SMS storage is full", "+CMS ERROR: 322", "Error parsing incoming message"]
    try:
        if not os.path.isfile(log_path):
            return False, "", 0
        size = os.path.getsize(log_path)
        read_size = min(size, 4 * 1024 * 1024)
        with open(log_path, "rb") as f:
            f.seek(size - read_size)
            raw = f.read().decode(errors="ignore")
    except Exception:
        return False, "", 0

    now = datetime.datetime.now()
    found_sig = ""
    count = 0

    for line in raw.splitlines():
        if f"[{dongle_id}]" not in line and f"[{dongle_id.lower()}]" not in line:
            continue
        is_sms_fault = any(s in line for s in sms_sigs)
        if not is_sms_fault:
            continue
        ts_match = re.match(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]', line)
        if ts_match:
            try:
                line_ts = datetime.datetime.strptime(ts_match.group(1), "%Y-%m-%d %H:%M:%S")
            except Exception:
                line_ts = now
            if (now - line_ts).total_seconds() > lookback_seconds:
                continue
        else:
            continue
        count += 1
        if not found_sig:
            for s in sms_sigs:
                if s in line:
                    found_sig = s
                    break

    return (count > 0), found_sig, count

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

