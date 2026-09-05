-- 0062: persist the route-selective settlement basis used by Gateway Key
-- limits. Private BYOK settles at the catalog/list-price equivalent, while a
-- shared/platform fallback for the same request settles at the gateway charge.

ALTER TABLE guardrail_budget_reservations
	ADD COLUMN settlement_basis VARCHAR(32) NOT NULL DEFAULT 'charged' AFTER settled_micros,
	ADD CONSTRAINT guardrail_budget_reservations_settlement_basis_chk
		CHECK (settlement_basis IN ('charged', 'gateway_key_route'));
