SET LOCAL lock_timeout = '2s';
ALTER TABLE cinatoken_gateway.config_group_audit DROP CONSTRAINT config_group_audit_provider_check;
ALTER TABLE cinatoken_gateway.config_group_audit ADD CONSTRAINT config_group_audit_provider_check CHECK (provider IS NULL OR provider IN ('bocha', 'tavily', 'cleversee', 'tencent_wsa', 'deepseek', 'firecrawl', 'jina', 'tencent_tms'));
ALTER TABLE cinatoken_gateway.config_group_audit DROP CONSTRAINT config_group_audit_active_before_check;
ALTER TABLE cinatoken_gateway.config_group_audit ADD CONSTRAINT config_group_audit_active_before_check CHECK (active_before IS NULL OR active_before IN ('bocha', 'tavily', 'cleversee', 'tencent_wsa', 'deepseek', 'firecrawl', 'jina', 'tencent_tms'));
ALTER TABLE cinatoken_gateway.config_group_audit DROP CONSTRAINT config_group_audit_active_after_check;
ALTER TABLE cinatoken_gateway.config_group_audit ADD CONSTRAINT config_group_audit_active_after_check CHECK (active_after IS NULL OR active_after IN ('bocha', 'tavily', 'cleversee', 'tencent_wsa', 'deepseek', 'firecrawl', 'jina', 'tencent_tms'));
