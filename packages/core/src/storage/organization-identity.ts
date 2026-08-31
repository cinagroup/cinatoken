import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type {
	CinaAuthOrganizationEvent,
	OrganizationMembershipProjection,
} from '../organization-identity';
import { organizationEventAggregate } from '../organization-identity';
import type { GatewayDatabaseClient } from './database-client';

const SOURCE = 'cinaauth';
// Keep inside MySQL TIMESTAMP's portable range while remaining older than real CinaAuth events.
const PLACEHOLDER_UPDATED_AT = '1970-01-02T00:00:00.000Z';
const mysqlTimestamp = (value: string): string =>
	new Date(value).toISOString().slice(0, 23).replace('T', ' ');

export type ApplyOrganizationIdentityEventResult = 'applied' | 'duplicate' | 'conflict';

export type ApplyOrganizationIdentityEventInput = {
	event: CinaAuthOrganizationEvent;
	/** Lowercase SHA-256 hex of the exact signed HTTP body. */
	payloadSha256: string;
	/** Unique per delivery attempt; generated with crypto.randomUUID(). */
	processorToken?: string;
	processedAt?: string;
};

type IdentityInboxRow = {
	payload_sha256: string;
	processor_token: string;
};

const eventValues = (input: ApplyOrganizationIdentityEventInput) => {
	const aggregate = organizationEventAggregate(input.event);
	const processorToken = input.processorToken ?? crypto.randomUUID();
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(processorToken)) {
		throw new Error('processorToken is invalid');
	}
	return {
		aggregate,
		processorToken,
		processedAt: new Date(input.processedAt ?? Date.now()).toISOString(),
	};
};

const organizationValues = (event: CinaAuthOrganizationEvent) => ({
	id: event.organization.id,
	name: event.organization.name ?? event.organization.id,
	slug: event.organization.slug ?? null,
	status:
		event.type === 'organization.deleted'
			? 'deleted'
			: (event.organization.status ?? 'active'),
	metadataJson:
		event.organization.metadata === undefined
			? null
			: JSON.stringify(event.organization.metadata),
	sourceUpdatedAt: event.organization.updatedAt ?? event.occurredAt,
});

const membershipValues = (event: CinaAuthOrganizationEvent) => {
	if (!event.membership) return null;
	return {
		organizationId: event.organization.id,
		subject: event.membership.subject,
		email: event.membership.email ?? null,
		rolesJson: JSON.stringify(event.membership.roles),
		status:
			event.type === 'organization.membership.removed'
				? 'removed'
				: (event.membership.status ?? 'active'),
		sourceUpdatedAt: event.membership.updatedAt ?? event.occurredAt,
	};
};

