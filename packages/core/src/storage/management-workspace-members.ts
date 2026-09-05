import type { RowDataPacket } from 'mysql2/promise';
import {
	assertManagementApiKeyAccount,
	type ManagementApiKeyAccount,
} from '../db/management-api-keys-types';
import { fromMySqlDateTime, mysqlExecute, mysqlQueryRows, toMySqlDateTime } from '../db/mysql/mysql2-compat';
import {
	managementWorkspaceRoleFromOrganizationRoles,
	type ManagementWorkspaceMemberListPage,
	type ManagementWorkspaceMemberMutationResult,
	type ManagementWorkspaceMemberRow,
	type ManagementWorkspaceMutationPrincipal,
} from '../management-workspaces';
import { workspaceMembershipKey } from '../workspaces';
import type { GatewayDatabaseClient } from './database-client';
import { getManagementWorkspace } from './management-workspaces';

type RawMemberRow = {
	id: string | null;
	workspace_id: string;
	user_id: string;
	roles_json: string;
	created_at: string | Date;
};

type MySqlMemberRow = RawMemberRow & RowDataPacket;

const MAX_MEMBER_IDS = 100;
const MAX_MEMBER_ID_LENGTH = 255;
const MAX_PAGE_OFFSET = 1_000_000;

function assertPage(offset: number, limit: number): void {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET) {
		throw new TypeError('offset must be a non-negative integer no greater than 1000000');
	}
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new TypeError('limit must be an integer between 1 and 100');
	}
}

export function normalizeManagementWorkspaceMemberIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MEMBER_IDS) {
		throw new TypeError('user_ids must contain between 1 and 100 user IDs');
	}
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== 'string') throw new TypeError('user_ids must contain only strings');
		const id = item.trim();
		if (!id || id.length > MAX_MEMBER_ID_LENGTH) throw new TypeError('user_ids contains an invalid user ID');
		if (seen.has(id)) throw new TypeError('user_ids must not contain duplicates');
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

function isoTimestamp(value: string | Date, mysql = false): string {
	if (mysql) return fromMySqlDateTime(value);
	if (value instanceof Date) return value.toISOString();
	const parsed = Date.parse(String(value));
	if (!Number.isFinite(parsed)) throw new TypeError('Workspace membership timestamp is invalid');
	return new Date(parsed).toISOString();
}

async function mapMember(
	row: RawMemberRow,
	adminRoles: ReadonlySet<string>,
	mysql = false,
): Promise<ManagementWorkspaceMemberRow> {
	return {
		id: row.id ?? await workspaceMembershipKey(row.workspace_id, row.user_id),
		workspace_id: row.workspace_id,
		user_id: row.user_id,
		role: managementWorkspaceRoleFromOrganizationRoles(row.roles_json, adminRoles),
		created_at: isoTimestamp(row.created_at, mysql),
	};
}

async function mapMembers(
	rows: RawMemberRow[],
	adminRoles: ReadonlySet<string>,
	mysql = false,
): Promise<ManagementWorkspaceMemberRow[]> {
	return Promise.all(rows.map((row) => mapMember(row, adminRoles, mysql)));
}

async function activeOrganizationMembers(
	client: GatewayDatabaseClient,
	organizationId: string,
	userIds: string[],
): Promise<RawMemberRow[]> {
	if (client.driver === 'd1') {
		const rows = await client.raw.prepare(`SELECT NULL AS id, '' AS workspace_id,
			membership.subject AS user_id, membership.roles_json, membership.created_at
			FROM organization_memberships membership
			WHERE membership.organization_id = ? AND membership.status = 'active'
				AND membership.subject IN (SELECT value FROM json_each(?))
			ORDER BY membership.subject ASC`)
			.bind(organizationId, JSON.stringify(userIds)).all<RawMemberRow>();
		return rows.results ?? [];
	}
	if (client.driver === 'postgres') {
		return client.raw.unsafe<RawMemberRow[]>(`SELECT NULL AS id, '' AS workspace_id,
			membership.subject AS user_id, membership.roles_json, membership.created_at
			FROM organization_memberships membership
			WHERE membership.organization_id = $1 AND membership.status = 'active'
				AND membership.subject = ANY($2::text[])
			ORDER BY membership.subject ASC`, [organizationId, userIds]);
	}
	const placeholders = userIds.map(() => '?').join(', ');
	return mysqlQueryRows<MySqlMemberRow>(client.raw, `SELECT NULL AS id, '' AS workspace_id,
		membership.subject AS user_id, membership.roles_json, membership.created_at
		FROM organization_memberships membership
		WHERE membership.organization_id = ? AND membership.status = 'active'
			AND membership.subject IN (${placeholders})
		ORDER BY membership.subject ASC`, [organizationId, ...userIds]);
}

