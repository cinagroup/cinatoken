-- 0047: endpoint-first model/provider capability and route-target linkage.
-- Existing route JSON is intentionally not backfilled: endpoint evidence must
-- be created explicitly by the later dual-write/cutover phase.

CREATE TABLE model_endpoints (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  provider_slug TEXT NOT NULL,
  tag TEXT NOT NULL,
  endpoint_class TEXT,
  region TEXT,
  context_length INTEGER,
  max_prompt_tokens INTEGER,
  max_completion_tokens INTEGER,
  quantization TEXT,
  supported_parameters TEXT NOT NULL DEFAULT '[]',
  pricing TEXT NOT NULL DEFAULT '{}',
  supports_tool_choice TEXT NOT NULL DEFAULT '{"auto":null,"function":null,"none":null,"required":null}',
  image_capabilities TEXT NOT NULL DEFAULT '{}',
  supports_implicit_caching INTEGER,
  supports_voice_cloning INTEGER,
  evidence_url TEXT,
  verified_by TEXT,
  verified_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_model_endpoints_identity UNIQUE (model_id, provider_id, tag),
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
);

CREATE INDEX idx_model_endpoints_provider
  ON model_endpoints(provider_id);
CREATE INDEX idx_model_endpoints_model_status
  ON model_endpoints(model_id, status);

CREATE TABLE model_endpoint_routes (
  endpoint_id TEXT NOT NULL REFERENCES model_endpoints(id) ON DELETE CASCADE,
  route_target_id TEXT NOT NULL UNIQUE REFERENCES model_routes(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (endpoint_id, route_target_id)
);
