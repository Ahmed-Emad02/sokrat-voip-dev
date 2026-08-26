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

CREATE TABLE IF NOT EXISTS `dashboard_settings` (
  `setting_key` VARCHAR(100) PRIMARY KEY,
  `setting_value` TEXT DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
