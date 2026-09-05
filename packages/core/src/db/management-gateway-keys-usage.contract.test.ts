import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMySqlApiKeysRepository } from './mysql/api-keys.impl';
import { createPostgresApiKeysRepository } from './postgres/api-keys.impl';
import type {
	MySqlDatabaseClient,
	PostgresDatabaseClient,
} from '../storage/database-client';

const usageRow = {
	id: 'key-1',
	key_hash: `sha256:${'a'.repeat(64)}`,
	key_preview: 'sk-test…1234',
	user_id: 'user-1',
	workspace_id: 'personal:user-1',
	name: 'Production',
	status: 'active',
	expires_at: null,
	limit_micros: null,
	limit_reset: null,
	include_byok_in_limit: false,
	limit_epoch: 0,
	limit_consumed_micros: '1250000',
	created_at: '2026-09-03T00:00:00.000Z',
	updated_at: '2026-09-03T00:00:00.000Z',
	usage: '1.25',
	usage_daily: '0.25',
	usage_weekly: '0.50',
	usage_monthly: '0.75',
	byok_usage: '4.00',
	byok_usage_daily: '1.00',
	byok_usage_weekly: '2.00',
	byok_usage_monthly: '3.00',
};

describe('Management Gateway key BYOK usage SQL contracts', () => {
	it('projects and maps PostgreSQL BYOK standard-cost windows', async () => {
		let query = '';
		const raw = {
			unsafe: async (sql: string) => {
				query = sql;
				return [usageRow];
			},
		};
		const repository = createPostgresApiKeysRepository({
			driver: 'postgres',
			raw,
			drizzle: {},
		} as unknown as PostgresDatabaseClient);

		const row = await repository.getCurrentById('key-1');
		assert.match(query, /SUM\(log\.standard_cost\)[\s\S]+log\.is_byok IS TRUE/u);
		assert.match(query, /date_trunc\('week', CURRENT_TIMESTAMP\)/u);
		assert.match(query, /budget_window\.unreserved_micros \+ budget_window\.settled_micros/u);
		assert.equal(row?.limit_consumed_micros, 1_250_000);
		assert.equal(row?.byok_usage, 4);
		assert.equal(row?.byok_usage_daily, 1);
		assert.equal(row?.byok_usage_weekly, 2);
		assert.equal(row?.byok_usage_monthly, 3);
	});

	it('projects and maps MySQL BYOK standard-cost windows', async () => {
		let query = '';
		const raw = {
			execute: async (sql: string) => {
				query = sql;
				return [[{ ...usageRow, include_byok_in_limit: 0 }], {}];
			},
		};
		const repository = createMySqlApiKeysRepository({
			driver: 'mysql',
			raw,
			drizzle: {},
		} as unknown as MySqlDatabaseClient);

		const row = await repository.getCurrentById('key-1');
		assert.match(query, /SUM\(log\.standard_cost\)[\s\S]+log\.is_byok = 1/u);
		assert.match(query, /WEEKDAY\(UTC_DATE\(\)\)/u);
		assert.match(query, /budget_window\.unreserved_micros \+ budget_window\.settled_micros/u);
		assert.equal(row?.limit_consumed_micros, 1_250_000);
		assert.equal(row?.byok_usage, 4);
		assert.equal(row?.byok_usage_daily, 1);
		assert.equal(row?.byok_usage_weekly, 2);
		assert.equal(row?.byok_usage_monthly, 3);
	});
});
