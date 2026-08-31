import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import {
	ORDINARY_BUDGET_ADMISSION_LEASE_MS,
	ORDINARY_BUDGET_DISPATCH_LEASE_MS,
	ORDINARY_BUDGET_RECOVERY_MAX_PASSES,
	ORDINARY_BUDGET_RECOVERY_PAGE_SIZE,
	OrdinaryBudgetLifecycleError,
	ordinaryBudgetReservationMicros,
	reserveOrdinaryUserBudget,
	type OrdinaryBudgetLease,
	type OrdinaryBudgetRepositories,
	type ReserveOrdinaryBudgetParams,
} from './ordinary-budget-lifecycle';

const NOW = new Date('2026-08-29T04:00:00.000Z');

type UserBudgetsRepository = GatewayRepositories['userBudgets'];

function reservationFor(
	params: Parameters<UserBudgetsRepository['reserve']>[0],
	budgetEpoch = 7,
	reservedMicros = params.reservedMicros,
) {
	return {
		requestId: params.requestId,
		userId: params.userId,
		apiKeyId: params.apiKeyId,
		budgetEpoch,
		limitMicros: 10_000_000,
		reservedMicros,
	};
}

function repositoriesWithUserBudget(
	overrides: Partial<UserBudgetsRepository> = {},
): OrdinaryBudgetRepositories {
	const userBudgets: UserBudgetsRepository = {
		reserve: async (params) => ({
			status: 'reserved',
			reservation: reservationFor(params),
		}),
		markDispatched: async () => true,
		release: async () => 1,
		forfeitDispatched: async () => 1,
		expireBefore: async () => 0,
		...overrides,
	};
	return { userBudgets };
}

function baseParams(
	overrides: Partial<ReserveOrdinaryBudgetParams> = {},
): ReserveOrdinaryBudgetParams {
	return {
		requestId: 'request-1',
		userId: 'user-1',
		apiKeyId: 'key-1',
		budgetMax: 10,
		expectedBudgetEpoch: 7,
		estimatedChargedCost: 0.25,
		now: NOW,
		...overrides,
	};
}

function property(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null) return undefined;
	return Reflect.get(value, key);
}

async function admittedLease(
	overrides: Partial<UserBudgetsRepository> = {},
	paramOverrides: Partial<ReserveOrdinaryBudgetParams> = {},
): Promise<OrdinaryBudgetLease> {
	const result = await reserveOrdinaryUserBudget(
		repositoriesWithUserBudget(overrides),
		baseParams(paramOverrides),
	);
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error(result.error.message);
	assert.equal(result.kind, 'reserved');
	return result.lease;
}

async function expectLifecycleError(
	promise: Promise<unknown>,
	code: OrdinaryBudgetLifecycleError['code'],
	state: OrdinaryBudgetLifecycleError['leaseState'],
): Promise<OrdinaryBudgetLifecycleError> {
	let captured: OrdinaryBudgetLifecycleError | null = null;
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof OrdinaryBudgetLifecycleError);
		assert.equal(error.code, code);
		assert.equal(error.leaseState, state);
		captured = error;
		return true;
	});
	assert.ok(captured);
	return captured;
}

describe('ordinary budget estimate conversion', () => {
	it('distinguishes an unprovable estimate from a proven free request', () => {
		assert.deepEqual(ordinaryBudgetReservationMicros(null), {
			ok: false,
			error: {
				code: 'estimate_unavailable',
				message: 'A finite user budget requires a provable charged-cost ceiling',
				retryable: false,
			},
		});
		assert.deepEqual(ordinaryBudgetReservationMicros(0), {
			ok: true,
			reservedMicros: 0,
		});
	});

	it('rejects every non-finite and negative estimate instead of rounding it to zero', () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const result = ordinaryBudgetReservationMicros(value);
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.error.code, 'estimate_non_finite');
		}
		const negative = ordinaryBudgetReservationMicros(-0.000001);
		assert.equal(negative.ok, false);
		if (!negative.ok) assert.equal(negative.error.code, 'estimate_negative');
	});

	it('rounds positive estimates upward to a positive safe micro-unit ceiling', () => {
		assert.deepEqual(ordinaryBudgetReservationMicros(0.0000001), {
			ok: true,
			reservedMicros: 1,
		});
		assert.deepEqual(ordinaryBudgetReservationMicros(1.0000001), {
			ok: true,
			reservedMicros: 1_000_001,
		});
	});

	it('rejects ceilings outside the safe integer micro-unit range', () => {
		const result = ordinaryBudgetReservationMicros(Number.MAX_VALUE);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.code, 'estimate_out_of_range');
	});
});

