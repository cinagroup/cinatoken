-- 0049: immutable, transactional provenance for audited model-endpoint applies.

-- A database-generated, persistent identity prevents an approved manifest from
-- being replayed against a different database that merely received the same
-- operator environment variable. It is an identifier, not a credential.
CREATE TABLE model_endpoint_backfill_database_identity (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  database_fingerprint TEXT NOT NULL UNIQUE
    CHECK (database_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  database_name TEXT NOT NULL,
  database_oid BIGINT NOT NULL,
  gateway_schema TEXT NOT NULL CHECK (gateway_schema = 'cinatoken_gateway'),
  apply_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO model_endpoint_backfill_database_identity
  (singleton, database_fingerprint, database_name, database_oid, gateway_schema, apply_role, created_at)
SELECT
  1,
  'sha256:' || encode(
    sha256(convert_to(
      random()::text || ':' || clock_timestamp()::text || ':' ||
      txid_current()::text || ':' || current_database() || ':' || current_user,
      'UTF8'
    )),
    'hex'
  ),
  current_database(),
  oid::bigint,
  'cinatoken_gateway',
  current_user,
  CURRENT_TIMESTAMP
FROM pg_database
WHERE datname = current_database();

-- The first production bootstrap writes the canonical trusted-signer registry
-- digest here.  The singleton key plus append-only trigger makes that trust
-- root impossible to rotate implicitly during an apply.
CREATE TABLE model_endpoint_backfill_trust_registry (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  trusted_signers_sha256 TEXT NOT NULL UNIQUE
    CHECK (trusted_signers_sha256 ~ '^[0-9a-f]{64}$'),
  initialized_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  initialized_by TEXT NOT NULL DEFAULT current_user
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
    CHECK (approval_approved_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  approval_expires_at TEXT NOT NULL
    CHECK (approval_expires_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  applied_at TIMESTAMPTZ NOT NULL,
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
  evidence_observed_at TIMESTAMPTZ NOT NULL,
  evidence_expires_at TIMESTAMPTZ NOT NULL,
  evidence_reviewed_by TEXT NOT NULL,
  evidence_reviewer_key_id TEXT NOT NULL,
  manifest_actor_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (idempotency_key, endpoint_id),
  CHECK (manifest_actor_id <> approved_by),
  CHECK (evidence_reviewed_by <> approved_by)
);

CREATE INDEX idx_model_endpoint_evidence_latest
  ON model_endpoint_evidence_attestations(endpoint_id, applied_at DESC, idempotency_key DESC);

CREATE FUNCTION reject_model_endpoint_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'model endpoint evidence ledger is append-only';
END;
$$;

CREATE TRIGGER model_endpoint_backfill_runs_no_mutation
BEFORE UPDATE OR DELETE ON model_endpoint_backfill_runs
FOR EACH ROW EXECUTE FUNCTION reject_model_endpoint_ledger_mutation();

CREATE TRIGGER model_endpoint_backfill_database_identity_no_mutation
BEFORE UPDATE OR DELETE ON model_endpoint_backfill_database_identity
FOR EACH ROW EXECUTE FUNCTION reject_model_endpoint_ledger_mutation();

CREATE TRIGGER model_endpoint_backfill_trust_registry_no_mutation
BEFORE UPDATE OR DELETE ON model_endpoint_backfill_trust_registry
FOR EACH ROW EXECUTE FUNCTION reject_model_endpoint_ledger_mutation();

CREATE TRIGGER model_endpoint_evidence_no_mutation
BEFORE UPDATE OR DELETE ON model_endpoint_evidence_attestations
FOR EACH ROW EXECUTE FUNCTION reject_model_endpoint_ledger_mutation();

-- A previously provisioned runtime role may inherit INSERT through the
-- migrator's default privileges. Revoke DML in this migration transaction so
-- there is no post-commit window in which runtime credentials can claim the
-- singleton trust root or manufacture immutable provenance. The role is
-- optional in development databases, hence the conditional dynamic statement.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cinatoken_gateway_runtime') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE '
      || 'cinatoken_gateway.model_endpoint_backfill_database_identity, '
      || 'cinatoken_gateway.model_endpoint_backfill_trust_registry, '
      || 'cinatoken_gateway.model_endpoint_backfill_runs, '
      || 'cinatoken_gateway.model_endpoint_evidence_attestations '
      || 'FROM cinatoken_gateway_runtime';
  END IF;
END;
$$;
