-- 0043: endpoint-first model/provider capability and route-target linkage.
-- Existing route JSON is intentionally not backfilled: endpoint evidence must
-- be created explicitly by the later dual-write/cutover phase.
--
-- model_id/provider_id are VARCHAR(512), so an exact three-column utf8mb4
-- unique key would exceed InnoDB's 3072-byte key limit. endpoint_identity_key
-- is the full-tuple, length-delimited SHA-256 physical implementation of
-- UNIQUE(model_id, provider_id, tag); prefix indexes are intentionally avoided.

CREATE TABLE model_endpoints (
  id VARCHAR(191) NOT NULL,
  model_id VARCHAR(512) NOT NULL,
  provider_id VARCHAR(512) NOT NULL,
  provider_slug VARCHAR(255) NOT NULL,
  tag VARCHAR(255) NOT NULL,
  endpoint_identity_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      SHA2(CONCAT(
        CHAR_LENGTH(model_id), ':', model_id,
        CHAR_LENGTH(provider_id), ':', provider_id,
        CHAR_LENGTH(tag), ':', tag
      ), 256)
    ) STORED,
  endpoint_class VARCHAR(32),
  region VARCHAR(64),
  context_length INT,
  max_prompt_tokens INT,
  max_completion_tokens INT,
  quantization VARCHAR(32),
  supported_parameters TEXT NOT NULL DEFAULT ('[]'),
  pricing TEXT NOT NULL DEFAULT ('{}'),
  supports_tool_choice TEXT NOT NULL DEFAULT ('{"auto":null,"function":null,"none":null,"required":null}'),
  image_capabilities TEXT NOT NULL DEFAULT ('{}'),
  supports_implicit_caching TINYINT(1),
  supports_voice_cloning TINYINT(1),
  evidence_url TEXT,
  verified_by VARCHAR(512),
  verified_at TIMESTAMP(6),
  expires_at TIMESTAMP(6),
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uk_model_endpoints_identity (endpoint_identity_key),
  INDEX idx_model_endpoints_provider (provider_id),
  INDEX idx_model_endpoints_model_status (model_id, status),
  CONSTRAINT fk_model_endpoints_model
    FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
  CONSTRAINT fk_model_endpoints_provider
    FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  CONSTRAINT model_endpoints_status_chk
    CHECK (status IN ('draft', 'verified', 'disabled')),
  CONSTRAINT model_endpoints_implicit_caching_chk
    CHECK (supports_implicit_caching IS NULL OR supports_implicit_caching IN (0, 1)),
  CONSTRAINT model_endpoints_voice_cloning_chk
    CHECK (supports_voice_cloning IS NULL OR supports_voice_cloning IN (0, 1)),
  CONSTRAINT model_endpoints_context_length_chk
    CHECK (context_length IS NULL OR context_length > 0),
  CONSTRAINT model_endpoints_max_prompt_tokens_chk
    CHECK (max_prompt_tokens IS NULL OR max_prompt_tokens > 0),
  CONSTRAINT model_endpoints_max_completion_tokens_chk
    CHECK (max_completion_tokens IS NULL OR max_completion_tokens > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE model_endpoint_routes (
  endpoint_id VARCHAR(191) NOT NULL,
  route_target_id VARCHAR(512) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (endpoint_id, route_target_id),
  UNIQUE KEY uk_model_endpoint_routes_target (route_target_id),
  CONSTRAINT fk_model_endpoint_routes_endpoint
    FOREIGN KEY (endpoint_id) REFERENCES model_endpoints(id) ON DELETE CASCADE,
  CONSTRAINT fk_model_endpoint_routes_target
    FOREIGN KEY (route_target_id) REFERENCES model_routes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
