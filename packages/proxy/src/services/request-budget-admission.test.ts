import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { GatewayRepositories, GuardrailBudgetIntent } from '@octafuse/core';
import type { RouteResult } from './model-router';
import {
	createRouteAwareBudgetAdmission,
	RequestBudgetAdmissionError,
	type GuardrailBudgetRequestPort,
} from './request-budget-admission';

const NOW = new Date('2026-09-03T08:00:00.000Z');

const intent: GuardrailBudgetIntent = {
	workspaceId: 'workspace-1',
	assignmentId: 'assignment-1',
	guardrailId: 'guardrail-1',
	guardrailVersion: 1,
	scopeType: 'user',
	scopeId: 'user-1',
	period: 'daily',
	periodStart: '2026-09-03T00:00:00.000Z',
	periodEnd: '2026-09-04T00:00:00.000Z',
	limitMicros: 10_000_000,
};

const gatewayKeyIntent: GuardrailBudgetIntent = {
	workspaceId: 'workspace-1',
	assignmentId: 'gateway-key-limit:key-1',
	guardrailId: 'gateway-key-limit:key-1',
	guardrailVersion: 1,
	scopeType: 'api_key',
	scopeId: 'key-1',
	period: 'daily',
	periodStart: '2026-09-03T00:00:00.000Z',
	periodEnd: '2026-09-04T00:00:00.000Z',
	limitMicros: 10_000_000,
};

function route(providerKeyId: string): RouteResult {
	return { providerKeyId } as RouteResult;
}

function repositories(overrides: {
	userReserve?: GatewayRepositories['userBudgets']['reserve'];
	userMarkDispatched?: GatewayRepositories['userBudgets']['markDispatched'];
	guardrailReserve?: GatewayRepositories['guardrailBudgets']['reserveMany'];
	guardrailExtend?: GatewayRepositories['guardrailBudgets']['extendDispatched'];
	guardrailMarkDispatched?: GatewayRepositories['guardrailBudgets']['markDispatched'];
} = {}) {
	const calls: string[] = [];
	const userReserve = overrides.userReserve ?? (async (params) => {
		calls.push('ordinary:reserve');
		return {
			status: 'reserved' as const,
			reservation: {
				requestId: params.requestId,
				userId: params.userId,
				apiKeyId: params.apiKeyId,
				budgetEpoch: params.expectedBudgetEpoch,
				limitMicros: 10_000_000,
				reservedMicros: params.reservedMicros,
			},
		};
	});
	const guardrailReserve = overrides.guardrailReserve ?? (async () => {
		calls.push('guardrail:reserve');
		return { status: 'reserved' as const, reservationCount: 1 };
	});
	const guardrailExtend = overrides.guardrailExtend ?? (async () => {
		calls.push('guardrail:extend');
		return { status: 'reserved' as const, reservationCount: 2 };
	});
	const repos = {
		userBudgets: {
			reserve: userReserve,
			expireBefore: async () => 0,
			markDispatched: overrides.userMarkDispatched
				?? (async () => { calls.push('ordinary:dispatch'); return true; }),
			release: async () => { calls.push('ordinary:release'); return 1; },
			forfeitDispatched: async () => { calls.push('ordinary:forfeit'); return 1; },
		},
		guardrailBudgets: {
			reserveMany: guardrailReserve,
			extendDispatched: guardrailExtend,
			expireBefore: async () => 0,
			markDispatched: overrides.guardrailMarkDispatched
				?? (async () => { calls.push('guardrail:dispatch'); return true; }),
			releaseMany: async () => { calls.push('guardrail:release'); return 1; },
			forfeitMany: async () => { calls.push('guardrail:forfeit'); return 1; },
		},
	} as unknown as GatewayRepositories;
	return { repos, calls };
}

async function coordinator(
	repos: GatewayRepositories,
	includePrivateByokInBudget = false,
	options: Parameters<typeof createRouteAwareBudgetAdmission>[2] = {},
) {
	return createRouteAwareBudgetAdmission(repos, {
		ordinary: {
			requestId: 'request-1',
			userId: 'user-1',
			apiKeyId: 'key-1',
			budgetMax: 10,
			expectedBudgetEpoch: 7,
			estimatedChargedCost: 0.25,
			now: NOW,
		},
		guardrail: {
			intents: includePrivateByokInBudget ? [gatewayKeyIntent, intent] : [intent],
			reservedMicros: 250_000,
			now: NOW,
		},
		privateByokGatewayKey: {
			includeInLimit: includePrivateByokInBudget,
			reservedMicros: 250_000,
		},
	}, options);
}

