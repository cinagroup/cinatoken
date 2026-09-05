-- 0055: every active Workspace has one implicit Default Guardrail.

ALTER TABLE guardrails
  ADD COLUMN is_workspace_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN workspace_default_key CHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN is_workspace_default = TRUE THEN SHA2(workspace_id, 256) ELSE NULL END
    ) STORED,
  ADD UNIQUE INDEX uk_guardrails_workspace_default (workspace_default_key);

INSERT INTO guardrails (
  id, workspace_id, workspace_key, owner_user_id, name, description, status,
  designated_version, latest_version, created_at, updated_at,
  is_workspace_default
)
SELECT
  UUID(),
  workspace.id,
  SHA2(workspace.id, 256),
  COALESCE(
    (
      SELECT owner.id FROM users owner
      WHERE owner.id = workspace.personal_owner_user_id AND owner.status = 'active'
      LIMIT 1
    ),
    (
      SELECT creator.id FROM users creator
      WHERE creator.id = workspace.created_by_user_id AND creator.status = 'active'
      LIMIT 1
    ),
    (
      SELECT member.user_id
      FROM organization_memberships member
      JOIN users member_user ON member_user.id = member.user_id AND member_user.status = 'active'
      WHERE member.organization_id = workspace.organization_id
        AND member.status = 'active' AND member.user_id IS NOT NULL
      ORDER BY member.user_id
      LIMIT 1
    )
  ),
  CONCAT('Workspace ', LEFT(workspace.id, 180), ' Default'),
  NULL,
  'active',
  1,
  1,
  UTC_TIMESTAMP(6),
  UTC_TIMESTAMP(6),
  TRUE
FROM workspaces workspace
WHERE workspace.status = 'active'
  AND COALESCE(
    (SELECT owner.id FROM users owner WHERE owner.id = workspace.personal_owner_user_id AND owner.status = 'active' LIMIT 1),
    (SELECT creator.id FROM users creator WHERE creator.id = workspace.created_by_user_id AND creator.status = 'active' LIMIT 1),
    (
      SELECT member.user_id
      FROM organization_memberships member
      JOIN users member_user ON member_user.id = member.user_id AND member_user.status = 'active'
      WHERE member.organization_id = workspace.organization_id
        AND member.status = 'active' AND member.user_id IS NOT NULL
      ORDER BY member.user_id
      LIMIT 1
    )
  ) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM guardrails existing
    WHERE existing.workspace_id = workspace.id
      AND existing.is_workspace_default = TRUE
  );

INSERT INTO guardrail_versions (
  id, guardrail_id, version, config_json, created_by_user_id, created_at
)
SELECT UUID(), guardrail.id, 1, '{}', guardrail.owner_user_id, guardrail.created_at
FROM guardrails guardrail
WHERE guardrail.is_workspace_default = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM guardrail_versions version
    WHERE version.guardrail_id = guardrail.id AND version.version = 1
  );
