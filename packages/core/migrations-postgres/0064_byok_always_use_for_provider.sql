-- 0064: add the two non-default BYOK shared-capacity policies. Fallback keys
-- cannot carry either policy, and the two strengths are mutually exclusive.

ALTER TABLE byok_keys
	ADD COLUMN always_use_for_provider BOOLEAN NOT NULL DEFAULT FALSE,
	ADD COLUMN always_use_for_matching_models BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE byok_keys
	ADD CONSTRAINT byok_keys_always_use_priority_chk
	CHECK (
		(NOT always_use_for_provider AND NOT always_use_for_matching_models)
		OR NOT is_fallback
	),
	ADD CONSTRAINT byok_keys_shared_capacity_policy_exclusive_chk
	CHECK (NOT always_use_for_provider OR NOT always_use_for_matching_models);
