import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { GatewayRepositories, McpCallableItem } from '@octafuse/core';
import type { ApiKeyContext } from '../../middleware/auth';
import { prepareMcpInvocation } from './invocation';
const apiKey = {
	keyId: 'key',
	workspaceId: 'workspace',
	userId: 'user',
	budgetMax: 10,
	budgetEpoch: 7,
} as ApiKeyContext;
const item = { slug: 'test', upstreamKey: 'ask', timeoutMs: 1000, maxResponseBytes: 1024 } as McpCallableItem;
function fixture(deny = false) {
	const calls: string[] = [];
	const repos = {
		client: { driver: 'd1', raw: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) } },
		apiKeys: {
			getApiKeyByIdInWorkspace: async () => ({
				id: 'key',
				user_id: 'user',
				workspace_id: 'workspace',
				limit_micros: null,
				limit_reset: null,
				include_byok_in_limit: false,
				limit_epoch: 0,
			}),
		},
		guardrails: { getEffectiveForRequest: async () => [] },
		userAuditLogs: { insertUserAuditLog: async () => undefined },
		userBudgets: {
			expireBefore: async () => 0,
			reserve: async (params: {
				requestId: string;
				userId: string;
				apiKeyId: string;
				expectedBudgetEpoch: number;
				reservedMicros: number;
			}) => {
				calls.push('reserve');
				if (deny) return { status: 'insufficient', availableMicros: 0 };
				return {
					status: 'reserved',
					reservation: {
						requestId: params.requestId,
						userId: params.userId,
						apiKeyId: params.apiKeyId,
						budgetEpoch: params.expectedBudgetEpoch,
						reservedMicros: params.reservedMicros,
						limitMicros: 10_000_000,
					},
				};
			},
			markDispatched: async () => {
				calls.push('dispatch');
				return true;
			},
			release: async () => {
				calls.push('release');
				return 1;
			},
			forfeitDispatched: async () => {
				calls.push('forfeit');
				return 1;
			},
		},
	} as unknown as GatewayRepositories;
	const fetchImpl: typeof fetch = async () => {
		calls.push('fetch');
		return Response.json({ result: 'ok' });
	};
	return { repos, calls, fetchImpl };
}
it('MCP pre-dispatch termination releases its ordinary reservation without network work', async () => {
	const f = fixture();
	const invocation = await prepareMcpInvocation(
		f.repos,
		apiKey,
		item,
		{ query: 'test' },
		1,
		new Request('https://gateway.test/mcp'),
		f.fetchImpl,
	);
	const settlement = invocation.settlement('actual', 'test');
	assert.equal(settlement.userBudgetSettlement?.budgetEpoch, 7);
	assert.equal(settlement.userBudgetSettlement?.reservedMicros, 1_000_000);
	assert.equal(settlement.requestLogId, settlement.userBudgetSettlement?.requestId);
	await invocation.terminate('local_reject');
	assert.deepEqual(f.calls, ['reserve', 'release']);
});
it('MCP owned dispatch marks the durable lease before fetch and forfeits unknown outcomes', async () => {
	const f = fixture();
	const invocation = await prepareMcpInvocation(
		f.repos,
		apiKey,
		item,
		{},
		1,
		new Request('https://gateway.test/mcp'),
		f.fetchImpl,
	);
	const value = await invocation.run(async (ownedFetch) =>
		(await ownedFetch('https://mcp.test', { method: 'POST', body: '{}' })).json(),
	);
	assert.deepEqual(value, { result: 'ok' });
	assert.deepEqual(f.calls, ['reserve', 'dispatch', 'fetch']);
	assert.equal(invocation.settlement('reserved', 'unknown').userBudgetSettlement?.mode, 'reserved');
	await invocation.terminate('unknown');
	assert.deepEqual(f.calls, ['reserve', 'dispatch', 'fetch', 'forfeit']);
});
it('MCP cannot dispatch when ordinary admission denies the request', async () => {
	const f = fixture(true);
	await assert.rejects(
		prepareMcpInvocation(f.repos, apiKey, item, {}, 1, new Request('https://gateway.test/mcp'), f.fetchImpl),
	);
	assert.deepEqual(f.calls, ['reserve']);
});
