-- 0050: immutable, transactional provenance for audited model-endpoint applies.

-- D1 apply remains disabled, but the same persistent database identity is
-- created now so a future Worker-bound writer can share the contract.
CREATE TABLE model_endpoint_backfill_database_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  database_fingerprint TEXT NOT NULL UNIQUE
    CHECK (
      length(database_fingerprint) = 71
      AND substr(database_fingerprint, 1, 7) = 'sha256:'
      AND substr(database_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  created_at TEXT NOT NULL
);

INSERT INTO model_endpoint_backfill_database_identity
  (singleton, database_fingerprint, created_at)
VALUES (1, 'sha256:' || lower(hex(randomblob(32))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- D1 apply remains fail-closed, but keeping the same empty one-time trust-root
-- slot prevents a future D1 writer from adopting weaker authorization state.
CREATE TABLE model_endpoint_backfill_trust_registry (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  trusted_signers_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(trusted_signers_sha256) = 64
      AND trusted_signers_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  initialized_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  initialized_by TEXT NOT NULL
);

CREATE TABLE model_endpoint_backfill_runs (
  idempotency_key TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  selected_manifest_sha256 TEXT NOT NULL,
  selection_sha256 TEXT NOT NULL,
  database_fingerprint TEXT NOT NULL
    REFERENCES model_endpoint_backfill_database_identity(database_fingerprint),
  request_sha256 TEXT NOT NULL,
  execution_sha256 TEXT NOT NULL,
  authorization_sha256 TEXT NOT NULL,
  trusted_signers_sha256 TEXT NOT NULL
    REFERENCES model_endpoint_backfill_trust_registry(trusted_signers_sha256),
  manifest_actor_id TEXT NOT NULL,
  manifest_actor_key_id TEXT NOT NULL,
  evidence_reviewers_json TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approval_key_id TEXT NOT NULL,
  approval_approved_at TEXT NOT NULL
    CHECK (
      length(approval_approved_at) = 24
      AND approval_approved_at GLOB '????-??-??T??:??:??.???Z'
    ),
  approval_expires_at TEXT NOT NULL
    CHECK (
      length(approval_expires_at) = 24
      AND approval_expires_at GLOB '????-??-??T??:??:??.???Z'
    ),
  applied_at TEXT NOT NULL,
  actions_count INTEGER NOT NULL CHECK (actions_count >= 0),
  endpoints_count INTEGER NOT NULL CHECK (endpoints_count > 0),
  CHECK (manifest_actor_id <> approved_by),
  CHECK (approval_expires_at > approval_approved_at)
);

CREATE TABLE model_endpoint_evidence_attestations (
  idempotency_key TEXT NOT NULL REFERENCES model_endpoint_backfill_runs(idempotency_key),
  endpoint_id TEXT NOT NULL REFERENCES model_endpoints(id) ON DELETE RESTRICT,
  desired_sha256 TEXT NOT NULL,
  before_sha256 TEXT,
  verification_state_sha256 TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  evidence_observed_at TEXT NOT NULL,
  evidence_expires_at TEXT NOT NULL,
  evidence_reviewed_by TEXT NOT NULL,
  evidence_reviewer_key_id TEXT NOT NULL,
  manifest_actor_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (idempotency_key, endpoint_id),
  CHECK (manifest_actor_id <> approved_by),
  CHECK (evidence_reviewed_by <> approved_by)
);

CREATE INDEX idx_model_endpoint_evidence_latest
  ON model_endpoint_evidence_attestations(endpoint_id, applied_at DESC, idempotency_key DESC);

CREATE TRIGGER model_endpoint_backfill_runs_no_update
BEFORE UPDATE ON model_endpoint_backfill_runs
BEGIN
  SELECT RAISE(ABORT, 'model endpoint apply ledger is append-only');
END;

CREATE TRIGGER model_endpoint_backfill_database_identity_no_update
BEFORE UPDATE ON model_endpoint_backfill_database_identity
BEGIN
  SELECT RAISE(ABORT, 'model endpoint database identity is immutable');
END;

CREATE TRIGGER model_endpoint_backfill_database_identity_no_delete
BEFORE DELETE ON model_endpoint_backfill_database_identity
BEGIN
  SELECT RAISE(ABORT, 'model endpoint database identity is immutable');
END;

CREATE TRIGGER model_endpoint_backfill_trust_registry_no_update
BEFORE UPDATE ON model_endpoint_backfill_trust_registry
BEGIN
  SELECT RAISE(ABORT, 'model endpoint signer trust root is immutable');
END;

CREATE TRIGGER model_endpoint_backfill_trust_registry_no_delete
BEFORE DELETE ON model_endpoint_backfill_trust_registry
BEGIN
  SELECT RAISE(ABORT, 'model endpoint signer trust root is immutable');
END;

CREATE TRIGGER model_endpoint_backfill_runs_no_delete
BEFORE DELETE ON model_endpoint_backfill_runs
BEGIN
  SELECT RAISE(ABORT, 'model endpoint apply ledger is append-only');
END;

CREATE TRIGGER model_endpoint_evidence_no_update
BEFORE UPDATE ON model_endpoint_evidence_attestations
BEGIN
  SELECT RAISE(ABORT, 'model endpoint evidence ledger is append-only');
END;

CREATE TRIGGER model_endpoint_evidence_no_delete
BEFORE DELETE ON model_endpoint_evidence_attestations
BEGIN
  SELECT RAISE(ABORT, 'model endpoint evidence ledger is append-only');
END;
