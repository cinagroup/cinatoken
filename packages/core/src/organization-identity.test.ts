import assert from 'node:assert/strict';
import test from 'node:test';
import {
	organizationEventAggregate,
	parseCinaAuthOrganizationEvent,
} from './organization-identity';

test('normalizes an organization membership event without collapsing dynamic roles', () => {
	const event = parseCinaAuthOrganizationEvent({
		id: 'evt:org-member:1',
		type: 'organization.membership.upserted',
		occurredAt: '2026-08-29T01:02:03+00:00',
		organization: { id: 'org_123' },
		membership: {
			subject: 'user_123',
			email: ' member@example.com ',
			roles: ['billing_admin', 'member', 'billing_admin'],
		},
	});

	assert.equal(event.occurredAt, '2026-08-29T01:02:03.000Z');
	assert.deepEqual(event.membership?.roles, ['billing_admin', 'member']);
	assert.equal(event.membership?.email, 'member@example.com');
	assert.deepEqual(organizationEventAggregate(event), {
		type: 'organization_membership',
		id: 'org_123:user_123',
	});
});

test('turns removal and deletion events into tombstones', () => {
	const membership = parseCinaAuthOrganizationEvent({
		id: 'evt_remove_1',
		type: 'organization.membership.removed',
		occurredAt: '2026-08-29T01:02:03Z',
		organization: { id: 'org_123' },
		membership: { subject: 'user_123', roles: ['owner'] },
	});
	assert.equal(membership.membership?.status, 'removed');
	assert.deepEqual(membership.membership?.roles, []);

	const organization = parseCinaAuthOrganizationEvent({
		id: 'evt_delete_1',
		type: 'organization.deleted',
		occurredAt: '2026-08-29T01:02:03Z',
		organization: { id: 'org_123' },
	});
	assert.equal(organization.organization.status, 'deleted');
});

test('rejects incomplete or unsafe identity events', () => {
	assert.throws(
		() =>
			parseCinaAuthOrganizationEvent({
				id: 'evt_1',
				type: 'organization.upserted',
				occurredAt: '2026-08-29T01:02:03Z',
				organization: { id: 'org_123' },
			}),
		/organization.name is required/u,
	);
	assert.throws(
		() =>
			parseCinaAuthOrganizationEvent({
				id: '../bad',
				type: 'organization.deleted',
				occurredAt: '2026-08-29T01:02:03Z',
				organization: { id: 'org_123' },
			}),
		/event.id is invalid/u,
	);
	assert.throws(
		() =>
			parseCinaAuthOrganizationEvent({
				id: 'evt_2',
				type: 'organization.membership.upserted',
				occurredAt: '2026-08-29T01:02:03Z',
				organization: { id: 'org_123' },
				membership: { subject: 'user_123', roles: [] },
			}),
		/must not be empty/u,
	);
});
