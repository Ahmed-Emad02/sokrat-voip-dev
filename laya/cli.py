#!/usr/bin/env python3
"""
Sokrat VoIP — Laya GSM Maintenance Agent CLI (laya-cli)
Local terminal utility for inspecting GSM dongle health, running triage, and healing modems.
"""

import sys
import os
import json
import socket
import argparse
import time

# Ensure /opt/sokrat-voip is in python path
INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
if INSTALL_DIR not in sys.path:
    sys.path.insert(0, INSTALL_DIR)

from laya.config import SOCKET_PATH
from laya.sensors.db import (
    get_all_dongle_health,
    get_recent_maintenance_events,
    get_scheduled_restart_settings,
    set_scheduled_restart_setting
)
from laya.sensors.sysfs import scan_usb_modems
from laya.sensors.cli import (
    parse_dongle_devices_summary,
    get_dongle_device_state,
    parse_active_channels
)
from laya.evaluator.state_machine import DongleStateManager
from laya.evaluator.heuristics import evaluate_dongle_anomalies
from laya.healer.ladder import RecoveryLadder

# ANSI Colors
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

def send_ipc_command(cmd_dict, timeout=4.0):
    """
    Sends command to the running sokrat-laya.service via Unix Domain Socket.
    Returns (success: bool, response_dict: dict).
    """
    if not os.path.exists(SOCKET_PATH):
        return False, {"error": "Laya daemon socket not active (sokrat-laya.service may be stopped)"}
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(SOCKET_PATH)
        payload = json.dumps(cmd_dict) + "\n"
        s.sendall(payload.encode("utf-8"))
        data = ""
        while True:
            chunk = s.recv(4096).decode("utf-8", errors="ignore")
            if not chunk:
                break
            data += chunk
            if "\n" in data:
                break
        s.close()
        return True, json.loads(data.strip())
    except Exception as e:
        return False, {"error": str(e)}

def cmd_status(args):
    # Try daemon IPC first for live in-memory state
    ok, ipc_resp = send_ipc_command({"command": "status"})
    dongles = []
    daemon_online = False
    
    if ok and ipc_resp.get("success"):
        dongles = ipc_resp.get("dongles", [])
        daemon_online = True
    else:
        # Fallback to direct DB query
        dongles = get_all_dongle_health()
        
    if args.json:
        print(json.dumps({"daemon_online": daemon_online, "dongles": dongles}, indent=2, default=str))
        return

    print(f"\n{BOLD}{CYAN}=== Sokrat Laya GSM Dongle Health Monitor ==={RESET}")
    daemon_badge = f"{GREEN}ONLINE (Active){RESET}" if daemon_online else f"{YELLOW}STANDALONE (DB Fallback){RESET}"
    print(f"Daemon Status: {daemon_badge}\n")

    if not dongles:
        print("  No GSM dongle records found.")
        return

    # Print Table
    header = f"{'DONGLE':<12} {'SCORE':<8} {'STATUS':<11} {'STATE':<14} {'RSSI':<6} {'NUMBER':<16} {'CARRIER':<9} {'LAST HEALING'}"
    print(BOLD + header + RESET)
    print("-" * 95)

    for d in dongles:
        name = d.get("dongle_name", "")
        score = d.get("health_score", 0)
        status = d.get("status", "unknown")
        state = d.get("curr_state") or d.get("state") or "N/A"
        rssi = str(d.get("rssi", 0))
        num = d.get("phone_number") or "N/A"
        reg = "OK" if d.get("carrier_registered") else "NO"
        last_heal = d.get("last_heal_action") or "None"

        # Colorize score
        if score >= 85:
            score_str = f"{GREEN}{score}/100{RESET}"
        elif score >= 50:
            score_str = f"{YELLOW}{score}/100{RESET}"
        else:
            score_str = f"{RED}{score}/100{RESET}"

        # Colorize status
        status_color = GREEN if status == "healthy" else (YELLOW if status in ("degraded", "healing") else RED)
        status_str = f"{status_color}{status.upper():<11}{RESET}"

        print(f"{BOLD}{name:<12}{RESET} {score_str:<17} {status_str} {state:<14} {rssi:<6} {num:<16} {reg:<9} {last_heal}")
    print()

