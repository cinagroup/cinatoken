import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { toMySqlDateTime } from './mysql/mysql2-compat';
import {
	buildRecentRoutePerformanceSamplesSql,
	MAX_ROUTE_PERFORMANCE_SAMPLES_PER_TARGET,
	normalizeRoutePerformanceSamplesPerTarget,
} from './route-performance-sampling';
import { sqlitePlaceholdersToPg } from './shared/sql-placeholders';

test('D1 sampling keeps the newest limit independently for every route target', () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`
			CREATE TABLE api_key_request_logs (
				id TEXT PRIMARY KEY,
				route_target_id TEXT NOT NULL,
				status TEXT NOT NULL,
				output_tokens INTEGER NOT NULL,
				latency_ms INTEGER,
				upstream_response_ms INTEGER,
				final_upstream_headers_ms INTEGER,
				first_reasoning_token_ms INTEGER,
				first_token_ms INTEGER,
				stream_duration_ms INTEGER,
				created_at TEXT NOT NULL
			);
			INSERT INTO api_key_request_logs VALUES
				('busy-1', 'busy', 'success', 10, 100, NULL, NULL, NULL, 100, 1000, '2026-08-30 00:01:00'),
				('busy-2', 'busy', 'success', 20, 200, NULL, NULL, NULL, 200, 1000, '2026-08-30T00:02:00.000Z'),
				('busy-3', 'busy', 'success', 30, 300, NULL, NULL, NULL, 300, 1000, '2026-08-30 00:03:00'),
				('busy-4', 'busy', 'success', 40, 400, NULL, NULL, NULL, 400, 1000, '2026-08-30T00:04:00.000Z'),
				('sparse-1', 'sparse', 'success', 15, 150, NULL, NULL, NULL, 150, 1000, '2026-08-30 00:01:30'),
				('sparse-2', 'sparse', 'success', 25, 250, NULL, NULL, NULL, 250, 1000, '2026-08-30T00:02:30.000Z'),
				('sparse-old', 'sparse', 'success', 1, 1, NULL, NULL, NULL, 1, 1000, '2026-08-29 23:59:59'),
				('sparse-error', 'sparse', 'error', 999, 999, NULL, NULL, NULL, 999, 1000, '2026-08-30 00:05:00');
		`);

		const sql = buildRecentRoutePerformanceSamplesSql('d1', 2);
		const rows = database.prepare(sql).all(
			'busy',
			'sparse',
			'2026-08-30T00:00:00.000Z',
			2,
		) as Array<{ route_target_id: string; output_tokens: number }>;

		assert.deepEqual(
			rows.map((row) => [row.route_target_id, row.output_tokens]),
			[['busy', 40], ['busy', 30], ['sparse', 25], ['sparse', 15]],
		);
	} finally {
		database.close();
	}
});

test('Postgres and MySQL sampling SQL preserve the per-target window contract', () => {
	const postgresSql = sqlitePlaceholdersToPg(buildRecentRoutePerformanceSamplesSql('postgres', 2));
	assert.match(postgresSql, /PARTITION BY route_target_id/u);
	assert.match(postgresSql, /route_target_id IN \(\$1, \$2\)/u);
	assert.match(postgresSql, /created_at >= \$3/u);
	assert.match(postgresSql, /sample_rank <= \$4/u);
	assert.match(postgresSql, /created_at::text AS created_at/u);

	const mysqlSql = buildRecentRoutePerformanceSamplesSql('mysql', 2);
	assert.match(mysqlSql, /PARTITION BY route_target_id/u);
	assert.match(mysqlSql, /route_target_id IN \(\?, \?\)/u);
	assert.match(mysqlSql, /created_at >= \?/u);
	assert.match(mysqlSql, /sample_rank <= \?/u);
	assert.equal(
		toMySqlDateTime('2026-08-30T01:02:03.456Z'),
		'2026-08-30 01:02:03.456000',
	);
});

test('per-target sample limits are safely normalized', () => {
	assert.equal(normalizeRoutePerformanceSamplesPerTarget(Number.NaN), 0);
	assert.equal(normalizeRoutePerformanceSamplesPerTarget(0), 0);
	assert.equal(normalizeRoutePerformanceSamplesPerTarget(2.9), 2);
	assert.equal(
		normalizeRoutePerformanceSamplesPerTarget(10_000),
		MAX_ROUTE_PERFORMANCE_SAMPLES_PER_TARGET,
	);
});
