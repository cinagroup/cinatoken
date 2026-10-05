import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { createSqliteD1 } from '../../../proxy/src/test-support/sqlite-d1';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../route-data-policy';
import type { D1DatabaseClient, MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import { createD1RouteDataPoliciesRepository } from './d1/route-data-policies.impl';
import { createMySqlRouteDataPoliciesRepository } from './mysql/route-data-policies.impl';
import { withPolicyUtcConnection } from './mysql/route-data-policy-utc';
import type { MySqlPoolLike } from './mysql/mysql2-compat';
import { createPostgresRouteDataPoliciesRepository } from './postgres/route-data-policies.impl';
import { POLICY_COLUMNS, policyMySqlDate } from './route-data-policy-conditional-write';
import {
	RouteDataPolicyWriteConflictError,
	type RouteDataPolicyWritePrecondition,
	type UpsertRouteDataPolicyParams,
} from './route-data-policy-types';

const instant = '2026-10-01T09:00:00.123456Z';
const trust: RouteDataPolicyWritePrecondition['subjectReadSet'] = {
	route: {
		id: 'Route-A',
		provider_id: 'Provider-A',
		provider_model_name: 'upstream-model',
		upstream_protocol: 'openai',
		upstream_operation: 'chat.completions',
		adapter: 'passthrough',
		custom_params: '{"temperature":0.2}',
	},
	provider: {
		id: 'Provider-A',
		endpoints: '{"openai":"https://provider.example.invalid/v1"}',
		api_key: 'synthetic-credential',
		shared_channel_type: null,
	},
};

/** Actual SQLite execution/rollback for all repository SQL; PG/MySQL adaptation
 * does not claim native socket, collation, isolation, pooling or two-session proof. */
function fixture(driver: 'd1' | 'postgres' | 'mysql') {
	const hooks: {
		drift?: () => void;
		auditError?: boolean;
		commitError?: boolean;
		restoreError?: boolean;
		rollbackError?: boolean;
		duplicate?: boolean;
		afterCommit?: () => Promise<void>;
	} = {};
	const d1 =
		driver === 'd1'
			? createSqliteD1(
					{
						beforeStatement(sql) {
							if (/INSERT INTO route_data_policies/u.test(sql) && hooks.drift) {
								const run = hooks.drift;
								delete hooks.drift;
								run();
							}
						},
						async afterBatch() {
							if (hooks.afterCommit) {
								const run = hooks.afterCommit;
								delete hooks.afterCommit;
								await run();
							}
						},
					},
					{ applyMigrations: false },
				)
			: undefined;
	const sqlite = d1?.sqlite ?? new DatabaseSync(':memory:');
	sqlite.exec(`PRAGMA foreign_keys=ON;
		CREATE TABLE providers(id TEXT COLLATE NOCASE PRIMARY KEY,name TEXT,endpoints TEXT,api_key TEXT,shared_channel_type TEXT);
		CREATE TABLE model_routes(id TEXT COLLATE NOCASE PRIMARY KEY,provider_id TEXT,provider_model_name TEXT,upstream_protocol TEXT,upstream_operation TEXT,adapter TEXT,custom_params TEXT,model_id TEXT,route_group TEXT,created_at TEXT);
		CREATE TABLE route_data_policies(route_target_id TEXT COLLATE NOCASE PRIMARY KEY REFERENCES model_routes(id),subject_fingerprint TEXT,retention_days INTEGER,training_allowed INTEGER,zdr_supported INTEGER,evidence_url TEXT,verified_by TEXT,verified_at TEXT,expires_at TEXT,status TEXT,invalidated_at TEXT,invalidation_reason TEXT,updated_at TEXT);
		CREATE TABLE route_data_policy_audit(id TEXT PRIMARY KEY,route_target_id TEXT REFERENCES model_routes(id),snapshot_json TEXT,actor_id TEXT,created_at TEXT);`);
	sqlite
		.prepare('INSERT INTO providers VALUES(?,?,?,?,?)')
		.run(trust.provider.id, 'Provider', trust.provider.endpoints!, trust.provider.api_key!, null);
	sqlite.prepare('INSERT INTO providers VALUES(?,?,?,?,?)').run('Provider-B', 'Other', '{}', 'synthetic-other', null);
	sqlite
		.prepare('INSERT INTO model_routes VALUES(?,?,?,?,?,?,?,?,?,?)')
		.run(...(Object.values(trust.route) as SQLInputValue[]), 'Model', null, instant);
	sqlite
		.prepare('INSERT INTO model_routes VALUES(?,?,?,?,?,?,?,?,?,?)')
		.run('Route-B', 'Provider-B', 'Other', 'openai', null, null, null, 'Other', null, instant);
	sqlite.function('fixture_timestamp', (value: SQLInputValue) =>
		value === null ? null : String(value).replace(' ', 'T').replace(/Z?$/u, 'Z'),
	);
	const queries: { sql: string; params: unknown[] }[] = [],
		events: string[] = [];
	let timezone = '+08:00';
	function execute(sql: string, params: unknown[] = []) {
		queries.push({ sql, params });
		if (hooks.drift && (sql.includes('SELECT r.id') || sql.includes('INSERT INTO cinatoken_gateway.route_data_policies'))) {
			const run = hooks.drift;
			delete hooks.drift;
			run();
		}
		if (sql.includes('route_data_policy_audit') && /^INSERT/iu.test(sql.trim()) && hooks.auditError)
			throw new Error('synthetic audit failure');
		if (driver === 'mysql' && /^INSERT INTO route_data_policies/iu.test(sql.trim()) && hooks.duplicate)
			throw Object.assign(new Error('synthetic unique conflict'), { code: 'ER_DUP_ENTRY' });
		let bound = params;
		let adapted = sql
			.replaceAll('cinatoken_gateway.', '')
			.replace(/pg_catalog\.to_char\(([\s\S]*?), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'\)/gu, 'fixture_timestamp($1)')
			.replace(/ AT TIME ZONE 'UTC'/gu, '')
			.replace(/DATE_FORMAT\(([\s\S]*?), '%Y-%m-%dT%H:%i:%s.%fZ'\)/gu, 'fixture_timestamp($1)')
			.replace(/\bBINARY ((?:r\.|pr\.|p\.)?[a-z_]+|\?)/gu, '$1 COLLATE BINARY')
			.replaceAll('COLLATE "C"', 'COLLATE BINARY')
			.replaceAll('IS NOT DISTINCT FROM', 'IS')
			.replaceAll('<=>', 'IS')
			.replace(/ FOR UPDATE(?: OF r)?/gu, '')
			.replace(/UPDATE route_data_policies p /gu, 'UPDATE route_data_policies AS p ')
			.replace(/ON DUPLICATE KEY UPDATE/gu, 'ON CONFLICT(route_target_id) DO UPDATE SET')
			.replace(/VALUES\(([a-z_]+)\)/gu, 'excluded.$1');
		if (driver === 'postgres') {
			bound = [];
			adapted = adapted.replace(/\$(\d+)/gu, (_, index: string) => {
				bound.push(params[Number(index) - 1]);
				return '?';
			});
		}
		adapted = adapted.replace(/RETURNING ([\s\S]*)/u, (_, projection: string) => 'RETURNING ' + projection.replaceAll('p.', ''));
		const stmt = sqlite.prepare(adapted);
		const values = bound.map((v) => (typeof v === 'boolean' ? Number(v) : v)) as SQLInputValue[];
		if (/^SELECT/iu.test(adapted.trim()) || /RETURNING/u.test(adapted)) return stmt.all(...values);
		return { affectedRows: Number(stmt.run(...values).changes) };
	}
	const connection = {
		query: async (sql: string, params: unknown[] = []) => {
			if (sql.includes('@@session.time_zone')) {
				events.push('timezone-read');
				return [[{ policy_time_zone: timezone }], []];
			}
			if (sql.startsWith('SET SESSION')) {
				events.push('timezone:' + String(params[0]));
				if (params[0] !== '+00:00' && hooks.restoreError) throw new Error('synthetic restore failure');
				timezone = String(params[0]);
				return [[], []];
			}
			assert.equal(timezone, '+00:00');
			return [execute(sql, params), []];
		},
		execute: async (sql: string, params: unknown[] = []) => {
			assert.equal(timezone, '+00:00');
			return [execute(sql, params), []];
		},
		beginTransaction: async () => {
			events.push('begin');
			sqlite.exec('BEGIN');
		},
		commit: async () => {
			if (hooks.commitError) throw new Error('synthetic uncertain commit');
			events.push('commit');
			sqlite.exec('COMMIT');
		},
		rollback: async () => {
			events.push('rollback');
			if (hooks.rollbackError) throw new Error('synthetic rollback failure');
			if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
		},
		release: () => events.push('release'),
		destroy: () => events.push('destroy'),
	};
	const pg = {
		unsafe: async (sql: string, params: unknown[] = []) => execute(sql, params),
		typed: (value: unknown) => value,
		begin: async (run: (tx: { unsafe: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
			sqlite.exec('BEGIN');
			events.push('begin');
			try {
				const row = await run({ unsafe: pg.unsafe });
				if (hooks.commitError) throw new Error('synthetic uncertain commit');
				sqlite.exec('COMMIT');
				events.push('commit');
				return row;
			} catch (error) {
				sqlite.exec('ROLLBACK');
				events.push('rollback');
				throw error;
			}
		},
	};
	const repo =
		driver === 'd1'
			? createD1RouteDataPoliciesRepository({ raw: d1!.binding } as D1DatabaseClient)
			: driver === 'postgres'
				? createPostgresRouteDataPoliciesRepository({ raw: pg } as unknown as PostgresDatabaseClient)
				: createMySqlRouteDataPoliciesRepository({ raw: { getConnection: async () => connection } } as unknown as MySqlDatabaseClient);
	const state = () => ({
		policy: sqlite.prepare('SELECT * FROM route_data_policies ORDER BY route_target_id').all(),
		audit: sqlite.prepare('SELECT * FROM route_data_policy_audit ORDER BY id').all(),
	});
	const params = async (id = 'audit', conditional = true): Promise<UpsertRouteDataPolicyParams> => {
		const subjectFingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(trust.route, trust.provider);
		return {
			id,
			routeTargetId: 'Route-A',
			subjectFingerprint,
			retentionDays: 0,
			trainingAllowed: false,
			zdrSupported: true,
			evidenceUrl: 'https://provider.example.invalid/policy',
			verifiedBy: 'Admin',
			verifiedAt: instant,
			expiresAt: '2099-01-01T00:00:00.654321Z',
			status: 'verified',
			actorId: 'Admin',
			nowIso: instant,
			...(conditional
				? {
						precondition: {
							currentSubjectFingerprint: subjectFingerprint,
							subjectReadSet: structuredClone(trust),
							priorPolicy: await repo.getByRouteTargetId('Route-A'),
						},
					}
				: {}),
		};
	};
	return { sqlite, repo, queries, events, hooks, state, params, connection };
}

for (const driver of ['d1', 'postgres', 'mysql'] as const) {
	test(`${driver}: absent and existing CAS commit exactly one policy/audit and acknowledge the committed row`, async () => {
		const f = fixture(driver);
		try {
			const first = await f.repo.upsertWithAudit(await f.params('first'));
			assert.equal(first.verified_at, instant);
			assert.equal(first.expires_at, '2099-01-01T00:00:00.654321Z');
			const next = await f.params('second');
			next.retentionDays = 3;
			assert.equal((await f.repo.upsertWithAudit(next)).retention_days, 3);
			assert.equal(f.state().policy.length, 1);
			assert.equal(f.state().audit.length, 2);
			const list = await f.repo.listAll();
			assert.equal(list[0]?.updated_at, instant);
			assert.equal((await f.repo.getByRouteTargetId('Route-A'))?.verified_at, instant);
			if (driver !== 'postgres') assert.equal((await f.repo.getByRouteTargetIds(['Route-A']))[0]?.verified_at, instant);
			if (driver === 'mysql') assert.equal(f.events.filter((e) => e === 'destroy').length, 0);
		} finally {
			f.sqlite.close();
		}
	});
	const drift: [string, string, string | null][] = [
		['model_routes', 'id', 'route-a'],
		['model_routes', 'provider_id', 'Provider-B'],
		['model_routes', 'provider_model_name', 'UPSTREAM-model'],
		['model_routes', 'upstream_protocol', 'OPENAI'],
		['model_routes', 'upstream_operation', null],
		['model_routes', 'adapter', null],
		['model_routes', 'custom_params', '{ "temperature": 0.2 }'],
		['providers', 'id', 'provider-a'],
		['providers', 'endpoints', '{"openai":"https://different.example.invalid"}'],
		['providers', 'api_key', 'synthetic-different'],
		['providers', 'shared_channel_type', 'shared'],
	];
	for (const [table, column, value] of drift)
		test(`${driver}: commit rejects exact subject read-set drift ${table}.${column}`, async () => {
			const f = fixture(driver);
			try {
				const input = await f.params();
				f.hooks.drift = () => {
					f.sqlite.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(value, table === 'model_routes' ? 'Route-A' : 'Provider-A');
				};
				await assert.rejects(f.repo.upsertWithAudit(input), RouteDataPolicyWriteConflictError);
				assert.equal(f.state().policy.length, 0);
				assert.equal(f.state().audit.length, 0);
			} finally {
				f.sqlite.close();
			}
		});
	for (const column of POLICY_COLUMNS)
		test(`${driver}: prior policy CAS includes ${column}`, async () => {
			const f = fixture(driver);
			try {
				await f.repo.upsertWithAudit(await f.params('first'));
				const input = await f.params('second');
				const old = input.precondition!.priorPolicy![column];
				const changed =
					column === 'route_target_id'
						? 'Route-B'
						: column === 'retention_days'
							? 7
							: column === 'training_allowed'
								? 1
								: column === 'zdr_supported'
									? 0
									: column === 'status'
										? 'unknown'
										: column === 'subject_fingerprint'
											? 'b'.repeat(64)
											: column.endsWith('_at')
												? driver === 'mysql'
													? '2026-10-01 09:00:00.123457'
													: '2026-10-01T09:00:00.123457Z'
												: old === null
													? 'Changed'
													: String(old).toUpperCase();
				f.sqlite.prepare(`UPDATE route_data_policies SET ${column}=?`).run(changed);
				const before = f.state();
				await assert.rejects(f.repo.upsertWithAudit(input), RouteDataPolicyWriteConflictError);
				assert.deepEqual(f.state(), before);
			} finally {
				f.sqlite.close();
			}
		});
	test(`${driver}: absent-policy stale read cannot overwrite a newly created policy`, async () => {
		const f = fixture(driver);
		try {
			const absent = await f.params('second');
			await f.repo.upsertWithAudit(await f.params('first', false));
			const before = f.state();
			await assert.rejects(f.repo.upsertWithAudit(absent), RouteDataPolicyWriteConflictError);
			assert.deepEqual(f.state(), before);
		} finally {
			f.sqlite.close();
		}
	});
	for (const table of ['providers', 'model_routes'] as const)
		test(`${driver}: deleted ${table} cannot create a policy or audit`, async () => {
			const f = fixture(driver);
			try {
				const input = await f.params();
				f.sqlite.prepare(`DELETE FROM ${table} WHERE id=?`).run(table === 'providers' ? 'Provider-A' : 'Route-A');
				await assert.rejects(f.repo.upsertWithAudit(input), RouteDataPolicyWriteConflictError);
				assert.equal(f.state().policy.length, 0);
				assert.equal(f.state().audit.length, 0);
			} finally {
				f.sqlite.close();
			}
		});
	test(`${driver}: audit failure rolls back conditional policy; legacy remains compatible`, async () => {
		const f = fixture(driver);
		try {
			await f.repo.upsertWithAudit(await f.params('first', false));
			const before = f.state();
			f.sqlite.exec(
				`CREATE TRIGGER fixture_audit_fail BEFORE INSERT ON route_data_policy_audit WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END`,
			);
			const input = await f.params('second');
			input.retentionDays = 99;
			await assert.rejects(f.repo.upsertWithAudit(input), /fixture audit failure/u);
			assert.deepEqual(f.state(), before);
		} finally {
			f.sqlite.close();
		}
	});
	test(`${driver}: matched no-op and ABA deliberately use current value, not history`, async () => {
		const f = fixture(driver);
		try {
			await f.repo.upsertWithAudit(await f.params('first'));
			const original = await f.params('last');
			const b = await f.params('b');
			b.retentionDays = 9;
			await f.repo.upsertWithAudit(b);
			const a = await f.params('a');
			await f.repo.upsertWithAudit(a);
			assert.equal((await f.repo.upsertWithAudit(original)).retention_days, 0);
			assert.equal(f.state().audit.length, 4);
		} finally {
			f.sqlite.close();
		}
	});
	test(`${driver}: malformed or fabricated preconditions fail closed without SQL mutation`, async () => {
		const f = fixture(driver);
		try {
			await f.repo.upsertWithAudit(await f.params('first'));
			const original = await f.params('second'),
				before = f.state();
			for (const change of [
				(p: UpsertRouteDataPolicyParams) => {
					p.precondition!.currentSubjectFingerprint = 'b'.repeat(64);
					p.subjectFingerprint = 'b'.repeat(64);
				},
				(p: UpsertRouteDataPolicyParams) => {
					delete (p.precondition!.priorPolicy as Partial<NonNullable<RouteDataPolicyWritePrecondition['priorPolicy']>>).updated_at;
				},
				(p: UpsertRouteDataPolicyParams) => {
					p.precondition!.subjectReadSet.route.provider_id = 'Provider-B';
				},
				(p: UpsertRouteDataPolicyParams) => {
					p.precondition = null as unknown as RouteDataPolicyWritePrecondition;
				},
			]) {
				const input = structuredClone(original);
				change(input);
				await assert.rejects(f.repo.upsertWithAudit(input), RouteDataPolicyWriteConflictError);
				assert.deepEqual(f.state(), before);
			}
		} finally {
			f.sqlite.close();
		}
	});
	if (driver !== 'd1')
		test(`${driver}: uncertain transaction commit throws without success acknowledgement`, async () => {
			const f = fixture(driver);
			try {
				f.hooks.commitError = true;
				await assert.rejects(f.repo.upsertWithAudit(await f.params()), /uncertain commit/u);
				assert.equal(f.state().audit.length, 0);
			} finally {
				f.sqlite.close();
			}
		});
}

test('D1 conditional commit and audit rollback execute on the full formal migration chain', async () => {
	const f = createSqliteD1();
	try {
		f.sqlite.exec(`INSERT INTO models(id,display_name) VALUES('Model','Model');
			INSERT INTO providers(id,name,api_key,endpoints,shared_channel_type) VALUES('Provider-A','Provider','synthetic-credential','{"openai":"https://provider.example.invalid/v1"}',NULL);
			INSERT INTO model_routes(id,model_id,provider_id,provider_model_name,upstream_protocol,upstream_operation,adapter,custom_params)
			VALUES('Route-A','Model','Provider-A','upstream-model','openai','chat.completions','passthrough','{"temperature":0.2}');`);
		const repo = createD1RouteDataPoliciesRepository({ raw: f.binding } as D1DatabaseClient);
		const subjectFingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(trust.route, trust.provider);
		const input: UpsertRouteDataPolicyParams = {
			id: 'formal-first',
			routeTargetId: 'Route-A',
			subjectFingerprint,
			retentionDays: 0,
			trainingAllowed: false,
			zdrSupported: true,
			evidenceUrl: 'https://provider.example.invalid/policy',
			verifiedBy: 'Admin',
			verifiedAt: instant,
			expiresAt: '2099-01-01T00:00:00.654321Z',
			status: 'verified',
			actorId: 'Admin',
			nowIso: instant,
			precondition: { currentSubjectFingerprint: subjectFingerprint, subjectReadSet: structuredClone(trust), priorPolicy: null },
		};
		const row = await repo.upsertWithAudit(input);
		assert.equal(row.verified_at, instant);
		assert.equal(row.retention_days, 0);
		assert.equal((await repo.listAudit('Route-A')).length, 1);
		const prior = await repo.getByRouteTargetId('Route-A');
		f.sqlite.exec(
			`CREATE TRIGGER fixture_policy_audit_failure BEFORE INSERT ON route_data_policy_audit WHEN NEW.id='formal-fail' BEGIN SELECT RAISE(ABORT,'formal audit failure'); END`,
		);
		await assert.rejects(
			repo.upsertWithAudit({ ...input, id: 'formal-fail', retentionDays: 7, precondition: { ...input.precondition!, priorPolicy: prior } }),
			/formal audit failure/u,
		);
		assert.deepEqual(await repo.getByRouteTargetId('Route-A'), prior);
		assert.equal((await repo.listAudit('Route-A')).length, 1);
	} finally {
		f.sqlite.close();
	}
});
for (const conditional of [false, true])
	test(`D1 ${conditional ? 'conditional' : 'legacy'} acknowledgement retains writer A snapshot after writer B commits`, async () => {
		const f = fixture('d1');
		try {
			const input = await f.params('writer-a', conditional);
			f.hooks.afterCommit = async () => {
				const b = await f.params('writer-b', false);
				b.retentionDays = 99;
				assert.equal((await f.repo.upsertWithAudit(b)).retention_days, 99);
			};
			const a = await f.repo.upsertWithAudit(input);
			assert.equal(a.retention_days, 0);
			assert.equal(a.verified_at, instant);
			assert.equal((await f.repo.getByRouteTargetId('Route-A'))?.retention_days, 99);
			assert.equal(f.state().audit.length, 2);
			const snapshots = f.state().audit.map((row) => JSON.parse(String(row.snapshot_json)) as { retention_days: number });
			assert.deepEqual(
				snapshots.map((row) => row.retention_days),
				[0, 99],
			);
		} finally {
			f.sqlite.close();
		}
	});

test('MySQL timestamp conversion preserves six digits and rejects non-UTC/invalid input', () => {
	assert.equal(policyMySqlDate(instant), '2026-10-01 09:00:00.123456');
	assert.equal(policyMySqlDate('2026-10-01T09:00:00Z'), '2026-10-01 09:00:00.000000');
	for (const value of ['2026-10-01T09:00:00+08:00', 'not-a-time', '2026-10-01T09:00:00.1234567Z'])
		assert.throws(() => policyMySqlDate(value), RouteDataPolicyWriteConflictError);
});
test('MySQL UTC restore failure destroys the connection and never releases a polluted session', async () => {
	const f = fixture('mysql');
	try {
		f.hooks.restoreError = true;
		await assert.rejects(f.repo.listAll(), /restore/u);
		assert.equal(f.events.at(-1), 'destroy');
		assert.equal(f.events.includes('release'), false);
	} finally {
		f.sqlite.close();
	}
});
test('MySQL restore failure after COMMIT reports unknown while retaining the atomically committed policy and audit', async () => {
	const f = fixture('mysql');
	try {
		const input = await f.params(),
			releases = f.events.filter((event) => event === 'release').length;
		f.hooks.restoreError = true;
		await assert.rejects(f.repo.upsertWithAudit(input), /restore/u);
		assert.equal(f.state().policy.length, 1);
		assert.equal(f.state().audit.length, 1);
		assert.equal(f.events.includes('commit'), true);
		assert.equal(f.events.at(-1), 'destroy');
		assert.equal(f.events.filter((event) => event === 'release').length, releases);
	} finally {
		f.sqlite.close();
	}
});
test('MySQL partial write rollback and UTC restoration are both required before release', async () => {
	const f = fixture('mysql');
	try {
		f.hooks.auditError = true;
		await assert.rejects(f.repo.upsertWithAudit(await f.params()), /audit failure/u);
		assert.equal(f.state().policy.length, 0);
		assert.equal(f.state().audit.length, 0);
		assert.deepEqual(f.events.slice(-3), ['rollback', 'timezone:+08:00', 'release']);
	} finally {
		f.sqlite.close();
	}
});
test('MySQL rollback failure destroys instead of releasing a connection with an unresolved transaction', async () => {
	const f = fixture('mysql');
	try {
		f.hooks.auditError = true;
		f.hooks.rollbackError = true;
		const input = await f.params();
		const releases = f.events.filter((e) => e === 'release').length;
		await assert.rejects(f.repo.upsertWithAudit(input), /audit failure/u);
		assert.equal(f.events.at(-1), 'destroy');
		assert.equal(f.events.filter((e) => e === 'release').length, releases);
	} finally {
		f.sqlite.close();
	}
});
test('MySQL competing unique-key INSERT is a conflict, not legacy overwrite', async () => {
	const f = fixture('mysql');
	try {
		f.hooks.duplicate = true;
		await assert.rejects(f.repo.upsertWithAudit(await f.params()), RouteDataPolicyWriteConflictError);
		assert.equal(f.state().audit.length, 0);
	} finally {
		f.sqlite.close();
	}
});
test('MySQL fixtures without exclusive/disposable connection fail closed rather than downgrade production', async () => {
	await assert.rejects(
		withPolicyUtcConnection({} as MySqlPoolLike, async () => true),
		/owned MySQL connection/u,
	);
	let released = 0;
	await assert.rejects(
		withPolicyUtcConnection({ getConnection: async () => ({ release: () => released++ }) } as unknown as MySqlPoolLike, async () => true),
		/disposable MySQL connection/u,
	);
	assert.equal(released, 1);
});

for (const fault of ['read', 'invalid', 'set', 'begin', 'action', 'commit', 'restore'] as const)
	test(`MySQL owned UTC resource guard: ${fault} failure`, async () => {
		const events: string[] = [];
		let ran = 0;
		const connection = {
			query: async (sql: string, params: unknown[] = []) => {
				if (sql.includes('@@session.time_zone')) {
					events.push('read');
					if (fault === 'read') throw new Error('synthetic read failure');
					return [[{ policy_time_zone: fault === 'invalid' ? "UTC'; SELECT 1;--" : 'Asia/Singapore' }], []];
				}
				events.push('set:' + String(params[0]));
				if (fault === 'set' && params[0] === '+00:00') throw new Error('synthetic set failure');
				if (fault === 'restore' && params[0] !== '+00:00') throw new Error('synthetic restore failure');
				return [[], []];
			},
			beginTransaction: async () => {
				events.push('begin');
				if (fault === 'begin') throw new Error('synthetic begin failure');
			},
			commit: async () => {
				events.push('commit');
				if (fault === 'commit') throw new Error('synthetic commit failure');
			},
			rollback: async () => {
				events.push('rollback');
			},
			release: () => events.push('release'),
			destroy: () => events.push('destroy'),
		};
		await assert.rejects(
			withPolicyUtcConnection(
				{ getConnection: async () => connection } as unknown as MySqlPoolLike,
				async () => {
					ran++;
					events.push('action');
					if (fault === 'action') throw new Error('synthetic action failure');
					return true;
				},
				true,
			),
		);
		assert.equal(ran, ['action', 'commit', 'restore'].includes(fault) ? 1 : 0);
		if (['read', 'invalid', 'restore'].includes(fault)) {
			assert.equal(events.at(-1), 'destroy');
			assert.equal(events.includes('release'), false);
		} else assert.deepEqual(events.slice(-2), ['set:Asia/Singapore', 'release']);
		if (['begin', 'action', 'commit'].includes(fault)) assert.equal(events.includes('rollback'), true);
		assert.ok(events.every((event) => !event.includes('SELECT 1')));
	});