def cmd_triage(args):
    print(f"\n{BOLD}{CYAN}=== Sokrat Laya Deep Diagnostic Triage ==={RESET}\n")
    print("Running on-demand hardware, Asterisk, and cellular evaluation...\n")
    
    # 1. Physical USB Audit
    modems = scan_usb_modems()
    print(f"{BOLD}1. Physical USB Hardware Bus:{RESET}")
    if modems:
        for m in modems:
            ports = ", ".join(p["port"] for p in m["ports"])
            alive = "ALIVE" if m["is_alive"] else "PORTS_MISSING"
            print(f"  • [{m['sysfs_name']}] {m['manufacturer']} {m['product_name']} ({m['vendor_id']}:{m['product_id']}) -> [{ports}] ({alive})")
    else:
        print("  • No physical USB GSM modems detected on sysfs bus.")

    # 2. Asterisk Devices & Active Channels
    print(f"\n{BOLD}2. Asterisk Core & chan_dongle:{RESET}")
    devices = parse_dongle_devices_summary()
    channels = parse_active_channels()
    print(f"  • Configured Dongles in Asterisk: {len(devices)}")
    print(f"  • Active Cellular Channels: {len(channels)}")

    # 3. Anomaly Evaluation
    print(f"\n{BOLD}3. Dongle Anomaly Matrix:{RESET}")
    state_mgr = DongleStateManager()
    
    for d in devices:
        dongle_id = d["id"]
        detail = get_dongle_device_state(dongle_id) if d["state"] != "Not connected" else None
        health = state_mgr.update_dongle(d, detail, channels, modems)
        anomaly, reason, rec_level = evaluate_dongle_anomalies(health, detail)

        status_tag = f"{GREEN}[HEALTHY]{RESET}" if anomaly == "NONE" else f"{RED}[ANOMALY: {anomaly}]{RESET}"
        print(f"  • {BOLD}{dongle_id}{RESET}: {status_tag} {d['state']} (Score: {health['health_score']}/100)")
        if anomaly != "NONE":
            print(f"    - Finding: {reason}")
            print(f"    - Recommended Action: Level {rec_level}")
    print()

def cmd_heal(args):
    target = args.dongle.lower()
    print(f"\n{BOLD}{YELLOW}Initiating Laya graduated recovery on '{target}'...{RESET}")
    
    # Check if daemon can handle it via IPC
    ok, resp = send_ipc_command({"command": "heal", "dongle": target})
    if ok and resp.get("success"):
        action = resp.get("action", "Heal")
        healed = resp.get("healed", False)
        details = resp.get("details", "")
        status_str = f"{GREEN}SUCCESS{RESET}" if healed else f"{RED}FAILED{RESET}"
        print(f"Action: {action}")
        print(f"Result: {status_str} — {details}\n")
        return

    # Standalone execution if daemon offline
    devices = parse_dongle_devices_summary()
    target_dev = next((d for d in devices if d["id"].lower() == target), None)
    if not target_dev:
        print(f"{RED}Error: Dongle '{target}' not found in Asterisk inventory.{RESET}\n")
        return

    channels = parse_active_channels()
    usb_modems = scan_usb_modems()
    state_mgr = DongleStateManager()
    ladder = RecoveryLadder()
    detail = get_dongle_device_state(target) if target_dev["state"] != "Not connected" else None
    health = state_mgr.update_dongle(target_dev, detail, channels, usb_modems)

    action, lvl, success, details = ladder.attempt_recovery(
        target, "MANUAL_CLI", "Manual recovery triggered via laya-cli", health, detail
    )
    status_str = f"{GREEN}SUCCESS{RESET}" if success else f"{RED}FAILED{RESET}"
    print(f"Executed: {action} (Level {lvl})")
    print(f"Result:   {status_str} — {details}\n")

