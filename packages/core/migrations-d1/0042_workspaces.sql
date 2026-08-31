-- 0042: CinaToken-owned gateway workspaces over the CinaAuth organization projection.
-- Existing users and active/pending organizations receive deterministic Default workspaces.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL
    CHECK (scope_type IN ('personal', 'organization')),
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  personal_owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  is_default INTEGER NOT NULL DEFAULT 0
    CHECK (is_default IN (0, 1)),
  default_scope_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  settings_json TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT workspaces_scope_owner_chk CHECK (
    (scope_type = 'personal' AND personal_owner_user_id IS NOT NULL AND organization_id IS NULL)
    OR
    (scope_type = 'organization' AND organization_id IS NOT NULL AND personal_owner_user_id IS NULL)
  ),
  CONSTRAINT workspaces_default_key_chk CHECK (
    (is_default = 1 AND default_scope_key IS NOT NULL)
    OR (is_default = 0 AND default_scope_key IS NULL)
  ),
  CONSTRAINT workspaces_name_chk CHECK (length(name) BETWEEN 1 AND 255),
  CONSTRAINT workspaces_slug_chk CHECK (length(slug) BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX uk_workspaces_personal_slug
  ON workspaces(personal_owner_user_id, slug)
  WHERE personal_owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX uk_workspaces_organization_slug
  ON workspaces(organization_id, slug)
  WHERE organization_id IS NOT NULL;
CREATE INDEX idx_workspaces_personal_status
  ON workspaces(personal_owner_user_id, status);
CREATE INDEX idx_workspaces_organization_status
  ON workspaces(organization_id, status);
CREATE INDEX idx_workspaces_created_by
  ON workspaces(created_by_user_id) WHERE created_by_user_id IS NOT NULL;

CREATE TABLE workspace_memberships (
  id TEXT PRIMARY KEY,
  membership_key TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'removed')),
  granted_by_subject TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT workspace_memberships_subject_chk CHECK (length(subject) BETWEEN 1 AND 255),
  CONSTRAINT workspace_memberships_key_chk CHECK (length(membership_key) = 64)
);

CREATE INDEX idx_workspace_memberships_workspace_status
  ON workspace_memberships(workspace_id, status);
CREATE INDEX idx_workspace_memberships_subject_status
  ON workspace_memberships(subject, status);

INSERT OR IGNORE INTO workspaces (
  id, scope_type, personal_owner_user_id, name, slug,
  is_default, default_scope_key, status, created_by_user_id
)
SELECT
  'personal:' || id, 'personal', id, 'Default', 'default',
  1, 'personal:' || id, 'active', id
FROM users;

INSERT OR IGNORE INTO workspaces (
  id, scope_type, organization_id, name, slug,
  is_default, default_scope_key, status
)
SELECT
  'organization:' || id, 'organization', id, 'Default', 'default',
  1, 'organization:' || id, 'active'
FROM organizations
WHERE status IN ('active', 'pending');
