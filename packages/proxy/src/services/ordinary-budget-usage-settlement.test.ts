import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	ordinaryBudgetAuditCharge,
	ordinaryBudgetAuditSnapshotTransition,
	ordinaryBudgetSettlementForCriticalWrite,
	type OrdinaryBudgetUsageSettlement,
} from './usage-tracker';

function settlement(overrides: Partial<OrdinaryBudgetUsageSettlement> = {}): OrdinaryBudgetUsageSettlement {
	return {
		requestId: 'request-1',
		budgetEpoch: 7,
		reservedMicros: 250_000,
		unknownCost: false,
		...overrides,
	};
}

describe('ordinary budget usage settlement mapping', () => {
	it('maps known usage to actual and unknown usage to the reserved ceiling', () => {
		assert.deepEqual(ordinaryBudgetSettlementForCriticalWrite(settlement()), {
			requestId: 'request-1',
			mode: 'actual',
			reason: 'request_usage_settled',
		});
		assert.deepEqual(ordinaryBudgetSettlementForCriticalWrite(settlement({ unknownCost: true })), {
			requestId: 'request-1',
			mode: 'reserved',
			reason: 'usage_unavailable_after_dispatch',
		});
	});

	it('uses the reserved ceiling in unknown-cost audit snapshots', () => {
		assert.equal(ordinaryBudgetAuditCharge({
			settlement: settlement({ unknownCost: true }),
			currentBudgetEpoch: 7,
			chargedCost: 0,
			shouldChargeBudget: false,
		}), 0.25);
	});

	it('does not attribute a late settlement to a newer budget epoch', () => {
		assert.equal(ordinaryBudgetAuditCharge({
			settlement: settlement({ unknownCost: true }),
			currentBudgetEpoch: 8,
			chargedCost: 0.1,
			shouldChargeBudget: true,
		}), 0);
		assert.deepEqual(ordinaryBudgetAuditSnapshotTransition({
			settlement: settlement({ unknownCost: true }),
			currentBudgetEpoch: 8,
			currentReservedMicros: 600_000,
			chargedCost: 0.1,
			shouldChargeBudget: true,
		}), {
			auditCharge: 0,
			afterReservedMicros: 600_000,
			settlementEpochMatches: false,
		});
	});

	it('removes only the matching request reservation from the audit snapshot', () => {
		assert.deepEqual(ordinaryBudgetAuditSnapshotTransition({
			settlement: settlement({ unknownCost: true }),
			currentBudgetEpoch: 7,
			currentReservedMicros: 600_000,
			chargedCost: 0,
			shouldChargeBudget: false,
		}), {
			auditCharge: 0.25,
			afterReservedMicros: 350_000,
			settlementEpochMatches: true,
		});
		assert.equal(ordinaryBudgetAuditSnapshotTransition({
			settlement: settlement({ reservedMicros: 750_000 }),
			currentBudgetEpoch: 7,
			currentReservedMicros: 600_000,
			chargedCost: 0.125,
			shouldChargeBudget: true,
		}).afterReservedMicros, 0);
	});

	it('uses actual charged cost only when the existing billing policy charges it', () => {
		assert.equal(ordinaryBudgetAuditCharge({
			settlement: settlement(), currentBudgetEpoch: 7,
			chargedCost: 0.125, shouldChargeBudget: true,
		}), 0.125);
		assert.equal(ordinaryBudgetAuditCharge({
			settlement: settlement(), currentBudgetEpoch: 7,
			chargedCost: 0.125, shouldChargeBudget: false,
		}), 0);
	});

	it('rejects unsafe audit metadata', () => {
		assert.throws(() => ordinaryBudgetAuditCharge({
			settlement: settlement({ reservedMicros: Number.MAX_SAFE_INTEGER + 1 }),
			currentBudgetEpoch: 7,
			chargedCost: 0,
			shouldChargeBudget: false,
		}), /metadata is invalid/);
		assert.throws(() => ordinaryBudgetAuditSnapshotTransition({
			settlement: settlement(),
			currentBudgetEpoch: 7,
			currentReservedMicros: Number.NaN,
			chargedCost: 0.125,
			shouldChargeBudget: true,
		}), /reserved total is invalid/);
	});
});