async function applyPostgres(
	client: Extract<GatewayDatabaseClient, { driver: 'postgres' }>,
	input: ApplyOrganizationIdentityEventInput,
): Promise<ApplyOrganizationIdentityEventResult> {
	const { event, payloadSha256 } = input;
	const { aggregate, processorToken, processedAt } = eventValues(input);
	const organization = organizationValues(event);
	const membership = membershipValues(event);

	return client.raw.begin(async (tx) => {
		const inserted = await tx<IdentityInboxRow[]>`
			INSERT INTO identity_event_inbox (
				source, event_id, event_type, aggregate_type, aggregate_id,
				payload_sha256, processor_token, occurred_at, processed_at
			) VALUES (
				${SOURCE}, ${event.id}, ${event.type}, ${aggregate.type}, ${aggregate.id},
				${payloadSha256}, ${processorToken}, ${event.occurredAt}, ${processedAt}
			)
			ON CONFLICT (source, event_id) DO NOTHING
			RETURNING payload_sha256, processor_token
		`;
		if (inserted.length === 0) {
			const existing = await tx<IdentityInboxRow[]>`
				SELECT payload_sha256, processor_token
				FROM identity_event_inbox
				WHERE source = ${SOURCE} AND event_id = ${event.id}
			`;
			return existing[0]?.payload_sha256 === payloadSha256 ? 'duplicate' : 'conflict';
		}

		if (!membership) {
			await tx`
				INSERT INTO organizations (
					id, source, name, slug, status, metadata_json,
					source_updated_at, created_at, updated_at
				) VALUES (
					${organization.id}, ${SOURCE}, ${organization.name}, ${organization.slug},
					${organization.status}, ${organization.metadataJson},
					${organization.sourceUpdatedAt}, ${processedAt}, ${processedAt}
				)
				ON CONFLICT (id) DO UPDATE SET
					name = CASE WHEN EXCLUDED.status = 'deleted' THEN organizations.name ELSE EXCLUDED.name END,
					slug = CASE WHEN EXCLUDED.status = 'deleted' THEN organizations.slug ELSE EXCLUDED.slug END,
					status = EXCLUDED.status,
					metadata_json = CASE WHEN EXCLUDED.status = 'deleted' THEN organizations.metadata_json ELSE EXCLUDED.metadata_json END,
					source_updated_at = EXCLUDED.source_updated_at,
					updated_at = EXCLUDED.updated_at
				WHERE organizations.source = ${SOURCE}
					AND (
						organizations.source_updated_at < EXCLUDED.source_updated_at
						OR (
							organizations.source_updated_at = EXCLUDED.source_updated_at
							AND (organizations.status <> 'deleted' OR EXCLUDED.status = 'deleted')
						)
					)
			`;
			return 'applied';
		}

		await tx`
			INSERT INTO organizations (
				id, source, name, status, source_updated_at, created_at, updated_at
			) VALUES (
				${organization.id}, ${SOURCE}, ${organization.id}, 'pending',
				${PLACEHOLDER_UPDATED_AT}, ${processedAt}, ${processedAt}
			)
			ON CONFLICT (id) DO NOTHING
		`;
		await tx`
			INSERT INTO organization_memberships (
				organization_id, subject, user_id, email, roles_json, status,
				source_updated_at, created_at, updated_at
			) VALUES (
				${membership.organizationId}, ${membership.subject},
				(SELECT id FROM users WHERE external_system = ${SOURCE} AND external_user_id = ${membership.subject}),
				${membership.email}, ${membership.rolesJson}, ${membership.status},
				${membership.sourceUpdatedAt}, ${processedAt}, ${processedAt}
			)
			ON CONFLICT (organization_id, subject) DO UPDATE SET
				user_id = COALESCE(EXCLUDED.user_id, organization_memberships.user_id),
				email = CASE WHEN EXCLUDED.status = 'removed' THEN organization_memberships.email ELSE EXCLUDED.email END,
				roles_json = CASE WHEN EXCLUDED.status = 'removed' THEN organization_memberships.roles_json ELSE EXCLUDED.roles_json END,
				status = EXCLUDED.status,
				source_updated_at = EXCLUDED.source_updated_at,
				updated_at = EXCLUDED.updated_at
			WHERE organization_memberships.source_updated_at < EXCLUDED.source_updated_at
				OR (
					organization_memberships.source_updated_at = EXCLUDED.source_updated_at
					AND (organization_memberships.status <> 'removed' OR EXCLUDED.status = 'removed')
				)
		`;
		return 'applied';
	});
}

