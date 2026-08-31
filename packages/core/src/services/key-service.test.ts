import assert from 'node:assert/strict';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { assertAndFinalizeUserAuditInsert, normalizeUserAuditActorKinds } from '../db/user-audit-catalog';
import type { GatewayRepositories } from '../storage/repositories-types';
import { createKey } from './key-service';

class CapturingStatement {
	values: unknown[] = [];
	constructor(readonly sql: string) {}
	bind(...values: unknown[]): D1PreparedStatement {
		this.values = values;
		return this as unknown as D1PreparedStatement;
	}
}

function repositories() {
	const batches: CapturingStatement[][] = [];
	const raw = {
		prepare(sql: string) {
			return new CapturingStatement(sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]) {
			batches.push(statements as unknown as CapturingStatement[]);
			return statements.map(() => ({ success: true, results: [], meta: {} } as unknown as D1Result));
		},
	} as unknown as D1Database;
	const user = {
		id: 'user-1', email: 'user@example.com', budget_max: 10, budget_base: 10, budget_spent: 0,
		budget_period: 'none', budget_reset_at: null, budget_epoch: 0, budget_reserved_micros: 0,
		status: 'active', metadata: null, charged_cost_factors: null,
		external_system: 'cinaauth', external_user_id: 'subject-1',
		created_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z',
	};
	return {
		batches,
		repos: {
			client: { driver: 'd1', raw, drizzle: {} },
			users: { getById: async () => user },
		} as unknown as GatewayRepositories,
	};
}

function auditValues(batches: CapturingStatement[][]): unknown[] {
	const statement = batches[0]?.find((candidate) => candidate.sql.includes('INSERT INTO user_audit_logs'));
	assert.ok(statement, 'expected a user_audit_logs insert in the atomic batch');
	return statement.values;
}

function keyValues(batches: CapturingStatement[][]): unknown[] {
	const statement = batches[0]?.find((candidate) => candidate.sql.includes('INSERT INTO api_keys'));
	assert.ok(statement, 'expected an api_keys insert in the atomic batch');
	return statement.values;
}

test('portal key creation records a user actor with the portal principal', async () => {
	const fixture = repositories();
	await createKey(fixture.repos, {
		user_id: 'user-1', workspace_id: 'personal:user-1', actor_type: 'user', actor_id: 'portal:user-1',
		provision_reason: 'User portal self-service key',
	});
	const values = auditValues(fixture.batches);
	assert.equal(values[3], 'key_created');
	assert.equal(values[4], 'user');
	assert.equal(values[11], 'key_provision');
	assert.equal(values[12], 'portal:user-1');
});

test('administrative key creation keeps the backward-compatible admin default', async () => {
	const fixture = repositories();
	await createKey(fixture.repos, {
		user_id: 'user-1', workspace_id: 'personal:user-1', actor_id: 'console:admin',
	});
	const values = auditValues(fixture.batches);
	assert.equal(values[4], 'admin');
	assert.equal(values[12], 'console:admin');
});

test('Gateway key creation stores only a canonical future expiry', async () => {
	const fixture = repositories();
	await createKey(fixture.repos, {
		user_id: 'user-1',
		workspace_id: 'personal:user-1',
		expires_at: '2027-01-01T00:00:00.000Z',
		now: new Date('2026-08-31T00:00:00.000Z'),
	});
	assert.equal(keyValues(fixture.batches)[9], '2027-01-01T00:00:00.000Z');

	await assert.rejects(
		createKey(repositories().repos, {
			user_id: 'user-1',
			workspace_id: 'personal:user-1',
			expires_at: '2026-08-30T00:00:00.000Z',
			now: new Date('2026-08-31T00:00:00.000Z'),
		}),
		/Gateway API key expiry must be in the future/,
	);
	await assert.rejects(
		createKey(repositories().repos, {
			user_id: 'user-1',
			workspace_id: 'personal:user-1',
			expires_at: '2027-01-01T00:00:00Z',
			now: new Date('2026-08-31T00:00:00.000Z'),
		}),
		/canonical UTC ISO 8601/,
	);
});

test('audit actor catalog recognizes portal actors and rejects mismatched attribution', () => {
	assert.deepEqual(normalizeUserAuditActorKinds(['portal', 'portal', 'unknown']), ['portal']);
	assert.throws(() => assertAndFinalizeUserAuditInsert({
		id: 'audit-1', userId: 'user-1', eventType: 'key_created', actorType: 'admin', actorId: 'portal:user-1',
	}), /portal actor_id requires actor_type/);
	assert.throws(() => assertAndFinalizeUserAuditInsert({
		id: 'audit-2', userId: 'user-1', eventType: 'key_created', actorType: 'user', actorId: 'console:user-1',
	}), /user actor_id must use/);
});