async function explicitMembersBySubjects(
	client: GatewayDatabaseClient,
	workspaceId: string,
	userIds: string[],
): Promise<RawMemberRow[]> {
	if (client.driver === 'd1') {
		const rows = await client.raw.prepare(`SELECT membership.id, membership.workspace_id,
			membership.subject AS user_id, organization_membership.roles_json, membership.created_at
			FROM workspace_memberships membership
			JOIN workspaces workspace ON workspace.id = membership.workspace_id
			JOIN organization_memberships organization_membership
				ON organization_membership.organization_id = workspace.organization_id
				AND organization_membership.subject = membership.subject
				AND organization_membership.status = 'active'
			WHERE membership.workspace_id = ? AND membership.status = 'active'
				AND membership.subject IN (SELECT value FROM json_each(?))
			ORDER BY membership.subject ASC`)
			.bind(workspaceId, JSON.stringify(userIds)).all<RawMemberRow>();
		return rows.results ?? [];
	}
	if (client.driver === 'postgres') {
		return client.raw.unsafe<RawMemberRow[]>(`SELECT membership.id, membership.workspace_id,
			membership.subject AS user_id, organization_membership.roles_json, membership.created_at
			FROM workspace_memberships membership
			JOIN workspaces workspace ON workspace.id = membership.workspace_id
			JOIN organization_memberships organization_membership
				ON organization_membership.organization_id = workspace.organization_id
				AND organization_membership.subject = membership.subject
				AND organization_membership.status = 'active'
			WHERE membership.workspace_id = $1 AND membership.status = 'active'
				AND membership.subject = ANY($2::text[])
			ORDER BY membership.subject ASC`, [workspaceId, userIds]);
	}
	const placeholders = userIds.map(() => '?').join(', ');
	return mysqlQueryRows<MySqlMemberRow>(client.raw, `SELECT membership.id, membership.workspace_id,
		membership.subject AS user_id, organization_membership.roles_json, membership.created_at
		FROM workspace_memberships membership
		JOIN workspaces workspace ON workspace.id = membership.workspace_id
		JOIN organization_memberships organization_membership
			ON organization_membership.organization_id = workspace.organization_id
			AND organization_membership.subject = membership.subject
			AND organization_membership.status = 'active'
		WHERE membership.workspace_id = ? AND membership.status = 'active'
			AND membership.subject IN (${placeholders})
		ORDER BY membership.subject ASC`, [workspaceId, ...userIds]);
}

