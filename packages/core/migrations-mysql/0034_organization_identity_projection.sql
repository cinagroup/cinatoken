-- 0034: local projection of CinaAuth organizations and memberships.
-- CinaAuth remains the source of truth; identity_event_inbox makes delivery idempotent.

CREATE TABLE organizations (
  id VARCHAR(255) PRIMARY KEY,
  source VARCHAR(128) NOT NULL,
  name VARCHAR(512) NOT NULL,
  slug VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  metadata_json TEXT,
  source_updated_at TIMESTAMP(6) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT organizations_status_chk
    CHECK (status IN ('pending', 'active', 'suspended', 'deleted')),
  CONSTRAINT organizations_source_nonempty_chk CHECK (CHAR_LENGTH(source) > 0),
  INDEX idx_organizations_source_status (source, status),
  INDEX idx_organizations_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE organization_memberships (
  organization_id VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  user_id VARCHAR(512),
  email VARCHAR(512),
  roles_json TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  source_updated_at TIMESTAMP(6) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (organization_id, subject),
  CONSTRAINT fk_organization_memberships_org
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_organization_memberships_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT organization_memberships_status_chk
    CHECK (status IN ('active', 'suspended', 'removed')),
  CONSTRAINT organization_memberships_subject_nonempty_chk CHECK (CHAR_LENGTH(subject) > 0),
  INDEX idx_organization_memberships_subject_status (subject, status),
  INDEX idx_organization_memberships_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE identity_event_inbox (
  source VARCHAR(128) NOT NULL,
  event_id VARCHAR(200) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(512) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  processor_token VARCHAR(64) NOT NULL UNIQUE,
  occurred_at TIMESTAMP(6) NOT NULL,
  processed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (source, event_id),
  CONSTRAINT identity_event_inbox_hash_chk
    CHECK (payload_sha256 REGEXP '^[a-f0-9]{64}$'),
  INDEX idx_identity_event_inbox_aggregate
    (source, aggregate_type, aggregate_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
