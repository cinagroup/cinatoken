import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
	assertProviderAttemptRetentionDeleteParams,
	assertProviderAttemptAvailabilityFacts,
	buildProviderAttemptRetentionDeleteSql,
	buildRouteAvailabilityAggregateSql,
	normalizeRouteAvailabilityAggregate,
	routeAvailabilityAggregateParams,
} from './provider-attempt-availability';
import { sqlitePlaceholdersToPg } from './shared/sql-placeholders';

test('D1 route availability aggregation excludes caller outcomes and preserves every window', () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`CREATE TABLE provider_attempt_availability (
			request_log_id TEXT NOT NULL,
			attempt_index INTEGER NOT NULL,
			route_target_id TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			outcome TEXT NOT NULL,
			reason TEXT NOT NULL,
			http_status INTEGER,
			observed_at TEXT NOT NULL
		)`);
		const insert = database.prepare(`INSERT INTO provider_attempt_availability
			VALUES (?, 1, ?, 'provider-1', ?, 'accepted', 200, ?)`);
		insert.run('a-1', 'route-a', 'available', '2026-08-30T11:59:00.000Z');
		insert.run('a-2', 'route-a', 'unavailable', '2026-08-30T11:58:00.000Z');
		insert.run('a-3', 'route-a', 'excluded', '2026-08-30T11:57:00.000Z');
		insert.run('a-4', 'route-a', 'available', '2026-08-30T11:00:00.000Z');
		insert.run('a-5', 'route-a', 'unavailable', '2026-08-29T13:00:00.000Z');
		insert.run('a-old', 'route-a', 'available', '2026-08-29T11:59:59.000Z');
		insert.run('b-1', 'route-b', 'available', '2026-08-30T11:59:30.000Z');

		const options = {
			routeTargetIds: ['route-a', 'route-b'],
			since5mIso: '2026-08-30T11:55:00.000Z',
			since30mIso: '2026-08-30T11:30:00.000Z',
			since1dIso: '2026-08-29T12:00:00.000Z',
		};
		const rows = database.prepare(
			buildRouteAvailabilityAggregateSql('d1', options.routeTargetIds.length),
		).all(...routeAvailabilityAggregateParams(options));
		assert.deepEqual(rows.map((row) => normalizeRouteAvailabilityAggregate(row)), [
			{
				route_target_id: 'route-a',
				available_5m: 1,
				total_5m: 2,
				available_30m: 1,
				total_30m: 2,
				available_1d: 2,
				total_1d: 4,
			},
			{
				route_target_id: 'route-b',
				available_5m: 1,
				total_5m: 1,
				available_30m: 1,
				total_30m: 1,
				available_1d: 1,
				total_1d: 1,
			},
		]);
	} finally {
		database.close();
	}
});

test('availability aggregate SQL keeps dialect placeholders and the indexed time predicate stable', () => {
	const sql = buildRouteAvailabilityAggregateSql('postgres', 2);
	const postgresSql = sqlitePlaceholdersToPg(sql);
	assert.match(postgresSql, /route_target_id IN \(\$7, \$8\)/u);
	assert.match(postgresSql, /AND observed_at >= \$9/u);
	assert.equal((buildRouteAvailabilityAggregateSql('mysql', 2).match(/\?/gu) ?? []).length, 9);
	assert.equal(routeAvailabilityAggregateParams({
		routeTargetIds: ['route-a', 'route-b'],
		since5mIso: '2026-08-30T11:55:00.000Z',
		since30mIso: '2026-08-30T11:30:00.000Z',
		since1dIso: '2026-08-29T12:00:00.000Z',
	}).length, 9);
});