describe('ordinary budget admission', { concurrency: false }, () => {
	it('returns unlimited for a null maximum without estimation, recovery, or reservation', async () => {
		const calls: string[] = [];
		const result = await reserveOrdinaryUserBudget(
			repositoriesWithUserBudget({
				expireBefore: async () => { calls.push('expire'); return 0; },
				reserve: async () => { calls.push('reserve'); return { status: 'unlimited' }; },
			}),
			baseParams({
				budgetMax: null,
				expectedBudgetEpoch: -1,
				estimatedChargedCost: null,
			}),
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.kind, 'unlimited');
		assert.equal(result.lease.state, 'unmetered');
		assert.equal(result.lease.reserved, false);
		assert.deepEqual(calls, []);
	});

	it('admits a proven-free request when a finite limit has no positive capacity', async () => {
		let called = false;
		const result = await reserveOrdinaryUserBudget(
			repositoriesWithUserBudget({
				reserve: async () => { called = true; return { status: 'unlimited' }; },
			}),
			baseParams({ budgetMax: 0, estimatedChargedCost: 0 }),
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.kind, 'free');
		assert.equal(result.lease.budgetEpoch, 7);
		assert.equal(result.lease.state, 'unmetered');
		assert.equal(called, false);
	});

	it('rejects malformed identities, finite limits, epochs, estimates, and clocks', async () => {
		const repositories = repositoriesWithUserBudget();
		const cases: Array<{
			overrides: Partial<ReserveOrdinaryBudgetParams>;
			code: string;
		}> = [
			{ overrides: { requestId: '' }, code: 'invalid_identity' },
			{ overrides: { userId: '' }, code: 'invalid_identity' },
			{ overrides: { apiKeyId: '' }, code: 'invalid_identity' },
			{ overrides: { budgetMax: Number.NaN }, code: 'invalid_budget_limit' },
			{ overrides: { budgetMax: Number.POSITIVE_INFINITY }, code: 'invalid_budget_limit' },
			{ overrides: { budgetMax: -1 }, code: 'invalid_budget_limit' },
			{ overrides: { expectedBudgetEpoch: -1 }, code: 'invalid_budget_epoch' },
			{ overrides: { expectedBudgetEpoch: 1.5 }, code: 'invalid_budget_epoch' },
			{ overrides: { estimatedChargedCost: null }, code: 'estimate_unavailable' },
			{ overrides: { estimatedChargedCost: Number.NaN }, code: 'estimate_non_finite' },
			{ overrides: { now: new Date(Number.NaN) }, code: 'invalid_time' },
		];
		for (const testCase of cases) {
			const result = await reserveOrdinaryUserBudget(
				repositories,
				baseParams(testCase.overrides),
			);
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.error.code, testCase.code);
		}
	});

	it('drains only bounded recovery pages before atomic reservation', async () => {
		const calls: string[] = [];
		let received: unknown;
		const result = await reserveOrdinaryUserBudget(
			repositoriesWithUserBudget({
				expireBefore: async (nowIso, limit) => {
					calls.push(`expire:${nowIso}:${limit}`);
					return ORDINARY_BUDGET_RECOVERY_PAGE_SIZE;
				},
				reserve: async (params) => {
					calls.push('reserve');
					received = params;
					return { status: 'reserved', reservation: reservationFor(params) };
				},
			}),
			baseParams({ estimatedChargedCost: 0.0000001 }),
		);
		assert.equal(result.ok, true);
		assert.equal(
			calls.filter((call) => call.startsWith('expire:')).length,
			ORDINARY_BUDGET_RECOVERY_MAX_PASSES,
		);
		assert.equal(calls.at(-1), 'reserve');
		assert.equal(property(received, 'reservedMicros'), 1);
		assert.equal(property(received, 'expectedBudgetEpoch'), 7);
		assert.equal(property(received, 'nowIso'), NOW.toISOString());
		assert.equal(
			property(received, 'expiresAtIso'),
			new Date(NOW.getTime() + ORDINARY_BUDGET_ADMISSION_LEASE_MS).toISOString(),
		);
	});

	it('stops recovery after a partial page', async () => {
		const pages = [ORDINARY_BUDGET_RECOVERY_PAGE_SIZE, 12];
		let calls = 0;
		const result = await reserveOrdinaryUserBudget(
			repositoriesWithUserBudget({
				expireBefore: async () => pages[calls++] ?? 0,
			}),
			baseParams(),
		);
		assert.equal(result.ok, true);
		assert.equal(calls, 2);
	});

	it('keeps recovery best-effort while preserving atomic admission as the authority', async () => {
		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (...values: unknown[]) => { warnings.push(values.map(String).join(' ')); };
		try {
			let reserveCalled = false;
			const result = await reserveOrdinaryUserBudget(
				repositoriesWithUserBudget({
					expireBefore: async () => { throw new Error('recovery offline'); },
					reserve: async (params) => {
						reserveCalled = true;
						return { status: 'reserved', reservation: reservationFor(params) };
					},
				}),
				baseParams(),
			);
			assert.equal(result.ok, true);
			assert.equal(reserveCalled, true);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /ordinary budget lease recovery failed/);
		} finally {
			console.warn = originalWarn;
		}
	});

	it('accepts both newly reserved and idempotently replayed leases', async () => {
		for (const status of ['reserved', 'idempotent'] as const) {
			const result = await reserveOrdinaryUserBudget(
				repositoriesWithUserBudget({
					reserve: async (params) => ({ status, reservation: reservationFor(params) }),
				}),
				baseParams(),
			);
			assert.equal(result.ok, true);
			if (!result.ok) continue;
			assert.equal(result.kind, 'reserved');
			assert.equal(result.lease.reservedMicros, 250_000);
			assert.equal(result.lease.budgetEpoch, 7);
			assert.equal(result.lease.limitMicros, 10_000_000);
			assert.equal(result.lease.state, 'reserved');
		}
	});

	it('honors an authoritative unlimited result after a finite authentication snapshot', async () => {
		const result = await reserveOrdinaryUserBudget(
			repositoriesWithUserBudget({ reserve: async () => ({ status: 'unlimited' }) }),
			baseParams(),
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.kind, 'unlimited');
		assert.equal(result.lease.reserved, false);
	});

	it('maps capacity, stale epoch, and request-id conflicts to stable failures', async () => {
		const blocked = await reserveOrdinaryUserBudget(
			repositoriesWithUserBudget({
				reserve: async () => ({ status: 'blocked', remainingMicros: 123 }),
			}),
			baseParams(),
		);
		assert.deepEqual(blocked, {
			ok: false,
			error: {
				code: 'budget_exhausted',
				message: 'User budget does not have enough remaining capacity',
				retryable: false,
				remainingMicros: 123,
			},
		});

		const stale = await reserveOrdinaryUserBudget(
			repositoriesWithUserBudget({
				reserve: async () => ({
					status: 'stale',
					budgetResetAt: '2026-08-29T05:00:00.000Z',
				}),
			}),
			baseParams(),
		);
		assert.equal(stale.ok, false);
		if (!stale.ok) {
			assert.equal(stale.error.code, 'budget_epoch_stale');
			assert.equal(stale.error.retryable, true);
			assert.equal(stale.error.expectedBudgetEpoch, 7);
		}

		const conflict = await reserveOrdinaryUserBudget(
			repositoriesWithUserBudget({
				reserve: async () => ({ status: 'conflict', message: 'payload mismatch' }),
			}),
			baseParams(),
		);
		assert.deepEqual(conflict, {
			ok: false,
			error: {
				code: 'reservation_conflict',
				message: 'payload mismatch',
				retryable: false,
			},
		});
	});

	it('fails closed and releases when the repository returns a different epoch', async () => {
		const releases: Array<{ requestId: string; nowIso: string; reason: string }> = [];
		const result = await reserveOrdinaryUserBudget(
			repositoriesWithUserBudget({
				reserve: async (params) => ({
					status: 'reserved',
					reservation: reservationFor(params, 8),
				}),
				release: async (requestId, nowIso, reason) => {
					releases.push({ requestId, nowIso, reason });
					return 1;
				},
			}),
			baseParams(),
		);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.error.code, 'budget_epoch_stale');
			assert.equal(result.error.expectedBudgetEpoch, 7);
			assert.equal(result.error.actualBudgetEpoch, 8);
		}
		assert.deepEqual(releases, [{
			requestId: 'request-1',
			nowIso: NOW.toISOString(),
			reason: 'budget_epoch_mismatch',
		}]);
	});

	it('fails closed on malformed repository snapshots and schedules bounded cleanup', async () => {
		let released = 0;
		const result = await reserveOrdinaryUserBudget(
			repositoriesWithUserBudget({
				reserve: async (params) => ({
					status: 'reserved',
					reservation: reservationFor(params, 7, params.reservedMicros + 1),
				}),
				release: async () => { released += 1; return 1; },
			}),
			baseParams(),
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.code, 'reservation_invariant_violation');
		assert.equal(released, 1);
	});

	it('wraps reserve storage failures with a stable lifecycle error and cause', async () => {
		const cause = new Error('database unavailable');
		const error = await expectLifecycleError(
			reserveOrdinaryUserBudget(
				repositoriesWithUserBudget({ reserve: async () => { throw cause; } }),
				baseParams(),
			),
			'reserve_persistence_failed',
			null,
		);
		assert.equal(error.cause, cause);
	});
});

