"""
Sokrat VoIP — Laya GSM Dongle Maintenance Daemon Engine
Always-on background orchestrator monitoring dongle telemetry and healing faults.
"""

import os
import sys
import time
import signal
import socket
import json
import threading
import logging

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if INSTALL_DIR not in sys.path:
    sys.path.insert(0, INSTALL_DIR)

from laya.config import (
    POLL_INTERVAL_SEC,
    SOCKET_PATH,
    SCHEDULED_RESTART_DEFAULT_START,
    SCHEDULED_RESTART_DEFAULT_END,
    SCHEDULED_RESTART_DEFAULT_COOLDOWN,
    AT_FAULT_LOOKBACK_SEC
)
from laya.sensors.cli import (
    parse_dongle_devices_summary,
    get_dongle_device_state,
    parse_active_channels,
    get_total_active_calls,
    is_any_dongle_call_active,
    scan_asterisk_log_for_dongle_faults
)
from laya.sensors.sysfs import scan_usb_modems
from laya.sensors.db import (
    upsert_dongle_health,
    get_all_dongle_health,
    get_recent_maintenance_events,
    get_scheduled_restart_settings,
    set_scheduled_restart_setting,
    is_kill_switch_active,
    record_maintenance_event,
    prune_stale_dongle_health
)
from laya.evaluator.state_machine import DongleStateManager
from laya.evaluator.heuristics import evaluate_dongle_anomalies, ANOMALY_NONE
from laya.healer.ladder import RecoveryLadder
from laya.healer.actions import action_restart_dongle, action_cfun_restart, action_baseband_reboot, is_call_active_on_dongle
from datetime import datetime