test('provider attempt fact and route-query bounds fail closed', () => {
	assert.throws(
		() => buildRouteAvailabilityAggregateSql('postgres', 65),
		/route bound/u,
	);
	assert.throws(
		() => assertProviderAttemptAvailabilityFacts([{
			attemptIndex: 1,
			routeTargetId: 'route-a',
			providerId: 'provider-a',
			outcome: 'available',
			reason: 'network_error',
			httpStatus: 200,
			observedAtIso: '2026-08-30T12:00:00.000Z',
		}]),
		/outcome and reason/u,
	);
	assert.throws(
		() => assertProviderAttemptAvailabilityFacts([{
			attemptIndex: 1,
			routeTargetId: 'route-a',
			providerId: 'provider-a',
			outcome: 'available',
			reason: 'accepted',
			httpStatus: 200,
			observedAtIso: 'not-a-timestamp',
		}]),
		/fact is invalid/u,
	);
	assert.throws(
		() => assertProviderAttemptAvailabilityFacts([{
			attemptIndex: 1,
			routeTargetId: 'route-a',
			providerId: 'provider-a',
			outcome: 'unavailable',
			reason: 'provider_http_error',
			httpStatus: 200,
			observedAtIso: '2026-08-30T12:00:00.000Z',
		}]),
		/outcome and reason/u,
	);
	assert.throws(
		() => routeAvailabilityAggregateParams({
			routeTargetIds: ['route-a', 'route-a'],
			since5mIso: '2026-08-30T11:55:00.000Z',
			since30mIso: '2026-08-30T11:30:00.000Z',
			since1dIso: '2026-08-29T12:00:00.000Z',
		}),
		/options are invalid/u,
	);
	assert.doesNotThrow(() => assertProviderAttemptAvailabilityFacts([{
		attemptIndex: 1,
		routeTargetId: 'route-a',
		providerId: 'provider-a',
		outcome: 'excluded',
		reason: 'rate_limited',
		httpStatus: 429,
		observedAtIso: '2026-08-30T12:00:00.000Z',
	}]));
	assert.doesNotThrow(() => assertProviderAttemptAvailabilityFacts([{
		attemptIndex: 1,
		routeTargetId: 'route-a',
		providerId: 'provider-a',
		outcome: 'unavailable',
		reason: 'invalid_response',
		httpStatus: 200,
		observedAtIso: '2026-08-30T12:00:00.000Z',
	}]));
	assert.doesNotThrow(() => assertProviderAttemptAvailabilityFacts([{
		attemptIndex: 1,
		routeTargetId: 'route-a',
		providerId: 'provider-a',
		outcome: 'excluded',
		reason: 'client_cancelled',
		httpStatus: 200,
		observedAtIso: '2026-08-30T12:00:00.000Z',
	}]));
	assert.throws(() => assertProviderAttemptAvailabilityFacts([{
		attemptIndex: 1,
		routeTargetId: 'route-a',
		providerId: 'provider-a',
		outcome: 'unavailable',
		reason: 'invalid_response',
		httpStatus: 503,
		observedAtIso: '2026-08-30T12:00:00.000Z',
	}]), /outcome and reason/u);
});

test('provider attempt retention deletes only a bounded oldest-first batch', () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`CREATE TABLE provider_attempt_availability (
			request_log_id TEXT NOT NULL,
			attempt_index INTEGER NOT NULL,
			observed_at TEXT NOT NULL
		)`);
		const insert = database.prepare('INSERT INTO provider_attempt_availability VALUES (?, 1, ?)');
		insert.run('oldest', '1998-01-01T00:00:00.000Z');
		insert.run('older', '1999-01-01T00:00:00.000Z');
		insert.run('old', '1999-12-01T00:00:00.000Z');
		insert.run('kept', '2001-01-01T00:00:00.000Z');

		const cutoff = '2000-01-01T00:00:00.000Z';
		const result = database.prepare(buildProviderAttemptRetentionDeleteSql('d1'))
			.run(cutoff, cutoff, 2);
		assert.equal(result.changes, 2);
		assert.deepEqual(
			database.prepare('SELECT request_log_id FROM provider_attempt_availability ORDER BY observed_at')
				.all()
				.map((row) => String(row.request_log_id)),
			['old', 'kept'],
		);
		assert.match(buildProviderAttemptRetentionDeleteSql('postgres'),
			/cinatoken_gateway\.delete_provider_attempt_availability_before\(\?, \?\)/u);
		assert.match(buildProviderAttemptRetentionDeleteSql('mysql'), /INTERVAL 25 HOUR/u);
		assert.doesNotThrow(() => assertProviderAttemptRetentionDeleteParams({ cutoffIso: cutoff, limit: 5_000 }));
		assert.throws(
			() => assertProviderAttemptRetentionDeleteParams({ cutoffIso: cutoff, limit: 5_001 }),
			/parameters are invalid/u,
		);
	} finally {
		database.close();
	}
});
