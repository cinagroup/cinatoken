-- Provider classification after all existing CinaToken migrations.

-- Rebuild the full provider dependency closure, retaining every column, constraint, index and trigger.

-- Foreign keys remain enabled; copies reference the new parent tables.

CREATE TABLE providers__kind (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now'))
, endpoints TEXT, api_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', shared_channel_type TEXT, kind TEXT NOT NULL DEFAULT '');

INSERT INTO "providers__kind" ("id", "name", "description", "created_at", "endpoints", "api_key", "status", "shared_channel_type") SELECT "id", "name", "description", "created_at", "endpoints", "api_key", "status", "shared_channel_type" FROM "providers";

CREATE TABLE model_endpoints__kind (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES providers__kind(id) ON DELETE CASCADE,
  provider_slug TEXT NOT NULL,
  tag TEXT NOT NULL,
  endpoint_class TEXT,
  region TEXT,
  context_length INTEGER,
  max_prompt_tokens INTEGER,
  max_completion_tokens INTEGER,
  quantization TEXT,
  supported_parameters TEXT NOT NULL DEFAULT '[]',
  pricing TEXT NOT NULL DEFAULT '{}',
  supports_tool_choice TEXT NOT NULL DEFAULT '{"auto":null,"function":null,"none":null,"required":null}',
  image_capabilities TEXT NOT NULL DEFAULT '{}',
  supports_implicit_caching INTEGER,
  supports_voice_cloning INTEGER,
  evidence_url TEXT,
  verified_by TEXT,
  verified_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, audio_capabilities TEXT NOT NULL DEFAULT '{}',
  CONSTRAINT uk_model_endpoints_identity UNIQUE (model_id, provider_id, tag),
  CONSTRAINT model_endpoints_status_chk
    CHECK (status IN ('draft', 'verified', 'disabled')),
  CONSTRAINT model_endpoints_implicit_caching_chk
    CHECK (supports_implicit_caching IS NULL OR supports_implicit_caching IN (0, 1)),
  CONSTRAINT model_endpoints_voice_cloning_chk
    CHECK (supports_voice_cloning IS NULL OR supports_voice_cloning IN (0, 1)),
  CONSTRAINT model_endpoints_context_length_chk
    CHECK (context_length IS NULL OR context_length > 0),
  CONSTRAINT model_endpoints_max_prompt_tokens_chk
    CHECK (max_prompt_tokens IS NULL OR max_prompt_tokens > 0),
  CONSTRAINT model_endpoints_max_completion_tokens_chk
    CHECK (max_completion_tokens IS NULL OR max_completion_tokens > 0)
);

INSERT INTO "model_endpoints__kind" ("id", "model_id", "provider_id", "provider_slug", "tag", "endpoint_class", "region", "context_length", "max_prompt_tokens", "max_completion_tokens", "quantization", "supported_parameters", "pricing", "supports_tool_choice", "image_capabilities", "supports_implicit_caching", "supports_voice_cloning", "evidence_url", "verified_by", "verified_at", "expires_at", "status", "created_at", "updated_at", "audio_capabilities") SELECT "id", "model_id", "provider_id", "provider_slug", "tag", "endpoint_class", "region", "context_length", "max_prompt_tokens", "max_completion_tokens", "quantization", "supported_parameters", "pricing", "supports_tool_choice", "image_capabilities", "supports_implicit_caching", "supports_voice_cloning", "evidence_url", "verified_by", "verified_at", "expires_at", "status", "created_at", "updated_at", "audio_capabilities" FROM "model_endpoints";

CREATE TABLE model_endpoint_evidence_attestations__kind (
  idempotency_key TEXT NOT NULL REFERENCES model_endpoint_backfill_runs(idempotency_key),
  endpoint_id TEXT NOT NULL REFERENCES model_endpoints__kind(id) ON DELETE RESTRICT,
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

INSERT INTO "model_endpoint_evidence_attestations__kind" ("idempotency_key", "endpoint_id", "desired_sha256", "before_sha256", "verification_state_sha256", "evidence_sha256", "evidence_url", "evidence_observed_at", "evidence_expires_at", "evidence_reviewed_by", "evidence_reviewer_key_id", "manifest_actor_id", "approved_by", "applied_at") SELECT "idempotency_key", "endpoint_id", "desired_sha256", "before_sha256", "verification_state_sha256", "evidence_sha256", "evidence_url", "evidence_observed_at", "evidence_expires_at", "evidence_reviewed_by", "evidence_reviewer_key_id", "manifest_actor_id", "approved_by", "applied_at" FROM "model_endpoint_evidence_attestations";

CREATE TABLE model_routes__kind (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id),
  provider_id TEXT NOT NULL REFERENCES providers__kind(id),
  provider_model_name TEXT NOT NULL,
  upstream_protocol TEXT NOT NULL DEFAULT 'openai',
  route_group TEXT NOT NULL DEFAULT 'default',
  priority INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  price_override TEXT DEFAULT NULL,
  custom_params TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now'))
, weight INTEGER NOT NULL DEFAULT 1, route_pool_id TEXT REFERENCES route_pools(id), upstream_operation TEXT NOT NULL DEFAULT '*', adapter TEXT NOT NULL DEFAULT 'passthrough', routing_metadata TEXT);

INSERT INTO "model_routes__kind" ("id", "model_id", "provider_id", "provider_model_name", "upstream_protocol", "route_group", "priority", "status", "price_override", "custom_params", "created_at", "weight", "route_pool_id", "upstream_operation", "adapter", "routing_metadata") SELECT "id", "model_id", "provider_id", "provider_model_name", "upstream_protocol", "route_group", "priority", "status", "price_override", "custom_params", "created_at", "weight", "route_pool_id", "upstream_operation", "adapter", "routing_metadata" FROM "model_routes";

CREATE TABLE model_endpoint_routes__kind (
  endpoint_id TEXT NOT NULL REFERENCES model_endpoints__kind(id) ON DELETE CASCADE,
  route_target_id TEXT NOT NULL UNIQUE REFERENCES model_routes__kind(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, subject_fingerprint TEXT
  CHECK (
    subject_fingerprint IS NULL OR (
      length(subject_fingerprint) = 64
      AND subject_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  PRIMARY KEY (endpoint_id, route_target_id)
);

INSERT INTO "model_endpoint_routes__kind" ("endpoint_id", "route_target_id", "created_at", "subject_fingerprint") SELECT "endpoint_id", "route_target_id", "created_at", "subject_fingerprint" FROM "model_endpoint_routes";

CREATE TABLE route_data_policies__kind (
  route_target_id TEXT PRIMARY KEY REFERENCES model_routes__kind(id) ON DELETE CASCADE,
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days >= 0),
  training_allowed INTEGER NOT NULL DEFAULT 1 CHECK (training_allowed IN (0, 1)),
  zdr_supported INTEGER NOT NULL DEFAULT 0 CHECK (zdr_supported IN (0, 1)),
  evidence_url TEXT,
  verified_by TEXT,
  verified_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('verified', 'expired', 'unknown')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, subject_fingerprint TEXT, invalidated_at TEXT, invalidation_reason TEXT);

INSERT INTO "route_data_policies__kind" ("route_target_id", "retention_days", "training_allowed", "zdr_supported", "evidence_url", "verified_by", "verified_at", "expires_at", "status", "updated_at", "subject_fingerprint", "invalidated_at", "invalidation_reason") SELECT "route_target_id", "retention_days", "training_allowed", "zdr_supported", "evidence_url", "verified_by", "verified_at", "expires_at", "status", "updated_at", "subject_fingerprint", "invalidated_at", "invalidation_reason" FROM "route_data_policies";

CREATE TABLE route_data_policy_audit__kind (
  id TEXT PRIMARY KEY,
  route_target_id TEXT REFERENCES model_routes__kind(id) ON DELETE SET NULL,
  snapshot_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "route_data_policy_audit__kind" ("id", "route_target_id", "snapshot_json", "actor_id", "created_at") SELECT "id", "route_target_id", "snapshot_json", "actor_id", "created_at" FROM "route_data_policy_audit";

CREATE TABLE route_pool_sticky_bindings__kind (
  route_pool_id TEXT NOT NULL REFERENCES route_pools(id) ON DELETE CASCADE,
  affinity_hash TEXT NOT NULL,
  route_target_id TEXT NOT NULL REFERENCES model_routes__kind(id) ON DELETE CASCADE,
  binding_token TEXT NOT NULL,
  pool_epoch INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (route_pool_id, affinity_hash)
);

INSERT INTO "route_pool_sticky_bindings__kind" ("route_pool_id", "affinity_hash", "route_target_id", "binding_token", "pool_epoch", "expires_at", "created_at", "updated_at") SELECT "route_pool_id", "affinity_hash", "route_target_id", "binding_token", "pool_epoch", "expires_at", "created_at", "updated_at" FROM "route_pool_sticky_bindings";

DROP TABLE "route_pool_sticky_bindings";

DROP TABLE "route_data_policy_audit";

DROP TABLE "route_data_policies";

DROP TABLE "model_endpoint_routes";

DROP TABLE "model_routes";

DROP TABLE "model_endpoint_evidence_attestations";

DROP TABLE "model_endpoints";

DROP TABLE "providers";

ALTER TABLE "providers__kind" RENAME TO "providers";

ALTER TABLE "model_endpoints__kind" RENAME TO "model_endpoints";

ALTER TABLE "model_endpoint_evidence_attestations__kind" RENAME TO "model_endpoint_evidence_attestations";

ALTER TABLE "model_routes__kind" RENAME TO "model_routes";

ALTER TABLE "model_endpoint_routes__kind" RENAME TO "model_endpoint_routes";

ALTER TABLE "route_data_policies__kind" RENAME TO "route_data_policies";

ALTER TABLE "route_data_policy_audit__kind" RENAME TO "route_data_policy_audit";

ALTER TABLE "route_pool_sticky_bindings__kind" RENAME TO "route_pool_sticky_bindings";

CREATE INDEX idx_model_routes_model_status_group_priority
  ON model_routes(model_id, status, route_group, priority);

CREATE INDEX idx_model_routes_pool_status_priority
  ON model_routes(route_pool_id, status, priority);

CREATE INDEX idx_route_pool_sticky_expires_at
  ON route_pool_sticky_bindings(expires_at);

CREATE INDEX idx_route_pool_sticky_target
  ON route_pool_sticky_bindings(route_target_id);

CREATE INDEX idx_route_data_policies_status_expiry ON route_data_policies(status, expires_at);

CREATE INDEX idx_route_data_policy_audit_target_created ON route_data_policy_audit(route_target_id, created_at);

CREATE INDEX idx_model_endpoints_provider
  ON model_endpoints(provider_id);

CREATE INDEX idx_model_endpoints_model_status
  ON model_endpoints(model_id, status);

CREATE INDEX idx_model_endpoint_evidence_latest
  ON model_endpoint_evidence_attestations(endpoint_id, applied_at DESC, idempotency_key DESC);

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

CREATE UNIQUE INDEX uk_providers_name_kind ON providers(name, kind);