def cmd_logs(args):
    events = get_recent_maintenance_events(limit=args.tail)
    if args.json:
        print(json.dumps(events, indent=2, default=str))
        return

    print(f"\n{BOLD}{CYAN}=== Sokrat Laya Maintenance Audit Log (Last {len(events)}) ==={RESET}\n")
    if not events:
        print("  No maintenance events recorded yet.\n")
        return

    header = f"{'TIME':<20} {'DONGLE':<10} {'LEVEL':<6} {'RESULT':<10} {'ACTION':<32} {'DETAILS'}"
    print(BOLD + header + RESET)
    print("-" * 110)

    for e in events:
        t = str(e.get("created_at", ""))[:19]
        d = e.get("dongle_name", "")
        lvl = f"L{e.get('recovery_level', 0)}"
        res = e.get("result", "")
        act = (e.get("action_taken", "") or "")[:30]
        det = (e.get("details", "") or "")[:35]

        res_color = GREEN if res == "success" else (YELLOW if res == "in_progress" else RED)
        res_str = f"{res_color}{res.upper():<10}{RESET}"

        print(f"{t:<20} {BOLD}{d:<10}{RESET} {lvl:<6} {res_str} {act:<32} {det}")
    print()

def cmd_audit_usb(args):
    modems = scan_usb_modems()
    if args.json:
        print(json.dumps(modems, indent=2))
        return

    print(f"\n{BOLD}{CYAN}=== Physical USB Modem Hardware Topology ==={RESET}\n")
    if not modems:
        print("  No USB cellular modems detected.")
        return

    for m in modems:
        print(f"• {BOLD}Bus Path: {m['sysfs_name']}{RESET} ({m['sysfs_path']})")
        print(f"  Manufacturer: {m['manufacturer']} (Vendor ID: {m['vendor_id']}, Product ID: {m['product_id']})")
        print(f"  Product Name: {m['product_name'] or 'N/A'}")
        print(f"  Endpoints:")
        for p in m["ports"]:
            p_status = f"{GREEN}EXISTS{RESET}" if p["present"] else f"{RED}MISSING{RESET}"
            print(f"    - {BOLD}{p['port']}{RESET} -> {p['node']} [{p_status}]")
        print()

def cmd_simulate_escalation(args):
    target = (args.dongle or "dongle0").lower()
    print(f"\n{BOLD}{CYAN}=== Sokrat Laya Escalation & Telegram Alarm Virtual Scenario ==={RESET}\n")
    print(f"Target Modem: {BOLD}{target}{RESET}")
    print("Initiating virtual multi-level recovery failure simulation...\n")

    steps = [
        ("Level 1 (Soft AT Probe)", "Sending AT+CPAS & AT+CSQ... Modem fails to acknowledge AT queue"),
        ("Level 2 (Channel De-Sticking)", "Executing channel hangup on zombie call... Modem UART remains locked"),
        ("Level 3 (Targeted Restart)", "Emitting 'dongle restart now'... State remains stuck in 'Waiting/Deadlock'"),
        ("Level 4 (Kernel USB Re-bind)", "Simulating sysfs USB unbind/bind... Hardware endpoints non-responsive"),
    ]

    for lvl_name, detail in steps:
        time.sleep(0.4)
        print(f"  • {YELLOW}{lvl_name}{RESET}: {detail} -> {RED}[FAILED]{RESET}")

    time.sleep(0.5)
    print(f"\n{BOLD}{RED}💥 All autonomous recovery levels exhausted! Triggering Level 5 Hardware Escalation...{RESET}\n")

    from laya.healer.actions import action_escalate_alert
    reason = "Virtual Scenario: Hardware freeze & modem unresponsiveness across Levels 1-4"
    details = f"Simulated unrecoverable state on {target} (AT timeout, sysfs unresponsive, queue deadlock)"

    ok, dispatch_info = action_escalate_alert(target, reason, details, dry_run=args.dry_run)
    
    if ok:
        print(f"  ✅ {GREEN}{BOLD}Telegram Alarm Dispatched Successfully!{RESET}")
        print(f"  📡 Details: {dispatch_info}")
    else:
        print(f"  ⚠️ {YELLOW}Telegram Dispatch Returned:{RESET} {dispatch_info}")

    print(f"\nAudit event logged to {BOLD}asterisk.laya_maintenance_events{RESET}.")
    if not args.dry_run:
        print(f"Check your Telegram app or run {CYAN}laya logs --tail 5{RESET} to verify.\n")
    else:
        print(f"(Dry-run mode active: live Telegram message skipped).\n")

