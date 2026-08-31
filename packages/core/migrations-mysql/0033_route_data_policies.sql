-- 0033: verified retention/training/ZDR policy per concrete route target.

CREATE TABLE route_data_policies (
  route_target_id VARCHAR(512) PRIMARY KEY,
  retention_days INT,
  training_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  zdr_supported BOOLEAN NOT NULL DEFAULT FALSE,
  evidence_url TEXT,
  verified_by VARCHAR(512),
  verified_at TIMESTAMP(6) NULL,
  expires_at TIMESTAMP(6) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'unknown',
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT route_data_policies_retention_chk CHECK (retention_days IS NULL OR retention_days >= 0),
  CONSTRAINT route_data_policies_status_chk CHECK (status IN ('verified', 'expired', 'unknown')),
  CONSTRAINT fk_route_data_policies_target FOREIGN KEY (route_target_id) REFERENCES model_routes(id) ON DELETE CASCADE,
  INDEX idx_route_data_policies_status_expiry (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE route_data_policy_audit (
  id VARCHAR(512) PRIMARY KEY,
  route_target_id VARCHAR(512),
  snapshot_json TEXT NOT NULL,
  actor_id VARCHAR(512) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_route_data_policy_audit_target FOREIGN KEY (route_target_id) REFERENCES model_routes(id) ON DELETE SET NULL,
  INDEX idx_route_data_policy_audit_target_created (route_target_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
