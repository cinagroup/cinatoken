-- 0036: immutable guardrail policies and one direct assignment per user/API key scope.

CREATE TABLE guardrails (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  designated_version INTEGER NOT NULL DEFAULT 1,
  latest_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT guardrails_versions_chk CHECK (designated_version >= 1 AND latest_version >= designated_version)
);

CREATE INDEX idx_guardrails_owner_status ON guardrails(owner_user_id, status, updated_at DESC);

CREATE TABLE guardrail_versions (
  id TEXT PRIMARY KEY,
  guardrail_id TEXT NOT NULL REFERENCES guardrails(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  config_json TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_guardrail_versions UNIQUE (guardrail_id, version)
);

CREATE INDEX idx_guardrail_versions_guardrail_created ON guardrail_versions(guardrail_id, created_at DESC);

CREATE TABLE guardrail_assignments (
  id TEXT PRIMARY KEY,
  guardrail_id TEXT NOT NULL REFERENCES guardrails(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'api_key')),
  scope_id TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_guardrail_assignments_scope UNIQUE (scope_type, scope_id)
);

CREATE INDEX idx_guardrail_assignments_guardrail ON guardrail_assignments(guardrail_id, scope_type, scope_id);
