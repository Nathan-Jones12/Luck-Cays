CREATE TABLE IF NOT EXISTS luck_cays_admins (
  firebase_uid VARCHAR(128) NOT NULL,
  email VARCHAR(255) NOT NULL,
  role ENUM('SUPER_ADMIN', 'CONTENT_ADMIN') NOT NULL DEFAULT 'CONTENT_ADMIN',
  status ENUM('ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
  totp_secret_ciphertext VARBINARY(512) NULL,
  totp_enabled_at DATETIME(3) NULL,
  last_totp_counter BIGINT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (firebase_uid),
  UNIQUE KEY uq_luck_cays_admins_email (email),
  KEY idx_luck_cays_admins_status_role (status, role)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS luck_cays_admin_sessions (
  id CHAR(36) NOT NULL,
  firebase_uid VARCHAR(128) NOT NULL,
  session_token_hash BINARY(32) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_luck_cays_admin_sessions_token (session_token_hash),
  KEY idx_luck_cays_admin_sessions_admin_expiry (firebase_uid, expires_at, revoked_at),
  CONSTRAINT fk_luck_cays_admin_sessions_admin
    FOREIGN KEY (firebase_uid) REFERENCES luck_cays_admins (firebase_uid)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS luck_cays_games (
  id CHAR(36) NOT NULL,
  slug VARCHAR(80) NOT NULL,
  name VARCHAR(120) NOT NULL,
  category ENUM('Slots', 'Table', 'Instant') NOT NULL,
  studio VARCHAR(100) NOT NULL,
  art_theme ENUM('coral', 'lagoon', 'mango', 'night', 'palm', 'tide') NOT NULL DEFAULT 'lagoon',
  mark VARCHAR(16) NOT NULL DEFAULT '*',
  description VARCHAR(280) NOT NULL DEFAULT '',
  status ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
  real_money_enabled TINYINT(1) NOT NULL DEFAULT 0,
  created_by_uid VARCHAR(128) NOT NULL,
  updated_by_uid VARCHAR(128) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_luck_cays_games_slug (slug),
  KEY idx_luck_cays_games_public_catalog (status, category, created_at),
  CONSTRAINT chk_luck_cays_games_demo_only CHECK (real_money_enabled = 0),
  CONSTRAINT fk_luck_cays_games_created_by
    FOREIGN KEY (created_by_uid) REFERENCES luck_cays_admins (firebase_uid)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_luck_cays_games_updated_by
    FOREIGN KEY (updated_by_uid) REFERENCES luck_cays_admins (firebase_uid)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS luck_cays_audit_logs (
  id CHAR(36) NOT NULL,
  actor_uid VARCHAR(128) NULL,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(48) NOT NULL,
  entity_id VARCHAR(64) NULL,
  details JSON NULL,
  correlation_id CHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_luck_cays_audit_actor_time (actor_uid, created_at),
  KEY idx_luck_cays_audit_entity_time (entity_type, entity_id, created_at),
  CONSTRAINT fk_luck_cays_audit_actor
    FOREIGN KEY (actor_uid) REFERENCES luck_cays_admins (firebase_uid)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS luck_cays_security_events (
  id CHAR(36) NOT NULL,
  firebase_uid VARCHAR(128) NULL,
  source_hash BINARY(32) NULL,
  event_type VARCHAR(48) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_luck_cays_security_source_time (source_hash, event_type, created_at),
  KEY idx_luck_cays_security_user_time (firebase_uid, event_type, created_at),
  CONSTRAINT fk_luck_cays_security_admin
    FOREIGN KEY (firebase_uid) REFERENCES luck_cays_admins (firebase_uid)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;
