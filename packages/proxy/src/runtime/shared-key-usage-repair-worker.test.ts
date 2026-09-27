import assert from 'node:assert/strict';
import test from 'node:test';
import {
	runSharedKeyUsageRepairClient,
	runWorkerSharedKeyUsageRepair,
	type RepairClient,
} from './shared-key-usage-repair-worker';

const authorized = Object.freeze({
	current_role: 'cinatoken_gateway_shared_key_usage_repair_consumer',
	session_role: 'cinatoken_gateway_shared_key_usage_repair_consumer',
	transaction_timeout_ms: '30000',
	statement_timeout_ms: '15000',
	lock_timeout_ms: '5000',
	idle_transaction_timeout_ms: '10000',
});
const uuid = 'c5f8e3ee-3d3f-465c-8dd1-b8f02296834e';

type Item = { key: string; outcome: 'repaired' | 'deferred' | 'dead_lettered' | 'stale';
	attempts?: number } | null;
function fixture(items: Item[], roles: object[] = []): {
	client: RepairClient; transactions: string[][]; claims: () => number;
} {
	const transactions: string[][] = [];
	let claims = 0;
	let active: NonNullable<Item> | null = null;
	const client: RepairClient = {
		async begin<T>(run: (tx: { unsafe<R extends Record<string, unknown>[]>(
			query: string, parameters?: readonly unknown[]): PromiseLike<R> }) => Promise<T>): Promise<T> {
			const queries: string[] = [];
			transactions.push(queries);
			return run({
				async unsafe<R extends Record<string, unknown>[]>(query: string,
					parameters?: readonly unknown[]): Promise<R> {
					queries.push(query);
					if (query.includes('pg_catalog.pg_settings')) {
						return [roles[transactions.length - 1] ?? authorized] as unknown as R;
					}
					if (query.includes('claim_one_shared_key_usage_repair()')) {
						active = items[claims] ?? null;
						claims += 1;
						return [active === null
							? { shared_key_id: null, claim_token: null, attempt_count: 0 }
							: { shared_key_id: active.key, claim_token: uuid,
								attempt_count: active.attempts ?? 1 }] as unknown as R;
					}
					if (query.includes('finish_claimed_shared_key_usage_repair(') && active !== null) {
						assert.deepEqual(parameters, [active.key, uuid]);
						const outcome = active.outcome;
						return [{ shared_key_id: active.key, outcome,
							attempt_count: outcome === 'stale' ? 0 : active.attempts ?? 1,
							retry_at: outcome === 'deferred' ? new Date(Date.now() + 60_000) : null }] as unknown as R;
					}
					throw new Error('unexpected query');
				},
			});
		},
	};
	return { client, transactions, claims: () => claims };
}

test('each committed claim has a separate finish transaction; no candidate stops', async () => {
	const f = fixture([{ key: 'key-a', outcome: 'repaired' },
		{ key: 'key-b', outcome: 'repaired' }, null]);
	const result = await runSharedKeyUsageRepairClient(f.client,
		{ maxItems: 5, admissionBudgetMs: 1000 });
	assert.deepEqual(result, { processed: 2, repaired: 2, deferred: 0,
		deadLettered: 0, cancelled: 0, stale: 0, stopReason: 'no_candidate' });
	assert.equal(f.claims(), 3);
	assert.equal(f.transactions.length, 5);
	for (const queries of f.transactions) {
		assert.equal(queries.length, 2);
		assert.match(queries[0]!, /session_user AS session_role/);
	}
	assert.match(f.transactions[0]![1]!, /claim_one_shared_key_usage_repair/);
	assert.match(f.transactions[1]![1]!, /finish_claimed_shared_key_usage_repair/);
});

test('item and admission limits stop new claims after finishing admitted work', async () => {
	const capped = fixture([{ key: 'a', outcome: 'repaired' },
		{ key: 'b', outcome: 'repaired' }, { key: 'c', outcome: 'repaired' }]);
	assert.deepEqual(await runSharedKeyUsageRepairClient(capped.client,
		{ maxItems: 2, admissionBudgetMs: 1000 }),
	{ processed: 2, repaired: 2, deferred: 0, deadLettered: 0, cancelled: 0,
		stale: 0, stopReason: 'item_limit' });
	assert.equal(capped.claims(), 2);
	const timed = fixture([{ key: 'a', outcome: 'repaired' },
		{ key: 'b', outcome: 'repaired' }]);
	const ticks = [0, 0, 5];
	assert.deepEqual(await runSharedKeyUsageRepairClient(timed.client,
		{ maxItems: 2, admissionBudgetMs: 5 }, () => ticks.shift()!),
	{ processed: 1, repaired: 1, deferred: 0, deadLettered: 0, cancelled: 0,
		stale: 0, stopReason: 'admission_budget' });
	assert.equal(timed.claims(), 1);
});

test('deferred, dead-lettered and stale finish outcomes are visible; later keys continue', async () => {
	const f = fixture([
		{ key: 'poison', outcome: 'deferred' },
		{ key: 'healthy', outcome: 'repaired' },
		{ key: 'old-poison', outcome: 'dead_lettered', attempts: 5 },
		{ key: 'lost-lease', outcome: 'stale' }, null,
	]);
	assert.deepEqual(await runSharedKeyUsageRepairClient(f.client,
		{ maxItems: 5, admissionBudgetMs: 1000 }),
	{ processed: 4, repaired: 1, deferred: 1, deadLettered: 1, cancelled: 0,
		stale: 1, stopReason: 'no_candidate' });
});

