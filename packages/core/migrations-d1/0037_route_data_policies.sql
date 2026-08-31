-- 0037: verified retention/training/ZDR policy per concrete route target.

CREATE TABLE route_data_policies (
  route_target_id TEXT PRIMARY KEY REFERENCES model_routes(id) ON DELETE CASCADE,
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days >= 0),
  training_allowed INTEGER NOT NULL DEFAULT 1 CHECK (training_allowed IN (0, 1)),
  zdr_supported INTEGER NOT NULL DEFAULT 0 CHECK (zdr_supported IN (0, 1)),
  evidence_url TEXT,
  verified_by TEXT,
  verified_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('verified', 'expired', 'unknown')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_route_data_policies_status_expiry ON route_data_policies(status, expires_at);

CREATE TABLE route_data_policy_audit (
  id TEXT PRIMARY KEY,
  route_target_id TEXT REFERENCES model_routes(id) ON DELETE SET NULL,
  snapshot_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_route_data_policy_audit_target_created ON route_data_policy_audit(route_target_id, created_at);