def cmd_baseband(args):
    """
    Layer 4 operator commands:
      hygiene   - inspect the baseband hygiene configuration
      reattach  - safe radio stack re-attach (AT+CFUN=1), USB device never drops
      reboot    - FULL baseband reboot (AT^RESET). Destructive: the modem removes
                  itself from the USB bus and needs a physical reseat.
    """
    from laya.sensors.db import get_baseband_hygiene_settings
    from laya.healer.actions import action_cfun_restart, action_baseband_reboot

    target = (args.dongle or "").lower()
    settings = get_baseband_hygiene_settings()

    if args.action == "hygiene":
        if getattr(args, "json", False):
            print(json.dumps(settings, indent=2))
            return
        print(f"\n{BOLD}{CYAN}=== Sokrat Laya Baseband Hygiene Configuration ==={RESET}\n")
        print(f"  Hygiene enabled        : {GREEN if settings['hygiene_enabled'] else RED}{settings['hygiene_enabled']}{RESET}")
        print(f"  AT+CFUN=1 re-attach    : {GREEN if settings['cfun_enabled'] else RED}{settings['cfun_enabled']}{RESET}")
        print(f"  CFUN threshold         : {settings['cfun_threshold']} cycle(s)")
        print(f"  AT^RESET reboot        : {RED if settings['reboot_enabled'] else GREEN}{settings['reboot_enabled']}{RESET}")
        print(f"  Reboot acknowledged    : {RED if settings['reboot_confirmed'] else GREEN}{settings['reboot_confirmed']}{RESET}")
        print(f"  Recovery timeout       : {settings['recovery_timeout_sec']}s")
        print(f"\n  {YELLOW}WARNING{RESET}: AT^RESET removes the modem from the USB bus and")
        print(f"  cannot be recovered in software. Only a physical reseat restores it.")
        print()
        return

    if not target:
        print(f"{RED}ERROR{RESET}: a dongle identifier is required (e.g. dongle0)")
        return

    if args.action == "reattach":
        print(f"\n{BOLD}{CYAN}=== Baseband Radio Re-attach (AT+CFUN=1) on {target} ==={RESET}\n")
        print("  This restarts ONLY the radio/protocol stack.")
        print("  The USB device stays on the bus - no physical reseat required.\n")
        ok, details = action_cfun_restart(target, reason="Operator CLI: baseband radio re-attach")
        print(f"  Result : {GREEN + 'SUCCESS' + RESET if ok else RED + 'FAILED' + RESET}")
        print(f"  Details: {details}\n")
        return

    if args.action == "reboot":
        print(f"\n{BOLD}{RED}=== FULL BASEBAND REBOOT (AT^RESET) on {target} ==={RESET}\n")
        print(f"  {RED}DESTRUCTIVE{RESET}: the modem will remove itself from the USB bus and")
        print(f"  will NOT re-enumerate. A physical reseat is required afterwards.\n")
        ok, details = action_baseband_reboot(target, reason="Operator CLI: full baseband reboot")
        print(f"  Result : {GREEN + 'SUCCESS' + RESET if ok else RED + 'FAILED' + RESET}")
        print(f"  Details: {details}\n")

