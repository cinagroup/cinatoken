import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import type { PostgresGuardrailBudgetExtensionOwnerV355 } from './postgres-guardrail-budget-extension-v355';
import { openPostgresGuardrailBudgetRequestPortV356 } from './postgres-guardrail-budget-request-port-v356';

const now = new Date('2026-09-25T01:00:00.000Z');
const identity = {
	runtimeClient: { driver: 'postgres' } as PostgresDatabaseClient,
	runtimeConnectionString: 'postgres://runtime:secret@localhost/gateway',
	admissionConnectionString: 'postgres://admission:secret@localhost/gateway',
	requestId: 'request-fixed', userId: 'user-fixed', apiKeyId: 'key-fixed',
};
const keyIntent = {
	workspaceId: 'workspace-fixed', assignmentId: 'gateway-key-limit:key-fixed',
	guardrailId: 'gateway-key-limit:key-fixed', guardrailVersion: 1,
	scopeType: 'api_key' as const, scopeId: 'key-fixed', period: 'daily' as const,
	periodStart: '2026-09-25T00:00:00.000Z', periodEnd: '2026-09-26T00:00:00.000Z',
	limitMicros: 1000,
};

test('request port uses strict owner recovery and direct lifecycle for BYOK-to-paid flow', async () => {
	const calls: string[] = [];
	const owner = {
		lifecycle: {
			reserveAfterRecovery: async (values: { requestId: string; settlementBasis?: string;
				nowIso: string; expiresAtIso: string }) => {
				assert.equal(values.requestId, identity.requestId);
				assert.equal(values.settlementBasis, 'gateway_key_route');
				assert.equal(values.nowIso, now.toISOString());
				assert.equal(values.expiresAtIso, new Date(now.getTime() + 120_000).toISOString());
				calls.push('recover+reserve');
				return { status: 'reserved', reservationCount: 1 };
			},
			admission: {
				markDispatched: async (requestId: string, _nowIso: string, expiresAtIso: string) => {
					assert.equal(requestId, identity.requestId);
					assert.equal(expiresAtIso, new Date(now.getTime() + 900_000).toISOString());
					calls.push('mark');
					return true;
				},
				releaseMany: async () => { calls.push('release'); return 1; },
			},
			forfeitDispatched: async () => { calls.push('forfeit'); return 1; },
		},
		extendDispatched: async (values: { requestId: string; expiresAtIso: string }) => {
			assert.equal(values.requestId, identity.requestId);
			assert.equal(values.expiresAtIso, new Date(now.getTime() + 900_000).toISOString());
			calls.push('extend');
			return { status: 'reserved', reservationCount: 1 };
		},
		close: async () => { calls.push('close'); },
	} as unknown as PostgresGuardrailBudgetExtensionOwnerV355;
	const port = await openPostgresGuardrailBudgetRequestPortV356(identity, async () => owner);
	assert.deepEqual(await port.reserve({
		intents: [keyIntent], reservedMicros: 100, settlementBasis: 'gateway_key_route', now,
	}), { ok: true, reserved: true });
	await port.markDispatched(now);
	assert.deepEqual(await port.extend({ intents: [keyIntent], reservedMicros: 100, now }),
		{ ok: true, reserved: true });
	await port.forfeitPostDispatch('usage_unavailable_after_dispatch');
	await port.close();
	assert.deepEqual(calls, ['recover+reserve', 'mark', 'extend', 'forfeit', 'close']);
});

test('request port propagates unknown recovery and rejects unconfirmed lifecycle transitions', async () => {
	let reserveAttempts = 0;
	const owner = {
		lifecycle: {
			reserveAfterRecovery: async () => { reserveAttempts++; throw new Error('recovery COMMIT unconfirmed'); },
			admission: { markDispatched: async () => false, releaseMany: async () => 0 },
			forfeitDispatched: async () => 0,
		},
		extendDispatched: async () => { throw new Error('extension COMMIT unconfirmed'); },
		close: async () => {},
	} as unknown as PostgresGuardrailBudgetExtensionOwnerV355;
	const port = await openPostgresGuardrailBudgetRequestPortV356(identity, async () => owner);
	await assert.rejects(port.reserve({ intents: [keyIntent], reservedMicros: 100, now }),
		/recovery COMMIT unconfirmed/);
	assert.equal(reserveAttempts, 1);
	await assert.rejects(port.extend({ intents: [keyIntent], reservedMicros: 100, now }),
		/extension COMMIT unconfirmed/);
	await assert.rejects(port.markDispatched(now), /not confirmed/);
	await assert.rejects(port.releasePreDispatch('pre_send_denied'), /not confirmed/);
	await assert.rejects(port.forfeitPostDispatch('usage_unavailable_after_dispatch'), /not confirmed/);
});

test('request port snapshots authenticated identity before owner open yields', async () => {
	const mutable = { ...identity };
	const owner = { close: async () => {} } as unknown as PostgresGuardrailBudgetExtensionOwnerV355;
	let resolveOpen!: (value: PostgresGuardrailBudgetExtensionOwnerV355) => void;
	const opening = new Promise<PostgresGuardrailBudgetExtensionOwnerV355>((resolve) => {
		resolveOpen = resolve;
	});
	let factoryParams: typeof identity | undefined;
	const portPromise = openPostgresGuardrailBudgetRequestPortV356(mutable, async (fixed) => {
		factoryParams = fixed;
		return opening;
	});
	mutable.requestId = 'request-swapped';
	mutable.userId = 'user-swapped';
	mutable.apiKeyId = 'key-swapped';
	resolveOpen(owner);
	const port = await portPromise;
	assert.equal(Object.isFrozen(factoryParams), true);
	assert.deepEqual(port.identity, {
		requestId: 'request-fixed', userId: 'user-fixed', apiKeyId: 'key-fixed',
	});
	assert.equal(factoryParams?.requestId, 'request-fixed');
	await port.close();
});