describe('ordinary budget lease lifecycle', () => {
	it('keeps unlimited and free leases storage-free across lifecycle callbacks', async () => {
		const calls: string[] = [];
		const repositories = repositoriesWithUserBudget({
			markDispatched: async () => { calls.push('dispatch'); return true; },
			release: async () => { calls.push('release'); return 1; },
			forfeitDispatched: async () => { calls.push('forfeit'); return 1; },
		});
		for (const params of [
			baseParams({ budgetMax: null, estimatedChargedCost: null }),
			baseParams({ estimatedChargedCost: 0 }),
		]) {
			const result = await reserveOrdinaryUserBudget(repositories, params);
			assert.equal(result.ok, true);
			if (!result.ok) continue;
			await result.lease.beforeUpstreamDispatch(NOW);
			await result.lease.releasePreDispatch('', new Date(Number.NaN));
			await result.lease.forfeitPostDispatchUnknown('', new Date(Number.NaN));
			await result.lease.terminateUnknown('', new Date(Number.NaN));
			assert.equal(result.lease.state, 'unmetered');
		}
		assert.deepEqual(calls, []);
	});

	it('marks dispatch immediately with a bounded extended lease and is locally idempotent', async () => {
		const calls: Array<{ requestId: string; nowIso: string; expiresAtIso: string }> = [];
		const lease = await admittedLease({
			markDispatched: async (requestId, nowIso, expiresAtIso) => {
				calls.push({ requestId, nowIso, expiresAtIso });
				return true;
			},
		});
		await lease.beforeUpstreamDispatch(NOW);
		await lease.beforeUpstreamDispatch(new Date('2026-08-29T04:01:00.000Z'));
		assert.equal(lease.state, 'dispatched');
		assert.deepEqual(calls, [{
			requestId: 'request-1',
			nowIso: NOW.toISOString(),
			expiresAtIso: new Date(NOW.getTime() + ORDINARY_BUDGET_DISPATCH_LEASE_MS).toISOString(),
		}]);
	});

	it('keeps a reservation releasable when the dispatch transition is rejected', async () => {
		let releases = 0;
		const lease = await admittedLease({
			markDispatched: async () => false,
			release: async () => { releases += 1; return 1; },
		});
		await expectLifecycleError(
			lease.beforeUpstreamDispatch(NOW),
			'dispatch_persistence_failed',
			'reserved',
		);
		assert.equal(lease.state, 'reserved');
		await lease.releasePreDispatch('dispatch_not_started', NOW);
		assert.equal(lease.state, 'released');
		assert.equal(releases, 1);
	});

	it('wraps a dispatch storage exception without losing its cause', async () => {
		const cause = new Error('write failed');
		const lease = await admittedLease({ markDispatched: async () => { throw cause; } });
		const error = await expectLifecycleError(
			lease.beforeUpstreamDispatch(NOW),
			'dispatch_persistence_failed',
			'reserved',
		);
		assert.equal(error.cause, cause);
		assert.equal(lease.state, 'reserved');
	});

	it('releases only before dispatch, normalizes the reason, and is locally idempotent', async () => {
		const calls: Array<{ requestId: string; nowIso: string; reason: string }> = [];
		const lease = await admittedLease({
			release: async (requestId, nowIso, reason) => {
				calls.push({ requestId, nowIso, reason });
				return 1;
			},
		});
		await lease.releasePreDispatch('  request_rejected  ', NOW);
		await lease.releasePreDispatch('ignored', new Date(Number.NaN));
		assert.equal(lease.state, 'released');
		assert.deepEqual(calls, [{
			requestId: 'request-1',
			nowIso: NOW.toISOString(),
			reason: 'request_rejected',
		}]);
		await expectLifecycleError(
			lease.beforeUpstreamDispatch(NOW),
			'invalid_transition',
			'released',
		);
	});

	it('rejects release after dispatch and forfeit before dispatch', async () => {
		const beforeDispatch = await admittedLease();
		await expectLifecycleError(
			beforeDispatch.forfeitPostDispatchUnknown('unknown', NOW),
			'invalid_transition',
			'reserved',
		);

		const afterDispatch = await admittedLease();
		await afterDispatch.beforeUpstreamDispatch(NOW);
		await expectLifecycleError(
			afterDispatch.releasePreDispatch('too_late', NOW),
			'invalid_transition',
			'dispatched',
		);
	});

	it('forfeits only after dispatch and is locally idempotent', async () => {
		const calls: Array<{ requestId: string; nowIso: string; reason: string }> = [];
		const lease = await admittedLease({
			forfeitDispatched: async (requestId, nowIso, reason) => {
				calls.push({ requestId, nowIso, reason });
				return 1;
			},
		});
		await lease.beforeUpstreamDispatch(NOW);
		await lease.forfeitPostDispatchUnknown('  upstream_outcome_unknown  ', NOW);
		await lease.forfeitPostDispatchUnknown('ignored', new Date(Number.NaN));
		assert.equal(lease.state, 'forfeited');
		assert.deepEqual(calls, [{
			requestId: 'request-1',
			nowIso: NOW.toISOString(),
			reason: 'upstream_outcome_unknown',
		}]);
		await expectLifecycleError(
			lease.beforeUpstreamDispatch(NOW),
			'invalid_transition',
			'forfeited',
		);
	});

	it('terminateUnknown releases before dispatch and forfeits after dispatch', async () => {
		const calls: string[] = [];
		const overrides: Partial<UserBudgetsRepository> = {
			release: async () => { calls.push('release'); return 1; },
			forfeitDispatched: async () => { calls.push('forfeit'); return 1; },
		};
		const reserved = await admittedLease(overrides, { requestId: 'request-release' });
		await reserved.terminateUnknown('unknown', NOW);
		assert.equal(reserved.state, 'released');

		const dispatched = await admittedLease(overrides, { requestId: 'request-forfeit' });
		await dispatched.beforeUpstreamDispatch(NOW);
		await dispatched.terminateUnknown('unknown', NOW);
		assert.equal(dispatched.state, 'forfeited');
		assert.deepEqual(calls, ['release', 'forfeit']);
	});

	it('fails closed when release or forfeit persistence reports no transition', async () => {
		const releaseLease = await admittedLease({ release: async () => 0 });
		await expectLifecycleError(
			releaseLease.releasePreDispatch('cancelled', NOW),
			'release_persistence_failed',
			'reserved',
		);
		assert.equal(releaseLease.state, 'reserved');

		const forfeitLease = await admittedLease({ forfeitDispatched: async () => 0 });
		await forfeitLease.beforeUpstreamDispatch(NOW);
		await expectLifecycleError(
			forfeitLease.forfeitPostDispatchUnknown('unknown', NOW),
			'forfeit_persistence_failed',
			'dispatched',
		);
		assert.equal(forfeitLease.state, 'dispatched');
	});

	it('wraps release and forfeit storage exceptions with their causes', async () => {
		const releaseCause = new Error('release failed');
		const releaseLease = await admittedLease({ release: async () => { throw releaseCause; } });
		const releaseError = await expectLifecycleError(
			releaseLease.releasePreDispatch('cancelled', NOW),
			'release_persistence_failed',
			'reserved',
		);
		assert.equal(releaseError.cause, releaseCause);

		const forfeitCause = new Error('forfeit failed');
		const forfeitLease = await admittedLease({
			forfeitDispatched: async () => { throw forfeitCause; },
		});
		await forfeitLease.beforeUpstreamDispatch(NOW);
		const forfeitError = await expectLifecycleError(
			forfeitLease.forfeitPostDispatchUnknown('unknown', NOW),
			'forfeit_persistence_failed',
			'dispatched',
		);
		assert.equal(forfeitError.cause, forfeitCause);
	});

	it('rejects invalid lifecycle timestamps and terminal reasons before storage', async () => {
		let calls = 0;
		const lease = await admittedLease({
			markDispatched: async () => { calls += 1; return true; },
			release: async () => { calls += 1; return 1; },
		});
		await expectLifecycleError(
			lease.beforeUpstreamDispatch(new Date(Number.NaN)),
			'invalid_time',
			'reserved',
		);
		await expectLifecycleError(
			lease.releasePreDispatch('   ', NOW),
			'invalid_reason',
			'reserved',
		);
		await expectLifecycleError(
			lease.releasePreDispatch('x'.repeat(129), NOW),
			'invalid_reason',
			'reserved',
		);
		assert.equal(calls, 0);
	});
});
