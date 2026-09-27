import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { D1DatabaseClient } from '../../storage/database-client';
import { createD1PortalLedgerRepository, createD1SharedKeysRepository } from './portal-marketplace.impl';

function repository(database: DatabaseSync) {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return {
				bind(...values: unknown[]): D1PreparedStatement {
					return {
						async first<T>(): Promise<T | null> {
							return (database.prepare(sql).get(...values as SQLInputValue[]) ?? null) as T | null;
						},
						async run(): Promise<D1Result> {
							const result = database.prepare(sql).run(...values as SQLInputValue[]);
							return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result;
						},
					} as D1PreparedStatement;
				},
			} as D1PreparedStatement;
		},
	} as D1Database;
	const client = { driver: 'd1' as const, raw, drizzle: {} as D1DatabaseClient['drizzle'] };
	return {
		ledger: createD1PortalLedgerRepository(client),
		keys: createD1SharedKeysRepository(client),
	};
}

test('shared-key usage rebuild assigns committed earning totals and recovers after a failed update', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`
			CREATE TABLE shared_keys (
				id TEXT PRIMARY KEY, served_input_tokens INTEGER NOT NULL DEFAULT 0,
				served_output_tokens INTEGER NOT NULL DEFAULT 0, earned_total REAL NOT NULL DEFAULT 0,
				last_used_at TEXT, updated_at TEXT
			);
			CREATE TABLE shared_key_earnings (
				id TEXT PRIMARY KEY, request_log_id TEXT NOT NULL UNIQUE, shared_key_id TEXT NOT NULL,
				seller_user_id TEXT NOT NULL DEFAULT 'seller-1',
				input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
				cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
				gross_amount REAL NOT NULL DEFAULT 0, platform_fee REAL NOT NULL DEFAULT 0,
				net_amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', created_at TEXT NOT NULL
			);
			INSERT INTO shared_keys VALUES ('k1', 999, 999, 999, NULL, NULL);
			INSERT INTO shared_key_earnings(id,request_log_id,shared_key_id,input_tokens,output_tokens,net_amount,created_at) VALUES
				('e1', 'r1', 'k1', 10, 20, 1.25, '2026-09-01T00:00:00.000Z'),
				('e2', 'r2', 'k1', 30, 40, 2.75, '2026-09-02T00:00:00.000Z');
		`);
		const { ledger, keys } = repository(database);
		const detail = await ledger.getEarningByRequestLogId('r1');
		assert.equal(detail?.sharedKeyId, 'k1');
		assert.equal(detail?.sellerUserId, 'seller-1');
		assert.equal(detail?.netAmount, 1.25);
		assert.equal(await ledger.getEarningByRequestLogId('missing'), null);
		const projection = () => ({ ...database.prepare(`SELECT served_input_tokens AS input,
			served_output_tokens AS output, earned_total AS net, last_used_at AS lastUsedAt
			FROM shared_keys WHERE id = 'k1'`).get() });
		const expected = {
			input: 40, output: 60, net: 4,
			lastUsedAt: '2026-09-02T00:00:00.000Z',
		};
		await ledger.rebuildSharedKeyUsageFromEarnings('r1', 'k1', '2026-09-03T00:00:00.000Z');
		assert.deepEqual(projection(), expected);
		assert.equal(await keys.addSharedKeyUsage('k1', 10, 20, 1.25, '2026-09-03T00:00:00.000Z', {
			servedInputTokens: 999, servedOutputTokens: 999, earnedTotalExact: '999',
		}), false);
		assert.deepEqual(projection(), expected);
		await ledger.rebuildSharedKeyUsageFromEarnings('r1', 'k1', '2026-09-03T00:00:00.000Z');
		assert.deepEqual(projection(), expected);

		await assert.rejects(ledger.rebuildSharedKeyUsageFromEarnings('r1', 'wrong-key', '2026-09-03T00:00:00.000Z'),
			/shared_key_usage_rebuild_earning_or_key_missing_or_mismatched/);
		await assert.rejects(ledger.rebuildSharedKeyUsageFromEarnings('missing', 'k1', '2026-09-03T00:00:00.000Z'),
			/shared_key_usage_rebuild_earning_or_key_missing_or_mismatched/);
		assert.deepEqual(projection(), expected);

		database.exec(`INSERT INTO shared_key_earnings(id,request_log_id,shared_key_id,input_tokens,output_tokens,net_amount,created_at) VALUES
			('e3', 'r3', 'k1', 5, 7, 0.5, '2026-09-04T00:00:00.000Z');
			CREATE TRIGGER fail_summary BEFORE UPDATE ON shared_keys
			BEGIN SELECT RAISE(ABORT, 'summary unavailable'); END;`);
		await assert.rejects(ledger.rebuildSharedKeyUsageFromEarnings('r3', 'k1', '2026-09-05T00:00:00.000Z'),
			/summary unavailable/);
		assert.deepEqual(projection(), expected);
		database.exec('DROP TRIGGER fail_summary');
		await ledger.rebuildSharedKeyUsageFromEarnings('r3', 'k1', '2026-09-05T00:00:00.000Z');
		assert.deepEqual(projection(), {
			input: 45, output: 67, net: 4.5,
			lastUsedAt: '2026-09-04T00:00:00.000Z',
		});
		assert.equal(await keys.addSharedKeyUsage('k1', 0, 0, 0, '2026-09-05T00:00:00.000Z', {
			servedInputTokens: 45, servedOutputTokens: 67, earnedTotalExact: '4.5',
		}), true);
	} finally {
		database.close();
	}
});
