import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { D1DatabaseClient } from '../../storage/database-client';
import { createD1PortalLedgerRepository, createD1SharedKeysRepository } from './portal-marketplace.impl';

test('D1 withdrawal readers preserve owner, exact amounts, nullable chain fields and stable pages', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`CREATE TABLE withdrawals (
			id TEXT PRIMARY KEY, user_id TEXT, amount REAL, fee REAL, net_amount REAL, currency TEXT,
			wallet_address TEXT, status TEXT, token_amount REAL, tx_hash TEXT, chain_id INTEGER,
			failure_reason TEXT, created_at TEXT, updated_at TEXT, confirmed_at TEXT
		);
		INSERT INTO withdrawals VALUES
			('w1', 'seller-1', 10.125001, 0.125001, 10, 'USD', 'wallet-1', 'requested', 30.5, NULL, NULL, NULL,
			 '2026-09-01T00:00:00.000Z', '2026-09-01T01:00:00.000Z', NULL),
			('w2', 'seller-1', 12.5, 0.5, 12, 'CNY', 'wallet-2', 'failed', NULL, 'tx-2', 84532, 'chain failed',
			 '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', NULL),
			('w3', 'seller-2', 20, 1, 19, 'USD', 'wallet-3', 'confirmed', 57, 'tx-3', 8453, NULL,
			 '2026-09-03T00:00:00.000Z', '2026-09-03T01:00:00.000Z', '2026-09-03T01:00:00.000Z');`);
		const { ledger } = repository(database);
		const expected = {
			id: 'w1', userId: 'seller-1', amount: 10.125001, fee: 0.125001, netAmount: 10,
			currency: 'USD', walletAddress: 'wallet-1', status: 'requested', tokenAmount: 30.5,
			txHash: null, chainId: null, failureReason: null, createdAt: '2026-09-01T00:00:00.000Z',
			updatedAt: '2026-09-01T01:00:00.000Z', confirmedAt: null,
		};
		assert.deepEqual(await ledger.getWithdrawal('w1'), expected);
		assert.deepEqual(await ledger.getActiveWithdrawalByUser('seller-1'), expected);
		assert.equal(await ledger.getActiveWithdrawalByUser('seller-2'), null);
		assert.equal(await ledger.getWithdrawal('missing'), null);
		const first = await ledger.listWithdrawalsByUser('seller-1', 1, 1);
		assert.equal(first.total, 2);
		assert.equal(first.rows[0].id, 'w2');
		assert.equal(first.rows[0].tokenAmount, null);
		assert.equal(first.rows[0].chainId, 84532);
		assert.equal(first.rows[0].failureReason, 'chain failed');
		assert.equal(first.rows[0].currency, 'CNY');
		assert.deepEqual(await ledger.listWithdrawalsByUser('seller-1', 2, 1), { rows: [expected], total: 2 });
		assert.deepEqual(await ledger.listWithdrawalsByUser('missing', 1, 20), { rows: [], total: 0 });
		assert.deepEqual(await ledger.listAllWithdrawals('requested'), [expected]);
		const all = await ledger.listAllWithdrawals();
		assert.equal(all.length, 3);
		assert.equal(all[0].userId, 'seller-2');
		assert.equal(all[0].confirmedAt, '2026-09-03T01:00:00.000Z');
	} finally { database.close(); }
});

test('D1 wallet verification atomically rejects replay and stale challenges without changing the ledger', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`CREATE TABLE user_earnings (
			user_id TEXT PRIMARY KEY, wallet_address TEXT, wallet_verified_at TEXT, updated_at TEXT,
			balance REAL, locked_amount REAL
		); INSERT INTO user_earnings VALUES ('seller-1', NULL, NULL, NULL, 12.125001, 3.5);`);
		const { ledger } = repository(database);
		const issued = '2026-09-01T00:00:00.000Z';
		const verified = '2026-09-01T00:00:01.000Z';
		assert.equal(await ledger.updateWalletIfChallengeUnused('seller-1', 'wallet-1', verified, issued), true);
		const current = () => ({ ...database.prepare('SELECT * FROM user_earnings').get() });
		const accepted = current();
		assert.equal(accepted.wallet_address, 'wallet-1');
		assert.equal(accepted.balance, 12.125001);
		assert.equal(accepted.locked_amount, 3.5);
		assert.equal(await ledger.updateWalletIfChallengeUnused('seller-1', 'replayed-wallet', '2026-09-01T00:00:02.000Z', issued), false);
		assert.equal(await ledger.updateWalletIfChallengeUnused('seller-1', 'same-cutoff', '2026-09-01T00:00:02.000Z', verified), false);
		assert.deepEqual(current(), accepted);
		assert.equal(await ledger.updateWalletIfChallengeUnused('missing', 'wallet-x', verified, issued), false);
		assert.equal(await ledger.updateWalletIfChallengeUnused('seller-1', 'wallet-2', '2026-09-01T00:00:04.000Z', '2026-09-01T00:00:03.000Z'), true);
		assert.equal(current().wallet_address, 'wallet-2');
		assert.equal(await ledger.updateWalletIfChallengeUnused('seller-1', 'stale-wallet', '2026-09-01T00:00:05.000Z', issued), false);
		assert.equal(current().wallet_address, 'wallet-2');
	} finally { database.close(); }
});

