import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	applyPrivateByokBillingPolicy,
	PRIVATE_BYOK_BILLING_POLICY,
	privateByokSettlementMode,
} from './byok-billing-policy';

describe('private BYOK billing policy', () => {
	it('leaves platform billing byte-for-byte unchanged', () => {
		const input = {
			meteredCost: 0.2,
			standardCost: 0.3,
			chargedCost: 0.25,
			pricingAuditJson: '{"v":4}',
		};
		assert.equal(applyPrivateByokBillingPolicy(input, false), input);
	});

	it('waives gateway costs, retains list-price equivalence, and writes an explicit audit', () => {
		const result = applyPrivateByokBillingPolicy({
			meteredCost: 0.2,
			standardCost: 0.3,
			chargedCost: 0.25,
			pricingAuditJson: '{"v":4,"snapshot":{"kind":"tokens"}}',
		}, true);
		assert.equal(result.meteredCost, 0);
		assert.equal(result.standardCost, 0.3);
		assert.equal(result.chargedCost, 0);
		assert.deepEqual(JSON.parse(result.pricingAuditJson), {
			v: 4,
			snapshot: { kind: 'tokens' },
			byok: {
				policy: PRIVATE_BYOK_BILLING_POLICY,
				provider_cost_responsibility: 'credential_owner',
				gateway_supplier_cost_usd: 0,
				gateway_charged_cost_usd: 0,
				standard_equivalent_cost_usd: 0.3,
				nominal_gateway_supplier_cost_usd: 0.2,
				nominal_gateway_charged_cost_usd: 0.25,
			},
		});
	});

	it('settles a BYOK reservation as known actual zero', () => {
		assert.equal(privateByokSettlementMode(true, 'reserved'), 'actual');
		assert.equal(privateByokSettlementMode(false, 'reserved'), 'reserved');
	});

	it('fails closed on a malformed internal audit', () => {
		assert.throws(() => applyPrivateByokBillingPolicy({
			meteredCost: 0,
			standardCost: 0,
			chargedCost: 0,
			pricingAuditJson: 'not-json',
		}, true), /must be valid JSON/);
	});
});
