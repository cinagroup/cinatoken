import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { createD1RouteDataPoliciesRepository } from '../db/d1/route-data-policies.impl';
import type { D1DatabaseClient } from './database-client';

class SqliteD1Statement {
	constructor(
		private readonly database: DatabaseSync,
		private readonly sql: string,
		private readonly values: SQLInputValue[] = [],
	) {}
	bind(...values: SQLInputValue[]): D1PreparedStatement {
		return new SqliteD1Statement(this.database, this.sql, values) as unknown as D1PreparedStatement;
	}
	run(): D1Result {
		const result = this.database.prepare(this.sql).run(...this.values);
		return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result;
	}
	first<T>(): T | null {
		return (this.database.prepare(this.sql).get(...this.values) ?? null) as T | null;
	}
	all<T>(): D1Result<T> {
		return { success: true, results: this.database.prepare(this.sql).all(...this.values) as T[], meta: {} } as unknown as D1Result<T>;
	}
}

function createClient(database: DatabaseSync): D1DatabaseClient {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
			database.exec('BEGIN');
			try {
				const results = (statements as unknown as SqliteD1Statement[]).map((statement) => statement.run());
				database.exec('COMMIT');
				return results;
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
		},
	} as unknown as D1Database;
	return { driver: 'd1', raw, drizzle: {} as D1DatabaseClient['drizzle'] };
}

function createLegacySchema(database: DatabaseSync): void {
	database.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE providers (id TEXT PRIMARY KEY);
		CREATE TABLE model_routes (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id));
		CREATE TABLE route_data_policies (
			route_target_id TEXT PRIMARY KEY REFERENCES model_routes(id) ON DELETE CASCADE,
			retention_days INTEGER, training_allowed INTEGER NOT NULL DEFAULT 1,
			zdr_supported INTEGER NOT NULL DEFAULT 0, evidence_url TEXT, verified_by TEXT,
			verified_at TEXT, expires_at TEXT, status TEXT NOT NULL DEFAULT 'unknown',
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE route_data_policy_audit (
			id TEXT PRIMARY KEY, route_target_id TEXT REFERENCES model_routes(id) ON DELETE SET NULL,
			snapshot_json TEXT NOT NULL, actor_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
	`);
}

const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

test('D1 migration invalidates legacy assertions and repository records subject invalidations', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		createLegacySchema(database);
		database.exec(`
			INSERT INTO providers (id) VALUES ('provider-1');
			INSERT INTO model_routes (id, provider_id) VALUES ('route-1', 'provider-1'), ('route-2', 'provider-1');
			INSERT INTO route_data_policies (
				route_target_id, retention_days, training_allowed, zdr_supported, evidence_url,
				verified_by, verified_at, expires_at, status, updated_at
			) VALUES (
				'route-1', 0, 0, 1, 'https://provider.example/privacy', 'admin',
				'2026-08-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'verified', '2026-08-01T00:00:00.000Z'
			);
		`);
		database.exec(readFileSync(
			new URL('../../migrations-d1/0046_route_data_policy_subject_fingerprint.sql', import.meta.url),
			'utf8',
		));
		const migrated = database.prepare(`SELECT status, subject_fingerprint, invalidation_reason FROM route_data_policies WHERE route_target_id = 'route-1'`).get() as Record<string, unknown>;
		assert.deepEqual({ ...migrated }, {
			status: 'unknown', subject_fingerprint: null,
			invalidation_reason: 'subject_fingerprint_backfill_required',
		});

		const repository = createD1RouteDataPoliciesRepository(createClient(database));
		const assertion = {
			retentionDays: 0, trainingAllowed: false, zdrSupported: true,
			evidenceUrl: 'https://provider.example/privacy', verifiedBy: 'admin',
			verifiedAt: '2026-08-30T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
			status: 'verified' as const, actorId: 'admin', nowIso: '2026-08-30T00:00:00.000Z',
		};
		await repository.upsertWithAudit({ id: 'verify-1', routeTargetId: 'route-1', subjectFingerprint: FINGERPRINT_A, ...assertion });
		await repository.upsertWithAudit({ id: 'verify-2', routeTargetId: 'route-2', subjectFingerprint: FINGERPRINT_B, ...assertion });
		assert.equal((await repository.getByRouteTargetId('route-1'))?.subject_fingerprint, FINGERPRINT_A);

		assert.equal(await repository.invalidateForRouteTarget('route-1', {
			id: 'invalidate-route', actorId: 'admin', nowIso: '2026-08-30T01:00:00.000Z', reason: 'route_subject_changed:custom_params',
		}), 1);
		assert.equal((await repository.getByRouteTargetId('route-1'))?.status, 'unknown');
		assert.equal((await repository.getByRouteTargetId('route-1'))?.invalidation_reason, 'route_subject_changed:custom_params');

		await repository.upsertWithAudit({ id: 'verify-3', routeTargetId: 'route-1', subjectFingerprint: FINGERPRINT_A, ...assertion });
		assert.equal(await repository.invalidateForProvider('provider-1', {
			id: 'invalidate-provider', actorId: 'admin', nowIso: '2026-08-30T02:00:00.000Z', reason: 'provider_subject_changed:endpoints',
		}), 2);
		assert.equal((await repository.getByRouteTargetId('route-1'))?.status, 'unknown');
		assert.equal((await repository.getByRouteTargetId('route-2'))?.status, 'unknown');
		const providerAudit = (await repository.listAudit('route-2')).find((row) => row.actor_id === 'admin');
		assert.match(providerAudit?.snapshot_json ?? '', /provider_subject_changed:endpoints/u);
	} finally {
		database.close();
	}
});
