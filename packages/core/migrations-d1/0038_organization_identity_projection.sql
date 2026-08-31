-- 0038: local projection of CinaAuth organizations and memberships.
-- CinaAuth remains the source of truth; identity_event_inbox makes delivery idempotent.

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'suspended', 'deleted')),
  metadata_json TEXT,
  source_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organizations_source_nonempty_chk CHECK (length(source) > 0)
);

CREATE INDEX idx_organizations_source_status ON organizations(source, status);
CREATE INDEX idx_organizations_slug ON organizations(slug) WHERE slug IS NOT NULL;

CREATE TABLE organization_memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  email TEXT,
  roles_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'removed')),
  source_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, subject),
  CONSTRAINT organization_memberships_subject_nonempty_chk CHECK (length(subject) > 0)
);

CREATE INDEX idx_organization_memberships_subject_status
  ON organization_memberships(subject, status);
CREATE INDEX idx_organization_memberships_user
  ON organization_memberships(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE identity_event_inbox (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  processor_token TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source, event_id),
  CONSTRAINT identity_event_inbox_hash_chk
    CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*')
);

CREATE INDEX idx_identity_event_inbox_aggregate
  ON identity_event_inbox(source, aggregate_type, aggregate_id, occurred_at);