def cmd_schedule(args):
    # Check if modifying settings
    modifying = False
    set_payload = {"command": "set-schedule"}

    if args.set_window:
        w_start, w_end = args.set_window
        set_payload["start"] = w_start
        set_payload["end"] = w_end
        modifying = True

    if args.enable:
        set_payload["enabled"] = True
        modifying = True
    elif args.disable:
        set_payload["enabled"] = False
        modifying = True

    if args.cooldown is not None:
        set_payload["cooldown"] = args.cooldown
        modifying = True

    if modifying:
        ok, res = send_ipc_command(set_payload)
        if ok and res.get("success"):
            print(f"\n  ✅ {GREEN}{BOLD}Maintenance schedule updated successfully!{RESET}\n")
        else:
            # Fallback to direct DB update
            if "start" in set_payload:
                set_scheduled_restart_setting("laya_scheduled_restart_start", set_payload["start"])
            if "end" in set_payload:
                set_scheduled_restart_setting("laya_scheduled_restart_end", set_payload["end"])
            if "enabled" in set_payload:
                set_scheduled_restart_setting("laya_scheduled_restart_enabled", "true" if set_payload["enabled"] else "false")
            if "cooldown" in set_payload:
                set_scheduled_restart_setting("laya_scheduled_restart_cooldown_sec", str(set_payload["cooldown"]))
            print(f"\n  ✅ {GREEN}{BOLD}Maintenance schedule updated in database (offline mode).{RESET}\n")

    if args.run_now:
        print(f"\n{BOLD}{CYAN}=== Triggering Sequential Dongle Restarts (1-by-1) ==={RESET}")
        print("Checking PBX active call safety guards...\n")
        ok, res = send_ipc_command({"command": "run-scheduled-restart", "force": args.force, "async": False}, timeout=120.0)
        if ok and res.get("success"):
            r_data = res.get("result", {})
            restarted = r_data.get("restarted", [])
            skipped = r_data.get("skipped", [])
            print(f"  ✅ {GREEN}{BOLD}Restart Sequence Completed!{RESET}")
            print(f"  • Restarted Dongles: {BOLD}{', '.join(restarted) if restarted else 'None'}{RESET}")
            if skipped:
                print(f"  • Skipped Dongles: {YELLOW}{skipped}{RESET}")
            print()
        elif ok and res.get("aborted"):
            print(f"  ⚠️ {YELLOW}{BOLD}Restart Sequence Aborted by Safety Guard:{RESET} {res.get('reason')}\n")
        else:
            err = res.get("error") if isinstance(res, dict) else str(res)
            print(f"  ❌ {RED}{BOLD}Failed to trigger restart sequence:{RESET} {err}\n")
        return

    # Query schedule info
    ok, ipc_resp = send_ipc_command({"command": "get-schedule"})
    sched = {}
    if ok and ipc_resp.get("success"):
        sched = ipc_resp.get("schedule", {})
    else:
        sched = get_scheduled_restart_settings()
        from datetime import datetime
        now_hm = datetime.now().strftime("%H:%M")
        sched["current_time"] = now_hm
        sched["in_window"] = False

    if args.json:
        print(json.dumps(sched, indent=2))
        return

    enabled = sched.get("enabled", True)
    start_t = sched.get("start_time", "03:00")
    end_t = sched.get("end_time", "07:00")
    cooldown = sched.get("cooldown_sec", 25)
    last_run = sched.get("last_run", "Never")
    curr_t = sched.get("current_time", "")
    in_win = sched.get("in_window", False)
    is_restarting = sched.get("is_restarting", False)

    print(f"\n{BOLD}{CYAN}=== Sokrat Laya Off-Hours Maintenance Schedule ==={RESET}\n")
    status_str = f"{GREEN}ENABLED{RESET}" if enabled else f"{RED}DISABLED{RESET}"
    window_state = f"{GREEN}[CURRENTLY IN WINDOW]{RESET}" if in_win else f"{YELLOW}[OUTSIDE WINDOW]{RESET}"
    restarting_str = f" {YELLOW}{BOLD}(Restart Sequence In Progress){RESET}" if is_restarting else ""

    print(f"  • Status:               {BOLD}{status_str}{restarting_str}")
    print(f"  • Maintenance Window:   {BOLD}{start_t} - {end_t}{RESET}  {window_state}")
    print(f"  • Current System Time:  {BOLD}{curr_t}{RESET}")
    print(f"  • Pacing Cooldown:      {BOLD}{cooldown}s{RESET} (wait time between each dongle restart)")
    print(f"  • Last Maintenance Run: {BOLD}{last_run or 'Never'}{RESET}")
    print(f"  • Safety Call Guard:    {BOLD}{GREEN}ACTIVE{RESET} (Restarts strictly 1-by-1 only when 0 calls active)")
    print(f"\nTo change the maintenance window: {CYAN}laya schedule --set-window 03:00 07:00{RESET}")
    print(f"To run immediate test sequence:  {CYAN}laya schedule --run-now{RESET}\n")

