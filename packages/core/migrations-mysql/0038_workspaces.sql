-- 0038: CinaToken-owned gateway workspaces over the CinaAuth organization projection.
-- Opaque ids use binary collation; existing identities receive deterministic Default workspaces.

CREATE TABLE workspaces (
  id VARCHAR(600) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PRIMARY KEY,
  scope_type VARCHAR(32) NOT NULL,
  organization_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin,
  personal_owner_user_id VARCHAR(512),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(128) NOT NULL,
  description TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  default_scope_key VARCHAR(600) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin UNIQUE,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  settings_json TEXT,
  created_by_user_id VARCHAR(512),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_workspaces_organization
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_workspaces_personal_owner
    FOREIGN KEY (personal_owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_workspaces_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT workspaces_scope_type_chk
    CHECK (scope_type IN ('personal', 'organization')),
  CONSTRAINT workspaces_status_chk
    CHECK (status IN ('active', 'archived')),
  CONSTRAINT workspaces_scope_owner_chk CHECK (
    (scope_type = 'personal' AND personal_owner_user_id IS NOT NULL AND organization_id IS NULL)
    OR
    (scope_type = 'organization' AND organization_id IS NOT NULL AND personal_owner_user_id IS NULL)
  ),
  CONSTRAINT workspaces_default_key_chk CHECK (
    (is_default = TRUE AND default_scope_key IS NOT NULL)
    OR (is_default = FALSE AND default_scope_key IS NULL)
  ),
  CONSTRAINT workspaces_name_chk CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 255),
  CONSTRAINT workspaces_slug_chk CHECK (CHAR_LENGTH(slug) BETWEEN 1 AND 128),
  UNIQUE INDEX uk_workspaces_personal_slug (personal_owner_user_id, slug),
  UNIQUE INDEX uk_workspaces_organization_slug (organization_id, slug),
  INDEX idx_workspaces_personal_status (personal_owner_user_id, status),
  INDEX idx_workspaces_organization_status (organization_id, status),
  INDEX idx_workspaces_created_by (created_by_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE workspace_memberships (
  id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PRIMARY KEY,
  membership_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  workspace_id VARCHAR(600) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  subject VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'member',
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  granted_by_subject VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_workspace_memberships_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT workspace_memberships_role_chk
    CHECK (role IN ('admin', 'member')),
  CONSTRAINT workspace_memberships_status_chk
    CHECK (status IN ('active', 'removed')),
  CONSTRAINT workspace_memberships_subject_chk
    CHECK (CHAR_LENGTH(subject) BETWEEN 1 AND 255),
  CONSTRAINT workspace_memberships_key_chk
    CHECK (CHAR_LENGTH(membership_key) = 64),
  INDEX idx_workspace_memberships_workspace_status (workspace_id, status),
  INDEX idx_workspace_memberships_subject_status (subject, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO workspaces (
  id, scope_type, personal_owner_user_id, name, slug,
  is_default, default_scope_key, status, created_by_user_id
)
SELECT
  CONCAT('personal:', id), 'personal', id, 'Default', 'default',
  TRUE, CONCAT('personal:', id), 'active', id
FROM users;

INSERT IGNORE INTO workspaces (
  id, scope_type, organization_id, name, slug,
  is_default, default_scope_key, status
)
SELECT
  CONCAT('organization:', id), 'organization', id, 'Default', 'default',
  TRUE, CONCAT('organization:', id), 'active'
FROM organizations
WHERE status IN ('active', 'pending');