async function applyD1(
	client: Extract<GatewayDatabaseClient, { driver: 'd1' }>,
	input: ApplyOrganizationIdentityEventInput,
): Promise<ApplyOrganizationIdentityEventResult> {
	const { event, payloadSha256 } = input;
	const { aggregate, processorToken, processedAt } = eventValues(input);
	const organization = organizationValues(event);
	const membership = membershipValues(event);
	const db = client.raw;
	const ownsEvent = `EXISTS (
		SELECT 1 FROM identity_event_inbox
		WHERE source = ? AND event_id = ? AND processor_token = ?
	)`;
	const statements = [
		db.prepare(`
			INSERT INTO identity_event_inbox (
				source, event_id, event_type, aggregate_type, aggregate_id,
				payload_sha256, processor_token, occurred_at, processed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(source, event_id) DO NOTHING
		`).bind(
			SOURCE,
			event.id,
			event.type,
			aggregate.type,
			aggregate.id,
			payloadSha256,
			processorToken,
			event.occurredAt,
			processedAt,
		),
	];

	if (!membership) {
		statements.push(
			db.prepare(`
				INSERT INTO organizations (
					id, source, name, slug, status, metadata_json,
					source_updated_at, created_at, updated_at
				)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
				WHERE ${ownsEvent}
				ON CONFLICT(id) DO UPDATE SET
					name = CASE WHEN excluded.status = 'deleted' THEN organizations.name ELSE excluded.name END,
					slug = CASE WHEN excluded.status = 'deleted' THEN organizations.slug ELSE excluded.slug END,
					status = excluded.status,
					metadata_json = CASE WHEN excluded.status = 'deleted' THEN organizations.metadata_json ELSE excluded.metadata_json END,
					source_updated_at = excluded.source_updated_at,
					updated_at = excluded.updated_at
				WHERE organizations.source = ?
					AND (
						organizations.source_updated_at < excluded.source_updated_at
						OR (
							organizations.source_updated_at = excluded.source_updated_at
							AND (organizations.status <> 'deleted' OR excluded.status = 'deleted')
						)
					)
			`).bind(
				organization.id,
				SOURCE,
				organization.name,
				organization.slug,
				organization.status,
				organization.metadataJson,
				organization.sourceUpdatedAt,
				processedAt,
				processedAt,
				SOURCE,
				event.id,
				processorToken,
				SOURCE,
			),
		);
	} else {
		statements.push(
			db.prepare(`
				INSERT INTO organizations (
					id, source, name, status, source_updated_at, created_at, updated_at
				)
				SELECT ?, ?, ?, 'pending', ?, ?, ?
				WHERE ${ownsEvent}
				ON CONFLICT(id) DO NOTHING
			`).bind(
				organization.id,
				SOURCE,
				organization.id,
				PLACEHOLDER_UPDATED_AT,
				processedAt,
				processedAt,
				SOURCE,
				event.id,
				processorToken,
			),
			db.prepare(`
				INSERT INTO organization_memberships (
					organization_id, subject, user_id, email, roles_json, status,
					source_updated_at, created_at, updated_at
				)
				SELECT ?, ?,
					(SELECT id FROM users WHERE external_system = ? AND external_user_id = ?),
					?, ?, ?, ?, ?, ?
				WHERE ${ownsEvent}
				ON CONFLICT(organization_id, subject) DO UPDATE SET
					user_id = COALESCE(excluded.user_id, organization_memberships.user_id),
					email = CASE WHEN excluded.status = 'removed' THEN organization_memberships.email ELSE excluded.email END,
					roles_json = CASE WHEN excluded.status = 'removed' THEN organization_memberships.roles_json ELSE excluded.roles_json END,
					status = excluded.status,
					source_updated_at = excluded.source_updated_at,
					updated_at = excluded.updated_at
				WHERE organization_memberships.source_updated_at < excluded.source_updated_at
					OR (
						organization_memberships.source_updated_at = excluded.source_updated_at
						AND (organization_memberships.status <> 'removed' OR excluded.status = 'removed')
					)
			`).bind(
				membership.organizationId,
				membership.subject,
				SOURCE,
				membership.subject,
				membership.email,
				membership.rolesJson,
				membership.status,
				membership.sourceUpdatedAt,
				processedAt,
				processedAt,
				SOURCE,
				event.id,
				processorToken,
			),
		);
	}

	await db.batch(statements);
	const existing = await db.prepare(`
		SELECT payload_sha256, processor_token
		FROM identity_event_inbox
		WHERE source = ? AND event_id = ?
	`).bind(SOURCE, event.id).first<IdentityInboxRow>();
	if (existing?.processor_token === processorToken) return 'applied';
	return existing?.payload_sha256 === payloadSha256 ? 'duplicate' : 'conflict';
}

