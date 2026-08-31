import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories, GuardrailBudgetIntent } from '@octafuse/core';
import {
	filterGuardrailResponse,
	forfeitRequestGuardrailBudgets,
	GUARDRAIL_MAX_RESPONSE_BYTES,
	markRequestGuardrailBudgetsDispatched,
	releaseRequestGuardrailBudgets,
	reserveRequestGuardrailBudgets,
	runRequestGuardrails,
} from './request-guardrails';

function d1ClientWithWorkspaceBudgets(rows: Array<Record<string, unknown>> = []) {
	const statement = {
		bind: () => statement,
		all: async () => ({ results: rows }),
	};
	return { driver: 'd1', raw: { prepare: () => statement }, drizzle: {} };
}

const budgetIntent: GuardrailBudgetIntent = {
	workspaceId: 'personal:user-1',
	assignmentId: 'assignment-1',
	guardrailId: 'guardrail-1',
	guardrailVersion: 1,
	scopeType: 'user',
	scopeId: 'user-1',
	period: 'daily',
	periodStart: '2026-08-29T00:00:00.000Z',
	periodEnd: '2026-08-30T00:00:00.000Z',
	limitMicros: 1_000_000,
};

function repositoriesWithBudget(overrides: Partial<GatewayRepositories['guardrailBudgets']> = {}) {
	return {
		guardrailBudgets: {
			reserveMany: async () => ({ status: 'reserved' as const, reservationCount: 1 }),
			markDispatched: async () => true,
			releaseMany: async () => 1,
			forfeitMany: async () => 1,
			expireBefore: async () => 0,
			...overrides,
		},
	} as unknown as GatewayRepositories;
}

describe('guardrail budget request lifecycle', () => {
	it('skips storage when no budget applies', async () => {
		let called = false;
		const repositories = repositoriesWithBudget({ reserveMany: async () => {
			called = true;
			return { status: 'reserved', reservationCount: 1 };
		} });
		assert.deepEqual(await reserveRequestGuardrailBudgets(repositories, {
			requestId: 'request-1', intents: [], reservedMicros: 123,
		}), { ok: true, reserved: false });
		assert.equal(called, false);
	});

	it('recovers expired leases before atomic admission and preserves blocked/conflict results', async () => {
		const calls: string[] = [];
		const blockedRepositories = repositoriesWithBudget({
			expireBefore: async () => { calls.push('expire'); return 0; },
			reserveMany: async () => { calls.push('reserve'); return { status: 'blocked', assignmentId: 'assignment-1' }; },
		});
		assert.deepEqual(await reserveRequestGuardrailBudgets(blockedRepositories, {
			requestId: 'request-1', intents: [budgetIntent], reservedMicros: 100,
			now: new Date('2026-08-29T01:00:00.000Z'),
		}), { ok: false, blocked: true, reason: 'guardrail_budget', message: 'Request blocked by guardrail budget' });
		assert.deepEqual(calls, ['expire', 'reserve']);

		const keyLimitRepositories = repositoriesWithBudget({
			reserveMany: async () => ({ status: 'blocked', assignmentId: 'gateway-key-limit:key-1' }),
		});
		assert.deepEqual(await reserveRequestGuardrailBudgets(keyLimitRepositories, {
			requestId: 'request-key-limit', intents: [budgetIntent], reservedMicros: 100,
		}), {
			ok: false,
			blocked: true,
			reason: 'gateway_key_limit',
			message: 'Gateway key spend limit exceeded',
		});

		const workspaceBudgetRepositories = repositoriesWithBudget({
			reserveMany: async () => ({ status: 'blocked', assignmentId: 'workspace-budget:budget-1' }),
		});
		assert.deepEqual(await reserveRequestGuardrailBudgets(workspaceBudgetRepositories, {
			requestId: 'request-workspace-budget', intents: [budgetIntent], reservedMicros: 100,
		}), {
			ok: false,
			blocked: true,
			reason: 'workspace_budget',
			message: 'Workspace spend budget exceeded',
		});

		const conflictRepositories = repositoriesWithBudget({
			reserveMany: async () => ({ status: 'conflict', message: 'payload mismatch' }),
		});
		assert.deepEqual(await reserveRequestGuardrailBudgets(conflictRepositories, {
			requestId: 'request-2', intents: [budgetIntent], reservedMicros: 100,
		}), { ok: false, blocked: false, message: 'payload mismatch' });
	});

	it('drains bounded pages of expired leases before admission', async () => {
		const recovered = [50, 50, 0];
		let expiryCalls = 0;
		const repositories = repositoriesWithBudget({
			expireBefore: async () => recovered[expiryCalls++] ?? 0,
		});
		assert.deepEqual(await reserveRequestGuardrailBudgets(repositories, {
			requestId: 'request-backlog', intents: [budgetIntent], reservedMicros: 100,
		}), { ok: true, reserved: true });
		assert.equal(expiryCalls, 3);
	});

	it('dispatches and terminates only real reservations', async () => {
		const calls: string[] = [];
		const repositories = repositoriesWithBudget({
			markDispatched: async () => { calls.push('dispatch'); return true; },
			releaseMany: async () => { calls.push('release'); return 1; },
			forfeitMany: async () => { calls.push('forfeit'); return 1; },
		});
		await markRequestGuardrailBudgetsDispatched(repositories, 'request-1', false);
		await releaseRequestGuardrailBudgets(repositories, 'request-1', false, 'unused');
		await forfeitRequestGuardrailBudgets(repositories, 'request-1', false, 'unused');
		assert.deepEqual(calls, []);
		await markRequestGuardrailBudgetsDispatched(repositories, 'request-1', true);
		await releaseRequestGuardrailBudgets(repositories, 'request-1', true, 'not_started');
		await forfeitRequestGuardrailBudgets(repositories, 'request-1', true, 'unknown_usage');
		assert.deepEqual(calls, ['dispatch', 'release', 'forfeit']);
	});
});

