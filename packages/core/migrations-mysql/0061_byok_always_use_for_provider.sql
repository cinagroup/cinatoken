-- 0061: add the two non-default BYOK shared-capacity policies. Fallback keys
-- cannot carry either policy, and the two strengths are mutually exclusive.

ALTER TABLE byok_keys
  ADD COLUMN always_use_for_provider TINYINT(1) NOT NULL DEFAULT 0 AFTER is_fallback,
	ADD COLUMN always_use_for_matching_models TINYINT(1) NOT NULL DEFAULT 0 AFTER always_use_for_provider,
  ADD CONSTRAINT byok_keys_always_use_priority_chk
    CHECK (
      always_use_for_provider IN (0, 1)
      AND always_use_for_matching_models IN (0, 1)
      AND ((always_use_for_provider = 0 AND always_use_for_matching_models = 0) OR is_fallback = 0)
    ),
	ADD CONSTRAINT byok_keys_shared_capacity_policy_exclusive_chk
		CHECK (always_use_for_provider = 0 OR always_use_for_matching_models = 0);
