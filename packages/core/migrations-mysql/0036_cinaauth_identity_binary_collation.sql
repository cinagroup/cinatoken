-- 0036: preserve CinaAuth opaque identifiers exactly on the Node/MySQL runtime.
--
-- CinaAuth's default IDs contain both upper- and lower-case ASCII characters.
-- Linguistic/case-insensitive collations can therefore merge distinct users,
-- organizations, memberships, or delivery events. Never normalize these IDs.
--
-- Production runbook requirement: pause identity consumers and first-login user
-- creation, verify no upstream case-fold collisions, and take a recoverable
-- backup before applying this potentially rebuilding ALTER.

-- A case-insensitive FK may currently accept a membership whose stored bytes
-- do not exactly match its organization id. Detect that before any implicit-
-- commit ALTER; otherwise re-adding the binary FK could fail after it was
-- already dropped.
CREATE TEMPORARY TABLE cinaauth_identity_binary_preflight (
	  mismatch_count BIGINT NOT NULL,
	  CONSTRAINT cinaauth_identity_binary_preflight_chk CHECK (mismatch_count = 0)
) ENGINE=InnoDB;

INSERT INTO cinaauth_identity_binary_preflight (mismatch_count)
SELECT COUNT(*)
FROM organization_memberships AS membership
JOIN organizations AS organization
  ON membership.organization_id = organization.id
WHERE BINARY membership.organization_id <> BINARY organization.id;

DROP TEMPORARY TABLE cinaauth_identity_binary_preflight;

ALTER TABLE users
  MODIFY COLUMN external_system VARCHAR(128)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY COLUMN external_user_id VARCHAR(512)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY COLUMN external_system_norm VARCHAR(128)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin
    AS (COALESCE(external_system, '')) STORED;

ALTER TABLE portal_sessions
  MODIFY COLUMN subject VARCHAR(255)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;

ALTER TABLE organization_memberships
  DROP FOREIGN KEY fk_organization_memberships_org;

ALTER TABLE organizations
  MODIFY COLUMN id VARCHAR(255)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY COLUMN source VARCHAR(128)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;

ALTER TABLE organization_memberships
  MODIFY COLUMN organization_id VARCHAR(255)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY COLUMN subject VARCHAR(255)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  ADD CONSTRAINT fk_organization_memberships_org
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE identity_event_inbox
  MODIFY COLUMN source VARCHAR(128)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY COLUMN event_id VARCHAR(200)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY COLUMN aggregate_type VARCHAR(64)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY COLUMN aggregate_id VARCHAR(512)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
