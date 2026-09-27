import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { GuardrailBudgetIntent, PostgresDatabaseClient } from '@octafuse/core';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';
import {
	admitPostgresCompleteChatQuoteV361,
	PostgresCompleteChatAdmissionCleanupUnconfirmedError,
} from './postgres-complete-chat-admission-v361';

const expiresAt = new Date(Date.now() + 60_000).toISOString();
const quote: CompleteFlatTextQuoteV360 = Object.freeze({
	quoteId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
	requestId: 'request-complete-admission',
	finalBodySha256: 'a'.repeat(64),
	modelIds: Object.freeze(['model-a']),
	routeCount: 1,
	credentialClass: 'platform',
	maxPerAttemptCeilingMicros: 12_000,
	threeAttemptCeilingMicros: 36_000,
	expiresAt,
});
const intents: GuardrailBudgetIntent[] = [{
	workspaceId: 'workspace-a', assignmentId: 'assignment-a', guardrailId: 'guardrail-a',
	guardrailVersion: 1, scopeType: 'user', scopeId: 'user-a', period: 'daily',
	periodStart: '2026-09-25T00:00:00.000Z', periodEnd: '2026-09-26T00:00:00.000Z',
	limitMicros: 200_000,
}];

function harness(options: {
	role?: string;
	value?: unknown;
	closeFails?: boolean;
} = {}) {
	const events: string[] = [];
	const calls: Array<{ query: string; params?: unknown[] }> = [];
	const value = options.value ?? {
		status: 'admitted', quoteId: quote.quoteId,
		finalBodySha256: quote.finalBodySha256, reservedMicros: 36_000,
		ordinary: 'reserved', guardrailCount: 1, expiresAt,
	};
	const sql = {
		json(value: unknown) { return value; },
		async unsafe(query: string, params?: unknown[]) {
			calls.push({ query, params });
			if (query.startsWith('SELECT current_user')) {
				const role = options.role ?? 'cinatoken_gateway_budget_admission';
				return [{ current_role: role, session_role: role }];
			}
			if (query.includes('admit_complete_flat_text_quote_v361')) return [{ value }];
			throw new Error('Unexpected SQL');
		},
		async begin<T>(callback: (tx: unknown) => Promise<T>) {
			events.push('begin');
			const result = await callback(this);
			events.push('commit');
			return result;
		},
		async end() {
			events.push('close');
			if (options.closeFails) throw new Error('close ACK lost');
		},
	};
	const runtime = { async unsafe() {
		return [{ current_role: 'cinatoken_gateway_runtime',
			session_role: 'cinatoken_gateway_runtime' }];
	} };
	const run = () => admitPostgresCompleteChatQuoteV361({
		runtimeClient: { driver: 'postgres', raw: runtime } as unknown as PostgresDatabaseClient,
		runtimeConnectionString: 'postgres://runtime:secret@localhost/gateway',
		admissionConnectionString: 'postgres://admission:secret@localhost/gateway',
		quote, guardrailIntents: intents,
	}, () => sql as unknown as PostgresDatabaseClient['raw']);
	return { run, calls, events };
}

it('admits only the committed quote ID and Guardrail intents, with no caller amount', async () => {
	const h = harness();
	const result = await h.run();
	assert.equal(result.reservedMicros, quote.threeAttemptCeilingMicros);
	assert.deepEqual(h.events, ['begin', 'commit', 'close']);
	assert.equal(h.calls.length, 2);
	assert.deepEqual(h.calls[1]?.params, [quote.requestId, quote.quoteId, intents]);
	assert.equal(h.calls[1]?.params?.some(value => typeof value === 'number'), false);
});

it('rejects an underheld DB result before COMMIT', async () => {
	const h = harness({ value: { status: 'admitted', quoteId: quote.quoteId,
		finalBodySha256: quote.finalBodySha256, reservedMicros: 35_999,
		ordinary: 'reserved', guardrailCount: 1, expiresAt } });
	await assert.rejects(h.run(), /differs from quoted request/);
	assert.deepEqual(h.events, ['begin', 'close']);
});

it('keeps ordinary hold status on an exact idempotent replay', async () => {
	const h = harness({ value: { status: 'idempotent', quoteId: quote.quoteId,
		finalBodySha256: quote.finalBodySha256, reservedMicros: 36_000,
		ordinary: 'unlimited', guardrailCount: 1, expiresAt } });
	const result = await h.run();
	assert.equal(result.status, 'idempotent');
	assert.equal(result.ordinary, 'unlimited');
});

it('rejects a wrong admission LOGIN before calling v361', async () => {
	const h = harness({ role: 'cinatoken_gateway_runtime' });
	await assert.rejects(h.run(), /LOGIN mismatch/);
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.events, ['begin', 'close']);
});

it('treats an unacknowledged close after COMMIT as unsafe', async () => {
	const h = harness({ closeFails: true });
	await assert.rejects(h.run(), PostgresCompleteChatAdmissionCleanupUnconfirmedError);
	assert.deepEqual(h.events, ['begin', 'commit', 'close']);
});