describe('Gateway key limit policy injection', () => {
	it('adds an epoch-pinned Key limit intent to every successful preflight', async () => {
		const repositories = {
			client: d1ClientWithWorkspaceBudgets(),
			guardrails: { getEffectiveForRequest: async () => [] },
			apiKeys: {
				getApiKeyByIdInWorkspace: async () => ({
					id: 'key-1', key: 'sk-preview', user_id: 'user-1', workspace_id: 'personal:user-1',
					name: null, status: 'active', metadata: null, expires_at: null,
					limit_micros: 5_000_000, limit_reset: 'monthly', include_byok_in_limit: false, limit_epoch: 4,
					last_used_at: null, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
				}),
			},
		} as unknown as GatewayRepositories;
		const result = await runRequestGuardrails(repositories, {
			workspaceId: 'personal:user-1', userId: 'user-1', apiKeyId: 'key-1',
			modelIds: ['openai/test'], body: { prompt: 'hello' }, correlationId: 'request-1',
			now: new Date('2026-08-31T12:00:00.000Z'),
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.budgetIntents, [{
			workspaceId: 'personal:user-1', assignmentId: 'gateway-key-limit:key-1',
			guardrailId: 'gateway-key-limit:key-1', guardrailVersion: 5,
			scopeType: 'api_key', scopeId: 'key-1', period: 'monthly',
			periodStart: '2026-08-01T00:00:00.000Z', periodEnd: '2026-09-01T00:00:00.000Z',
			limitMicros: 5_000_000,
		}]);
	});

	it('adds every configured Workspace budget to the same atomic admission batch', async () => {
		const repositories = {
			client: d1ClientWithWorkspaceBudgets([{
				id: 'budget-1', workspace_id: 'personal:user-1', reset_interval: 'daily',
				limit_micros: 2_000_000, config_epoch: 3,
				workspace_created_at: '2026-01-01T00:00:00.000Z',
				created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
			}]),
			guardrails: { getEffectiveForRequest: async () => [] },
			apiKeys: {
				getApiKeyByIdInWorkspace: async () => ({
					id: 'key-1', key: 'sk-preview', user_id: 'user-1', workspace_id: 'personal:user-1',
					name: null, status: 'active', metadata: null, expires_at: null,
					limit_micros: null, limit_reset: null, include_byok_in_limit: false, limit_epoch: 0,
					last_used_at: null, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
				}),
			},
		} as unknown as GatewayRepositories;
		const result = await runRequestGuardrails(repositories, {
			workspaceId: 'personal:user-1', userId: 'user-1', apiKeyId: 'key-1',
			modelIds: ['openai/test'], body: { prompt: 'hello' }, correlationId: 'request-2',
			now: new Date('2026-08-31T12:00:00.000Z'),
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.budgetIntents, [{
			workspaceId: 'personal:user-1', assignmentId: 'workspace-budget:budget-1',
			guardrailId: 'workspace-budget:budget-1', guardrailVersion: 4,
			scopeType: 'workspace', scopeId: 'personal:user-1', period: 'daily',
			periodStart: '2026-08-31T00:00:00.000Z', periodEnd: '2026-09-01T00:00:00.000Z',
			limitMicros: 2_000_000,
		}]);
	});
});

describe('guardrail response boundary', () => {
	it('redacts buffered JSON before returning it', async () => {
		const result = await filterGuardrailResponse(
			Response.json({ choices: [{ message: { content: 'secret token' } }] }),
			[{ id: 'secret', pattern: 'secret', action: 'redact' }],
		);
		assert.equal(result.blockedBy, null);
		assert.equal(result.redactionCount, 1);
		assert.deepEqual(await result.response.json(), { choices: [{ message: { content: '[REDACTED:secret] token' } }] });
	});

	it('fails closed before buffering a declared oversized response', async () => {
		const response = new Response('{}', {
			headers: { 'content-type': 'application/json', 'content-length': String(GUARDRAIL_MAX_RESPONSE_BYTES + 1) },
		});
		const result = await filterGuardrailResponse(response, [{ id: 'secret', pattern: 'secret', action: 'block' }]);
		assert.equal(result.blockedBy, 'response_too_large');
		assert.equal(response.bodyUsed, false);
	});

	it('cancels an undeclared oversized response while reading the bounded prefix', async () => {
		let cancelled = false;
		let emitted = false;
		const response = new Response(new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!emitted) {
					emitted = true;
					controller.enqueue(new Uint8Array(GUARDRAIL_MAX_RESPONSE_BYTES));
					return;
				}
				controller.enqueue(new Uint8Array([0x7b]));
			},
			cancel() {
				cancelled = true;
			},
		}), { headers: { 'content-type': 'application/json' } });

		const result = await filterGuardrailResponse(response, [{ id: 'secret', pattern: 'secret', action: 'block' }]);
		assert.equal(result.blockedBy, 'response_too_large');
		assert.equal(cancelled, true);
	});

	it('fails closed for non-JSON and malformed JSON outputs', async () => {
		const unsupported = await filterGuardrailResponse(new Response('secret', { headers: { 'content-type': 'text/plain' } }), [{ id: 'secret', pattern: 'secret', action: 'block' }]);
		assert.equal(unsupported.blockedBy, 'unsupported_response_type');
		const malformed = await filterGuardrailResponse(new Response('{', { headers: { 'content-type': 'application/json' } }), [{ id: 'secret', pattern: 'secret', action: 'block' }]);
		assert.equal(malformed.blockedBy, 'invalid_json_response');
	});
});