function repository(database: DatabaseSync) {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return {
				async all<T>(): Promise<D1Result<T>> {
					return { success: true, results: database.prepare(sql).all() } as D1Result<T>;
				},
				bind(...values: unknown[]): D1PreparedStatement {
					return {
						async first<T>(): Promise<T | null> {
							return (database.prepare(sql).get(...values as SQLInputValue[]) ?? null) as T | null;
						},
						async run(): Promise<D1Result> {
							const result = database.prepare(sql).run(...values as SQLInputValue[]);
							return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result;
						},
						async all<T>(): Promise<D1Result<T>> {
							return { success: true, results: database.prepare(sql).all(...values as SQLInputValue[]) } as D1Result<T>;
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

test('D1 earnings pages preserve camelCase ownership, token counts, and recorded decimal amounts', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`CREATE TABLE shared_key_earnings (
			id TEXT PRIMARY KEY, request_log_id TEXT, shared_key_id TEXT, seller_user_id TEXT,
			input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
			gross_amount REAL, platform_fee REAL, net_amount REAL, currency TEXT, created_at TEXT
		);
		INSERT INTO shared_key_earnings VALUES
			('e1', 'r1', 'k1', 'seller-1', 10, 20, 3, 4, 1.25, 0.25, 1, 'USD', '2026-09-01T00:00:00.000Z'),
			('e2', 'r2', 'k1', 'seller-1', 11, 21, 5, 6, 2.125, 0.125, 2, 'USD', '2026-09-01T00:00:00.000Z'),
			('e3', 'r3', 'k2', 'seller-2', 99, 99, 0, 0, 9, 1, 8, 'USD', '2026-09-02T00:00:00.000Z');`);
		const { ledger } = repository(database);
		const first = await ledger.listEarningsBySeller('seller-1', 1, 1);
		assert.equal(first.total, 2);
		assert.deepEqual(first.rows, [{
			id: 'e2', requestLogId: 'r2', sharedKeyId: 'k1', sellerUserId: 'seller-1',
			inputTokens: 11, outputTokens: 21, cacheReadTokens: 5, cacheWriteTokens: 6,
			grossAmount: 2.125, platformFee: 0.125, netAmount: 2, currency: 'USD',
			createdAt: '2026-09-01T00:00:00.000Z',
		}]);
		const second = await ledger.listEarningsBySeller('seller-1', 2, 1);
		assert.equal(second.total, 2);
		assert.equal(second.rows[0].id, 'e1');
		assert.equal(second.rows[0].grossAmount, 1.25);
		assert.deepEqual((await ledger.listEarningsBySeller('seller-1', 3, 1)).rows, []);
		assert.deepEqual(await ledger.listEarningsBySeller('missing', 1, 20), { rows: [], total: 0 });
	} finally { database.close(); }
});

test('D1 NFT lists preserve owner filtering, optional chain data, status filtering and contribution snapshots', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`CREATE TABLE nft_mints (
			id TEXT PRIMARY KEY, user_id TEXT, badge_token_id INTEGER, tier_name TEXT, wallet_address TEXT,
			status TEXT, tx_hash TEXT, chain_id INTEGER, value_snapshot REAL, failure_reason TEXT,
			created_at TEXT, confirmed_at TEXT
		);
		INSERT INTO nft_mints VALUES
			('n1', 'seller-1', 105, 'Bronze', '0xwallet1', 'pending', NULL, NULL, 10.125, NULL,
			 '2026-09-01T00:00:00.000Z', NULL),
			('n2', 'seller-2', 106, 'Silver', '0xwallet2', 'confirmed', '0xtx2', 100, 50.25, NULL,
			 '2026-09-02T00:00:00.000Z', '2026-09-02T01:00:00.000Z');`);
		const { ledger } = repository(database);
		const owned = await ledger.getNftMintsByUser('seller-1');
		assert.deepEqual(owned, [{ id: 'n1', userId: 'seller-1', badgeTokenId: 105, tierName: 'Bronze',
			walletAddress: '0xwallet1', status: 'pending', txHash: null, chainId: null,
			valueSnapshot: 10.125, failureReason: null, createdAt: '2026-09-01T00:00:00.000Z', confirmedAt: null }]);
		assert.deepEqual(await ledger.getNftMintsByUser('missing'), []);
		assert.deepEqual(await ledger.listAllNftMints('pending'), owned);
		const all = await ledger.listAllNftMints();
		assert.deepEqual(all.map((row) => row.id), ['n2', 'n1']);
		assert.equal(all[0].userId, 'seller-2');
		assert.equal(all[0].badgeTokenId, 106);
		assert.equal(all[0].chainId, 100);
		assert.equal(all[0].valueSnapshot, 50.25);
		assert.equal(all[0].confirmedAt, '2026-09-02T01:00:00.000Z');
	} finally { database.close(); }
});
