CREATE TABLE IF NOT EXISTS `dashboard_users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(100) NOT NULL UNIQUE,
  `email` VARCHAR(255) DEFAULT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `extension` VARCHAR(20) DEFAULT NULL,
  `reset_token` VARCHAR(255) DEFAULT NULL,
  `reset_expires` DATETIME DEFAULT NULL,
  `reset_token_expires` DATETIME DEFAULT NULL,
  `group_id` INT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_dash_users_extension` (`extension`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dashboard_user_dongles` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `dongle_name` VARCHAR(50) NOT NULL,
  UNIQUE KEY `idx_user_dongle` (`user_id`, `dongle_name`),
  KEY `idx_dongle_name` (`dongle_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dashboard_user_extensions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `extension` VARCHAR(20) NOT NULL,
  `peer_id` INT DEFAULT NULL,
  UNIQUE KEY `idx_user_extension` (`user_id`, `extension`),
  KEY `idx_extension` (`extension`),
  KEY `idx_peer_id` (`peer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dashboard_user_preferences` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(100) NOT NULL UNIQUE,
  `user_id` INT DEFAULT NULL,
  `preferences_json` LONGTEXT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_pref_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dashboard_settings` (
  `setting_key` VARCHAR(100) PRIMARY KEY,
  `setting_value` TEXT DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO `dashboard_settings` (`setting_key`, `setting_value`) VALUES
  ('alert_telegram_enabled', 'true'),
  ('alert_telegram_bot_token', '8742498784:AAF49-2KCi7kT24ZnGpdKuxO4CweqyqHELc'),
  ('alert_telegram_chat_id', '8996079391'),
  ('alert_email_enabled', 'false'),
  ('alert_email_recipients', ''),
  ('alert_healthchecks_url', 'https://hc-ping.com/b8b5b103-e272-4666-bb37-561780de64f3'),
  ('alert_auto_restart', 'true'),
  ('alert_check_interval_sec', '30'),
  ('alert_monitored_services', '["asterisk","database","sokrat-voip","httpd"]'),
  ('webhook_incoming_call_enabled', 'false'),
  ('webhook_incoming_call_url', ''),
  ('webhook_incoming_call_secret', '');

CREATE TABLE IF NOT EXISTS `dashboard_groups` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL UNIQUE,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dashboard_group_permissions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `group_id` INT NOT NULL,
  `tab` VARCHAR(50) NOT NULL,
  UNIQUE KEY `idx_group_tab` (`group_id`, `tab`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `extension_policies` (
  `extension` VARCHAR(20) PRIMARY KEY,
  `auto_answer` ENUM('user_choice', 'force_on', 'force_off') NOT NULL DEFAULT 'user_choice',
  `dnd` ENUM('user_choice', 'force_on', 'force_off') NOT NULL DEFAULT 'user_choice',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `gsm_dongles` (
  `dongle_name` VARCHAR(50) NOT NULL PRIMARY KEY,
  `imsi` VARCHAR(30) DEFAULT NULL,
  `imei` VARCHAR(30) DEFAULT NULL,
  `phone_number` VARCHAR(30) DEFAULT NULL,
  `dynamic_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_imsi` (`imsi`),
  KEY `idx_imei` (`imei`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dongle_state_logs` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `dongle_name` VARCHAR(50) NOT NULL,
  `sim_number` VARCHAR(50) DEFAULT NULL,
  `imsi` VARCHAR(30) DEFAULT NULL,
  `imei` VARCHAR(30) DEFAULT NULL,
  `state` VARCHAR(50) NOT NULL,
  `started_at` DATETIME NOT NULL,
  `ended_at` DATETIME DEFAULT NULL,
  `duration_sec` INT DEFAULT 0,
  KEY `idx_dongle_start` (`dongle_name`, `started_at`),
  KEY `idx_sim_start` (`sim_number`, `started_at`),
  KEY `idx_state` (`state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `employee_groups` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL UNIQUE,
  `description` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `employee_extras` (
  `extension` VARCHAR(50) NOT NULL PRIMARY KEY,
  `photo` VARCHAR(255) DEFAULT NULL,
  `title` VARCHAR(255) DEFAULT NULL,
  `emp_group` VARCHAR(100) DEFAULT NULL,
  `is_group_admin` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `synq_agent_status` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `extension` VARCHAR(20) NOT NULL,
  `display_name` VARCHAR(100) NOT NULL,
  `status` VARCHAR(50) NOT NULL,
  `last_update` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `idx_extension` (`extension`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `synq_agent_status_log` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `extension` VARCHAR(20) NOT NULL,
  `status` VARCHAR(50) NOT NULL,
  `start_time` TIMESTAMP NOT NULL,
  `end_time` TIMESTAMP NULL DEFAULT NULL,
  `duration_seconds` INT DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS `dialer_campaigns` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL,
  `mode` ENUM('progressive', 'predictive') DEFAULT 'progressive',
  `status` ENUM('draft', 'running', 'paused', 'completed') DEFAULT 'draft',
  `outbound_route_id` INT DEFAULT NULL,
  `origination_caller_id` VARCHAR(50) DEFAULT '101',
  `queue_name` VARCHAR(50) DEFAULT 'autodialer-queue',
  `fallback_destination` VARCHAR(100) DEFAULT 'app-blackhole,hangup,1',
  `pacing_ratio` DECIMAL(3,1) DEFAULT 1.0,
  `max_concurrent_dials` INT DEFAULT 5,
  `amd_enabled` TINYINT(1) DEFAULT 1,
  `wrapup_time_sec` INT DEFAULT 15,
  `max_queue_wait_sec` INT DEFAULT 5,
  `auto_answer` TINYINT(1) DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dialer_leads` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `campaign_id` INT NOT NULL,
  `phone_number` VARCHAR(50) NOT NULL,
  `first_name` VARCHAR(100) DEFAULT NULL,
  `last_name` VARCHAR(100) DEFAULT NULL,
  `company` VARCHAR(100) DEFAULT NULL,
  `custom_data` JSON DEFAULT NULL,
  `status` ENUM('pending', 'dialing', 'connected', 'no_answer', 'busy', 'failed', 'machine', 'dnc') DEFAULT 'pending',
  `attempts` INT DEFAULT 0,
  `last_called_at` DATETIME DEFAULT NULL,
  `agent_extension` VARCHAR(20) DEFAULT NULL,
  `disposition` VARCHAR(50) DEFAULT NULL,
  `call_duration_sec` INT DEFAULT 0,
  KEY `idx_camp_status_id` (`campaign_id`, `status`, `id`),
  KEY `idx_phone` (`phone_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dialer_call_attempts` (
  `attempt_uuid` VARCHAR(64) PRIMARY KEY,
  `action_id` VARCHAR(64) UNIQUE,
  `campaign_id` INT NOT NULL,
  `lead_id` INT NOT NULL,
  `active_flag` TINYINT(1) DEFAULT NULL, -- 1 when in-flight, NULL when terminal (enforces 1 active attempt per lead)
  `uniqueid` VARCHAR(64) DEFAULT NULL,
  `linkedid` VARCHAR(64) DEFAULT NULL,
  `channel` VARCHAR(100) DEFAULT NULL,
  `dongle_id` VARCHAR(50) DEFAULT NULL,
  `agent_extension` VARCHAR(20) DEFAULT NULL,
  `status` ENUM('originated', 'ringing', 'lead_answered', 'amd_passed', 'queued', 'agent_bridged', 'completed', 'abandoned', 'machine', 'busy', 'no_answer', 'failed', 'stale') NOT NULL DEFAULT 'originated',
  `cause_code` INT DEFAULT NULL,
  `lease_expires_at` DATETIME NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `idx_active_lead` (`lead_id`, `active_flag`),
  KEY `idx_action_id` (`action_id`),
  KEY `idx_uniqueid` (`uniqueid`),
  KEY `idx_linkedid` (`linkedid`),
  KEY `idx_camp_status` (`campaign_id`, `status`),
  KEY `idx_lease` (`status`, `lease_expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dialer_agent_states` (
  `extension` VARCHAR(20) PRIMARY KEY,
  `state` ENUM('idle', 'reserved', 'in_call', 'wrapup', 'paused') DEFAULT 'idle',
  `current_lead_id` INT DEFAULT NULL,
  `current_attempt_uuid` VARCHAR(64) DEFAULT NULL,
  `wrapup_until` DATETIME DEFAULT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dialer_dispositions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(50) NOT NULL UNIQUE,
  `category` ENUM('interested', 'not_interested', 'callback', 'sale', 'wrong_number') DEFAULT 'not_interested'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dialer_dnc` (
  `phone_number` VARCHAR(50) PRIMARY KEY,
  `reason` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dashboard_inbound_blacklist` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `phone_number` VARCHAR(50) NOT NULL UNIQUE,
  `description` VARCHAR(255) DEFAULT NULL,
  `action` VARCHAR(30) DEFAULT 'zapateller',
  `enabled` TINYINT(1) DEFAULT 1,
  `blocked_count` INT DEFAULT 0,
  `last_blocked_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_phone` (`phone_number`),
  KEY `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `storage_settings` (
  `id` INT PRIMARY KEY DEFAULT 1,
  `auto_purge_days` INT DEFAULT 90,
  `gdrive_enabled` TINYINT(1) DEFAULT 0,
  `gdrive_folder_name` VARCHAR(255) DEFAULT 'Sokrat-VoIP-Backups',
  `gdrive_credentials` TEXT DEFAULT NULL,
  `auto_backup_schedule` VARCHAR(50) DEFAULT 'daily',
  `queue_provisioned` TINYINT(1) DEFAULT 0,
  `last_backup_at` DATETIME DEFAULT NULL,
  `last_backup_status` VARCHAR(50) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `storage_settings` (`id`) VALUES (1);

CREATE TABLE IF NOT EXISTS `voicemail_storage_settings` (
  `id` INT PRIMARY KEY DEFAULT 1,
  `max_messages` INT DEFAULT 1000,
  `max_duration_sec` INT DEFAULT 300,
  `retention_days` INT DEFAULT 90,
  `auto_purge_enabled` TINYINT(1) DEFAULT 0,
  `last_purged_at` DATETIME DEFAULT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `voicemail_storage_settings` (`id`, `max_messages`, `max_duration_sec`, `retention_days`, `auto_purge_enabled`)
VALUES (1, 1000, 300, 90, 0);

-- Ensure target tables exist before configuring FreePBX/Asterisk defaults
CREATE TABLE IF NOT EXISTS `asterisk`.`sipsettings` (
  `keyword` VARCHAR(50) NOT NULL DEFAULT '',
  `data`    VARCHAR(255) NOT NULL DEFAULT '',
  `seq`     TINYINT(1) NOT NULL DEFAULT '1',
  `type`    TINYINT(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`keyword`,`seq`,`type`)
);

CREATE TABLE IF NOT EXISTS `asterisk`.`pjsipsettings` (
  `keyword` VARCHAR(50) NOT NULL DEFAULT '',
  `data`    VARCHAR(255) NOT NULL DEFAULT '',
  `seq`     TINYINT(1) NOT NULL DEFAULT '1',
  `type`    TINYINT(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`keyword`,`seq`,`type`)
);

CREATE TABLE IF NOT EXISTS `asterisk`.`featurecodes` (
  `modulename` VARCHAR(50) NOT NULL,
  `featurename` VARCHAR(50) NOT NULL,
  `description` VARCHAR(200) NOT NULL DEFAULT '',
  `defaultcode` VARCHAR(20) DEFAULT NULL,
  `customcode` VARCHAR(20) DEFAULT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `providedest` TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`modulename`,`featurename`)
);

CREATE TABLE IF NOT EXISTS `asterisk`.`notifications` (
  `module` VARCHAR(24) NOT NULL,
  `id` VARCHAR(24) NOT NULL,
  `level` INTEGER NOT NULL DEFAULT 0,
  `display_text` VARCHAR(255) NOT NULL DEFAULT '',
  `extended_text` TEXT NOT NULL,
  `link` VARCHAR(255) NOT NULL DEFAULT '',
  `reset` TINYINT(1) NOT NULL DEFAULT 0,
  `candelete` TINYINT(1) NOT NULL DEFAULT 1,
  `timestamp` INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (`module`,`id`)
);

-- Prioritize HD Voice / Wideband Codecs (G.722 / Opus) for high-quality extension-to-extension calls
UPDATE `asterisk`.`sipsettings` SET `data` = '1', `seq` = 0 WHERE `keyword` = 'g722';
UPDATE `asterisk`.`sipsettings` SET `data` = '2', `seq` = 1 WHERE `keyword` = 'opus';
UPDATE `asterisk`.`sipsettings` SET `data` = '3', `seq` = 2 WHERE `keyword` = 'ulaw';
UPDATE `asterisk`.`sipsettings` SET `data` = '4', `seq` = 3 WHERE `keyword` = 'alaw';
UPDATE `asterisk`.`sipsettings` SET `data` = '5', `seq` = 4 WHERE `keyword` = 'gsm';

UPDATE `asterisk`.`pjsipsettings` SET `data` = '1', `seq` = 0 WHERE `keyword` = 'g722';
UPDATE `asterisk`.`pjsipsettings` SET `data` = '2', `seq` = 1 WHERE `keyword` = 'opus';
UPDATE `asterisk`.`pjsipsettings` SET `data` = '3', `seq` = 2 WHERE `keyword` = 'ulaw';
UPDATE `asterisk`.`pjsipsettings` SET `data` = '4', `seq` = 3 WHERE `keyword` = 'alaw';
UPDATE `asterisk`.`pjsipsettings` SET `data` = '5', `seq` = 4 WHERE `keyword` = 'gsm';

-- Configure Call Pickup feature code to '*' (General & Directed) and disable conflicting direct voicemail '*'
UPDATE `asterisk`.`featurecodes` SET `customcode` = '*', `enabled` = 1 WHERE `modulename` = 'core' AND `featurename` = 'pickupexten';
UPDATE `asterisk`.`featurecodes` SET `customcode` = '*', `enabled` = 1 WHERE `modulename` = 'core' AND `featurename` = 'pickup';
UPDATE `asterisk`.`featurecodes` SET `customcode` = '**', `enabled` = 0 WHERE `modulename` = 'voicemail' AND `featurename` = 'directdialvoicemail';

-- Clear any stale retrieve_conf failure notification
DELETE FROM `asterisk`.`notifications` WHERE `id` = 'RCONFFAIL';
CREATE TABLE IF NOT EXISTS `dashboard_crm_clients` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `client_id` VARCHAR(64) NOT NULL UNIQUE,
  `name` VARCHAR(100) NOT NULL,
  `secret_hash` VARCHAR(255) NOT NULL,
  `allowed_origin` VARCHAR(255) NOT NULL,
  `default_country_code` VARCHAR(10) NOT NULL DEFAULT '20',
  `allowed_scopes` TEXT NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` DATETIME DEFAULT NULL,
  `revoked_at` DATETIME DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dashboard_crm_pairing_codes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `code_hash` VARCHAR(255) NOT NULL UNIQUE,
  `expires_at` DATETIME NOT NULL,
  `used_at` DATETIME DEFAULT NULL,
  `created_by` VARCHAR(100) NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dashboard_crm_embed_tickets` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `ticket_hash` VARCHAR(255) NOT NULL UNIQUE,
  `session_token_hash` VARCHAR(255) DEFAULT NULL UNIQUE,
  `client_id` VARCHAR(64) NOT NULL,
  `crm_user_id` VARCHAR(100) NOT NULL,
  `crm_user_name` VARCHAR(100) NOT NULL,
  `supervisor_extension` VARCHAR(20) DEFAULT NULL,
  `effective_scopes` TEXT NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `consumed_at` DATETIME DEFAULT NULL,
  `session_expires_at` DATETIME DEFAULT NULL,
  KEY `idx_session_hash` (`session_token_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dashboard_crm_audit_logs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `client_id` VARCHAR(64) NOT NULL,
  `crm_user_id` VARCHAR(100) DEFAULT NULL,
  `supervisor_extension` VARCHAR(20) DEFAULT NULL,
  `target_extension` VARCHAR(20) DEFAULT NULL,
  `action` VARCHAR(50) NOT NULL,
  `success` TINYINT(1) NOT NULL DEFAULT 1,
  `details` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `stt_settings` (
  `id` INT PRIMARY KEY DEFAULT 1,
  `enabled` TINYINT(1) DEFAULT 1,
  `engine` VARCHAR(32) DEFAULT 'cloud_api',
  `provider` VARCHAR(32) DEFAULT 'groq',
  `api_key` TEXT DEFAULT NULL,
  `api_url` VARCHAR(255) DEFAULT 'https://api.groq.com/openai/v1/audio/transcriptions',
  `model_name` VARCHAR(64) DEFAULT 'whisper-large-v3',
  `language` VARCHAR(10) DEFAULT 'auto',
  `prompt` TEXT DEFAULT NULL,
  `transcribe_calls` TINYINT(1) DEFAULT 1,
  `transcribe_voicemails` TINYINT(1) DEFAULT 1,
  `min_duration_sec` INT DEFAULT 3,
  `max_concurrency` INT DEFAULT 1,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `stt_settings` (`id`) VALUES (1);

CREATE TABLE IF NOT EXISTS `asteriskcdrdb`.`cdr_transcriptions` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `uniqueid` VARCHAR(32) NOT NULL UNIQUE,
  `recordingfile` VARCHAR(255) NOT NULL,
  `language` VARCHAR(10) DEFAULT 'auto',
  `transcript` LONGTEXT NOT NULL,
  `status` ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
  `error_message` VARCHAR(255) DEFAULT NULL,
  `duration_sec` INT DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `completed_at` DATETIME DEFAULT NULL,
  INDEX `idx_stt_status` (`status`),
  FULLTEXT KEY `ft_transcript` (`transcript`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `asteriskcdrdb`.`voicemail_transcriptions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `mailbox` VARCHAR(20) NOT NULL,
  `msg_file` VARCHAR(100) NOT NULL,
  `callerid` VARCHAR(80) DEFAULT NULL,
  `transcript` LONGTEXT NOT NULL,
  `status` ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uniq_vm_file` (`mailbox`, `msg_file`),
  INDEX `idx_vm_stt_status` (`status`),
  FULLTEXT KEY `ft_vm_transcript` (`transcript`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Sokrat Push Gateway device registry (see sokrat-push-gateway repo)
-- Maps PBX extensions to their APNs/FCM push tokens for push-to-wake calls.
CREATE TABLE IF NOT EXISTS `mobile_devices` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `extension` VARCHAR(20) NOT NULL,
  `platform` ENUM('ios','android') NOT NULL,
  `token` VARCHAR(1024) NOT NULL COMMENT 'APNs device token (non-voip) or FCM registration token',
  `voip_token` VARCHAR(1024) DEFAULT NULL COMMENT 'APNs PushKit VoIP token (iOS only)',
  `device_uuid` VARCHAR(128) NOT NULL,
  `app_version` VARCHAR(40) DEFAULT NULL,
  `last_push_error` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `idx_token` (`token`(255)),
  UNIQUE KEY `uniq_platform_device` (`platform`, `device_uuid`),
  KEY `idx_extension` (`extension`),
  KEY `idx_updated` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sokrat IAX2 VoIP Multi-Server Federation & Central Live Panel Tables
CREATE TABLE IF NOT EXISTS `sokrat_federation_settings` (
  `id` TINYINT PRIMARY KEY DEFAULT 1,
  `local_site_code` VARCHAR(10) NOT NULL DEFAULT '10',
  `local_node_name` VARCHAR(100) NOT NULL DEFAULT 'Main PBX',
  `panel_role` ENUM('local', 'central') NOT NULL DEFAULT 'local',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `sokrat_federation_settings` (`id`, `local_site_code`, `local_node_name`, `panel_role`)
VALUES (1, '10', 'Main PBX', 'local');

CREATE TABLE IF NOT EXISTS `sokrat_federation_peers` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `node_name` VARCHAR(100) NOT NULL,
  `host` VARCHAR(255) NOT NULL,
  `site_code` VARCHAR(10) NOT NULL UNIQUE,
  `iax_port` SMALLINT UNSIGNED NOT NULL DEFAULT 4569,
  `iax_user_inbound` VARCHAR(80) NOT NULL,
  `iax_peer_outbound` VARCHAR(80) NOT NULL,
  `iax_secret_enc` TEXT NOT NULL,
  `api_base_url` VARCHAR(255) NOT NULL,
  `api_key_enc` TEXT NOT NULL,
  `tls_cert_fingerprint` VARCHAR(128) DEFAULT NULL,
  `allow_internal_dialing` TINYINT(1) NOT NULL DEFAULT 1,
  `allow_outbound_egress` TINYINT(1) NOT NULL DEFAULT 1,
  `status` ENUM('online', 'offline', 'error', 'unreachable') NOT NULL DEFAULT 'offline',
  `last_sync_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sokrat_federation_remote_extensions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `peer_id` INT NOT NULL,
  `native_extension` VARCHAR(20) NOT NULL,
  `dial_alias` VARCHAR(30) NOT NULL UNIQUE,
  `display_name` VARCHAR(100) NOT NULL,
  `status` ENUM('online', 'offline', 'ringing', 'in_call', 'unknown') NOT NULL DEFAULT 'unknown',
  `last_seen_at` DATETIME DEFAULT NULL,
  UNIQUE KEY `idx_peer_ext` (`peer_id`, `native_extension`),
  KEY `idx_peer_id` (`peer_id`),
  KEY `idx_dial_alias` (`dial_alias`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sokrat_federation_remote_dongles` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `peer_id` INT NOT NULL,
  `dongle_name` VARCHAR(50) NOT NULL,
  `phone_number` VARCHAR(50) DEFAULT NULL,
  `provider` VARCHAR(50) DEFAULT NULL,
  `status` VARCHAR(50) DEFAULT 'Unknown',
  UNIQUE KEY `idx_peer_dongle` (`peer_id`, `dongle_name`),
  KEY `idx_peer_id` (`peer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `extension_status_current` (
  `extension` VARCHAR(20) NOT NULL PRIMARY KEY,
  `status` ENUM('offline', 'idle', 'ringing', 'incall') NOT NULL DEFAULT 'offline',
  `partner` VARCHAR(50) DEFAULT NULL,
  `status_since` DATETIME NOT NULL,
  `last_updated` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `extension_status_logs` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `extension` VARCHAR(20) NOT NULL,
  `status` ENUM('offline', 'idle', 'ringing', 'incall') NOT NULL,
  `partner` VARCHAR(50) DEFAULT NULL,
  `start_time` DATETIME NOT NULL,
  `end_time` DATETIME NOT NULL,
  `duration_seconds` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_ext_start_end` (`extension`, `start_time`, `end_time`),
  INDEX `idx_ext_status` (`extension`, `status`),
  INDEX `idx_status` (`status`),
  INDEX `idx_start_time` (`start_time`),
  INDEX `idx_end_time` (`end_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `dashboard_api_keys` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL,
  `key_prefix` VARCHAR(64) NOT NULL,
  `key_hash` VARCHAR(64) NOT NULL UNIQUE,
  `encrypted_key` TEXT NOT NULL,
  `scopes` VARCHAR(255) DEFAULT '*',
  `allowed_ips` VARCHAR(255) DEFAULT NULL,
  `status` ENUM('active', 'revoked') DEFAULT 'active',
  `created_by` VARCHAR(64) DEFAULT 'root',
  `last_used_at` DATETIME DEFAULT NULL,
  `last_used_ip` VARCHAR(64) DEFAULT NULL,
  `expires_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_api_key_hash (`key_hash`),
  INDEX idx_api_key_status (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `crm_call_telemetry` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `uniqueid` VARCHAR(50) DEFAULT NULL,
  `call_id` VARCHAR(100) DEFAULT NULL,
  `extension` VARCHAR(20) NOT NULL,
  `phone` VARCHAR(50) DEFAULT NULL,
  `direction` ENUM('inbound', 'outbound') DEFAULT 'outbound',
  `lead_id` BIGINT DEFAULT NULL,
  `lead_name` VARCHAR(150) DEFAULT NULL,
  `hold_seconds` INT DEFAULT 0,
  `hold_count` TINYINT DEFAULT 0,
  `mute_seconds` INT DEFAULT 0,
  `wrap_up_seconds` INT DEFAULT 0,
  `jitter_ms` FLOAT DEFAULT 0,
  `packet_loss_pct` FLOAT DEFAULT 0,
  `rtt_ms` INT DEFAULT 0,
  `disposition_outcome` VARCHAR(100) DEFAULT NULL,
  `audio_device_name` VARCHAR(150) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_telemetry_uniqueid` (`uniqueid`),
  INDEX `idx_telemetry_ext` (`extension`),
  INDEX `idx_telemetry_lead` (`lead_id`),
  INDEX `idx_telemetry_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sokrat_camp_on_callbacks` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `caller_ext` VARCHAR(20) NOT NULL,
  `target_ext` VARCHAR(20) NOT NULL,
  `status` ENUM('pending', 'originating', 'connected', 'cancelled', 'expired', 'failed') NOT NULL DEFAULT 'pending',
  `attempt_count` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` DATETIME NOT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  INDEX `idx_camp_pending` (`status`, `target_ext`, `caller_ext`),
  INDEX `idx_camp_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sokrat Live Panel Call Control Codes (Dynamic & Configurable, Default on Install)
CREATE TABLE IF NOT EXISTS `sokrat_call_codes` (
  `id` VARCHAR(64) PRIMARY KEY,
  `cat` VARCHAR(32) NOT NULL,
  `code` VARCHAR(32) NOT NULL,
  `default_code` VARCHAR(32) NOT NULL,
  `name_en` VARCHAR(128) NOT NULL,
  `name_ar` VARCHAR(128) NOT NULL,
  `desc_en` TEXT NOT NULL,
  `desc_ar` TEXT NOT NULL,
  `example_en` VARCHAR(128) NOT NULL,
  `example_ar` VARCHAR(128) NOT NULL,
  `timing` VARCHAR(32) NOT NULL DEFAULT 'precall',
  `dial` TINYINT(1) NOT NULL DEFAULT 1,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order` INT NOT NULL DEFAULT 0,
  `backend_type` VARCHAR(32) NOT NULL,
  `backend_module` VARCHAR(64) DEFAULT NULL,
  `backend_feature` VARCHAR(64) DEFAULT NULL,
  `backend_feature_secondary` VARCHAR(64) DEFAULT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_scc_cat` (`cat`),
  INDEX `idx_scc_sort` (`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `sokrat_call_codes`
  (`id`, `cat`, `code`, `default_code`, `name_en`, `name_ar`, `desc_en`, `desc_ar`, `example_en`, `example_ar`, `timing`, `dial`, `enabled`, `sort_order`, `backend_type`, `backend_module`, `backend_feature`, `backend_feature_secondary`)
VALUES
  ('incall_blindxfer', 'incall', '##', '##', 'In-Call Blind Transfer', 'تحويل أعمى مباشر (Blind Transfer)', 'Transfers active call immediately to another extension without announcing.', 'تحويل المكالمة الجارية فوراً إلى رقم داخلي أو خارجي دون انتظار رده.', '## + [Target Extension]', '## + [رقم التحويلة]', 'incall', 0, 1, 1, 'featurecode', 'core', 'blindxfer', NULL),
  ('incall_atxfer', 'incall', '*2', '*2', 'In-Call Attended Transfer', 'تحويل مشروط بعد استئذان (Attended)', 'Puts caller on hold, calls recipient to announce, then bridges upon hangup.', 'وضع المتصل في الانتظار والتحدث مع المستلم أولاً قبل تأكيد التحويل.', '*2 + [Target Extension]', '*2 + [رقم التحويلة]', 'incall', 0, 1, 2, 'featurecode', 'core', 'atxfer', NULL),
  ('incall_recording', 'incall', '*1', '*1', 'One-Touch Call Recording', 'تسجيل المكالمة الحالية (One-Touch)', 'Toggles on-demand live audio recording for the active conversation.', 'بدء أو إيقاف تسجيل المكالمة الجارية يدوياً أثناء التحدث.', '*1', '*1', 'incall', 0, 1, 3, 'featurecode', 'core', 'automon', NULL),
  ('incall_disconnect', 'incall', '**', '**', 'Keypad Call Disconnect', 'إنهاء وفصل المكالمة عبر اللوحة', 'Immediately terminates the current active call via phone DTMF.', 'إنهاء المكالمة الحالية فوراً من لوحة المفاتيح دون لمس زر السماعة.', '**', '**', 'incall', 0, 1, 4, 'featurecode', 'core', 'disconnect', NULL),
  ('incall_campon_busy', 'incall', '6', '6', 'Camp-On Callback (When Busy)', 'حجز التحويلة المشغولة (Camp-On)', 'While hearing busy tone on an internal extension, press 6 to auto-callback when free.', 'عند سماع نغمة المشغول، اضغط 6 لحجز التحويلة والاتصال بك تلقائياً عند فراغها.', 'Press 6 during busy tone', 'اضغط 6 أثناء نغمة المشغول', 'busy', 0, 1, 5, 'dialplan_campon_busy', NULL, NULL, NULL),
  ('campon_activate', 'campon', '*82', '*82', 'Camp-On Activate (Post-Hangup)', 'طلب معاودة الاتصال التلقائي (*82)', 'Dial after hanging up on a busy extension to schedule automatic callback.', 'اطلب *82 بعد إغلاق الخط مع تحويلة مشغولة لحجز معاودة الاتصال التلقائي.', '*82', '*82', 'precall', 1, 1, 6, 'dialplan_campon_act', NULL, NULL, NULL),
  ('campon_cancel', 'campon', '*83', '*83', 'Camp-On Cancel', 'إلغاء حجز معاودة الاتصال (*83)', 'Cancels any pending automatic callbacks queued for your extension.', 'إلغاء كافة طلبات معاودة الاتصال التلقائي المحجوزة لتحويلتك.', '*83', '*83', 'precall', 1, 1, 7, 'dialplan_campon_cancel', NULL, NULL, NULL),
  ('campon_pickup_group', 'campon', '*', '*', 'Group Call Pickup (*)', 'التقاط مكالمة المجموعة (*)', 'Answers any incoming call currently ringing in your department/pickup group.', 'الرد على أي مكالمة ترن حالياً داخل قسمك أو مجموعة الرنين الخاصة بك.', '*', '*', 'precall', 1, 1, 8, 'featurecode', 'core', 'pickupexten', NULL),
  ('campon_pickup_directed', 'campon', '*[Ext]', '*[Ext]', 'Directed Call Pickup', 'سحب مكالمة تحويلة محددة (* + الرقم)', 'Intercepts and answers a call currently ringing on a specific colleague\'s phone.', 'سحب مكالمة ترن على هاتف زميل معين والرد عليها من جهازك (مثال: 102* أو 102**).', '*102 / **102', '*102 / **102', 'precall', 0, 1, 9, 'featurecode', 'core', 'pickup', NULL),
  ('spy_listen', 'spy', '222[Ext]', '222[Ext]', 'Spy: Listen-Only Mode', 'تنصت صامت (استماع فقط)', 'Silently listens to an active call on target extension without either party hearing.', 'الاستماع لمكالمة الموظف الجارية بسرية تامة دون أن يعلم أي طرف بوجودك.', '222102', '222102', 'precall', 0, 1, 10, 'dialplan_spy', NULL, 'listen', NULL),
  ('spy_whisper', 'spy', '223[Ext]', '223[Ext]', 'Whisper: Coaching Mode', 'تدريب وتوجيه الموظف (همس)', 'Speaks only into agent\'s headset for live guidance without client hearing.', 'التحدث مع الموظف فقط لتوجيهه وتدريبه دون أن يسمع العميل صوتك.', '223102', '223102', 'precall', 0, 1, 11, 'dialplan_spy', NULL, 'whisper', NULL),
  ('spy_barge', 'spy', '224[Ext]', '224[Ext]', 'Barge: Conference In', 'اقتحام المكالمة (مكالمة ثلاثية)', 'Barges into active conversation as a 3rd party where all participants can speak.', 'الدخول في المكالمة كمشارك ثالث يتحدث مع الطرفين ويسمعه الجميع.', '224102', '224102', 'precall', 0, 1, 12, 'dialplan_spy', NULL, 'barge', NULL),
  ('spy_hijack', 'spy', '225[Ext]', '225[Ext]', 'Instant Call Hijack', 'سحب وفصل المكالمة (Hijack)', 'Immediately disconnects the agent and redirects the customer leg to your phone.', 'فصل الموظف فوراً وتحويل مكالمة العميل إلى هاتفك لمتابعتها بنفسك.', '225102', '225102', 'precall', 0, 1, 13, 'dialplan_spy', NULL, 'hijack', NULL),
  ('spy_chanspy_menu', 'spy', '555', '555', 'ChanSpy Interactive Menu', 'قائمة تصفح المكالمات النشطة', 'Interactive Asterisk menu to cycle through all live channels (press * to skip).', 'الدخول لقائمة استعراض جميع القنوات النشطة والتنقل بينها بالزر *.', '555', '555', 'precall', 1, 1, 14, 'featurecode', 'core', 'chanspy', NULL),
  ('intercom_direct', 'intercom', '*80[Ext]', '*80[Ext]', 'Direct 1-to-1 Intercom', 'نداء داخلي فوري (1 إلى 1)', 'Auto-answers destination extension on speakerphone for instant two-way voice.', 'فتح مكبر صوت هاتف الزميل فوراً والتحدث معه مباشرة دون انتظار رنين.', '*80102', '*80102', 'precall', 0, 1, 15, 'featurecode', 'paging', 'intercom-prefix', NULL),
  ('intercom_mass', 'intercom', '*800 / 800', '*800 / 800', 'Mass Intercom / Paging', 'إذاعة صوتية جماعية (Paging)', 'Broadcasts audio announcement across all available deskphone speakerphones.', 'بث نداء صوتي جماعي عبر مكبرات صوت كافة الهواتف المتاحة في الشركة.', '*800', '*800', 'precall', 1, 1, 16, 'dialplan_paging', NULL, NULL, NULL),
  ('parking_lot', 'parking', '70', '70', 'Park Call (Lot 70)', 'تعليق المكالمة في الموقف (70)', 'Transfer call to 70 to park it; system announces assigned parking slot (71-78).', 'تحويل المكالمة إلى 70 لتعليقها؛ يعلن النظام صوتياً رقم الموقف (71-78).', 'Transfer to 70', 'تحويل المكالمة إلى 70', 'precall', 1, 1, 17, 'parking_lot', NULL, NULL, NULL),
  ('parking_retrieve', 'parking', '71 – 78', '71 – 78', 'Retrieve Parked Call', 'استرجاع المكالمة المعلقة (71-78)', 'Dial announced slot number (71 through 78) from any phone to resume the call.', 'طلب رقم الموقف المعلن (من 71 حتى 78) من أي هاتف لاستئناف المكالمة.', '71, 72, 73...', '71, 72, 73...', 'precall', 0, 1, 18, 'parking_retrieve', NULL, NULL, NULL),
  ('cf_all_on', 'forward', '*72', '*72', 'Call Forward All - Activate', 'تحويل كافة المكالمات - تفعيل', 'Unconditionally forwards all incoming calls to another internal or external number.', 'تحويل كافة المكالمات الواردة دائماً إلى رقم داخلي أو رقم خارجي.', '*72 + [Destination]', '*72 + [الرقم المراد التحويل إليه]', 'precall', 0, 1, 19, 'featurecode', 'callforward', 'cfon', NULL),
  ('cf_all_off', 'forward', '*73', '*73', 'Call Forward All - Deactivate', 'إلغاء تحويل كافة المكالمات (*73)', 'Cancels unconditional call forwarding and resumes normal ringing.', 'إلغاء التحويل الدائم وإعادة استقبال المكالمات على جهازك.', '*73', '*73', 'precall', 1, 1, 20, 'featurecode', 'callforward', 'cfoff', NULL),
  ('cf_toggle', 'forward', '*740', '*740', 'Call Forward Toggle', 'تبديل حالة التحويل (Toggle)', 'One-touch toggle for preconfigured call forward destination.', 'تشغيل أو إيقاف التحويل المسبق بضغطة زر واحدة.', '*740', '*740', 'precall', 1, 1, 21, 'featurecode', 'callforward', 'cf_toggle', NULL),
  ('cf_busy', 'forward', '*90 / *91', '*90 / *91', 'Call Forward Busy (On / Off)', 'تحويل عند الانشغال (تشغيل/إلغاء)', 'Forwards incoming calls only when line is engaged on another call.', 'تحويل المكالمات الواردة فقط إذا كان خطك مشغولاً بمكالمة أخرى.', '*90 + [Number] / *91', '*90 + [الرقم] / *91', 'precall', 0, 1, 22, 'featurecode_pair', 'callforward', 'cfbon', 'cfboff'),
  ('cf_noanswer', 'forward', '*52 / *53', '*52 / *53', 'Call Forward No Answer (On / Off)', 'تحويل عند عدم الرد (تشغيل/إلغاء)', 'Forwards calls when not answered within the configured ring duration.', 'تحويل المكالمة بعد انتهاء مدة الرنين المحددة دون رد.', '*52 + [Number] / *53', '*52 + [الرقم] / *53', 'precall', 0, 1, 23, 'featurecode_pair', 'callforward', 'cfuon', 'cfuoff'),
  ('dnd_on_off', 'forward', '*78 / *79', '*78 / *79', 'Do Not Disturb (DND On / Off)', 'وضع عدم الإزعاج (تشغيل/إلغاء)', 'Blocks all incoming calls and directs callers to busy signal or voicemail.', 'رفض كافة المكالمات الواردة تلقائياً وتحويلها للمشغول أو البريد.', '*78 / *79', '*78 / *79', 'precall', 1, 1, 24, 'featurecode_pair', 'donotdisturb', 'dnd_on', 'dnd_off'),
  ('dnd_toggle', 'forward', '*76', '*76', 'DND Toggle', 'تبديل وضع عدم الإزعاج (*76)', 'One-touch toggle for Do Not Disturb availability state.', 'تبديل وضع عدم الإزعاج (تشغيل / إيقاف) بالتناوب.', '*76', '*76', 'precall', 1, 1, 25, 'featurecode', 'donotdisturb', 'dnd_toggle', NULL),
  ('cw_on_off', 'forward', '*70 / *71', '*70 / *71', 'Call Waiting (On / Off)', 'انتظار المكالمات (تفعيل/إلغاء)', 'Enables or disables receiving a second incoming call while talking.', 'السماح باستقبال مكالمة ثانية أثناء التحدث في مكالمة أولى.', '*70 / *71', '*70 / *71', 'precall', 1, 1, 26, 'featurecode_pair', 'callwaiting', 'cwon', 'cwoff'),
  ('queue_agent_toggle', 'forward', '*45', '*45', 'Queue Agent Login / Logout', 'تسجيل دخول/خروج من الطابور (*45)', 'Toggles customer care queue dynamic agent membership.', 'تسجيل دخول أو خروج الموظف من طابور خدمة العملاء.', '*45', '*45', 'precall', 1, 1, 27, 'featurecode', 'queues', 'que_toggle', NULL),
  ('queue_agent_pause', 'forward', '*46', '*46', 'Queue Agent Pause / Resume', 'استراحة مؤقتة في الطابور (*46)', 'Puts agent on temporary break pause without unregistering from queue.', 'أخذ استراحة مؤقتة داخل الطابور دون تسجيل خروج كامل.', '*46', '*46', 'precall', 1, 1, 28, 'featurecode', 'queues', 'que_pause_toggle', NULL),
  ('diag_echo_test', 'diagnostics', '*43', '*43', 'Audio Echo & Latency Test', 'اختبار صدى الصوت وزمن الاستجابة (*43)', 'Echoes back spoken voice in real-time to assess network latency and audio fidelity.', 'إعادة سماع صوتك فوراً لفحص زمن استجابة الشبكة وجودة الصوت.', '*43', '*43', 'precall', 1, 1, 29, 'featurecode', 'infoservices', 'echotest', NULL),
  ('diag_rnnoise_vad', 'diagnostics', '*88', '*88', 'AI RNNoise + VAD Gate Echo Test', 'فحص عزل الضوضاء الذكي مع كتم الصمت (*88)', 'Live test of neural noise suppression with VAD gate (total silence on breath/pauses).', 'اختبار عزل الضوضاء بالذكاء الاصطناعي مع كتم تام أثناء الوقفات.', '*88', '*88', 'precall', 1, 1, 30, 'dialplan_rnnoise', NULL, 'vad', NULL),
  ('diag_rnnoise_cont', 'diagnostics', '*87', '*87', 'AI RNNoise Continuous Echo Test', 'فحص عزل الضوضاء المستمر (*87)', 'Live test of continuous neural noise cancellation without hard silence gate.', 'اختبار فلترة التشويش والضوضاء العصبية المستمرة دون كتم تام.', '*87', '*87', 'precall', 1, 1, 31, 'dialplan_rnnoise', NULL, 'cont', NULL),
  ('diag_rnnoise_raw', 'diagnostics', '*89', '*89', 'Raw Audio Baseline Test', 'اختبار الصوت الخام للمقارنة (*89)', 'Raw unfiltered microphone stream to benchmark noise cancellation performance.', 'سماع الصوت الطبيعي بدون فلترة لمقارنة فاعلية الذكاء الاصطناعي.', '*89', '*89', 'precall', 1, 1, 32, 'dialplan_rnnoise', NULL, 'raw', NULL),
  ('diag_my_voicemail', 'diagnostics', '*97', '*97', 'My Voicemail', 'صندوق البريد الصوتي الشخصي (*97)', 'Direct access to your extension\'s voicemail inbox.', 'الدخول إلى صندوق البريد الصوتي الخاص بتحويلتك لسماع الرسائل.', '*97', '*97', 'precall', 1, 1, 33, 'featurecode', 'voicemail', 'myvoicemail', NULL),
  ('diag_blacklist', 'diagnostics', '*30 / *32', '*30 / *32', 'Blacklist Caller (*30 / *32)', 'إضافة رقم للقائمة السوداء (*30 / *32)', 'Blocks nuisance numbers from calling your PBX (*32 blocks the last caller immediately).', 'حظر الأرقام المزعجة من الاتصال بالمقسم (*32 لحظر آخر متصل فوراً).', '*30 / *32', '*30 / *32', 'precall', 1, 1, 34, 'featurecode_pair', 'blacklist', 'blacklist_add', 'blacklist_last'),
  ('diag_speak_exten', 'diagnostics', '*65', '*65', 'Speak Extension Number', 'نطق رقم التحويلة (*65)', 'Speaks out the registered internal extension number of this phone.', 'ينطق النظام صوتياً رقم تحويلتك المسجلة للتأكد من هويتها.', '*65', '*65', 'precall', 1, 1, 35, 'featurecode', 'infoservices', 'speakextennum', NULL),
  ('diag_speaking_clock', 'diagnostics', '*60', '*60', 'Speaking Server Clock', 'ساعة النظام الرسمية (*60)', 'Speaks current official server date and time.', 'سماع التوقيت الرسمي المسجل على سيرفر المقسم صوتياً.', '*60', '*60', 'precall', 1, 1, 36, 'featurecode', 'infoservices', 'speakingclock', NULL)
ON DUPLICATE KEY UPDATE
  default_code = VALUES(default_code),
  name_en = VALUES(name_en),
  name_ar = VALUES(name_ar),
  desc_en = VALUES(desc_en),
  desc_ar = VALUES(desc_ar),
  timing = VALUES(timing),
  dial = VALUES(dial),
  sort_order = VALUES(sort_order),
  backend_type = VALUES(backend_type),
  backend_module = VALUES(backend_module),
  backend_feature = VALUES(backend_feature),
  backend_feature_secondary = VALUES(backend_feature_secondary);