export async function listManagementWorkspaceMembers(
	client: GatewayDatabaseClient,
	account: ManagementApiKeyAccount,
	idOrSlug: string,
	page: { offset: number; limit: number },
	adminRoles: ReadonlySet<string>,
): Promise<ManagementWorkspaceMemberListPage | null> {
	assertPage(page.offset, page.limit);
	assertManagementApiKeyAccount(account);
	const workspace = await getManagementWorkspace(client, account, idOrSlug);
	if (!workspace) return null;

	if (client.driver === 'd1') {
		if (workspace.scope_type === 'personal') {
			const owner = await client.raw.prepare(`SELECT NULL AS id, ? AS workspace_id,
				principal_user.external_user_id AS user_id, '[]' AS roles_json, principal_user.created_at
				FROM users principal_user WHERE principal_user.id = ? AND principal_user.status = 'active'
					AND principal_user.external_system = 'cinaauth' AND principal_user.external_user_id IS NOT NULL`)
				.bind(workspace.id, workspace.personal_owner_user_id).first<RawMemberRow>();
			const data = owner && page.offset === 0 ? [await mapMember(owner, new Set<string>())] : [];
			if (data[0]) data[0].role = 'admin';
			return { data, totalCount: owner ? 1 : 0 };
		}
		const organizationId = workspace.organization_id!;
		const source = workspace.is_default
			? `FROM organization_memberships membership
				WHERE membership.organization_id = ? AND membership.status = 'active'`
			: `FROM workspace_memberships membership
				JOIN organization_memberships organization_membership
					ON organization_membership.organization_id = ?
					AND organization_membership.subject = membership.subject
					AND organization_membership.status = 'active'
				WHERE membership.workspace_id = ? AND membership.status = 'active'`;
		const countValues = workspace.is_default ? [organizationId] : [organizationId, workspace.id];
		const count = await client.raw.prepare(`SELECT COUNT(*) AS total_count ${source}`)
			.bind(...countValues).first<{ total_count: number | string }>();
		const select = workspace.is_default
			? `SELECT NULL AS id, ? AS workspace_id, membership.subject AS user_id,
				membership.roles_json, membership.created_at ${source}`
			: `SELECT membership.id, membership.workspace_id, membership.subject AS user_id,
				organization_membership.roles_json, membership.created_at ${source}`;
		const selectValues = workspace.is_default
			? [workspace.id, organizationId, page.limit, page.offset]
			: [organizationId, workspace.id, page.limit, page.offset];
		const rows = await client.raw.prepare(`${select} ORDER BY user_id ASC LIMIT ? OFFSET ?`)
			.bind(...selectValues).all<RawMemberRow>();
		return {
			data: await mapMembers(rows.results ?? [], adminRoles),
			totalCount: Number(count?.total_count ?? 0),
		};
	}

	if (client.driver === 'postgres') {
		if (workspace.scope_type === 'personal') {
			const rows = await client.raw.unsafe<RawMemberRow[]>(`SELECT NULL AS id, $1 AS workspace_id,
				"user".external_user_id AS user_id, '[]' AS roles_json, "user".created_at
				FROM users "user" WHERE "user".id = $2 AND "user".status = 'active'
					AND "user".external_system = 'cinaauth' AND "user".external_user_id IS NOT NULL`,
			[workspace.id, workspace.personal_owner_user_id]);
			const data = rows[0] && page.offset === 0 ? [await mapMember(rows[0], new Set<string>())] : [];
			if (data[0]) data[0].role = 'admin';
			return { data, totalCount: rows[0] ? 1 : 0 };
		}
		const organizationId = workspace.organization_id!;
		const source = workspace.is_default
			? `FROM organization_memberships membership
				WHERE membership.organization_id = $1 AND membership.status = 'active'`
			: `FROM workspace_memberships membership
				JOIN organization_memberships organization_membership
					ON organization_membership.organization_id = $1
					AND organization_membership.subject = membership.subject
					AND organization_membership.status = 'active'
				WHERE membership.workspace_id = $2 AND membership.status = 'active'`;
		const values = workspace.is_default ? [organizationId] : [organizationId, workspace.id];
		const counts = await client.raw.unsafe<Array<{ total_count: number | string }>>(`SELECT COUNT(*) AS total_count ${source}`, values);
		const paginationStart = values.length + 1;
		const select = workspace.is_default
			? `SELECT NULL AS id, $${paginationStart + 2} AS workspace_id, membership.subject AS user_id,
				membership.roles_json, membership.created_at ${source}`
			: `SELECT membership.id, membership.workspace_id, membership.subject AS user_id,
				organization_membership.roles_json, membership.created_at ${source}`;
		const rows = await client.raw.unsafe<RawMemberRow[]>(`${select}
			ORDER BY user_id ASC LIMIT $${paginationStart} OFFSET $${paginationStart + 1}`,
		workspace.is_default
			? [...values, page.limit, page.offset, workspace.id]
			: [...values, page.limit, page.offset]);
		return { data: await mapMembers(rows, adminRoles), totalCount: Number(counts[0]?.total_count ?? 0) };
	}

	if (workspace.scope_type === 'personal') {
		const rows = await mysqlQueryRows<MySqlMemberRow>(client.raw, `SELECT NULL AS id, ? AS workspace_id,
			principal_user.external_user_id AS user_id, '[]' AS roles_json, principal_user.created_at
			FROM users principal_user WHERE principal_user.id = ? AND principal_user.status = 'active'
				AND principal_user.external_system = 'cinaauth' AND principal_user.external_user_id IS NOT NULL`,
		[workspace.id, workspace.personal_owner_user_id]);
		const data = rows[0] && page.offset === 0 ? [await mapMember(rows[0], new Set<string>(), true)] : [];
		if (data[0]) data[0].role = 'admin';
		return { data, totalCount: rows[0] ? 1 : 0 };
	}
	const organizationId = workspace.organization_id!;
	const source = workspace.is_default
		? `FROM organization_memberships membership
			WHERE membership.organization_id = ? AND membership.status = 'active'`
		: `FROM workspace_memberships membership
			JOIN organization_memberships organization_membership
				ON organization_membership.organization_id = ?
				AND organization_membership.subject = membership.subject
				AND organization_membership.status = 'active'
			WHERE membership.workspace_id = ? AND membership.status = 'active'`;
	const values = workspace.is_default ? [organizationId] : [organizationId, workspace.id];
	const counts = await mysqlQueryRows<RowDataPacket & { total_count: number | string }>(client.raw,
		`SELECT COUNT(*) AS total_count ${source}`, values);
	const select = workspace.is_default
		? `SELECT NULL AS id, ? AS workspace_id, membership.subject AS user_id,
			membership.roles_json, membership.created_at ${source}`
		: `SELECT membership.id, membership.workspace_id, membership.subject AS user_id,
			organization_membership.roles_json, membership.created_at ${source}`;
	const rows = await mysqlQueryRows<MySqlMemberRow>(client.raw, `${select} ORDER BY user_id ASC LIMIT ? OFFSET ?`,
	workspace.is_default
		? [workspace.id, ...values, page.limit, page.offset]
		: [...values, page.limit, page.offset]);
	return { data: await mapMembers(rows, adminRoles, true), totalCount: Number(counts[0]?.total_count ?? 0) };
}

