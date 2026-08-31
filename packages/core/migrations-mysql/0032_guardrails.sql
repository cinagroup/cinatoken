-- 0032: immutable guardrail policies and one direct assignment per user/API key scope.

CREATE TABLE guardrails (
  id VARCHAR(512) PRIMARY KEY,
  owner_user_id VARCHAR(512) NOT NULL,
  name VARCHAR(512) NOT NULL,
  description TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  designated_version INT NOT NULL DEFAULT 1,
  latest_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT guardrails_status_chk CHECK (status IN ('active', 'archived')),
  CONSTRAINT guardrails_versions_chk CHECK (designated_version >= 1 AND latest_version >= designated_version),
  CONSTRAINT fk_guardrails_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_guardrails_owner_status (owner_user_id, status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE guardrail_versions (
  id VARCHAR(512) PRIMARY KEY,
  guardrail_id VARCHAR(512) NOT NULL,
  version INT NOT NULL,
  config_json TEXT NOT NULL,
  created_by_user_id VARCHAR(512),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT uk_guardrail_versions UNIQUE (guardrail_id, version),
  CONSTRAINT guardrail_versions_version_chk CHECK (version >= 1),
  CONSTRAINT fk_guardrail_versions_guardrail FOREIGN KEY (guardrail_id) REFERENCES guardrails(id) ON DELETE CASCADE,
  CONSTRAINT fk_guardrail_versions_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_guardrail_versions_guardrail_created (guardrail_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE guardrail_assignments (
  id VARCHAR(512) PRIMARY KEY,
  guardrail_id VARCHAR(512) NOT NULL,
  scope_type VARCHAR(16) NOT NULL,
  scope_id VARCHAR(512) NOT NULL,
  created_by_user_id VARCHAR(512),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT uk_guardrail_assignments_scope UNIQUE (scope_type, scope_id),
  CONSTRAINT guardrail_assignments_scope_chk CHECK (scope_type IN ('user', 'api_key')),
  CONSTRAINT fk_guardrail_assignments_guardrail FOREIGN KEY (guardrail_id) REFERENCES guardrails(id) ON DELETE CASCADE,
  CONSTRAINT fk_guardrail_assignments_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_guardrail_assignments_guardrail (guardrail_id, scope_type, scope_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