describe('route-aware request budget admission', () => {
	it('uses the strict request-fixed Guardrail port for BYOK then paid fallback', async () => {
		const noRuntimeGuardrail = async (): Promise<never> => {
			throw new Error('runtime Guardrail repository reached');
		};
		const { repos, calls } = repositories({
			guardrailReserve: noRuntimeGuardrail,
			guardrailExtend: noRuntimeGuardrail,
			guardrailMarkDispatched: noRuntimeGuardrail,
		});
		const portCalls: string[] = [];
		const port: GuardrailBudgetRequestPort = {
			identity: { requestId: 'request-1', userId: 'user-1', apiKeyId: 'key-1' },
			reserve: async values => {
				portCalls.push(`reserve:${values.settlementBasis ?? 'charged'}`);
				assert.equal(values.intents.length, 1);
				return { ok: true, reserved: true };
			},
			extend: async values => {
				portCalls.push('extend');
				assert.equal(values.intents.length, 2);
				return { ok: true, reserved: true };
			},
			markDispatched: async () => { portCalls.push('mark'); },
			releasePreDispatch: async () => { portCalls.push('release'); },
			forfeitPostDispatch: async () => { portCalls.push('forfeit'); },
		};
		const admission = await coordinator(repos, true, { guardrailBudgetRequestPort: port });
		await admission.beforeUpstreamDispatch(route('byok:private-1'));
		await admission.beforeUpstreamDispatch(route('provider-1'));
		assert.deepEqual(portCalls, ['reserve:gateway_key_route', 'mark', 'extend']);
		assert.deepEqual(calls, ['ordinary:reserve', 'ordinary:dispatch']);
		assert.equal(admission.ordinaryLease.state, 'dispatched');
	});

	it('strict Guardrail recovery failure stops paid dispatch without runtime fallback or replay', async () => {
		const { repos, calls } = repositories();
		let attempts = 0;
		const port: GuardrailBudgetRequestPort = {
			identity: { requestId: 'request-1', userId: 'user-1', apiKeyId: 'key-1' },
			reserve: async () => { attempts++; throw new Error('recovery COMMIT unconfirmed'); },
			extend: async () => { throw new Error('extension must not run'); },
			markDispatched: async () => { throw new Error('dispatch must not run'); },
			releasePreDispatch: async () => { throw new Error('release must not run'); },
			forfeitPostDispatch: async () => { throw new Error('forfeit must not run'); },
		};
		const admission = await coordinator(repos, false, { guardrailBudgetRequestPort: port });
		for (let retry = 0; retry < 2; retry += 1) {
			await assert.rejects(admission.beforeUpstreamDispatch(route('provider-1')),
				/recovery COMMIT unconfirmed/);
		}
		assert.equal(attempts, 1, 'an uncertain recovery must not be replayed');
		assert.deepEqual(calls, ['ordinary:reserve', 'ordinary:release']);
		assert.equal(admission.guardrailDispatched, false);
	});

	it('rejects a Guardrail owner for another request before ordinary admission', async () => {
		const { repos, calls } = repositories();
		const wrong = {
			identity: { requestId: 'other-request', userId: 'user-1', apiKeyId: 'key-1' },
			reserve: async () => { throw new Error('wrong owner used'); },
			extend: async () => { throw new Error('wrong owner used'); },
			markDispatched: async () => { throw new Error('wrong owner used'); },
			releasePreDispatch: async () => { throw new Error('wrong owner used'); },
			forfeitPostDispatch: async () => { throw new Error('wrong owner used'); },
		} satisfies GuardrailBudgetRequestPort;
		await assert.rejects(coordinator(repos, false, { guardrailBudgetRequestPort: wrong }),
			/identity differs/);
		assert.deepEqual(calls, []);
	});

	it('keeps owner and budget inputs fixed across an asynchronous free admission', async () => {
		const { repos, calls } = repositories();
		const seen: string[] = [];
		const port: GuardrailBudgetRequestPort = {
			identity: { requestId: 'request-1', userId: 'user-1', apiKeyId: 'key-1' },
			reserve: async values => {
				seen.push(`reserve:${values.intents[0]?.assignmentId}:${values.reservedMicros}:${values.now.toISOString()}`);
				return { ok: true, reserved: true };
			},
			extend: async () => { throw new Error('unexpected extension'); },
			markDispatched: async now => { seen.push(`mark:${now.toISOString()}`); },
			releasePreDispatch: async () => {},
			forfeitPostDispatch: async () => {},
		};
		const wrong: GuardrailBudgetRequestPort = {
			...port,
			identity: { requestId: 'swapped', userId: 'swapped', apiKeyId: 'swapped' },
			reserve: async () => { throw new Error('swapped owner called'); },
		};
		const params: Parameters<typeof createRouteAwareBudgetAdmission>[1] = {
			ordinary: {
				requestId: 'request-1', userId: 'user-1', apiKeyId: 'key-1',
				budgetMax: 10, expectedBudgetEpoch: 7, estimatedChargedCost: 0.25,
				now: new Date(NOW),
			},
			guardrail: { intents: [{ ...intent }], reservedMicros: 250_000, now: new Date(NOW) },
			privateByokGatewayKey: { includeInLimit: false, reservedMicros: 250_000 },
		};
		const options: NonNullable<Parameters<typeof createRouteAwareBudgetAdmission>[2]> = {
			guardrailBudgetRequestPort: port,
		};
		const admission = await createRouteAwareBudgetAdmission(repos, params, options);
		params.ordinary.requestId = 'swapped';
		params.ordinary.userId = 'swapped';
		params.guardrail.intents[0]!.assignmentId = 'swapped';
		params.guardrail.reservedMicros = 1;
		params.guardrail.now!.setUTCFullYear(2030);
		options.guardrailBudgetRequestPort = wrong;
		await admission.beforeUpstreamDispatch(route('provider-1'));
		assert.equal(admission.ordinaryLease.requestId, 'request-1');
		assert.deepEqual(seen, [
			`reserve:assignment-1:250000:${NOW.toISOString()}`,
			`mark:${NOW.toISOString()}`,
		]);
		assert.deepEqual(calls, ['ordinary:reserve', 'ordinary:dispatch']);
	});

	it('holds both ledgers at reservation until an acknowledged single grant is ready to send', async () => {
		const { repos, calls } = repositories();
		const admission = await coordinator(repos);
		const ticket = await admission.prepareSingleGrant(route('provider-1'));
		assert.deepEqual(calls, ['ordinary:reserve', 'guardrail:reserve']);
		assert.equal(admission.ordinaryLease.state, 'reserved');
		assert.equal(admission.guardrailDispatched, false);
		await ticket.markAfterCommittedClaim();
		assert.deepEqual(calls, [
			'ordinary:reserve', 'guardrail:reserve', 'guardrail:dispatch', 'ordinary:dispatch',
		]);
		assert.equal(admission.ordinaryLease.state, 'dispatched');
		await assert.rejects(ticket.markAfterCommittedClaim(), /already resolved/u);
		await assert.rejects(ticket.releaseAfterDefiniteNoClaim(), /cannot be released/u);
	});

	it('releases reserved ledgers after a definitive no-claim result without marking dispatch', async () => {
		const { repos, calls } = repositories();
		const admission = await coordinator(repos);
		const ticket = await admission.prepareSingleGrant(route('provider-1'));
		await ticket.releaseAfterDefiniteNoClaim();
		assert.deepEqual(calls, [
			'ordinary:reserve', 'guardrail:reserve', 'guardrail:release', 'ordinary:release',
		]);
		assert.equal(admission.ordinaryLease.kind, 'free');
		assert.equal(admission.guardrailDispatched, false);
		await assert.rejects(ticket.markAfterCommittedClaim(), /already resolved/u);
		await assert.rejects(admission.prepareSingleGrant(route('provider-2')), /mode already selected/u);
	});

	it('keeps the reservation and blocks another dispatch when claim acknowledgement is uncertain', async () => {
		const { repos, calls } = repositories();
		const admission = await coordinator(repos);
		const ticket = await admission.prepareSingleGrant(route('provider-1'));
		ticket.holdAfterUncertainClaim();
		assert.deepEqual(calls, ['ordinary:reserve', 'guardrail:reserve']);
		assert.equal(admission.ordinaryLease.state, 'reserved');
		await assert.rejects(ticket.markAfterCommittedClaim(), /already resolved/u);
		await assert.rejects(admission.beforeUpstreamDispatch(route('provider-2')), /already owns/u);
	});

	it('keeps an excluded private BYOK single-grant ticket free of ledger writes', async () => {
		const { repos, calls } = repositories();
		const admission = await coordinator(repos);
		const ticket = await admission.prepareSingleGrant(route('byok:private-1'));
		await ticket.markAfterCommittedClaim();
		assert.deepEqual(calls, []);
		assert.equal(admission.ordinaryLease.state, 'unmetered');
	});

	it('does not reserve either gateway ledger for an excluded private BYOK route', async () => {
		const { repos, calls } = repositories();
		const admission = await coordinator(repos);

		await admission.beforeUpstreamDispatch(route('byok:private-1'));

		assert.deepEqual(calls, []);
		assert.equal(admission.ordinaryLease.kind, 'free');
		assert.equal(admission.ordinaryLease.state, 'unmetered');
		assert.equal(admission.guardrailReserved, false);
		assert.equal(admission.guardrailDispatched, false);
	});

	it('reserves and dispatches both ledgers exactly once at the first platform fallback', async () => {
		const { repos, calls } = repositories();
		const admission = await coordinator(repos);
		await admission.beforeUpstreamDispatch(route('byok:private-1'));

		await Promise.all([
			admission.beforeUpstreamDispatch(route('provider-1')),
			admission.beforeUpstreamDispatch(route('provider-2')),
		]);

		assert.deepEqual(calls, [
			'ordinary:reserve',
			'guardrail:reserve',
			'guardrail:dispatch',
			'ordinary:dispatch',
		]);
		assert.equal(admission.ordinaryLease.kind, 'reserved');
		assert.equal(admission.ordinaryLease.state, 'dispatched');
		assert.equal(admission.guardrailReserved, true);
		assert.equal(admission.guardrailDispatched, true);
	});

	it('can opt private BYOK into the same authenticated admission policy', async () => {
		const { repos, calls } = repositories();
		const admission = await coordinator(repos, true);

		await admission.beforeUpstreamDispatch(route('byok:private-1'));

		assert.deepEqual(calls, [
			'guardrail:reserve',
			'guardrail:dispatch',
		]);
		assert.equal(admission.ordinaryLease.kind, 'free');
		assert.equal(admission.ordinaryLease.state, 'unmetered');
		assert.equal(admission.guardrailReserved, true);
		assert.equal(admission.guardrailDispatched, true);
	});

	it('reuses one included key reservation across repeated private BYOK attempts', async () => {
		const { repos, calls } = repositories();
		const admission = await coordinator(repos, true);

		await Promise.all([
			admission.beforeUpstreamDispatch(route('byok:private-1')),
			admission.beforeUpstreamDispatch(route('byok:private-2')),
		]);

		assert.deepEqual(calls, [
			'guardrail:reserve',
			'guardrail:dispatch',
		]);
		assert.equal(admission.guardrailReserved, true);
		assert.equal(admission.guardrailDispatched, true);
	});

	it('fails closed before private BYOK egress when the Gateway key limit rejects admission', async () => {
		const guardrailReserve = mock.fn<GatewayRepositories['guardrailBudgets']['reserveMany']>(
			async () => ({ status: 'blocked', assignmentId: gatewayKeyIntent.assignmentId }),
		);
		const { repos } = repositories({ guardrailReserve });
		const admission = await coordinator(repos, true);

		await assert.rejects(
			admission.beforeUpstreamDispatch(route('byok:private-1')),
			(error: unknown) => {
				assert.ok(error instanceof RequestBudgetAdmissionError);
				assert.equal(error.code, 'gateway.budget_exceeded');
				return true;
			},
		);
		assert.equal(guardrailReserve.mock.callCount(), 1);
		assert.equal(admission.ordinaryLease.kind, 'free');
		assert.equal(admission.guardrailReserved, false);
		assert.equal(admission.guardrailDispatched, false);
	});

	it('atomically extends an included BYOK key reservation before platform fallback', async () => {
		const { repos, calls } = repositories();
		const admission = await coordinator(repos, true);

		await admission.beforeUpstreamDispatch(route('byok:private-1'));
		await admission.beforeUpstreamDispatch(route('provider-1'));

		assert.deepEqual(calls, [
			'guardrail:reserve',
			'guardrail:dispatch',
			'ordinary:reserve',
			'guardrail:extend',
			'ordinary:dispatch',
		]);
		assert.equal(admission.ordinaryLease.kind, 'reserved');
		assert.equal(admission.ordinaryLease.state, 'dispatched');
	});

	it('releases the new ordinary lease when BYOK-to-platform extension is rejected', async () => {
		const guardrailExtend = mock.fn<GatewayRepositories['guardrailBudgets']['extendDispatched']>(
			async () => ({ status: 'blocked', assignmentId: intent.assignmentId }),
		);
		const { repos, calls } = repositories({ guardrailExtend });
		const admission = await coordinator(repos, true);
		await admission.beforeUpstreamDispatch(route('byok:private-1'));

		await assert.rejects(
			admission.beforeUpstreamDispatch(route('provider-1')),
			(error: unknown) => {
				assert.ok(error instanceof RequestBudgetAdmissionError);
				assert.equal(error.code, 'gateway.guardrail_blocked');
				return true;
			},
		);

		assert.equal(guardrailExtend.mock.callCount(), 1);
		assert.deepEqual(calls, [
			'guardrail:reserve',
			'guardrail:dispatch',
			'ordinary:reserve',
			'ordinary:release',
		]);
		assert.equal(admission.ordinaryLease.kind, 'free');
		assert.equal(admission.guardrailReserved, true);
		assert.equal(admission.guardrailDispatched, true);
		assert.equal(admission.guardrailTerminal, false);
	});

	it('releases a pre-dispatch key reservation when its dispatch transition fails', async () => {
		const guardrailMarkDispatched = mock.fn<GatewayRepositories['guardrailBudgets']['markDispatched']>(
			async () => false,
		);
		const { repos, calls } = repositories({ guardrailMarkDispatched });
		const admission = await coordinator(repos, true);

		await assert.rejects(
			admission.beforeUpstreamDispatch(route('byok:private-1')),
			/enter dispatched state/u,
		);

		assert.equal(guardrailMarkDispatched.mock.callCount(), 1);
		assert.deepEqual(calls, ['guardrail:reserve', 'guardrail:release']);
		assert.equal(admission.guardrailReserved, false);
		assert.equal(admission.guardrailDispatched, false);
		assert.equal(admission.guardrailTerminal, true);
	});

	it('forfeits Guardrail capacity when the paired ordinary dispatch transition fails', async () => {
		const userMarkDispatched = mock.fn<GatewayRepositories['userBudgets']['markDispatched']>(
			async () => false,
		);
		const { repos, calls } = repositories({ userMarkDispatched });
		const admission = await coordinator(repos);

		await assert.rejects(
			admission.beforeUpstreamDispatch(route('provider-1')),
			/could not enter dispatched state/u,
		);

		assert.equal(userMarkDispatched.mock.callCount(), 1);
		assert.deepEqual(calls, [
			'ordinary:reserve',
			'guardrail:reserve',
			'guardrail:dispatch',
			'guardrail:forfeit',
			'ordinary:release',
		]);
		assert.equal(admission.guardrailReserved, false);
		assert.equal(admission.guardrailDispatched, true);
		assert.equal(admission.guardrailTerminal, true);
	});

	it('turns an ordinary budget rejection into a typed public admission error', async () => {
		const userReserve = mock.fn<GatewayRepositories['userBudgets']['reserve']>(async () => ({
			status: 'blocked',
			remainingMicros: 1,
		}));
		const { repos, calls } = repositories({ userReserve });
		const admission = await coordinator(repos);

		await assert.rejects(
			admission.beforeUpstreamDispatch(route('provider-1')),
			(error: unknown) => {
				assert.ok(error instanceof RequestBudgetAdmissionError);
				assert.equal(error.code, 'gateway.budget_exceeded');
				return true;
			},
		);
		assert.equal(userReserve.mock.callCount(), 1);
		assert.deepEqual(calls, []);
	});

	it('releases an ordinary reservation when a Guardrail budget rejects admission', async () => {
		const guardrailReserve = mock.fn<GatewayRepositories['guardrailBudgets']['reserveMany']>(
			async () => ({ status: 'blocked', assignmentId: 'assignment-1' }),
		);
		const { repos, calls } = repositories({ guardrailReserve });
		const admission = await coordinator(repos);

		await assert.rejects(
			admission.beforeUpstreamDispatch(route('provider-1')),
			(error: unknown) => {
				assert.ok(error instanceof RequestBudgetAdmissionError);
				assert.equal(error.code, 'gateway.guardrail_blocked');
				return true;
			},
		);
		assert.deepEqual(calls, ['ordinary:reserve', 'ordinary:release']);
		assert.equal(admission.ordinaryLease.kind, 'free');
		assert.equal(admission.guardrailReserved, false);
	});
});
