"""
Laya Sensors — MariaDB Database Storage Interface
Persists real-time health metrics and maintenance audit logs.
"""

import pymysql
from laya.config import DB_HOST, DB_USER, DB_PASS, DB_NAME

def get_connection():
    """
    Returns an open MariaDB connection.
    """
    return pymysql.connect(
        host=DB_HOST,
        user=DB_USER,
        password=DB_PASS,
        database=DB_NAME,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=True
    )

def upsert_dongle_health(health_data):
    """
    Upserts a dongle record into laya_dongle_health table.
    health_data is a dictionary with health properties.
    """
    query = """
    INSERT INTO `laya_dongle_health` (
        `dongle_name`, `health_score`, `status`, `rssi`, `carrier_registered`,
        `provider_name`, `model`, `firmware`, `imei`, `imsi`, `phone_number`,
        `active_channel`, `stuck_state_duration`, `healing_level`,
        `last_heal_action`, `last_heal_at`, `consecutive_errors`, `last_check_at`
    ) VALUES (
        %(dongle_name)s, %(health_score)s, %(status)s, %(rssi)s, %(carrier_registered)s,
        %(provider_name)s, %(model)s, %(firmware)s, %(imei)s, %(imsi)s, %(phone_number)s,
        %(active_channel)s, %(stuck_state_duration)s, %(healing_level)s,
        %(last_heal_action)s, %(last_heal_at)s, %(consecutive_errors)s, NOW()
    ) ON DUPLICATE KEY UPDATE
        `health_score` = VALUES(`health_score`),
        `status` = VALUES(`status`),
        `rssi` = VALUES(`rssi`),
        `carrier_registered` = VALUES(`carrier_registered`),
        `provider_name` = COALESCE(VALUES(`provider_name`), `provider_name`),
        `model` = COALESCE(VALUES(`model`), `model`),
        `firmware` = COALESCE(VALUES(`firmware`), `firmware`),
        `imei` = COALESCE(VALUES(`imei`), `imei`),
        `imsi` = COALESCE(VALUES(`imsi`), `imsi`),
        `phone_number` = COALESCE(VALUES(`phone_number`), `phone_number`),
        `active_channel` = VALUES(`active_channel`),
        `stuck_state_duration` = VALUES(`stuck_state_duration`),
        `healing_level` = VALUES(`healing_level`),
        `last_heal_action` = COALESCE(VALUES(`last_heal_action`), `last_heal_action`),
        `last_heal_at` = COALESCE(VALUES(`last_heal_at`), `last_heal_at`),
        `consecutive_errors` = VALUES(`consecutive_errors`),
        `last_check_at` = NOW()
    """
    clean_params = {
        "dongle_name": health_data.get("dongle_name"),
        "health_score": health_data.get("health_score", 100),
        "status": health_data.get("status", "healthy"),
        "rssi": health_data.get("rssi"),
        "carrier_registered": health_data.get("carrier_registered", 1),
        "provider_name": health_data.get("provider_name"),
        "model": health_data.get("model"),
        "firmware": health_data.get("firmware"),
        "imei": health_data.get("imei"),
        "imsi": health_data.get("imsi"),
        "phone_number": health_data.get("phone_number"),
        "active_channel": health_data.get("active_channel"),
        "stuck_state_duration": health_data.get("stuck_state_duration", 0),
        "healing_level": health_data.get("healing_level", 0),
        "last_heal_action": health_data.get("last_heal_action"),
        "last_heal_at": health_data.get("last_heal_at"),
        "consecutive_errors": health_data.get("consecutive_errors", 0),
    }
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute(query, clean_params)
        conn.close()
        return True
    except Exception as e:
        # Avoid crashing daemon on transient DB errors
        print(f"[LAYA-DB-WARN] upsert_dongle_health error: {e}")
        return False

def record_maintenance_event(dongle_name, trigger_reason, recovery_level, action_taken, result="in_progress", details=""):
    """
    Inserts a record into laya_maintenance_events.
    Returns the inserted record ID or None.
    """
    query = """
    INSERT INTO `laya_maintenance_events` (
        `dongle_name`, `trigger_reason`, `recovery_level`, `action_taken`, `result`, `details`, `created_at`
    ) VALUES (%s, %s, %s, %s, %s, %s, NOW())
    """
    try:
        conn = get_connection()
        event_id = None
        with conn.cursor() as cursor:
            cursor.execute(query, (dongle_name, trigger_reason, recovery_level, action_taken, result, details))
            event_id = cursor.lastrowid
        conn.close()
        return event_id
    except Exception as e:
        print(f"[LAYA-DB-WARN] record_maintenance_event error: {e}")
        return None

def update_maintenance_event_result(event_id, result, details=""):
    """
    Updates status and details of an existing maintenance event.
    """
    if not event_id:
        return False
    query = """
    UPDATE `laya_maintenance_events`
    SET `result` = %s,
        `details` = CASE 
            WHEN `details` IS NULL OR `details` = '' THEN %s 
            ELSE CONCAT(`details`, ' | ', %s) 
        END
    WHERE `id` = %s
    """
    try:
        conn = get_connection()
        clean_det = str(details).strip() if details else ""
        with conn.cursor() as cursor:
            cursor.execute(query, (result, clean_det, clean_det, event_id))
        conn.close()
        return True
    except Exception as e:
        print(f"[LAYA-DB-WARN] update_event_result error: {e}")
        return False