# Configure Logging
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [LAYA-%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("laya")

# Number of watch cycles between stale dongle health row prunes
PRUNE_EVERY_CYCLES = 12
# Minimum seconds between repeated anomaly log lines for the same dongle+type
ANOMALY_LOG_THROTTLE_SEC = 300

class LayaEngine:
    def __init__(self):
        self.running = False
        self.start_time = time.time()
        self.state_mgr = DongleStateManager()
        self.healer_ladder = RecoveryLadder()
        self.last_dongle_cache = {}
        self.server_sock = None
        self.last_scheduled_restart_epoch = 0
        self.is_restarting_sequence = False
        self._anomaly_log_throttle = {}


    def start_ipc_server(self):
        """
        Starts local Unix Domain Socket listener for fast CLI communication.
        """
        try:
            if os.path.exists(SOCKET_PATH):
                os.remove(SOCKET_PATH)
            self.server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.server_sock.bind(SOCKET_PATH)
            os.chmod(SOCKET_PATH, 0o666)  # allow local system users / node / root
            self.server_sock.listen(50)
            self.server_sock.settimeout(0.5)
            logger.info(f"IPC socket listening at {SOCKET_PATH}")
            self.ipc_thread = threading.Thread(target=self._ipc_listen_loop, daemon=True)
            self.ipc_thread.start()
        except Exception as e:
            logger.warning(f"Could not bind IPC socket {SOCKET_PATH}: {e}")

    def _ipc_listen_loop(self):
        while self.running and self.server_sock:
            try:
                client_sock, _ = self.server_sock.accept()
                threading.Thread(target=self.handle_ipc_client, args=(client_sock,), daemon=True).start()
            except (socket.timeout, BlockingIOError):
                continue
            except Exception:
                break

    def handle_ipc_client(self, client_sock):
        try:
            client_sock.settimeout(3.0)
            req_data = client_sock.recv(4096).decode("utf-8", errors="ignore").strip()
            if not req_data:
                return

            req = {}
            try:
                req = json.loads(req_data)
            except Exception:
                req = {"command": req_data}

            cmd = req.get("command", "").lower()
            resp = {"success": True}

            if cmd == "ping":
                resp["pong"] = True
                resp["uptime"] = int(time.time() - self.start_time)
            elif cmd == "status":
                resp["dongles"] = list(self.last_dongle_cache.values())
                resp["uptime"] = int(time.time() - self.start_time)
            elif cmd == "heal":
                target = req.get("dongle", "")
                if target and target.lower() in self.last_dongle_cache:
                    h_data = self.last_dongle_cache[target.lower()]
                    detail = get_dongle_device_state(target.lower())
                    action_name, lvl, ok, det = self.healer_ladder.attempt_recovery(
                        target.lower(), "MANUAL_REQUEST", "Manual healing triggered by operator", h_data, detail
                    )
                    resp["action"] = action_name
                    resp["level"] = lvl
                    resp["healed"] = ok
                    resp["details"] = det
                else:
                    resp["success"] = False
                    resp["error"] = f"Dongle '{target}' not found in active inventory"
            elif cmd == "triage":
                # Run an immediate deep triage pass
                triage_results = self.run_watch_cycle(deep=True)
                resp["triage"] = triage_results
            elif cmd == "get-schedule":
                sched = get_scheduled_restart_settings()
                now_hm = datetime.now().strftime("%H:%M")
                sched["current_time"] = now_hm
                sched["in_window"] = self.is_time_in_window(now_hm, sched.get("start_time", SCHEDULED_RESTART_DEFAULT_START), sched.get("end_time", SCHEDULED_RESTART_DEFAULT_END))
                sched["is_restarting"] = self.is_restarting_sequence
                resp["schedule"] = sched
            elif cmd == "set-schedule":
                if "start" in req and req["start"]:
                    set_scheduled_restart_setting("laya_scheduled_restart_start", req["start"])
                if "end" in req and req["end"]:
                    set_scheduled_restart_setting("laya_scheduled_restart_end", req["end"])
                if "enabled" in req:
                    set_scheduled_restart_setting("laya_scheduled_restart_enabled", "true" if req["enabled"] else "false")
                if "cooldown" in req and req["cooldown"]:
                    set_scheduled_restart_setting("laya_scheduled_restart_cooldown_sec", str(req["cooldown"]))
                sched = get_scheduled_restart_settings()
                now_hm = datetime.now().strftime("%H:%M")
                sched["current_time"] = now_hm
                sched["in_window"] = self.is_time_in_window(now_hm, sched.get("start_time", SCHEDULED_RESTART_DEFAULT_START), sched.get("end_time", SCHEDULED_RESTART_DEFAULT_END))
                sched["is_restarting"] = self.is_restarting_sequence
                resp["schedule"] = sched
                resp["message"] = "Maintenance schedule settings updated"
            elif cmd == "run-scheduled-restart":
                force = bool(req.get("force", False))
                run_async = bool(req.get("async", True))
                if self.is_restarting_sequence:
                    resp["success"] = False
                    resp["error"] = "A scheduled restart sequence is already in progress"
                elif run_async:
                    threading.Thread(
                        target=self.execute_scheduled_dongle_restarts,
                        kwargs={"force": force, "source": "Operator CLI Trigger"},
                        daemon=True
                    ).start()
                    resp["message"] = "Sequential dongle restart sequence initiated in background"
                else:
                    result = self.execute_scheduled_dongle_restarts(force=force, source="Operator CLI Trigger")
                    resp["result"] = result
            else:
                resp["success"] = False
                resp["error"] = f"Unknown command '{cmd}'"

            out = json.dumps(resp) + "\n"
            client_sock.sendall(out.encode("utf-8"))
        except Exception as e:
            logger.debug(f"IPC client error: {e}")
        finally:
            try:
                client_sock.close()
            except Exception:
                pass

    def run_watch_cycle(self, deep=False):
        """
        Executes a single monitoring and healing cycle.
        """
        devices = parse_dongle_devices_summary()
        active_channels = parse_active_channels()
        usb_modems = scan_usb_modems() if deep or (len(devices) > 0) else []

        cycle_results = []
        for dev in devices:
            dongle_id = dev.get("id", "").lower()
            if not dongle_id:
                continue

            # ALWAYS query the device state. Previously Asterisk's detail was
            # skipped for 'Not connected' dongles, which made the physical USB
            # presence check blind exactly in the failure scenario we must detect.
            detail = get_dongle_device_state(dongle_id)

            # Ground truth from the driver's own log signatures
            at_fault, at_sig, at_count = scan_asterisk_log_for_dongle_faults(
                dongle_id, lookback_seconds=AT_FAULT_LOOKBACK_SEC
            )

            # Update state machine
            health_data = self.state_mgr.update_dongle(dev, detail, active_channels, usb_modems)
            health_data["at_fault_confirmed"] = at_fault
            health_data["at_fault_signature"] = at_sig
            health_data["at_fault_count"] = at_count
            self.last_dongle_cache[dongle_id] = health_data

            # Anomaly evaluation
            anomaly_type, reason, recommended_level = evaluate_dongle_anomalies(health_data, detail)

            if anomaly_type != ANOMALY_NONE:
                # Throttle anomaly logging so a persistent condition does not
                # flood the journal on every 5 second poll cycle.
                sig_key = f"{dongle_id}:{anomaly_type}"
                last_logged = self._anomaly_log_throttle.get(sig_key, 0)
                if (time.time() - last_logged) >= ANOMALY_LOG_THROTTLE_SEC:
                    self._anomaly_log_throttle[sig_key] = time.time()
                    logger.warning(f"Anomaly detected on {dongle_id}: [{anomaly_type}] {reason}")

                if recommended_level == 0:
                    # Report-only anomalies (e.g. hardware physically absent)
                    # cannot be fixed by software. Do not burn recovery rungs.
                    health_data["healing_level"] = 0
                    health_data["last_heal_action"] = "Report Only (No Software Remedy)"
                else:
                    action_name, lvl, ok, det = self.healer_ladder.attempt_recovery(
                        dongle_id, anomaly_type, reason, health_data, detail
                    )
                    self.state_mgr.mark_healing_action(dongle_id, lvl, action_name)
                    health_data["healing_level"] = lvl
                    health_data["last_heal_action"] = action_name
                    health_data["last_heal_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                    logger.info(f"Recovery executed on {dongle_id} (Level {lvl}): {action_name} -> {det}")
            else:
                # Reset ladder once back to healthy
                if health_data.get("status") == "healthy":
                    self.healer_ladder.reset_dongle_ladder(dongle_id)

            # Persist to database
            upsert_dongle_health(health_data)
            cycle_results.append(health_data)

        # Periodically prune health rows for dongles that no longer exist
        self._cycle_counter = getattr(self, "_cycle_counter", 0) + 1
        if self._cycle_counter % PRUNE_EVERY_CYCLES == 0:
            try:
                prune_res = prune_stale_dongle_health(devices)
                if prune_res.get("pruned"):
                    logger.info(
                        f"Pruned {prune_res['pruned']} stale dongle health row(s); "
                        f"kept: {', '.join(prune_res.get('kept', []))}"
                    )
            except Exception as e:
                logger.warning(f"Stale dongle health prune failed: {e}")

        return cycle_results

    def is_time_in_window(self, current_time_str, start_str, end_str):
        """
        Evaluates whether current_time falls within [start, end).
        Handles both normal windows (e.g. 03:00 to 07:00) and overnight windows (e.g. 23:00 to 04:00).
        """
        try:
            t_now = datetime.strptime(current_time_str, "%H:%M").time() if isinstance(current_time_str, str) else current_time_str
            t_start = datetime.strptime(start_str, "%H:%M").time()
            t_end = datetime.strptime(end_str, "%H:%M").time()
            if t_start <= t_end:
                return t_start <= t_now < t_end
            else:
                return t_now >= t_start or t_now < t_end
        except Exception as e:
            logger.warning(f"Error parsing window times '{start_str}'-'{end_str}': {e}")
            return False

    def execute_scheduled_dongle_restarts(self, force=False, source="Scheduled Maintenance Window"):
        """
        Restarts connected GSM dongles sequentially one-by-one.
        Strict safety constraints:
          1. Verifies 0 active calls on Asterisk PBX.
          2. Verifies 0 active calls on target dongle.
          3. Waits for cooldown period between dongles while ensuring dongle returns to Free.
          4. Aborts immediately if an active call is detected at any point in the cycle.
        """
        if self.is_restarting_sequence:
            return {"success": False, "error": "A scheduled restart sequence is already in progress"}

        self.is_restarting_sequence = True
        try:
            sched = get_scheduled_restart_settings()
            cooldown_sec = sched.get("cooldown_sec", SCHEDULED_RESTART_DEFAULT_COOLDOWN)
            start_str = sched.get("start_time", SCHEDULED_RESTART_DEFAULT_START)
            end_str = sched.get("end_time", SCHEDULED_RESTART_DEFAULT_END)

            # 1. PBX Global active call check
            active_calls = get_total_active_calls()
            if active_calls > 0 and not force:
                logger.info(f"[{source}] Aborted: {active_calls} active call(s) detected on Asterisk PBX.")
                return {
                    "success": False,
                    "aborted": True,
                    "reason": f"Active calls on PBX ({active_calls})",
                    "restarted": [],
                    "skipped": []
                }

            # 2. Dongle-specific active channel check
            if is_any_dongle_call_active() and not force:
                logger.info(f"[{source}] Aborted: Active cellular channel detected on a dongle.")
                return {
                    "success": False,
                    "aborted": True,
                    "reason": "Active cellular call in progress",
                    "restarted": [],
                    "skipped": []
                }

            # 3. Retrieve connected dongles
            devices = parse_dongle_devices_summary()
            connected_dongles = [d for d in devices if d.get("state") != "Not connected" and d.get("id")]

            if not connected_dongles:
                logger.info(f"[{source}] No connected dongles to restart.")
                return {
                    "success": True,
                    "aborted": False,
                    "reason": "No connected dongles",
                    "restarted": [],
                    "skipped": []
                }

            logger.info(f"[{source}] Initiating sequential 1-by-1 restart of {len(connected_dongles)} dongle(s) (window: {start_str}-{end_str})...")

            restarted = []
            skipped = []
            hygiene_enabled = False
            try:
                from laya.sensors.db import get_baseband_hygiene_settings
                hygiene_enabled = bool(get_baseband_hygiene_settings().get("hygiene_enabled"))
            except Exception:
                hygiene_enabled = False

            for idx, dev in enumerate(connected_dongles):
                dongle_id = dev["id"].lower().strip()

                # Safety check AGAIN immediately before restarting this specific dongle
                if (get_total_active_calls() > 0 or is_call_active_on_dongle(dongle_id)) and not force:
                    logger.warning(f"[{source}] Halting sequential restart at {dongle_id}: Call detected on PBX or {dongle_id}!")
                    skipped.append({"dongle": dongle_id, "reason": "Call active"})
                    break

                logger.info(f"[{source}] [{idx+1}/{len(connected_dongles)}] Restarting {dongle_id}...")

                if hygiene_enabled:
                    # Layer 4-B: safe baseband hygiene.
                    # AT+CFUN=1 restarts only the radio/protocol stack, so the
                    # USB device never drops off the bus. The action verifies the
                    # modem identity (IMEI/IMSI) and falls back to a targeted
                    # Asterisk-level restart if the radio re-attach did not settle.
                    success, details = action_cfun_restart(
                        dongle_id,
                        reason=f"{source} ({start_str}-{end_str}) - baseband hygiene"
                    )
                else:
                    success, details = action_restart_dongle(
                        dongle_id,
                        reason=f"{source} ({start_str}-{end_str})"
                    )

                if success:
                    restarted.append(dongle_id)
                    logger.info(f"[{source}] {dongle_id} restart signal emitted -> {details}")
                else:
                    skipped.append({"dongle": dongle_id, "reason": details})
                    logger.warning(f"[{source}] {dongle_id} restart skipped/failed: {details}")

                # Pacing cooldown: Wait before proceeding to next dongle
                if idx < len(connected_dongles) - 1:
                    logger.info(f"[{source}] Pacing cooldown: Waiting {cooldown_sec}s for {dongle_id} to re-initialize before next dongle...")
                    wait_remaining = cooldown_sec
                    while wait_remaining > 0:
                        time.sleep(2)
                        wait_remaining -= 2
                        if get_total_active_calls() > 0 and not force:
                            logger.warning(f"[{source}] Call activity detected during cooldown! Halting remaining restarts.")
                            break
                    if get_total_active_calls() > 0 and not force:
                        break

            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            set_scheduled_restart_setting("laya_scheduled_restart_last_run", now_str)
            self.last_scheduled_restart_epoch = time.time()

            record_maintenance_event(
                dongle_name="all",
                trigger_reason=f"{source} ({start_str}-{end_str})",
                recovery_level=3,
                action_taken=f"Sequential Dongle Restarts ({len(restarted)}/{len(connected_dongles)})",
                result="success" if restarted else "failed",
                details=f"Restarted: {', '.join(restarted) if restarted else 'none'} | Skipped: {len(skipped)}"
            )

            return {
                "success": True,
                "aborted": False,
                "restarted": restarted,
                "skipped": skipped,
                "total_connected": len(connected_dongles),
                "timestamp": now_str
            }
        finally:
            self.is_restarting_sequence = False

    def check_and_run_scheduled_restarts(self):
        """
        Evaluates whether the current time is within the user-defined maintenance window,
        and executes sequential restarts if not already executed in this window cycle.
        """
        now = datetime.now()
        now_hm = now.strftime("%H:%M")

        sched = get_scheduled_restart_settings()
        if not sched.get("enabled", True):
            return

        start_str = sched.get("start_time", SCHEDULED_RESTART_DEFAULT_START)
        end_str = sched.get("end_time", SCHEDULED_RESTART_DEFAULT_END)

        if not self.is_time_in_window(now_hm, start_str, end_str):
            return

        # Check if we already ran within the last 8 hours
        last_run_str = sched.get("last_run", "")
        if last_run_str:
            try:
                last_run_dt = datetime.strptime(last_run_str, "%Y-%m-%d %H:%M:%S")
                if (now - last_run_dt).total_seconds() < 28800:
                    return
            except Exception:
                pass

        if self.last_scheduled_restart_epoch:
            if (time.time() - self.last_scheduled_restart_epoch) < 28800:
                return

        # Within window and not yet run: verify calls and execute
        logger.info(f"Scheduled maintenance window active ({start_str} to {end_str}). Checking PBX call load...")
        self.execute_scheduled_dongle_restarts(force=False, source="Scheduled Off-Hours Maintenance Window")

    def run(self):
        self.running = True
        logger.info(f"Starting Sokrat Laya GSM Maintenance Agent (PID: {os.getpid()})")
        self.start_ipc_server()

        def signal_handler(signum, frame):
            logger.info(f"Received signal {signum}, stopping Laya Agent...")
            self.running = False

        signal.signal(signal.SIGTERM, signal_handler)
        signal.signal(signal.SIGINT, signal_handler)

        while self.running:
            try:
                # If kill switch is active, agent is disarmed and stays in passive standby
                if is_kill_switch_active():
                    logger.debug("Laya kill switch active (agent disarmed). Standing by...")
                else:
                    # Run regular watch cycle
                    self.run_watch_cycle(deep=False)
                    # Check scheduled off-hours maintenance window
                    self.check_and_run_scheduled_restarts()
            except Exception as e:
                logger.error(f"Error in watcher loop: {e}", exc_info=True)

            # Responsive sleep loop
            slept = 0
            while self.running and slept < POLL_INTERVAL_SEC:
                time.sleep(0.5)
                slept += 0.5

        if self.server_sock:
            try:
                self.server_sock.close()
            except Exception:
                pass
            if os.path.exists(SOCKET_PATH):
                os.remove(SOCKET_PATH)
        logger.info("Laya Maintenance Agent shutdown cleanly.")

if __name__ == "__main__":
    agent = LayaEngine()
    agent.run()
