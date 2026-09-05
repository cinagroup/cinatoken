-- 0065: add the two non-default BYOK shared-capacity policies. Fallback keys
-- cannot carry either policy, and the two strengths are mutually exclusive.

ALTER TABLE byok_keys ADD COLUMN always_use_for_provider INTEGER NOT NULL DEFAULT 0
  CHECK (
    always_use_for_provider IN (0, 1)
    AND (always_use_for_provider = 0 OR is_fallback = 0)
  );

ALTER TABLE byok_keys ADD COLUMN always_use_for_matching_models INTEGER NOT NULL DEFAULT 0
  CHECK (
    always_use_for_matching_models IN (0, 1)
    AND (always_use_for_matching_models = 0 OR is_fallback = 0)
    AND (always_use_for_matching_models = 0 OR always_use_for_provider = 0)
  );