export async function addManagementWorkspaceMembers(
	client: GatewayDatabaseClient,
	principal: ManagementWorkspaceMutationPrincipal,
	idOrSlug: string,
	userIds: string[],
	adminRoles: ReadonlySet<string>,
	options: { nowIso?: string } = {},
): Promise<ManagementWorkspaceMemberMutationResult> {
	const account = principal.account;
	assertManagementApiKeyAccount(account);
	if (account.accountType !== 'organization') return { ok: false, reason: 'personal_workspace' };
	const workspace = await getManagementWorkspace(client, account, idOrSlug);
	if (!workspace) return { ok: false, reason: 'not_found' };
	if (workspace.scope_type !== 'organization' || !workspace.organization_id) {
		return { ok: false, reason: 'personal_workspace' };
	}
	const organizationMembers = await activeOrganizationMembers(client, workspace.organization_id, userIds);
	if (organizationMembers.length !== userIds.length) return { ok: false, reason: 'unknown_members' };
	if (workspace.is_default) {
		const projected = organizationMembers.map((member) => ({ ...member, workspace_id: workspace.id }));
		return { ok: true, data: await mapMembers(projected, adminRoles, client.driver === 'mysql'), changedCount: 0 };
	}

	const nowIso = isoTimestamp(options.nowIso ?? new Date().toISOString());
	const items = await Promise.all(userIds.map(async (subject) => ({
		id: crypto.randomUUID(),
		membershipKey: await workspaceMembershipKey(workspace.id, subject),
		subject,
	})));

	if (client.driver === 'd1') {
		const payload = JSON.stringify(items.map((item) => ({ id: item.id, key: item.membershipKey, subject: item.subject })));
		const mutation = client.raw.prepare(`WITH input AS (
			SELECT json_extract(value, '$.id') AS id,
				json_extract(value, '$.key') AS membership_key,
				json_extract(value, '$.subject') AS subject
			FROM json_each(?)
		)
		INSERT INTO workspace_memberships (
			id, membership_key, workspace_id, subject, role, status,
			granted_by_subject, created_at, updated_at
		)
		SELECT input.id, input.membership_key, workspace.id, input.subject,
			'member', 'active', NULL, ?, ?
		FROM input
		JOIN workspaces workspace ON workspace.id = ? AND workspace.status = 'active'
			AND workspace.scope_type = 'organization' AND workspace.is_default = 0
			AND workspace.organization_id = ? AND workspace.personal_owner_user_id IS NULL
		JOIN organization_memberships organization_member
			ON organization_member.organization_id = workspace.organization_id
			AND organization_member.subject = input.subject AND organization_member.status = 'active'
		JOIN management_api_keys management_key ON management_key.id = ?
			AND management_key.status = 'active'
			AND (management_key.expires_at IS NULL OR management_key.expires_at > datetime('now'))
			AND management_key.account_type = 'organization'
			AND management_key.personal_owner_user_id IS NULL
			AND management_key.organization_id = workspace.organization_id
			AND EXISTS (SELECT 1 FROM organizations owner
				WHERE owner.id = management_key.organization_id AND owner.status IN ('active', 'pending'))
		WHERE (SELECT COUNT(*) FROM input) = (
			SELECT COUNT(*) FROM input verify_input
			JOIN organization_memberships verify_member
				ON verify_member.organization_id = workspace.organization_id
				AND verify_member.subject = verify_input.subject AND verify_member.status = 'active'
		)
		ON CONFLICT(membership_key) DO UPDATE SET
			role = 'member', status = 'active', updated_at = excluded.updated_at`)
			.bind(payload, nowIso, nowIso, workspace.id, workspace.organization_id, principal.keyId);
		const audit = client.raw.prepare(`INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) SELECT ?, ?, NULL, 'workspace_members_added', 'service', ?,
			'gateway_management_workspaces', ?, 'workspace_members_add',
			'Workspace members added through Management API', ?
		FROM workspaces workspace JOIN management_api_keys management_key
			ON management_key.id = ? AND management_key.status = 'active'
			AND (management_key.expires_at IS NULL OR management_key.expires_at > datetime('now'))
			AND management_key.account_type = 'organization'
			AND management_key.personal_owner_user_id IS NULL
			AND management_key.organization_id = workspace.organization_id
			AND EXISTS (SELECT 1 FROM organizations owner
				WHERE owner.id = management_key.organization_id AND owner.status IN ('active', 'pending'))
		WHERE workspace.id = ? AND EXISTS (
			SELECT 1 FROM workspace_memberships membership
			WHERE membership.workspace_id = workspace.id AND membership.updated_at = ?
				AND membership.subject IN (SELECT value FROM json_each(?))
		)`).bind(
			crypto.randomUUID(), principal.createdByUserId,
			JSON.stringify({ workspace_id: workspace.id, user_ids: userIds }),
			`service:management_key:${principal.keyId}`, nowIso,
			principal.keyId, workspace.id, nowIso, JSON.stringify(userIds),
		);
		const results = await client.raw.batch([mutation, audit]);
		const changed = results[0]?.meta.changes ?? 0;
		if (changed === 0) return { ok: false, reason: 'not_found' };
		const rows = await explicitMembersBySubjects(client, workspace.id, userIds);
		return { ok: true, data: await mapMembers(rows, adminRoles), changedCount: changed };
	}

	if (client.driver === 'postgres') {
		const changed = await client.raw.begin(async (transaction) => {
			const authorized = await transaction.unsafe<Array<{ id: string }>>(`SELECT workspace.id
				FROM workspaces workspace JOIN management_api_keys management_key
					ON management_key.id = $2 AND management_key.status = 'active'
					AND (management_key.expires_at IS NULL OR management_key.expires_at > CURRENT_TIMESTAMP)
					AND management_key.account_type = 'organization'
					AND management_key.personal_owner_user_id IS NULL
					AND management_key.organization_id = workspace.organization_id
					AND EXISTS (SELECT 1 FROM organizations owner
						WHERE owner.id = management_key.organization_id AND owner.status IN ('active', 'pending'))
				WHERE workspace.id = $1 AND workspace.status = 'active'
					AND workspace.scope_type = 'organization' AND workspace.is_default = FALSE
					AND workspace.organization_id = $3 FOR UPDATE OF workspace, management_key`,
			[workspace.id, principal.keyId, workspace.organization_id]);
			if (authorized.length !== 1) return 0;
			const members = await transaction.unsafe<Array<{ subject: string }>>(`SELECT subject
				FROM organization_memberships WHERE organization_id = $1 AND status = 'active'
					AND subject = ANY($2::text[]) FOR UPDATE`, [workspace.organization_id, userIds]);
			if (members.length !== userIds.length) return -1;
			for (const item of items) {
				await transaction.unsafe(`INSERT INTO workspace_memberships (
					id, membership_key, workspace_id, subject, role, status,
					granted_by_subject, created_at, updated_at
				) VALUES ($1, $2, $3, $4, 'member', 'active', NULL, $5, $5)
				ON CONFLICT (membership_key) DO UPDATE SET role = 'member', status = 'active', updated_at = EXCLUDED.updated_at`,
				[item.id, item.membershipKey, workspace.id, item.subject, nowIso]);
			}
			await transaction.unsafe(`INSERT INTO user_audit_logs (
				id, user_id, api_key_id, event_type, actor_type, change_payload,
				source, actor_id, reason_code, reason_text, created_at
			) VALUES ($1, $2, NULL, 'workspace_members_added', 'service', $3,
				'gateway_management_workspaces', $4, 'workspace_members_add',
				'Workspace members added through Management API', $5)`, [
				crypto.randomUUID(), principal.createdByUserId,
				JSON.stringify({ workspace_id: workspace.id, user_ids: userIds }),
				`service:management_key:${principal.keyId}`, nowIso,
			]);
			return items.length;
		});
		if (changed < 0) return { ok: false, reason: 'unknown_members' };
		if (changed === 0) return { ok: false, reason: 'not_found' };
		const rows = await explicitMembersBySubjects(client, workspace.id, userIds);
		return { ok: true, data: await mapMembers(rows, adminRoles), changedCount: changed };
	}

	const connection = await client.raw.getConnection();
	try {
		await connection.beginTransaction();
		const authorized = await mysqlQueryRows<RowDataPacket & { id: string }>(connection, `SELECT workspace.id
			FROM workspaces workspace JOIN management_api_keys management_key
				ON management_key.id = ? AND management_key.status = 'active'
				AND (management_key.expires_at IS NULL OR management_key.expires_at > UTC_TIMESTAMP(6))
				AND management_key.account_type = 'organization'
				AND management_key.personal_owner_user_id IS NULL
				AND management_key.organization_id = workspace.organization_id
				AND EXISTS (SELECT 1 FROM organizations owner
					WHERE owner.id = management_key.organization_id AND owner.status IN ('active', 'pending'))
			WHERE workspace.id = ? AND workspace.status = 'active'
				AND workspace.scope_type = 'organization' AND workspace.is_default = FALSE
				AND workspace.organization_id = ? FOR UPDATE`,
		[principal.keyId, workspace.id, workspace.organization_id]);
		if (authorized.length !== 1) {
			await connection.rollback();
			return { ok: false, reason: 'not_found' };
		}
		const placeholders = userIds.map(() => '?').join(', ');
		const members = await mysqlQueryRows<RowDataPacket & { subject: string }>(connection,
			`SELECT subject FROM organization_memberships WHERE organization_id = ? AND status = 'active'
				AND subject IN (${placeholders}) FOR UPDATE`, [workspace.organization_id, ...userIds]);
		if (members.length !== userIds.length) {
			await connection.rollback();
			return { ok: false, reason: 'unknown_members' };
		}
		const mysqlNow = toMySqlDateTime(nowIso);
		for (const item of items) {
			await mysqlExecute(connection, `INSERT INTO workspace_memberships (
				id, membership_key, workspace_id, subject, role, status,
				granted_by_subject, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'member', 'active', NULL, ?, ?)
			ON DUPLICATE KEY UPDATE role = 'member', status = 'active', updated_at = VALUES(updated_at)`,
			[item.id, item.membershipKey, workspace.id, item.subject, mysqlNow, mysqlNow]);
		}
		await mysqlExecute(connection, `INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) VALUES (?, ?, NULL, 'workspace_members_added', 'service', ?,
			'gateway_management_workspaces', ?, 'workspace_members_add',
			'Workspace members added through Management API', ?)`, [
			crypto.randomUUID(), principal.createdByUserId,
			JSON.stringify({ workspace_id: workspace.id, user_ids: userIds }),
			`service:management_key:${principal.keyId}`, mysqlNow,
		]);
		await connection.commit();
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}
	const rows = await explicitMembersBySubjects(client, workspace.id, userIds);
	return { ok: true, data: await mapMembers(rows, adminRoles, true), changedCount: items.length };
}

