-- 0035: immutable, user-owned request preset versions.

CREATE TABLE request_presets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  designated_version INTEGER NOT NULL DEFAULT 1,
  latest_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_request_presets_slug UNIQUE (slug),
  CONSTRAINT request_presets_versions_chk CHECK (
    designated_version >= 1 AND latest_version >= designated_version
  )
);

CREATE INDEX idx_request_presets_owner_status
  ON request_presets(owner_user_id, status, updated_at DESC);
CREATE INDEX idx_request_presets_visibility_status
  ON request_presets(visibility, status, updated_at DESC);

CREATE TABLE request_preset_versions (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL REFERENCES request_presets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  system_prompt TEXT,
  config_json TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_request_preset_versions UNIQUE (preset_id, version)
);

CREATE INDEX idx_request_preset_versions_preset_created
  ON request_preset_versions(preset_id, created_at DESC);
