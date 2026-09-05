-- 0056: one account-level Default Guardrail is inherited by every Workspace.

ALTER TABLE guardrails
  ADD COLUMN is_account_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN account_scope_key VARCHAR(600)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  ADD UNIQUE INDEX uk_guardrails_account_default (account_scope_key),
  ADD CONSTRAINT guardrails_default_kind_chk
    CHECK (NOT (is_workspace_default = TRUE AND is_account_default = TRUE)),
  ADD CONSTRAINT guardrails_account_scope_key_chk
    CHECK (
      (is_account_default = TRUE AND account_scope_key IS NOT NULL)
      OR (is_account_default = FALSE AND account_scope_key IS NULL)
    );

INSERT INTO guardrails (
  id, workspace_id, workspace_key, owner_user_id, name, description, status,
  designated_version, latest_version, created_at, updated_at,
  is_workspace_default, is_account_default, account_scope_key
)
SELECT
  UUID(),
  workspace.id,
  SHA2(workspace.id, 256),
  owner.id,
  'Account Default',
  NULL,
  'active',
  1,
  1,
  UTC_TIMESTAMP(6),
  UTC_TIMESTAMP(6),
  FALSE,
  TRUE,
  CONCAT('personal:', owner.id)
FROM users owner
JOIN workspaces workspace ON workspace.id = (
  SELECT candidate.id FROM workspaces candidate
  WHERE candidate.scope_type = 'personal'
    AND candidate.personal_owner_user_id = owner.id
    AND candidate.organization_id IS NULL
    AND candidate.status = 'active'
  ORDER BY candidate.is_default DESC, candidate.created_at, candidate.id
  LIMIT 1
)
WHERE owner.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM guardrails existing
    WHERE existing.account_scope_key = CONCAT('personal:', owner.id)
      AND existing.is_account_default = TRUE
  );

INSERT INTO guardrails (
  id, workspace_id, workspace_key, owner_user_id, name, description, status,
  designated_version, latest_version, created_at, updated_at,
  is_workspace_default, is_account_default, account_scope_key
)
SELECT
  UUID(),
  workspace.id,
  SHA2(workspace.id, 256),
  (
    SELECT membership.user_id
    FROM organization_memberships membership
    JOIN users member_user ON member_user.id = membership.user_id
      AND member_user.status = 'active'
    WHERE membership.organization_id = organization.id
      AND membership.status = 'active'
      AND membership.user_id IS NOT NULL
    ORDER BY IF(membership.roles_json LIKE '%org-admin%', 0, 1), membership.user_id
    LIMIT 1
  ),
  'Account Default',
  NULL,
  'active',
  1,
  1,
  UTC_TIMESTAMP(6),
  UTC_TIMESTAMP(6),
  FALSE,
  TRUE,
  CONCAT('organization:', organization.id)
FROM organizations organization
JOIN workspaces workspace ON workspace.id = (
  SELECT candidate.id FROM workspaces candidate
  WHERE candidate.scope_type = 'organization'
    AND candidate.organization_id = organization.id
    AND candidate.personal_owner_user_id IS NULL
    AND candidate.status = 'active'
  ORDER BY candidate.is_default DESC, candidate.created_at, candidate.id
  LIMIT 1
)
WHERE organization.status IN ('active', 'pending')
  AND EXISTS (
    SELECT 1 FROM organization_memberships membership
    JOIN users member_user ON member_user.id = membership.user_id
      AND member_user.status = 'active'
    WHERE membership.organization_id = organization.id
      AND membership.status = 'active'
      AND membership.user_id IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM guardrails existing
    WHERE existing.account_scope_key = CONCAT('organization:', organization.id)
      AND existing.is_account_default = TRUE
  );

INSERT INTO guardrail_versions (
  id, guardrail_id, version, config_json, created_by_user_id, created_at
)
SELECT UUID(), guardrail.id, 1, '{}', guardrail.owner_user_id, guardrail.created_at
FROM guardrails guardrail
WHERE guardrail.is_account_default = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM guardrail_versions version
    WHERE version.guardrail_id = guardrail.id AND version.version = 1
  );