async function applyMySql(
	client: Extract<GatewayDatabaseClient, { driver: 'mysql' }>,
	input: ApplyOrganizationIdentityEventInput,
): Promise<ApplyOrganizationIdentityEventResult> {
	const { event, payloadSha256 } = input;
	const { aggregate, processorToken, processedAt } = eventValues(input);
	const organization = organizationValues(event);
	const membership = membershipValues(event);
	const connection = await client.raw.getConnection();
	try {
		await connection.beginTransaction();
		await connection.execute<ResultSetHeader>(`
			INSERT INTO identity_event_inbox (
				source, event_id, event_type, aggregate_type, aggregate_id,
				payload_sha256, processor_token, occurred_at, processed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE event_id = event_id
		`, [
			SOURCE,
			event.id,
			event.type,
			aggregate.type,
			aggregate.id,
			payloadSha256,
			processorToken,
			mysqlTimestamp(event.occurredAt),
			mysqlTimestamp(processedAt),
		]);
		const [rows] = await connection.execute<(IdentityInboxRow & RowDataPacket)[]>(`
			SELECT payload_sha256, processor_token
			FROM identity_event_inbox
			WHERE source = ? AND event_id = ?
			FOR UPDATE
		`, [SOURCE, event.id]);
		if (rows[0]?.processor_token !== processorToken) {
			await connection.rollback();
			return rows[0]?.payload_sha256 === payloadSha256 ? 'duplicate' : 'conflict';
		}

		if (!membership) {
			await connection.execute(`
				INSERT INTO organizations (
					id, source, name, slug, status, metadata_json,
					source_updated_at, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE
					name = IF(source = VALUES(source) AND (source_updated_at < VALUES(source_updated_at) OR (source_updated_at = VALUES(source_updated_at) AND (status <> 'deleted' OR VALUES(status) = 'deleted'))) AND VALUES(status) <> 'deleted', VALUES(name), name),
					slug = IF(source = VALUES(source) AND (source_updated_at < VALUES(source_updated_at) OR (source_updated_at = VALUES(source_updated_at) AND (status <> 'deleted' OR VALUES(status) = 'deleted'))) AND VALUES(status) <> 'deleted', VALUES(slug), slug),
					metadata_json = IF(source = VALUES(source) AND (source_updated_at < VALUES(source_updated_at) OR (source_updated_at = VALUES(source_updated_at) AND (status <> 'deleted' OR VALUES(status) = 'deleted'))) AND VALUES(status) <> 'deleted', VALUES(metadata_json), metadata_json),
					updated_at = IF(source = VALUES(source) AND (source_updated_at < VALUES(source_updated_at) OR (source_updated_at = VALUES(source_updated_at) AND (status <> 'deleted' OR VALUES(status) = 'deleted'))), VALUES(updated_at), updated_at),
					status = IF(source = VALUES(source) AND (source_updated_at < VALUES(source_updated_at) OR (source_updated_at = VALUES(source_updated_at) AND (status <> 'deleted' OR VALUES(status) = 'deleted'))), VALUES(status), status),
					source_updated_at = GREATEST(source_updated_at, VALUES(source_updated_at))
			`, [
				organization.id,
				SOURCE,
				organization.name,
				organization.slug,
				organization.status,
				organization.metadataJson,
				mysqlTimestamp(organization.sourceUpdatedAt),
				mysqlTimestamp(processedAt),
				mysqlTimestamp(processedAt),
			]);
		} else {
			await connection.execute(`
				INSERT INTO organizations (
					id, source, name, status, source_updated_at, created_at, updated_at
				) VALUES (?, ?, ?, 'pending', ?, ?, ?)
				ON DUPLICATE KEY UPDATE id = id
			`, [
				organization.id,
				SOURCE,
				organization.id,
				mysqlTimestamp(PLACEHOLDER_UPDATED_AT),
				mysqlTimestamp(processedAt),
				mysqlTimestamp(processedAt),
			]);
			await connection.execute(`
				INSERT INTO organization_memberships (
					organization_id, subject, user_id, email, roles_json, status,
					source_updated_at, created_at, updated_at
				) VALUES (
					?, ?, (SELECT id FROM users WHERE external_system = ? AND external_user_id = ?),
					?, ?, ?, ?, ?, ?
				)
				ON DUPLICATE KEY UPDATE
					user_id = IF(source_updated_at < VALUES(source_updated_at) OR (source_updated_at = VALUES(source_updated_at) AND (status <> 'removed' OR VALUES(status) = 'removed')), COALESCE(VALUES(user_id), user_id), user_id),
					email = IF((source_updated_at < VALUES(source_updated_at) OR (source_updated_at = VALUES(source_updated_at) AND (status <> 'removed' OR VALUES(status) = 'removed'))) AND VALUES(status) <> 'removed', VALUES(email), email),
					roles_json = IF((source_updated_at < VALUES(source_updated_at) OR (source_updated_at = VALUES(source_updated_at) AND (status <> 'removed' OR VALUES(status) = 'removed'))) AND VALUES(status) <> 'removed', VALUES(roles_json), roles_json),
					updated_at = IF(source_updated_at < VALUES(source_updated_at) OR (source_updated_at = VALUES(source_updated_at) AND (status <> 'removed' OR VALUES(status) = 'removed')), VALUES(updated_at), updated_at),
					status = IF(source_updated_at < VALUES(source_updated_at) OR (source_updated_at = VALUES(source_updated_at) AND (status <> 'removed' OR VALUES(status) = 'removed')), VALUES(status), status),
					source_updated_at = GREATEST(source_updated_at, VALUES(source_updated_at))
			`, [
				membership.organizationId,
				membership.subject,
				SOURCE,
				membership.subject,
				membership.email,
				membership.rolesJson,
				membership.status,
				mysqlTimestamp(membership.sourceUpdatedAt),
				mysqlTimestamp(processedAt),
				mysqlTimestamp(processedAt),
			]);
		}

		await connection.commit();
		return 'applied';
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}
}

/**
 * Atomically records an immutable event receipt and applies its projection.
 * A reused event id with a different body hash is rejected as a conflict.
 */