async function hasActiveKeysForSubjects(
	client: GatewayDatabaseClient,
	workspaceId: string,
	userIds: string[],
): Promise<boolean> {
	if (client.driver === 'd1') {
		const row = await client.raw.prepare(`SELECT 1 AS present FROM api_keys api_key
			JOIN users principal_user ON principal_user.id = api_key.user_id
			WHERE api_key.workspace_id = ? AND api_key.status = 'active'
				AND principal_user.external_system = 'cinaauth'
				AND principal_user.external_user_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
			.bind(workspaceId, JSON.stringify(userIds)).first<{ present: number }>();
		return row !== null;
	}
	if (client.driver === 'postgres') {
		const rows = await client.raw.unsafe<Array<{ present: number }>>(`SELECT 1 AS present FROM api_keys api_key
			JOIN users "user" ON "user".id = api_key.user_id
			WHERE api_key.workspace_id = $1 AND api_key.status = 'active'
				AND "user".external_system = 'cinaauth'
				AND "user".external_user_id = ANY($2::text[]) LIMIT 1`, [workspaceId, userIds]);
		return rows.length > 0;
	}
	const placeholders = userIds.map(() => '?').join(', ');
	const rows = await mysqlQueryRows<RowDataPacket & { present: number }>(client.raw, `SELECT 1 AS present FROM api_keys api_key
		JOIN users principal_user ON principal_user.id = api_key.user_id
		WHERE api_key.workspace_id = ? AND api_key.status = 'active'
			AND principal_user.external_system = 'cinaauth'
			AND principal_user.external_user_id IN (${placeholders}) LIMIT 1`, [workspaceId, ...userIds]);
	return rows.length > 0;
}

export async function removeManagementWorkspaceMembers(
	client: GatewayDatabaseClient,
	principal: ManagementWorkspaceMutationPrincipal,
	idOrSlug: string,
	userIds: string[],
	options: { nowIso?: string } = {},
): Promise<ManagementWorkspaceMemberMutationResult> {
	const account = principal.account;
	assertManagementApiKeyAccount(account);
	if (account.accountType !== 'organization') return { ok: false, reason: 'personal_workspace' };
	const workspace = await getManagementWorkspace(client, account, idOrSlug);
	if (!workspace) return { ok: false, reason: 'not_found' };
	if (workspace.scope_type !== 'organization') return { ok: false, reason: 'personal_workspace' };
	if (workspace.is_default) return { ok: false, reason: 'default_workspace' };
	if (await hasActiveKeysForSubjects(client, workspace.id, userIds)) {
		return { ok: false, reason: 'active_keys' };
	}
	const before = await explicitMembersBySubjects(client, workspace.id, userIds);
	const nowIso = isoTimestamp(options.nowIso ?? new Date().toISOString());

	if (client.driver === 'd1') {
		const mutation = client.raw.prepare(`UPDATE workspace_memberships AS membership
			SET status = 'removed', updated_at = ?
			WHERE membership.workspace_id = ? AND membership.status = 'active'
				AND membership.subject IN (SELECT value FROM json_each(?))
				AND EXISTS (
					SELECT 1 FROM workspaces workspace
					JOIN management_api_keys management_key
						ON management_key.id = ? AND management_key.status = 'active'
						AND (management_key.expires_at IS NULL OR management_key.expires_at > datetime('now'))
						AND management_key.account_type = 'organization'
						AND management_key.personal_owner_user_id IS NULL
						AND management_key.organization_id = workspace.organization_id
						AND EXISTS (SELECT 1 FROM organizations owner
							WHERE owner.id = management_key.organization_id AND owner.status IN ('active', 'pending'))
					WHERE workspace.id = membership.workspace_id AND workspace.status = 'active'
						AND workspace.scope_type = 'organization' AND workspace.is_default = 0
						AND workspace.organization_id = ?
				)
				AND NOT EXISTS (
					SELECT 1 FROM api_keys active_key JOIN users active_user ON active_user.id = active_key.user_id
					WHERE active_key.workspace_id = membership.workspace_id AND active_key.status = 'active'
						AND active_user.external_system = 'cinaauth'
						AND active_user.external_user_id IN (SELECT value FROM json_each(?))
				)`)
			.bind(
				nowIso, workspace.id, JSON.stringify(userIds), principal.keyId,
				workspace.organization_id, JSON.stringify(userIds),
			);
		const audit = client.raw.prepare(`INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) SELECT ?, ?, NULL, 'workspace_members_removed', 'service', ?,
			'gateway_management_workspaces', ?, 'workspace_members_remove',
			'Workspace members removed through Management API', ?
		FROM workspaces workspace JOIN management_api_keys management_key
			ON management_key.id = ? AND management_key.status = 'active'
			AND (management_key.expires_at IS NULL OR management_key.expires_at > datetime('now'))
			AND management_key.account_type = 'organization'
			AND management_key.personal_owner_user_id IS NULL
			AND management_key.organization_id = workspace.organization_id
			AND EXISTS (SELECT 1 FROM organizations owner
				WHERE owner.id = management_key.organization_id AND owner.status IN ('active', 'pending'))
		WHERE workspace.id = ? AND EXISTS (
			SELECT 1 FROM workspace_memberships membership
			WHERE membership.workspace_id = workspace.id AND membership.status = 'removed'
				AND membership.updated_at = ?
				AND membership.subject IN (SELECT value FROM json_each(?))
		)`).bind(
			crypto.randomUUID(), principal.createdByUserId,
			JSON.stringify({ workspace_id: workspace.id, user_ids: userIds }),
			`service:management_key:${principal.keyId}`, nowIso,
			principal.keyId, workspace.id, nowIso, JSON.stringify(userIds),
		);
		const results = await client.raw.batch([mutation, audit]);
		const changed = results[0]?.meta.changes ?? 0;
		if (changed < before.length && await hasActiveKeysForSubjects(client, workspace.id, userIds)) {
			return { ok: false, reason: 'active_keys' };
		}
		if (changed === 0 && before.length > 0) return { ok: false, reason: 'not_found' };
		return { ok: true, data: [], changedCount: changed };
	}

	if (client.driver === 'postgres') {
		const result = await client.raw.begin(async (transaction) => {
			const authorized = await transaction.unsafe<Array<{ id: string }>>(`SELECT workspace.id
				FROM workspaces workspace JOIN management_api_keys management_key
					ON management_key.id = $2 AND management_key.status = 'active'
					AND (management_key.expires_at IS NULL OR management_key.expires_at > CURRENT_TIMESTAMP)
					AND management_key.account_type = 'organization'
					AND management_key.personal_owner_user_id IS NULL
					AND management_key.organization_id = workspace.organization_id
					AND EXISTS (SELECT 1 FROM organizations owner
						WHERE owner.id = management_key.organization_id AND owner.status IN ('active', 'pending'))
				WHERE workspace.id = $1 AND workspace.status = 'active'
					AND workspace.scope_type = 'organization' AND workspace.is_default = FALSE
					AND workspace.organization_id = $3 FOR UPDATE OF workspace, management_key`,
			[workspace.id, principal.keyId, workspace.organization_id]);
			if (authorized.length !== 1) return null;
			const active = await transaction.unsafe<Array<{ id: string }>>(`SELECT api_key.id FROM api_keys api_key
				JOIN users "user" ON "user".id = api_key.user_id
				WHERE api_key.workspace_id = $1 AND api_key.status = 'active'
					AND "user".external_system = 'cinaauth'
					AND "user".external_user_id = ANY($2::text[]) LIMIT 1 FOR UPDATE OF api_key`,
			[workspace.id, userIds]);
			if (active.length > 0) return -1;
			const removed = await transaction.unsafe<Array<{ id: string }>>(`UPDATE workspace_memberships
				SET status = 'removed', updated_at = $1
				WHERE workspace_id = $2 AND status = 'active' AND subject = ANY($3::text[])
				RETURNING id`, [nowIso, workspace.id, userIds]);
			if (removed.length > 0) {
				await transaction.unsafe(`INSERT INTO user_audit_logs (
					id, user_id, api_key_id, event_type, actor_type, change_payload,
					source, actor_id, reason_code, reason_text, created_at
				) VALUES ($1, $2, NULL, 'workspace_members_removed', 'service', $3,
					'gateway_management_workspaces', $4, 'workspace_members_remove',
					'Workspace members removed through Management API', $5)`, [
					crypto.randomUUID(), principal.createdByUserId,
					JSON.stringify({ workspace_id: workspace.id, user_ids: userIds }),
					`service:management_key:${principal.keyId}`, nowIso,
				]);
			}
			return removed.length;
		});
		if (result === null) return { ok: false, reason: 'not_found' };
		if (result < 0) return { ok: false, reason: 'active_keys' };
		return { ok: true, data: [], changedCount: result };
	}

	const connection = await client.raw.getConnection();
	try {
		await connection.beginTransaction();
		const authorized = await mysqlQueryRows<RowDataPacket & { id: string }>(connection, `SELECT workspace.id
			FROM workspaces workspace JOIN management_api_keys management_key
				ON management_key.id = ? AND management_key.status = 'active'
				AND (management_key.expires_at IS NULL OR management_key.expires_at > UTC_TIMESTAMP(6))
				AND management_key.account_type = 'organization'
				AND management_key.personal_owner_user_id IS NULL
				AND management_key.organization_id = workspace.organization_id
				AND EXISTS (SELECT 1 FROM organizations owner
					WHERE owner.id = management_key.organization_id AND owner.status IN ('active', 'pending'))
			WHERE workspace.id = ? AND workspace.status = 'active'
				AND workspace.scope_type = 'organization' AND workspace.is_default = FALSE
				AND workspace.organization_id = ? FOR UPDATE`,
		[principal.keyId, workspace.id, workspace.organization_id]);
		if (authorized.length !== 1) {
			await connection.rollback();
			return { ok: false, reason: 'not_found' };
		}
		const placeholders = userIds.map(() => '?').join(', ');
		const active = await mysqlQueryRows<RowDataPacket & { id: string }>(connection, `SELECT api_key.id FROM api_keys api_key
			JOIN users principal_user ON principal_user.id = api_key.user_id
			WHERE api_key.workspace_id = ? AND api_key.status = 'active'
				AND principal_user.external_system = 'cinaauth'
				AND principal_user.external_user_id IN (${placeholders}) LIMIT 1 FOR UPDATE`,
		[workspace.id, ...userIds]);
		if (active.length > 0) {
			await connection.rollback();
			return { ok: false, reason: 'active_keys' };
		}
		const removed = await mysqlExecute(connection, `UPDATE workspace_memberships
			SET status = 'removed', updated_at = ?
			WHERE workspace_id = ? AND status = 'active' AND subject IN (${placeholders})`,
		[toMySqlDateTime(nowIso), workspace.id, ...userIds]);
		if (removed.affectedRows > 0) {
			await mysqlExecute(connection, `INSERT INTO user_audit_logs (
				id, user_id, api_key_id, event_type, actor_type, change_payload,
				source, actor_id, reason_code, reason_text, created_at
			) VALUES (?, ?, NULL, 'workspace_members_removed', 'service', ?,
				'gateway_management_workspaces', ?, 'workspace_members_remove',
				'Workspace members removed through Management API', ?)`, [
				crypto.randomUUID(), principal.createdByUserId,
				JSON.stringify({ workspace_id: workspace.id, user_ids: userIds }),
				`service:management_key:${principal.keyId}`, toMySqlDateTime(nowIso),
			]);
		}
		await connection.commit();
		return { ok: true, data: [], changedCount: removed.affectedRows };
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}
}