def main():
    parser = argparse.ArgumentParser(
        description="Sokrat Laya GSM Maintenance Agent CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--json", action="store_true", help="Output machine-readable JSON")
    subparsers = parser.add_subparsers(dest="subcommand", help="Command to execute")

    # status
    p_status = subparsers.add_parser("status", help="Display live GSM dongle health and states")

    # triage
    p_triage = subparsers.add_parser("triage", help="Run deep diagnostic triage on all dongles")

    # heal
    p_heal = subparsers.add_parser("heal", help="Trigger autonomous healing ladder on specific dongle")
    p_heal.add_argument("dongle", help="Dongle identifier (e.g. dongle0)")

    # logs
    p_logs = subparsers.add_parser("logs", help="Display maintenance intervention audit trail")
    p_logs.add_argument("--tail", type=int, default=25, help="Number of records to show (default: 25)")

    # audit-usb
    p_audit = subparsers.add_parser("audit-usb", help="Scan kernel sysfs USB bus topology")

    # simulate-escalation
    p_sim = subparsers.add_parser("simulate-escalation", help="Run virtual Level 5 escalation scenario & dispatch Telegram alarm")
    p_sim.add_argument("dongle", nargs="?", default="dongle0", help="Target dongle identifier (default: dongle0)")
    p_sim.add_argument("--dry-run", action="store_true", help="Run simulation and log event without sending live Telegram message")

    # schedule
    p_sched = subparsers.add_parser("schedule", help="Inspect and configure off-hours sequential dongle restart window")
    p_sched.add_argument("--set-window", nargs=2, metavar=("START", "END"), help="Define maintenance window (e.g. --set-window 03:00 07:00)")
    p_sched.add_argument("--enable", action="store_true", help="Enable scheduled maintenance window restarts")
    p_sched.add_argument("--disable", action="store_true", help="Disable scheduled maintenance window restarts")
    p_sched.add_argument("--cooldown", type=int, help="Cooldown time in seconds between each dongle restart (default: 25)")
    p_sched.add_argument("--run-now", action="store_true", help="Immediately run the 1-by-1 sequential restart sequence with active call protection")
    p_sched.add_argument("--force", action="store_true", help="Bypass active call check when used with --run-now (emergency use only)")

    # baseband (Layer 4)
    p_bb = subparsers.add_parser("baseband", help="Layer 4 baseband hygiene: safe radio re-attach (AT+CFUN=1) or destructive reboot (AT^RESET)")
    p_bb.add_argument("action", choices=["hygiene", "reattach", "reboot"], help="hygiene=show config, reattach=AT+CFUN=1, reboot=AT^RESET (destructive)")
    p_bb.add_argument("dongle", nargs="?", default="", help="Target dongle identifier (e.g. dongle0)")

    args = parser.parse_args()
    if not args.subcommand or args.subcommand == "status":
        cmd_status(args)
    elif args.subcommand == "triage":
        cmd_triage(args)
    elif args.subcommand == "heal":
        cmd_heal(args)
    elif args.subcommand == "logs":
        cmd_logs(args)
    elif args.subcommand == "audit-usb":
        cmd_audit_usb(args)
    elif args.subcommand == "simulate-escalation":
        cmd_simulate_escalation(args)
    elif args.subcommand == "schedule":
        cmd_schedule(args)
    elif args.subcommand == "baseband":
        cmd_baseband(args)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
