-- 0059: every active Workspace has one implicit Default Guardrail.

ALTER TABLE guardrails
  ADD COLUMN is_workspace_default INTEGER NOT NULL DEFAULT 0
    CHECK (is_workspace_default IN (0, 1));

CREATE UNIQUE INDEX uk_guardrails_workspace_default
  ON guardrails(workspace_id)
  WHERE is_workspace_default = 1;

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
)
INSERT INTO guardrails (
  id, workspace_id, owner_user_id, name, description, status,
  designated_version, latest_version, created_at, updated_at,
  is_workspace_default
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  candidate.workspace_id,
  candidate.owner_user_id,
  'Workspace ' || substr(candidate.workspace_id, 1, 180) || ' Default',
  NULL,
  'active',
  1,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  1
FROM candidate_owner candidate
WHERE candidate.owner_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM guardrails existing
    WHERE existing.workspace_id = candidate.workspace_id
      AND existing.is_workspace_default = 1
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
WHERE guardrail.is_workspace_default = 1
  AND NOT EXISTS (
    SELECT 1 FROM guardrail_versions version
    WHERE version.guardrail_id = guardrail.id AND version.version = 1
  );