test('role and server deadlines are checked before both privileged transactions', async () => {
	const wrongRole = fixture([{ key: 'a', outcome: 'repaired' }],
		[{ ...authorized, session_role: 'cinatoken_gateway_runtime' }]);
	await assert.rejects(runSharedKeyUsageRepairClient(wrongRole.client),
		/Dedicated shared-key usage repair LOGIN/);
	assert.equal(wrongRole.claims(), 0);
	const drift = fixture([{ key: 'a', outcome: 'repaired' }],
		[authorized, { ...authorized, statement_timeout_ms: null }]);
	await assert.rejects(runSharedKeyUsageRepairClient(drift.client),
		/Dedicated shared-key usage repair LOGIN/);
	assert.equal(drift.claims(), 1);
	assert.deepEqual(drift.transactions.map(queries => queries.length), [2, 1]);
});

test('known server statement timeout is counted and the same tick claims a healthy key', async () => {
	let claims = 0;
	const client: RepairClient = {
		async begin<T>(run: (tx: { unsafe<R extends Record<string, unknown>[]>(
			query: string): PromiseLike<R> }) => Promise<T>): Promise<T> {
			return run({
				async unsafe<R extends Record<string, unknown>[]>(query: string): Promise<R> {
					if (query.includes('pg_catalog.pg_settings')) return [authorized] as unknown as R;
					if (query.includes('claim_one_shared_key_usage_repair')) {
						claims += 1;
						return [claims === 1
							? { shared_key_id: 'bad', claim_token: uuid, attempt_count: 1 }
							: claims === 2
								? { shared_key_id: 'healthy', claim_token: uuid, attempt_count: 1 }
								: { shared_key_id: null, claim_token: null, attempt_count: 0 }] as unknown as R;
					}
					if (query.includes('finish_claimed_shared_key_usage_repair')) {
						if (claims === 1) throw Object.assign(
							new Error('canceling statement due to statement timeout'), { code: '57014' });
						return [{ shared_key_id: 'healthy', outcome: 'repaired',
							attempt_count: 1, retry_at: null }] as unknown as R;
					}
					throw new Error('unexpected query');
				},
			});
		},
	};
	assert.deepEqual(await runSharedKeyUsageRepairClient(client,
		{ maxItems: 3, admissionBudgetMs: 1000 }),
	{ processed: 2, repaired: 1, deferred: 0, deadLettered: 0,
		cancelled: 1, stale: 0, stopReason: 'no_candidate' });
	assert.equal(claims, 3);
});

test('external cancellation with the same SQLSTATE is propagated', async () => {
	let claims = 0;
	const client: RepairClient = {
		async begin<T>(run: (tx: { unsafe<R extends Record<string, unknown>[]>(
			query: string): PromiseLike<R> }) => Promise<T>): Promise<T> {
			return run({
				async unsafe<R extends Record<string, unknown>[]>(query: string): Promise<R> {
					if (query.includes('pg_catalog.pg_settings')) return [authorized] as unknown as R;
					if (query.includes('claim_one_shared_key_usage_repair')) {
						claims += 1;
						return [{ shared_key_id: 'bad', claim_token: uuid,
							attempt_count: 1 }] as unknown as R;
					}
					throw Object.assign(new Error('canceling statement due to user request'),
						{ code: '57014' });
				},
			});
		},
	};
	await assert.rejects(runSharedKeyUsageRepairClient(client),
		(error: unknown) => (error as { code?: string }).code === '57014');
	assert.equal(claims, 1);
});

test('ambiguous COMMIT acknowledgement with 57014 is propagated', async () => {
	let transactions = 0;
	const client: RepairClient = {
		async begin<T>(run: (tx: { unsafe<R extends Record<string, unknown>[]>(
			query: string): PromiseLike<R> }) => Promise<T>): Promise<T> {
			transactions += 1;
			const value = await run({
				async unsafe<R extends Record<string, unknown>[]>(query: string): Promise<R> {
					if (query.includes('pg_catalog.pg_settings')) return [authorized] as unknown as R;
					if (query.includes('claim_one_shared_key_usage_repair')) {
						return [{ shared_key_id: 'bad', claim_token: uuid,
							attempt_count: 1 }] as unknown as R;
					}
					return [{ shared_key_id: 'bad', outcome: 'repaired',
						attempt_count: 1, retry_at: null }] as unknown as R;
				},
			});
			if (transactions === 2) throw Object.assign(
				new Error('canceling statement due to statement timeout'), { code: '57014' });
			return value;
		},
	};
	await assert.rejects(runSharedKeyUsageRepairClient(client),
		(error: unknown) => (error as { code?: string }).code === '57014');
	assert.equal(transactions, 2);
});

test('shipped Cron stays disabled and v2 activation is rejected', async () => {
	const controller = { cron: '17 * * * *' };
	assert.deepEqual(await runWorkerSharedKeyUsageRepair(controller, {}),
		{ processed: 0, repaired: 0, deferred: 0, deadLettered: 0, cancelled: 0,
			stale: 0, stopReason: 'disabled' });
	for (const activation of ['true', 'reviewed-v1', 'reviewed-v2']) {
		await assert.rejects(runWorkerSharedKeyUsageRepair(controller,
			{ SHARED_KEY_USAGE_REPAIR_ENABLED: activation }),
			/Invalid shared-key usage repair activation/);
	}
	await assert.rejects(runWorkerSharedKeyUsageRepair(controller,
		{ SHARED_KEY_USAGE_REPAIR_ENABLED: 'reviewed-v3', DATABASE_DRIVER: 'd1' }),
		/requires PostgreSQL/);
	await assert.rejects(runWorkerSharedKeyUsageRepair(controller,
		{ SHARED_KEY_USAGE_REPAIR_ENABLED: 'reviewed-v3', DATABASE_DRIVER: 'postgres' }),
		/Dedicated REPAIR_HYPERDRIVE/);
});
