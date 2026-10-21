"""
Laya Maintenance Agent — Configuration Loader
Loads environment variables, Asterisk credentials, and daemon thresholds.
"""

import os
import re

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(INSTALL_DIR, ".env")
ISSABEL_CONF = "/etc/issabel.conf"
AMPORTAL_CONF = "/etc/amportal.conf"
SOCKET_PATH = "/run/sokrat-laya.sock"

def parse_env_file(filepath):
    config = {}
    if not os.path.isfile(filepath):
        return config
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, val = line.split("=", 1)
                    config[key.strip()] = val.strip().strip("'\"")
    except Exception:
        pass
    return config

# Load settings
_env = parse_env_file(ENV_FILE)
_issabel = parse_env_file(ISSABEL_CONF)

# Database Configuration
DB_HOST = _env.get("DB_HOST", "127.0.0.1")
DB_USER = _env.get("DB_USER", "root")
DB_PASS = _env.get("DB_PASS") or _issabel.get("mysqlrootpwd", "admin")
DB_NAME = _env.get("ASTERISK_DB", "asterisk")

# Asterisk Manager Interface (AMI) Configuration
AMI_HOST = _env.get("AMI_HOST", "127.0.0.1")
AMI_PORT = int(_env.get("AMI_PORT", 5038))
AMI_USER = _env.get("AMI_USER") or _issabel.get("amiadminpwd", "admin")
AMI_PASS = _env.get("AMI_PASS") or _issabel.get("amiadminpwd", "admin")

# Engine Polling & Diagnostic Thresholds (in seconds)
POLL_INTERVAL_SEC = int(os.environ.get("LAYA_POLL_INTERVAL", 5))
DEEP_TRIAGE_INTERVAL_SEC = int(os.environ.get("LAYA_TRIAGE_INTERVAL", 30))
STUCK_STATE_THRESHOLD_SEC = int(os.environ.get("LAYA_STUCK_THRESHOLD", 90))
HEALING_COOLDOWN_SEC = int(os.environ.get("LAYA_HEAL_COOLDOWN", 45))
USB_RESET_COOLDOWN_SEC = int(os.environ.get("LAYA_USB_COOLDOWN", 120))
ALERT_THROTTLE_SEC = int(os.environ.get("LAYA_ALERT_THROTTLE", 1800))  # 30 minutes throttle between repeat Telegram alerts
MAX_CONSECUTIVE_ERRORS = int(os.environ.get("LAYA_MAX_ERRORS", 3))
# Window used to scan the Asterisk log for chan_dongle's own AT-timeout signatures.
# This is the ground truth for "the modem baseband stopped answering".
AT_FAULT_LOOKBACK_SEC = int(os.environ.get("LAYA_AT_FAULT_LOOKBACK", 300))

# Asterisk Binary
ASTERISK_BIN = "/usr/sbin/asterisk"
DONGLE_CONF = "/etc/asterisk/dongle.conf"

# User-Defined Scheduled Off-Hours Maintenance Window
SCHEDULED_RESTART_DEFAULT_START = os.environ.get("LAYA_SCHEDULE_START", "03:00")
SCHEDULED_RESTART_DEFAULT_END = os.environ.get("LAYA_SCHEDULE_END", "07:00")
SCHEDULED_RESTART_DEFAULT_COOLDOWN = int(os.environ.get("LAYA_SCHEDULE_COOLDOWN", 25))

# Layer 4 — Baseband Hygiene Thresholds
# AT+CFUN=1 restarts the radio/protocol stack only. The USB composite device
# never drops off the bus, so this is safe to run unattended.
CFUN_RESTART_DEFAULT_ENABLED = os.environ.get("LAYA_CFUN_ENABLED", "true").lower() in ("true", "1", "yes")
CFUN_RESTART_DEFAULT_THRESHOLD = int(os.environ.get("LAYA_CFUN_THRESHOLD", 3))
# Maximum time to wait for a modem to re-initialise after a baseband action
BASEBAND_REINIT_TIMEOUT_SEC = int(os.environ.get("LAYA_BASEBAND_REINIT_TIMEOUT", 45))
# Maximum time to wait for a modem to re-enumerate on the USB bus after AT^RESET.
# AT^RESET is known to remove the modem from the bus entirely on several
# Huawei firmwares, so the recovery window must be generous.
BASEBAND_REBOOT_DEFAULT_TIMEOUT = int(os.environ.get("LAYA_BASEBAND_RECOVERY_TIMEOUT", 60))