export function applyOrganizationIdentityEvent(
	client: GatewayDatabaseClient,
	input: ApplyOrganizationIdentityEventInput,
): Promise<ApplyOrganizationIdentityEventResult> {
	if (!/^[a-f0-9]{64}$/u.test(input.payloadSha256)) {
		throw new Error('payloadSha256 must be lowercase SHA-256 hex');
	}
	if (client.driver === 'd1') return applyD1(client, input);
	if (client.driver === 'postgres') return applyPostgres(client, input);
	return applyMySql(client, input);
}

const parseRoles = (value: unknown): string[] => {
	if (typeof value !== 'string') return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) && parsed.every((role) => typeof role === 'string')
			? parsed
			: [];
	} catch {
		return [];
	}
};

type MembershipQueryRow = {
	organization_id: string;
	organization_name: string;
	organization_slug: string | null;
	organization_status: OrganizationMembershipProjection['organizationStatus'];
	subject: string;
	user_id: string | null;
	email: string | null;
	roles_json: string;
	status: OrganizationMembershipProjection['status'];
	source_updated_at: string | Date;
};

const mapMembership = (row: MembershipQueryRow): OrganizationMembershipProjection => ({
	organizationId: row.organization_id,
	organizationName: row.organization_name,
	organizationSlug: row.organization_slug,
	organizationStatus: row.organization_status,
	subject: row.subject,
	userId: row.user_id,
	email: row.email,
	roles: parseRoles(row.roles_json),
	status: row.status,
	sourceUpdatedAt:
		row.source_updated_at instanceof Date
			? row.source_updated_at.toISOString()
			: String(row.source_updated_at),
});

/** Read the active CinaAuth organization memberships available to one subject. */
export async function listOrganizationMembershipsForSubject(
	client: GatewayDatabaseClient,
	subject: string,
): Promise<OrganizationMembershipProjection[]> {
	if (client.driver === 'd1') {
		const result = await client.raw.prepare(`
			SELECT
				o.id AS organization_id, o.name AS organization_name,
				o.slug AS organization_slug, o.status AS organization_status,
				m.subject, m.user_id, m.email, m.roles_json, m.status, m.source_updated_at
			FROM organization_memberships m
			JOIN organizations o ON o.id = m.organization_id
			WHERE m.subject = ? AND m.status = 'active' AND o.status IN ('active', 'pending')
			ORDER BY o.name ASC, o.id ASC
		`).bind(subject).all<MembershipQueryRow>();
		return (result.results ?? []).map(mapMembership);
	}
	if (client.driver === 'postgres') {
		const rows = await client.raw<MembershipQueryRow[]>`
			SELECT
				o.id AS organization_id, o.name AS organization_name,
				o.slug AS organization_slug, o.status AS organization_status,
				m.subject, m.user_id, m.email, m.roles_json, m.status, m.source_updated_at
			FROM organization_memberships m
			JOIN organizations o ON o.id = m.organization_id
			WHERE m.subject = ${subject} AND m.status = 'active' AND o.status IN ('active', 'pending')
			ORDER BY o.name ASC, o.id ASC
		`;
		return rows.map(mapMembership);
	}
	const [rows] = await client.raw.execute<(MembershipQueryRow & RowDataPacket)[]>(`
		SELECT
			o.id AS organization_id, o.name AS organization_name,
			o.slug AS organization_slug, o.status AS organization_status,
			m.subject, m.user_id, m.email, m.roles_json, m.status, m.source_updated_at
		FROM organization_memberships m
		JOIN organizations o ON o.id = m.organization_id
		WHERE m.subject = ? AND m.status = 'active' AND o.status IN ('active', 'pending')
		ORDER BY o.name ASC, o.id ASC
	`, [subject]);
	return rows.map(mapMembership);
}

/** Link memberships delivered before the user's first CinaToken login. */
export async function linkOrganizationMembershipsToUser(
	client: GatewayDatabaseClient,
	subject: string,
	userId: string,
	nowIso = new Date().toISOString(),
): Promise<void> {
	if (client.driver === 'd1') {
		await client.raw.prepare(`
			UPDATE organization_memberships
			SET user_id = ?, updated_at = ?
			WHERE subject = ? AND (user_id IS NULL OR user_id = ?)
		`).bind(userId, nowIso, subject, userId).run();
		return;
	}
	if (client.driver === 'postgres') {
		await client.raw`
			UPDATE organization_memberships
			SET user_id = ${userId}, updated_at = ${nowIso}
			WHERE subject = ${subject} AND (user_id IS NULL OR user_id = ${userId})
		`;
		return;
	}
	await client.raw.execute(`
		UPDATE organization_memberships
		SET user_id = ?, updated_at = ?
		WHERE subject = ? AND (user_id IS NULL OR user_id = ?)
	`, [userId, nowIso, subject, userId]);
}
