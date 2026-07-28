-- Run this migration explicitly in the application database.
-- The connector must not create or alter customer tables automatically.

CREATE TABLE provenance_outbox (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  envelope JSON NOT NULL,
  available_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(6) NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  delivered_at DATETIME(6) NULL,
  dead_lettered_at DATETIME(6) NULL,
  receipt JSON NULL,
  last_error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  last_error_message VARCHAR(1024) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (sequence_id),
  UNIQUE KEY uq_provenance_outbox_event_id (event_id),
  KEY ix_provenance_outbox_available (
    delivered_at,
    dead_lettered_at,
    available_at,
    lease_expires_at,
    sequence_id
  )
) ENGINE=InnoDB;

-- Suggested least-privilege grants, adapted to the chosen database and accounts:
-- GRANT INSERT ON application_database.provenance_outbox TO 'application_user'@'%';
-- GRANT SELECT, UPDATE ON application_database.provenance_outbox TO 'glare9_provenance_connector'@'%';
