-- 0060: one account-level Default Guardrail is inherited by every Workspace.

ALTER TABLE guardrails
  ADD COLUMN is_account_default INTEGER NOT NULL DEFAULT 0
    CHECK (is_account_default IN (0, 1));

ALTER TABLE guardrails
  ADD COLUMN account_scope_key TEXT;

CREATE UNIQUE INDEX uk_guardrails_account_default
  ON guardrails(account_scope_key)
  WHERE is_account_default = 1;

CREATE TRIGGER guardrails_account_default_insert_guard
BEFORE INSERT ON guardrails
WHEN (NEW.is_account_default = 0 AND NEW.account_scope_key IS NOT NULL)
OR (NEW.is_account_default = 1 AND (
  NEW.is_workspace_default = 1 OR NEW.account_scope_key IS NULL OR NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.id = NEW.workspace_id
      AND NEW.account_scope_key = CASE workspace.scope_type
        WHEN 'personal' THEN 'personal:' || workspace.personal_owner_user_id
        WHEN 'organization' THEN 'organization:' || workspace.organization_id
      END
  )
))
BEGIN
  SELECT RAISE(ABORT, 'account Default Guardrail scope mismatch');
END;

CREATE TRIGGER guardrails_account_default_update_guard
BEFORE UPDATE OF workspace_id, is_workspace_default, is_account_default, account_scope_key ON guardrails
WHEN (NEW.is_account_default = 0 AND NEW.account_scope_key IS NOT NULL)
OR (NEW.is_account_default = 1 AND (
  NEW.is_workspace_default = 1 OR NEW.account_scope_key IS NULL OR NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.id = NEW.workspace_id
      AND NEW.account_scope_key = CASE workspace.scope_type
        WHEN 'personal' THEN 'personal:' || workspace.personal_owner_user_id
        WHEN 'organization' THEN 'organization:' || workspace.organization_id
      END
  )
))
BEGIN
  SELECT RAISE(ABORT, 'account Default Guardrail scope mismatch');
END;

INSERT INTO guardrails (
  id, workspace_id, owner_user_id, name, description, status,
  designated_version, latest_version, created_at, updated_at,
  is_workspace_default, is_account_default, account_scope_key
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  workspace.id,
  owner.id,
  'Account Default',
  NULL,
  'active',
  1,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  0,
  1,
  'personal:' || owner.id
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
    WHERE existing.account_scope_key = 'personal:' || owner.id
      AND existing.is_account_default = 1
  );

WITH organization_owner AS (
  SELECT organization.id AS organization_id, (
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
  ) AS owner_user_id
  FROM organizations organization
  WHERE organization.status IN ('active', 'pending')
)
INSERT INTO guardrails (
  id, workspace_id, owner_user_id, name, description, status,
  designated_version, latest_version, created_at, updated_at,
  is_workspace_default, is_account_default, account_scope_key
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  workspace.id,
  account.owner_user_id,
  'Account Default',
  NULL,
  'active',
  1,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  0,
  1,
  'organization:' || account.organization_id
FROM organization_owner account
JOIN workspaces workspace ON workspace.id = (
  SELECT candidate.id FROM workspaces candidate
  WHERE candidate.scope_type = 'organization'
    AND candidate.organization_id = account.organization_id
    AND candidate.personal_owner_user_id IS NULL
    AND candidate.status = 'active'
  ORDER BY candidate.is_default DESC, candidate.created_at, candidate.id
  LIMIT 1
)
WHERE account.owner_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM guardrails existing
    WHERE existing.account_scope_key = 'organization:' || account.organization_id
      AND existing.is_account_default = 1
  );

INSERT INTO guardrail_versions (
  id, guardrail_id, version, config_json, created_by_user_id, created_at
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  guardrail.id,
  1,
  '{}',
  guardrail.owner_user_id,
  guardrail.created_at
FROM guardrails guardrail
WHERE guardrail.is_account_default = 1
  AND NOT EXISTS (
    SELECT 1 FROM guardrail_versions version
    WHERE version.guardrail_id = guardrail.id AND version.version = 1
  );