def get_all_dongle_health():
    """
    Fetches all dongle health rows.
    """
    query = "SELECT * FROM `laya_dongle_health` ORDER BY `dongle_name` ASC"
    try:
        conn = get_connection()
        rows = []
        with conn.cursor() as cursor:
            cursor.execute(query)
            rows = cursor.fetchall()
        conn.close()
        return rows
    except Exception as e:
        print(f"[LAYA-DB-WARN] get_all_dongle_health error: {e}")
        return []

def get_recent_maintenance_events(limit=50):
    """
    Fetches recent maintenance events.
    """
    query = "SELECT * FROM `laya_maintenance_events` ORDER BY `id` DESC LIMIT %s"
    try:
        conn = get_connection()
        rows = []
        with conn.cursor() as cursor:
            cursor.execute(query, (limit,))
            rows = cursor.fetchall()
        conn.close()
        return rows
    except Exception as e:
        print(f"[LAYA-DB-WARN] get_recent_maintenance_events error: {e}")
        return []

def get_alert_settings():
    """
    Fetches alert credentials (Telegram, client_name) from dashboard_settings table.
    """
    settings = {
        "telegram_enabled": True,
        "telegram_bot_token": "8742498784:AAF49-2KCi7kT24ZnGpdKuxO4CweqyqHELc",
        "telegram_chat_id": "8996079391",
        "client_name": ""
    }
    query = "SELECT setting_key, setting_value FROM `dashboard_settings` WHERE setting_key LIKE 'alert_telegram%' OR setting_key = 'client_name'"
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute(query)
            rows = cursor.fetchall()
            for r in rows:
                k = r.get("setting_key", "")
                v = r.get("setting_value", "")
                if k == "alert_telegram_enabled":
                    settings["telegram_enabled"] = (str(v).lower() == "true")
                elif k == "alert_telegram_bot_token" and v:
                    settings["telegram_bot_token"] = str(v).strip()
                elif k == "alert_telegram_chat_id" and v:
                    settings["telegram_chat_id"] = str(v).strip()
                elif k == "client_name" and v:
                    settings["client_name"] = str(v).strip()
        conn.close()
    except Exception as e:
        print(f"[LAYA-DB-WARN] get_alert_settings error: {e}")
    return settings

def get_scheduled_restart_settings():
    """
    Fetches user-defined scheduled restart settings from dashboard_settings table.
    """
    settings = {
        "enabled": True,
        "start_time": "03:00",
        "end_time": "07:00",
        "cooldown_sec": 25,
        "last_run": ""
    }
    query = "SELECT setting_key, setting_value FROM `dashboard_settings` WHERE setting_key LIKE 'laya_scheduled_restart%'"
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute(query)
            rows = cursor.fetchall()
            for r in rows:
                k = r.get("setting_key", "")
                v = r.get("setting_value", "")
                if k == "laya_scheduled_restart_enabled":
                    settings["enabled"] = (str(v).lower() in ("true", "1", "yes"))
                elif k == "laya_scheduled_restart_start" and v:
                    settings["start_time"] = str(v).strip()
                elif k == "laya_scheduled_restart_end" and v:
                    settings["end_time"] = str(v).strip()
                elif k == "laya_scheduled_restart_cooldown_sec" and v:
                    try:
                        settings["cooldown_sec"] = max(5, int(v))
                    except ValueError:
                        pass
                elif k == "laya_scheduled_restart_last_run" and v:
                    settings["last_run"] = str(v).strip()
        conn.close()
    except Exception as e:
        print(f"[LAYA-DB-WARN] get_scheduled_restart_settings error: {e}")
    return settings

def is_kill_switch_active():
    """
    Checks if Laya Agent kill switch is active (default is True / disabled unless switched on).
    """
    query = "SELECT setting_value FROM `dashboard_settings` WHERE setting_key = 'laya_kill_switch_active' LIMIT 1"
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute(query)
            row = cursor.fetchone()
            if row:
                v = str(row.get("setting_value", "")).lower().strip()
                conn.close()
                return v in ("true", "1", "yes")
        conn.close()
    except Exception as e:
        print(f"[LAYA-DB-WARN] is_kill_switch_active error: {e}")
    return True

def set_scheduled_restart_setting(key, value):
    """
    Upserts a scheduled restart setting in dashboard_settings table.
    """
    query = """
    INSERT INTO `dashboard_settings` (setting_key, setting_value)
    VALUES (%s, %s)
    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
    """
    try:
        conn = get_connection()
        with conn.cursor() as cursor:
            cursor.execute(query, (key, str(value)))
        conn.commit()
        conn.close()
        return True
    except Exception as e:
        print(f"[LAYA-DB-WARN] set_scheduled_restart_setting error: {e}")
        return False

