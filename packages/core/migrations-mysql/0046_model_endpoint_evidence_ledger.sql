-- 0046: immutable, transactional provenance for audited model-endpoint applies.

-- Generated once by the database. Operators copy this non-secret identifier
-- into the manifest and environment; apply verifies the persisted row.
CREATE TABLE model_endpoint_backfill_database_identity (
  singleton TINYINT NOT NULL,
  database_fingerprint CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  database_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  server_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  apply_user VARCHAR(288) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  created_at TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (singleton),
  UNIQUE KEY uk_model_endpoint_backfill_database_fingerprint (database_fingerprint),
  CHECK (singleton = 1),
  CHECK (database_fingerprint REGEXP '^sha256:[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO model_endpoint_backfill_database_identity
  (singleton, database_fingerprint, database_name, server_uuid, apply_user, created_at)
VALUES (
  1,
  CONCAT('sha256:', LOWER(SHA2(CONCAT(UUID(), ':', UUID(), ':', UTC_TIMESTAMP(6), ':', DATABASE()), 256))),
  DATABASE(),
  @@server_uuid,
  CURRENT_USER(),
  UTC_TIMESTAMP(6)
);

-- Initialized exactly once by the production bootstrap after the signer
-- registry has been reviewed.  There is deliberately no seed row.
CREATE TABLE model_endpoint_backfill_trust_registry (
  singleton TINYINT NOT NULL,
  trusted_signers_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  initialized_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  initialized_by VARCHAR(288) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  PRIMARY KEY (singleton),
  UNIQUE KEY uk_model_endpoint_backfill_trusted_signers (trusted_signers_sha256),
  CHECK (singleton = 1),
  CHECK (trusted_signers_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE model_endpoint_backfill_runs (
  idempotency_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  manifest_id VARCHAR(512) NOT NULL,
  manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  selected_manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  selection_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  database_fingerprint VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  authorization_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trusted_signers_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  manifest_actor_id VARCHAR(512) NOT NULL,
  manifest_actor_key_id VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evidence_reviewers_json MEDIUMTEXT NOT NULL,
  approved_by VARCHAR(512) NOT NULL,
  approval_key_id VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  approval_approved_at VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  approval_expires_at VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  applied_at TIMESTAMP(6) NOT NULL,
  actions_count INT NOT NULL,
  endpoints_count INT NOT NULL,
  PRIMARY KEY (idempotency_key),
  CONSTRAINT fk_model_endpoint_backfill_run_database_identity
    FOREIGN KEY (database_fingerprint)
    REFERENCES model_endpoint_backfill_database_identity(database_fingerprint),
  CONSTRAINT fk_model_endpoint_backfill_run_trust_registry
    FOREIGN KEY (trusted_signers_sha256)
    REFERENCES model_endpoint_backfill_trust_registry(trusted_signers_sha256),
  CHECK (actions_count >= 0),
  CHECK (endpoints_count > 0),
  CHECK (BINARY manifest_actor_id <> BINARY approved_by),
  CHECK (approval_approved_at REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'),
  CHECK (approval_expires_at REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'),
  CHECK (BINARY approval_expires_at > BINARY approval_approved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE model_endpoint_evidence_attestations (
  idempotency_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  endpoint_id VARCHAR(191) NOT NULL,
  desired_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  before_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
  verification_state_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evidence_url TEXT NOT NULL,
  evidence_observed_at TIMESTAMP(6) NOT NULL,
  evidence_expires_at TIMESTAMP(6) NOT NULL,
  evidence_reviewed_by VARCHAR(512) NOT NULL,
  evidence_reviewer_key_id VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  manifest_actor_id VARCHAR(512) NOT NULL,
  approved_by VARCHAR(512) NOT NULL,
  applied_at TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (idempotency_key, endpoint_id),
  INDEX idx_model_endpoint_evidence_latest (endpoint_id, applied_at DESC, idempotency_key DESC),
  CONSTRAINT fk_model_endpoint_evidence_run
    FOREIGN KEY (idempotency_key) REFERENCES model_endpoint_backfill_runs(idempotency_key),
  CONSTRAINT fk_model_endpoint_evidence_endpoint
    FOREIGN KEY (endpoint_id) REFERENCES model_endpoints(id) ON DELETE RESTRICT,
  CHECK (BINARY manifest_actor_id <> BINARY approved_by),
  CHECK (BINARY evidence_reviewed_by <> BINARY approved_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TRIGGER model_endpoint_backfill_runs_no_update
BEFORE UPDATE ON model_endpoint_backfill_runs
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'model endpoint apply ledger is append-only';

CREATE TRIGGER model_endpoint_backfill_database_identity_no_update
BEFORE UPDATE ON model_endpoint_backfill_database_identity
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'model endpoint database identity is immutable';

CREATE TRIGGER model_endpoint_backfill_database_identity_no_delete
BEFORE DELETE ON model_endpoint_backfill_database_identity
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'model endpoint database identity is immutable';

CREATE TRIGGER model_endpoint_backfill_trust_registry_no_update
BEFORE UPDATE ON model_endpoint_backfill_trust_registry
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'model endpoint signer trust root is immutable';

CREATE TRIGGER model_endpoint_backfill_trust_registry_no_delete
BEFORE DELETE ON model_endpoint_backfill_trust_registry
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'model endpoint signer trust root is immutable';

CREATE TRIGGER model_endpoint_backfill_runs_no_delete
BEFORE DELETE ON model_endpoint_backfill_runs
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'model endpoint apply ledger is append-only';

CREATE TRIGGER model_endpoint_evidence_no_update
BEFORE UPDATE ON model_endpoint_evidence_attestations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'model endpoint evidence ledger is append-only';

CREATE TRIGGER model_endpoint_evidence_no_delete
BEFORE DELETE ON model_endpoint_evidence_attestations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'model endpoint evidence ledger is append-only';
