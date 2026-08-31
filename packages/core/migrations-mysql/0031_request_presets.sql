-- 0031: immutable, user-owned request preset versions.

CREATE TABLE request_presets (
  id VARCHAR(512) PRIMARY KEY,
  owner_user_id VARCHAR(512) NOT NULL,
  slug VARCHAR(128) NOT NULL,
  name VARCHAR(512) NOT NULL,
  description TEXT,
  visibility VARCHAR(16) NOT NULL DEFAULT 'private',
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  designated_version INT NOT NULL DEFAULT 1,
  latest_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT uk_request_presets_slug UNIQUE (slug),
  CONSTRAINT request_presets_visibility_chk CHECK (visibility IN ('private', 'public')),
  CONSTRAINT request_presets_status_chk CHECK (status IN ('active', 'archived')),
  CONSTRAINT request_presets_versions_chk CHECK (
    designated_version >= 1 AND latest_version >= designated_version
  ),
  CONSTRAINT fk_request_presets_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_request_presets_owner_status (owner_user_id, status, updated_at),
  INDEX idx_request_presets_visibility_status (visibility, status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE request_preset_versions (
  id VARCHAR(512) PRIMARY KEY,
  preset_id VARCHAR(512) NOT NULL,
  version INT NOT NULL,
  system_prompt TEXT,
  config_json TEXT NOT NULL,
  created_by_user_id VARCHAR(512),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT uk_request_preset_versions UNIQUE (preset_id, version),
  CONSTRAINT request_preset_versions_version_chk CHECK (version >= 1),
  CONSTRAINT fk_request_preset_versions_preset FOREIGN KEY (preset_id) REFERENCES request_presets(id) ON DELETE CASCADE,
  CONSTRAINT fk_request_preset_versions_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_request_preset_versions_preset_created (preset_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
