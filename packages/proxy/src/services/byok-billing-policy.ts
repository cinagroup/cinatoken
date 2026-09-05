/**
 * Transitional private-BYOK billing policy.
 *
 * The credential owner pays the upstream provider directly. Until CinaAuth
 * exposes a request-time plan allowance and overage decision, CinaToken must
 * not silently collect the full platform tariff as well. We therefore retain
 * the list-price equivalent for analytics while setting both the gateway's
 * supplier cost and the user-visible gateway charge to zero. Every adjusted
 * record is explicitly tagged in pricing_audit so this policy can be migrated
 * and reconciled without guessing from provider identity later.
 */

export const PRIVATE_BYOK_BILLING_POLICY = 'fee_waived_until_entitlement_v1' as const;

type BillingAmounts = {
	meteredCost: number;
	standardCost: number;
	chargedCost: number;
	pricingAuditJson: string;
};

function assertMoney(value: number, field: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new TypeError(`Private BYOK ${field} must be a finite non-negative number`);
	}
}

function parsePricingAudit(value: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new TypeError('Private BYOK pricing audit must be valid JSON');
	}
	if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new TypeError('Private BYOK pricing audit must be an object');
	}
	return parsed as Record<string, unknown>;
}

export function applyPrivateByokBillingPolicy(
	amounts: BillingAmounts,
	isByok: boolean,
): BillingAmounts {
	if (!isByok) return amounts;
	assertMoney(amounts.meteredCost, 'metered cost');
	assertMoney(amounts.standardCost, 'standard cost');
	assertMoney(amounts.chargedCost, 'charged cost');
	const audit = parsePricingAudit(amounts.pricingAuditJson);
	return {
		meteredCost: 0,
		standardCost: amounts.standardCost,
		chargedCost: 0,
		pricingAuditJson: JSON.stringify({
			...audit,
			byok: {
				policy: PRIVATE_BYOK_BILLING_POLICY,
				provider_cost_responsibility: 'credential_owner',
				gateway_supplier_cost_usd: 0,
				gateway_charged_cost_usd: 0,
				standard_equivalent_cost_usd: amounts.standardCost,
				nominal_gateway_supplier_cost_usd: amounts.meteredCost,
				nominal_gateway_charged_cost_usd: amounts.chargedCost,
			},
		}),
	};
}

/** A zero-fee BYOK result is known even when provider usage is unavailable. */
export function privateByokSettlementMode(
	isByok: boolean,
	mode: 'actual' | 'reserved',
): 'actual' | 'reserved' {
	return isByok ? 'actual' : mode;
}
