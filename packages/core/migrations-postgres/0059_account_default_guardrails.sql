-- 0059: one account-level Default Guardrail is inherited by every Workspace.

SET search_path TO cinatoken_gateway;

ALTER TABLE guardrails
  ADD COLUMN is_account_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN account_scope_key TEXT;

ALTER TABLE guardrails
  ADD CONSTRAINT guardrails_default_kind_chk
    CHECK (NOT (is_workspace_default AND is_account_default)),
  ADD CONSTRAINT guardrails_account_scope_key_chk
    CHECK (is_account_default = (account_scope_key IS NOT NULL));

CREATE UNIQUE INDEX uk_guardrails_account_default
  ON guardrails(account_scope_key)
  WHERE is_account_default;

WITH anchors AS (
  SELECT
    owner.id AS owner_user_id,
    'personal:' || owner.id AS account_scope_key,
    (
      SELECT workspace.id FROM workspaces workspace
      WHERE workspace.scope_type = 'personal'
        AND workspace.personal_owner_user_id = owner.id
        AND workspace.organization_id IS NULL
        AND workspace.status = 'active'
      ORDER BY workspace.is_default DESC, workspace.created_at, workspace.id
      LIMIT 1
    ) AS workspace_id
  FROM users owner
  WHERE owner.status = 'active'
), identities AS (
  SELECT anchor.*, md5(anchor.account_scope_key || ':account-default-guardrail') AS hash
  FROM anchors anchor
  WHERE anchor.workspace_id IS NOT NULL
)
INSERT INTO guardrails (
  id, workspace_id, owner_user_id, name, description, status,
  designated_version, latest_version, created_at, updated_at,
  is_workspace_default, is_account_default, account_scope_key
)
SELECT
  substr(identity.hash, 1, 8) || '-' || substr(identity.hash, 9, 4) || '-5' ||
    substr(identity.hash, 14, 3) || '-8' || substr(identity.hash, 18, 3) || '-' ||
    substr(identity.hash, 21, 12),
  identity.workspace_id,
  identity.owner_user_id,
  'Account Default',
  NULL,
  'active',
  1,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  FALSE,
  TRUE,
  identity.account_scope_key
FROM identities identity
ON CONFLICT DO NOTHING;

WITH anchors AS (
  SELECT
    organization.id AS organization_id,
    'organization:' || organization.id AS account_scope_key,
    (
      SELECT membership.user_id
      FROM organization_memberships membership
      JOIN users member_user ON member_user.id = membership.user_id
        AND member_user.status = 'active'
      WHERE membership.organization_id = organization.id
        AND membership.status = 'active'
        AND membership.user_id IS NOT NULL
      ORDER BY CASE WHEN membership.roles_json LIKE '%org-admin%' THEN 0 ELSE 1 END,
        membership.user_id
      LIMIT 1
    ) AS owner_user_id,
    (
      SELECT workspace.id FROM workspaces workspace
      WHERE workspace.scope_type = 'organization'
        AND workspace.organization_id = organization.id
        AND workspace.personal_owner_user_id IS NULL
        AND workspace.status = 'active'
      ORDER BY workspace.is_default DESC, workspace.created_at, workspace.id
      LIMIT 1
    ) AS workspace_id
  FROM organizations organization
  WHERE organization.status IN ('active', 'pending')
), identities AS (
  SELECT anchor.*, md5(anchor.account_scope_key || ':account-default-guardrail') AS hash
  FROM anchors anchor
  WHERE anchor.workspace_id IS NOT NULL AND anchor.owner_user_id IS NOT NULL
)
INSERT INTO guardrails (
  id, workspace_id, owner_user_id, name, description, status,
  designated_version, latest_version, created_at, updated_at,
  is_workspace_default, is_account_default, account_scope_key
)
SELECT
  substr(identity.hash, 1, 8) || '-' || substr(identity.hash, 9, 4) || '-5' ||
    substr(identity.hash, 14, 3) || '-8' || substr(identity.hash, 18, 3) || '-' ||
    substr(identity.hash, 21, 12),
  identity.workspace_id,
  identity.owner_user_id,
  'Account Default',
  NULL,
  'active',
  1,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  FALSE,
  TRUE,
  identity.account_scope_key
FROM identities identity
ON CONFLICT DO NOTHING;

INSERT INTO guardrail_versions (
  id, guardrail_id, version, config_json, created_by_user_id, created_at
)
SELECT
  substr(md5(guardrail.id || ':version:1'), 1, 8) || '-' ||
    substr(md5(guardrail.id || ':version:1'), 9, 4) || '-5' ||
    substr(md5(guardrail.id || ':version:1'), 14, 3) || '-8' ||
    substr(md5(guardrail.id || ':version:1'), 18, 3) || '-' ||
    substr(md5(guardrail.id || ':version:1'), 21, 12),
  guardrail.id,
  1,
  '{}',
  guardrail.owner_user_id,
  guardrail.created_at
FROM guardrails guardrail
WHERE guardrail.is_account_default
  AND NOT EXISTS (
    SELECT 1 FROM guardrail_versions version
    WHERE version.guardrail_id = guardrail.id AND version.version = 1
  );
