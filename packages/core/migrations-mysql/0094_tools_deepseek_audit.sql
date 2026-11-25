ALTER TABLE config_group_audit
  DROP CHECK config_group_audit_provider_chk,
  ADD CONSTRAINT config_group_audit_provider_chk CHECK (provider IS NULL OR provider IN ('bocha', 'tavily', 'cleversee', 'tencent_wsa', 'deepseek', 'firecrawl', 'jina', 'tencent_tms')),
  DROP CHECK config_group_audit_active_before_chk,
  ADD CONSTRAINT config_group_audit_active_before_chk CHECK (active_before IS NULL OR active_before IN ('bocha', 'tavily', 'cleversee', 'tencent_wsa', 'deepseek', 'firecrawl', 'jina', 'tencent_tms')),
  DROP CHECK config_group_audit_active_after_chk,
  ADD CONSTRAINT config_group_audit_active_after_chk CHECK (active_after IS NULL OR active_after IN ('bocha', 'tavily', 'cleversee', 'tencent_wsa', 'deepseek', 'firecrawl', 'jina', 'tencent_tms'));
