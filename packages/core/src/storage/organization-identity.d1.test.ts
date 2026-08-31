import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { parseCinaAuthOrganizationEvent } from '../organization-identity';
import type { D1DatabaseClient } from './database-client';
import {
	applyOrganizationIdentityEvent,
	linkOrganizationMembershipsToUser,
	listOrganizationMembershipsForSubject,
} from './organization-identity';

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
		return {
			success: true,
			results: [],
			meta: { changes: Number(result.changes) },
		} as D1Result;
	}

	first<T>(): T | null {
		return (this.database.prepare(this.sql).get(...this.values) ?? null) as T | null;
	}

	all<T>(): D1Result<T> {
		return {
			success: true,
			results: this.database.prepare(this.sql).all(...this.values) as T[],
			meta: {},
		} as D1Result<T>;
	}
}

function createD1Client(database: DatabaseSync): D1DatabaseClient {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
			database.exec('BEGIN');
			try {
				const results = (statements as unknown as SqliteD1Statement[]).map((statement) =>
					statement.run(),
				);
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

const EVENT_HASH = 'a'.repeat(64);

test('D1 projection is atomic, idempotent, ordered and links pre-login memberships', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE users (
				id TEXT PRIMARY KEY,
				external_system TEXT,
				external_user_id TEXT
			);
		`);
		database.exec(
			readFileSync(
				new URL('../../migrations-d1/0038_organization_identity_projection.sql', import.meta.url),
				'utf8',
			),
		);
		const client = createD1Client(database);
		const organizationEvent = parseCinaAuthOrganizationEvent({
			id: 'evt_org_1',
			type: 'organization.upserted',
			occurredAt: '2026-08-29T04:00:00Z',
			organization: { id: 'org_1', name: 'Cina Group', slug: 'cina-group' },
		});
		assert.equal(
			await applyOrganizationIdentityEvent(client, {
				event: organizationEvent,
				payloadSha256: EVENT_HASH,
				processorToken: 'processor_1',
				processedAt: '2026-08-29T04:00:01Z',
			}),
			'applied',
		);
		assert.equal(
			await applyOrganizationIdentityEvent(client, {
				event: organizationEvent,
				payloadSha256: EVENT_HASH,
				processorToken: 'processor_2',
				processedAt: '2026-08-29T04:00:02Z',
			}),
			'duplicate',
		);
		assert.equal(
			await applyOrganizationIdentityEvent(client, {
				event: organizationEvent,
				payloadSha256: 'b'.repeat(64),
				processorToken: 'processor_3',
				processedAt: '2026-08-29T04:00:03Z',
			}),
			'conflict',
		);

		const olderEvent = parseCinaAuthOrganizationEvent({
			id: 'evt_org_older',
			type: 'organization.upserted',
			occurredAt: '2026-08-28T04:00:00Z',
			organization: { id: 'org_1', name: 'Stale Name' },
		});
		assert.equal(
			await applyOrganizationIdentityEvent(client, {
				event: olderEvent,
				payloadSha256: 'c'.repeat(64),
				processorToken: 'processor_4',
				processedAt: '2026-08-29T04:00:04Z',
			}),
			'applied',
		);
		assert.equal(
			(database.prepare('SELECT name FROM organizations WHERE id = ?').get('org_1') as { name: string }).name,
			'Cina Group',
		);

		const membershipEvent = parseCinaAuthOrganizationEvent({
			id: 'evt_membership_1',
			type: 'organization.membership.upserted',
			occurredAt: '2026-08-29T04:05:00Z',
			organization: { id: 'org_1' },
			membership: {
				subject: 'user_1',
				email: 'member@example.com',
				roles: ['billing_admin', 'member'],
			},
		});
		assert.equal(
			await applyOrganizationIdentityEvent(client, {
				event: membershipEvent,
				payloadSha256: 'd'.repeat(64),
				processorToken: 'processor_5',
				processedAt: '2026-08-29T04:05:01Z',
			}),
			'applied',
		);
		assert.equal(
			(database.prepare('SELECT user_id FROM organization_memberships').get() as { user_id: string | null }).user_id,
			null,
		);

		database.prepare(
			'INSERT INTO users (id, external_system, external_user_id) VALUES (?, ?, ?)',
		).run('local_user_1', 'cinaauth', 'user_1');
		await linkOrganizationMembershipsToUser(
			client,
			'user_1',
			'local_user_1',
			'2026-08-29T04:06:00Z',
		);
		const memberships = await listOrganizationMembershipsForSubject(client, 'user_1');
		assert.equal(memberships.length, 1);
		assert.equal(memberships[0]?.organizationName, 'Cina Group');
		assert.equal(memberships[0]?.userId, 'local_user_1');
		assert.deepEqual(memberships[0]?.roles, ['billing_admin', 'member']);

		const removalEvent = parseCinaAuthOrganizationEvent({
			id: 'evt_membership_remove_1',
			type: 'organization.membership.removed',
			occurredAt: '2026-08-29T04:07:00Z',
			organization: { id: 'org_1' },
			membership: { subject: 'user_1', roles: ['owner'] },
		});
		await applyOrganizationIdentityEvent(client, {
			event: removalEvent,
			payloadSha256: 'e'.repeat(64),
			processorToken: 'processor_6',
			processedAt: '2026-08-29T04:07:01Z',
		});
		const removedMembership = database.prepare(`
				SELECT status, roles_json FROM organization_memberships
				WHERE organization_id = ? AND subject = ?
			`).get('org_1', 'user_1') as { status: string; roles_json: string };
		assert.equal(removedMembership.status, 'removed');
		assert.equal(removedMembership.roles_json, '["billing_admin","member"]');

		const equalTimeMembershipUpsert = parseCinaAuthOrganizationEvent({
			id: 'evt_membership_equal_time_upsert',
			type: 'organization.membership.upserted',
			occurredAt: '2026-08-29T04:07:00Z',
			organization: { id: 'org_1' },
			membership: { subject: 'user_1', roles: ['owner'] },
		});
		await applyOrganizationIdentityEvent(client, {
			event: equalTimeMembershipUpsert,
			payloadSha256: '1'.repeat(64),
			processorToken: 'processor_6_equal',
			processedAt: '2026-08-29T04:07:02Z',
		});
		const stillRemovedMembership = database.prepare(`
			SELECT status, roles_json FROM organization_memberships
			WHERE organization_id = ? AND subject = ?
		`).get('org_1', 'user_1') as { status: string; roles_json: string };
		assert.equal(stillRemovedMembership.status, 'removed');
		assert.equal(stillRemovedMembership.roles_json, '["billing_admin","member"]');

		const deletionEvent = parseCinaAuthOrganizationEvent({
			id: 'evt_org_delete_1',
			type: 'organization.deleted',
			occurredAt: '2026-08-29T04:08:00Z',
			organization: { id: 'org_1' },
		});
		await applyOrganizationIdentityEvent(client, {
			event: deletionEvent,
			payloadSha256: 'f'.repeat(64),
			processorToken: 'processor_7',
			processedAt: '2026-08-29T04:08:01Z',
		});
		const deletedOrganization = database
			.prepare('SELECT name, slug, status FROM organizations WHERE id = ?')
			.get('org_1') as { name: string; slug: string; status: string };
		assert.equal(deletedOrganization.name, 'Cina Group');
		assert.equal(deletedOrganization.slug, 'cina-group');
		assert.equal(deletedOrganization.status, 'deleted');

		const equalTimeOrganizationUpsert = parseCinaAuthOrganizationEvent({
			id: 'evt_org_equal_time_upsert',
			type: 'organization.upserted',
			occurredAt: '2026-08-29T04:08:00Z',
			organization: { id: 'org_1', name: 'Resurrected Name', status: 'active' },
		});
		await applyOrganizationIdentityEvent(client, {
			event: equalTimeOrganizationUpsert,
			payloadSha256: '2'.repeat(64),
			processorToken: 'processor_7_equal',
			processedAt: '2026-08-29T04:08:02Z',
		});
		const stillDeletedOrganization = database
			.prepare('SELECT name, status FROM organizations WHERE id = ?')
			.get('org_1') as { name: string; status: string };
		assert.equal(stillDeletedOrganization.name, 'Cina Group');
		assert.equal(stillDeletedOrganization.status, 'deleted');
	} finally {
		database.close();
	}
});
