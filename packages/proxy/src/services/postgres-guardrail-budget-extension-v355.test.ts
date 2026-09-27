import assert from 'node:assert/strict';
import test from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import { openPostgresGuardrailBudgetExtensionOwnerV355 } from './postgres-guardrail-budget-extension-v355';

function fakeConnection(options: {
	role?: string;
	commitLostOn?: number;
	cleanupUnconfirmed?: boolean;
	extensionResponse?: unknown;
} = {}) {
	const queries: string[] = [];
	let begins = 0;
	let closes = 0;
	const sql = {
		json: (value: unknown) => value,
		begin: async <T>(callback: (tx: {
			unsafe: (query: string, values?: unknown[]) => Promise<unknown[]>;
		}) => Promise<T>) => {
			begins += 1;
			const result = await callback({ unsafe: async query => {
				queries.push(query);
				if (query.startsWith('SELECT current_user')) {
					const role = options.role ?? 'cinatoken_gateway_budget_admission';
					return [{ current_role: role, session_role: role }];
				}
				if (query.includes('extend_guardrail_budgets_dispatched_v355')) {
					return [{ value: options.extensionResponse ?? {
						status: 'reserved', reservationCount: 1,
						leaseExpiresAt: '2026-09-25T01:15:00.000Z',
					} }];
				}
				throw new Error('Unexpected SQL');
			} });
			if (begins === options.commitLostOn) throw new Error('COMMIT acknowledgement lost');
			return result;
		},
		end: () => { closes += 1; return options.cleanupUnconfirmed
			? undefined : Promise.resolve(); },
	};
	return { sql: sql as unknown as PostgresDatabaseClient['raw'], queries,
		get begins() { return begins; }, get closes() { return closes; } };
}

function setup(extensionOptions: Parameters<typeof fakeConnection>[0] = {}) {
	const base = fakeConnection();
	const lifecycle = fakeConnection();
	const extension = fakeConnection(extensionOptions);
	let opens = 0;
	const factory = () => [base.sql, lifecycle.sql, extension.sql][opens++]!;
	const runtimeRole = 'cinatoken_gateway_runtime';
	const params = {
		runtimeClient: { driver: 'postgres', raw: {
			unsafe: async () => [{ current_role: runtimeRole, session_role: runtimeRole }],
		} } as unknown as PostgresDatabaseClient,
		runtimeConnectionString: 'postgres://runtime:secret@db.example/gateway',
		admissionConnectionString: 'postgres://admission:secret@db.example/gateway',
		requestId: 'request-one', userId: 'user-one', apiKeyId: 'key-one',
	};
	const intent = { workspaceId: 'workspace-one',
		assignmentId: 'gateway-key-limit:key-one', guardrailId: 'gateway-key-limit:key-one',
		guardrailVersion: 1, scopeType: 'api_key' as const, scopeId: 'key-one',
		period: 'daily' as const, periodStart: '2026-09-25T00:00:00.000Z',
		periodEnd: '2026-09-26T00:00:00.000Z', limitMicros: 1_000_000 };
	const values = { requestId: 'request-one', intents: [intent], reservedMicros: 100_000,
		nowIso: '2026-09-25T01:00:00.000Z',
		expiresAtIso: '2026-09-25T01:15:00.000Z' };
	return { base, lifecycle, extension, factory, params, values };
}

test('unknown extension COMMIT is surfaced once without retry', async () => {
	const fixture = setup({ commitLostOn: 2 });
	const owner = await openPostgresGuardrailBudgetExtensionOwnerV355(
		fixture.params, fixture.factory);
	await assert.rejects(owner.extendDispatched(fixture.values),
		/COMMIT acknowledgement lost/u);
	assert.equal(fixture.extension.queries.filter(query =>
		query.includes('extend_guardrail_budgets_dispatched_v355')).length, 1);
	await owner.close();
	assert.deepEqual([fixture.base.closes, fixture.lifecycle.closes,
		fixture.extension.closes], [1, 1, 1]);
});

test('preflight failure surfaces unconfirmed extension client cleanup', async () => {
	const fixture = setup({ role: 'cinatoken_gateway_runtime', cleanupUnconfirmed: true });
	await assert.rejects(openPostgresGuardrailBudgetExtensionOwnerV355(
		fixture.params, fixture.factory), /preflight cleanup unconfirmed/u);
	assert.deepEqual([fixture.base.closes, fixture.lifecycle.closes,
		fixture.extension.closes], [1, 1, 1]);
});

test('Key-only idempotent result requires a DB-attested lease covering paid dispatch', async () => {
	const short = setup({ extensionResponse: { status: 'idempotent', reservationCount: 1,
		leaseExpiresAt: '2026-09-25T01:14:59.999Z' } });
	const shortOwner = await openPostgresGuardrailBudgetExtensionOwnerV355(
		short.params, short.factory);
	await assert.rejects(shortOwner.extendDispatched(short.values), /response invalid/u);
	await shortOwner.close();

	const covered = setup({ extensionResponse: { status: 'idempotent', reservationCount: 1,
		leaseExpiresAt: '2026-09-25T01:15:00.000Z' } });
	const coveredOwner = await openPostgresGuardrailBudgetExtensionOwnerV355(
		covered.params, covered.factory);
	assert.deepEqual(await coveredOwner.extendDispatched(covered.values),
		{ status: 'idempotent', reservationCount: 1 });
	await coveredOwner.close();
});
