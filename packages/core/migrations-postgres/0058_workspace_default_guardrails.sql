-- 0058: every active Workspace has one implicit Default Guardrail.

ALTER TABLE guardrails
  ADD COLUMN is_workspace_default BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX uk_guardrails_workspace_default
  ON guardrails(workspace_id)
  WHERE is_workspace_default;

WITH candidate_owner AS (
  SELECT
    workspace.id AS workspace_id,
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
    ) AS owner_user_id
  FROM workspaces workspace
  WHERE workspace.status = 'active'
), identities AS (
  SELECT
    candidate.*,
    md5(candidate.workspace_id || ':workspace-default-guardrail') AS guardrail_hash
  FROM candidate_owner candidate
  WHERE candidate.owner_user_id IS NOT NULL
)
INSERT INTO guardrails (
  id, workspace_id, owner_user_id, name, description, status,
  designated_version, latest_version, created_at, updated_at,
  is_workspace_default
)
SELECT
  substr(identity.guardrail_hash, 1, 8) || '-' ||
    substr(identity.guardrail_hash, 9, 4) || '-5' ||
    substr(identity.guardrail_hash, 14, 3) || '-8' ||
    substr(identity.guardrail_hash, 18, 3) || '-' ||
    substr(identity.guardrail_hash, 21, 12),
  identity.workspace_id,
  identity.owner_user_id,
  'Workspace ' || left(identity.workspace_id, 180) || ' Default',
  NULL,
  'active',
  1,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  TRUE
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
WHERE guardrail.is_workspace_default
  AND NOT EXISTS (
    SELECT 1 FROM guardrail_versions version
    WHERE version.guardrail_id = guardrail.id AND version.version = 1
  );
