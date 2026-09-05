import type { RowDataPacket } from 'mysql2/promise';
import {
	assertManagementApiKeyAccount,
	type ManagementApiKeyAccount,
} from '../db/management-api-keys-types';
import {
	fromMySqlDateTime,
	mysqlExecute,
	mysqlQueryRows,
	toMySqlDateTime,
} from '../db/mysql/mysql2-compat';
import type {
	ManagementGuardrailAssignmentMutationResult,
	ManagementGuardrailAssignmentPage,
	ManagementGuardrailKeyAssignment,
	ManagementGuardrailMemberAssignment,
	ManagementGuardrailMutationPrincipal,
} from '../management-guardrails';
import type { GatewayDatabaseClient } from './database-client';
import { getManagementGuardrail } from './management-guardrails';

type AssignmentKind = 'keys' | 'members';
type AssignmentAction = 'assign' | 'unassign';
type RawKeyAssignment = Omit<ManagementGuardrailKeyAssignment, 'created_at'> & {
	created_at: string | Date;
};
type RawMemberAssignment = Omit<ManagementGuardrailMemberAssignment, 'created_at'> & {
	created_at: string | Date;
};
type MySqlKeyAssignment = RawKeyAssignment & RowDataPacket;
type MySqlMemberAssignment = RawMemberAssignment & RowDataPacket;
type TargetRow = { id: string };
type MySqlTargetRow = TargetRow & RowDataPacket;

const MAX_PAGE_OFFSET = 1_000_000;
const MAX_GUARDRAIL_ID_LENGTH = 128;

function assertPage(offset: number, limit: number): void {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET) {
		throw new TypeError('offset must be a non-negative integer no greater than 1000000');
	}
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new TypeError('limit must be an integer between 1 and 100');
	}
}

function guardrailId(value: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_GUARDRAIL_ID_LENGTH) {
		throw new TypeError('guardrail id is invalid');
	}
	return normalized;
}

function isoTimestamp(value: string | Date, mysql = false): string {
	if (mysql) return fromMySqlDateTime(value);
	if (value instanceof Date) return value.toISOString();
	const parsed = Date.parse(String(value));
	if (!Number.isFinite(parsed)) throw new TypeError('Guardrail assignment timestamp is invalid');
	return new Date(parsed).toISOString();
}

function mapKey(row: RawKeyAssignment, mysql = false): ManagementGuardrailKeyAssignment {
	return { ...row, created_at: isoTimestamp(row.created_at, mysql) };
}

function mapMember(row: RawMemberAssignment, mysql = false): ManagementGuardrailMemberAssignment {
	return { ...row, created_at: isoTimestamp(row.created_at, mysql) };
}

function d1AccountPredicate(account: ManagementApiKeyAccount, alias = 'workspace') {
	assertManagementApiKeyAccount(account);
	return account.accountType === 'personal'
		? {
			sql: `${alias}.scope_type = 'personal' AND ${alias}.personal_owner_user_id = ? AND ${alias}.organization_id IS NULL`,
			values: [account.personalOwnerUserId],
		}
		: {
			sql: `${alias}.scope_type = 'organization' AND ${alias}.personal_owner_user_id IS NULL AND ${alias}.organization_id = ?`,
			values: [account.organizationId],
		};
}

function postgresAccountPredicate(account: ManagementApiKeyAccount, alias: string, parameter: number) {
	assertManagementApiKeyAccount(account);
	return account.accountType === 'personal'
		? {
			sql: `${alias}.scope_type = 'personal' AND ${alias}.personal_owner_user_id = $${parameter} AND ${alias}.organization_id IS NULL`,
			value: account.personalOwnerUserId,
		}
		: {
			sql: `${alias}.scope_type = 'organization' AND ${alias}.personal_owner_user_id IS NULL AND ${alias}.organization_id = $${parameter}`,
			value: account.organizationId,
		};
}

function mysqlAccountPredicate(account: ManagementApiKeyAccount, alias = 'workspace') {
	assertManagementApiKeyAccount(account);
	return account.accountType === 'personal'
		? {
			sql: `${alias}.scope_type = 'personal' AND ${alias}.personal_owner_user_id = ? AND ${alias}.organization_id IS NULL`,
			value: account.personalOwnerUserId,
		}
		: {
			sql: `${alias}.scope_type = 'organization' AND ${alias}.personal_owner_user_id IS NULL AND ${alias}.organization_id = ?`,
			value: account.organizationId,
		};
}

const KEY_COLUMNS = `assignment.id, assignment.guardrail_id,
	CASE WHEN api_key.key_hash LIKE 'sha256:%' THEN substr(api_key.key_hash, 8) ELSE api_key.key_hash END AS key_hash,
	COALESCE(api_key.key_preview, api_key.name, '') AS key_label,
	COALESCE(api_key.name, '') AS key_name,
	COALESCE(actor.external_user_id, actor.id, assignment.management_source, 'admin') AS assigned_by,
	assignment.created_at`;

const MEMBER_COLUMNS = `assignment.id, assignment.guardrail_id,
	workspace.organization_id,
	COALESCE((SELECT membership.subject FROM organization_memberships membership
		WHERE membership.organization_id = workspace.organization_id AND membership.user_id = member.id
		ORDER BY membership.status, membership.subject LIMIT 1), member.external_user_id, member.id) AS user_id,
	COALESCE(actor.external_user_id, actor.id, assignment.management_source, 'admin') AS assigned_by,
	assignment.created_at`;

export async function listManagementGuardrailKeyAssignments(
	client: GatewayDatabaseClient,
	account: ManagementApiKeyAccount,
	guardrailReference: string | null,
	page: { offset: number; limit: number },
): Promise<ManagementGuardrailAssignmentPage<ManagementGuardrailKeyAssignment> | null> {
	assertPage(page.offset, page.limit);
	const normalizedId = guardrailReference === null ? null : guardrailId(guardrailReference);
	if (normalizedId !== null && !(await getManagementGuardrail(client, account, normalizedId))) return null;

	if (client.driver === 'd1') {
		const scope = d1AccountPredicate(account);
		const guardrailFilter = normalizedId === null ? '' : ' AND assignment.guardrail_id = ?';
		const values = [...scope.values, ...(normalizedId === null ? [] : [normalizedId])];
		const from = `FROM guardrail_assignments assignment
			JOIN guardrails guardrail ON guardrail.id = assignment.guardrail_id
			JOIN workspaces workspace ON workspace.id = assignment.workspace_id
			JOIN api_keys api_key ON api_key.id = assignment.scope_id
				AND api_key.workspace_id = assignment.workspace_id
			LEFT JOIN users actor ON actor.id = COALESCE(assignment.assigned_by_user_id, assignment.created_by_user_id)
			WHERE assignment.scope_type = 'api_key' AND api_key.key_hash IS NOT NULL
				AND workspace.status = 'active' AND ${scope.sql}${guardrailFilter}`;
		const total = await client.raw.prepare(`SELECT COUNT(*) AS total ${from}`)
			.bind(...values).first<{ total: number }>();
		const rows = await client.raw.prepare(`SELECT ${KEY_COLUMNS} ${from}
			ORDER BY assignment.created_at DESC, assignment.id ASC LIMIT ? OFFSET ?`)
			.bind(...values, page.limit, page.offset).all<RawKeyAssignment>();
		return { data: (rows.results ?? []).map((row) => mapKey(row)), totalCount: Number(total?.total ?? 0) };
	}

	if (client.driver === 'postgres') {
		const scope = postgresAccountPredicate(account, 'workspace', 1);
		const guardrailFilter = normalizedId === null ? '' : ' AND assignment.guardrail_id = $2';
		const values = [scope.value, ...(normalizedId === null ? [] : [normalizedId])];
		const pageStart = values.length + 1;
		const from = `FROM guardrail_assignments assignment
			JOIN guardrails guardrail ON guardrail.id = assignment.guardrail_id
			JOIN workspaces workspace ON workspace.id = assignment.workspace_id
			JOIN api_keys api_key ON api_key.id = assignment.scope_id
				AND api_key.workspace_id = assignment.workspace_id
			LEFT JOIN users actor ON actor.id = COALESCE(assignment.assigned_by_user_id, assignment.created_by_user_id)
			WHERE assignment.scope_type = 'api_key' AND api_key.key_hash IS NOT NULL
				AND workspace.status = 'active' AND ${scope.sql}${guardrailFilter}`;
		const total = (await client.raw.unsafe<Array<{ total: string | number }>>(`SELECT COUNT(*) AS total ${from}`, values))[0];
		const rows = await client.raw.unsafe<RawKeyAssignment[]>(`SELECT ${KEY_COLUMNS} ${from}
			ORDER BY assignment.created_at DESC, assignment.id ASC LIMIT $${pageStart} OFFSET $${pageStart + 1}`,
		[...values, page.limit, page.offset]);
		return { data: rows.map((row) => mapKey(row)), totalCount: Number(total?.total ?? 0) };
	}

	const scope = mysqlAccountPredicate(account);
	const guardrailFilter = normalizedId === null ? '' : ' AND assignment.guardrail_id = ?';
	const values = [scope.value, ...(normalizedId === null ? [] : [normalizedId])];
	const from = `FROM guardrail_assignments assignment
		JOIN guardrails guardrail ON guardrail.id = assignment.guardrail_id
		JOIN workspaces workspace ON workspace.id = assignment.workspace_id
		JOIN api_keys api_key ON api_key.id = assignment.scope_id
			AND api_key.workspace_id = assignment.workspace_id
		LEFT JOIN users actor ON actor.id = COALESCE(assignment.assigned_by_user_id, assignment.created_by_user_id)
		WHERE assignment.scope_type = 'api_key' AND api_key.key_hash IS NOT NULL
			AND workspace.status = 'active' AND ${scope.sql}${guardrailFilter}`;
	const total = (await mysqlQueryRows<RowDataPacket & { total: string | number }>(client.raw,
		`SELECT COUNT(*) AS total ${from}`, values))[0];
	const rows = await mysqlQueryRows<MySqlKeyAssignment>(client.raw, `SELECT ${KEY_COLUMNS} ${from}
		ORDER BY assignment.created_at DESC, assignment.id ASC LIMIT ? OFFSET ?`,
	[...values, page.limit, page.offset]);
	return { data: rows.map((row) => mapKey(row, true)), totalCount: Number(total?.total ?? 0) };
}

export async function listManagementGuardrailMemberAssignments(
	client: GatewayDatabaseClient,
	account: ManagementApiKeyAccount,
	guardrailReference: string | null,
	page: { offset: number; limit: number },
): Promise<ManagementGuardrailAssignmentPage<ManagementGuardrailMemberAssignment> | null> {
	assertPage(page.offset, page.limit);
	const normalizedId = guardrailReference === null ? null : guardrailId(guardrailReference);
	if (normalizedId !== null && !(await getManagementGuardrail(client, account, normalizedId))) return null;
	if (account.accountType !== 'organization') return { data: [], totalCount: 0 };

	if (client.driver === 'd1') {
		const scope = d1AccountPredicate(account);
		const guardrailFilter = normalizedId === null ? '' : ' AND assignment.guardrail_id = ?';
		const values = [...scope.values, ...(normalizedId === null ? [] : [normalizedId])];
		const from = `FROM guardrail_assignments assignment
			JOIN guardrails guardrail ON guardrail.id = assignment.guardrail_id
			JOIN workspaces workspace ON workspace.id = assignment.workspace_id
			JOIN users member ON member.id = assignment.scope_id
			LEFT JOIN users actor ON actor.id = COALESCE(assignment.assigned_by_user_id, assignment.created_by_user_id)
			WHERE assignment.scope_type = 'user' AND workspace.organization_id IS NOT NULL
				AND workspace.status = 'active' AND ${scope.sql}${guardrailFilter}`;
		const total = await client.raw.prepare(`SELECT COUNT(*) AS total ${from}`)
			.bind(...values).first<{ total: number }>();
		const rows = await client.raw.prepare(`SELECT ${MEMBER_COLUMNS} ${from}
			ORDER BY assignment.created_at DESC, assignment.id ASC LIMIT ? OFFSET ?`)
			.bind(...values, page.limit, page.offset).all<RawMemberAssignment>();
		return { data: (rows.results ?? []).map((row) => mapMember(row)), totalCount: Number(total?.total ?? 0) };
	}

	if (client.driver === 'postgres') {
		const scope = postgresAccountPredicate(account, 'workspace', 1);
		const guardrailFilter = normalizedId === null ? '' : ' AND assignment.guardrail_id = $2';
		const values = [scope.value, ...(normalizedId === null ? [] : [normalizedId])];
		const pageStart = values.length + 1;
		const from = `FROM guardrail_assignments assignment
			JOIN guardrails guardrail ON guardrail.id = assignment.guardrail_id
			JOIN workspaces workspace ON workspace.id = assignment.workspace_id
			JOIN users member ON member.id = assignment.scope_id
			LEFT JOIN users actor ON actor.id = COALESCE(assignment.assigned_by_user_id, assignment.created_by_user_id)
			WHERE assignment.scope_type = 'user' AND workspace.organization_id IS NOT NULL
				AND workspace.status = 'active' AND ${scope.sql}${guardrailFilter}`;
		const total = (await client.raw.unsafe<Array<{ total: string | number }>>(
			`SELECT COUNT(*) AS total ${from}`, values))[0];
		const rows = await client.raw.unsafe<RawMemberAssignment[]>(`SELECT ${MEMBER_COLUMNS} ${from}
			ORDER BY assignment.created_at DESC, assignment.id ASC LIMIT $${pageStart} OFFSET $${pageStart + 1}`,
		[...values, page.limit, page.offset]);
		return { data: rows.map((row) => mapMember(row)), totalCount: Number(total?.total ?? 0) };
	}

	const scope = mysqlAccountPredicate(account);
	const guardrailFilter = normalizedId === null ? '' : ' AND assignment.guardrail_id = ?';
	const values = [scope.value, ...(normalizedId === null ? [] : [normalizedId])];
	const from = `FROM guardrail_assignments assignment
		JOIN guardrails guardrail ON guardrail.id = assignment.guardrail_id
		JOIN workspaces workspace ON workspace.id = assignment.workspace_id
		JOIN users member ON member.id = assignment.scope_id
		LEFT JOIN users actor ON actor.id = COALESCE(assignment.assigned_by_user_id, assignment.created_by_user_id)
		WHERE assignment.scope_type = 'user' AND workspace.organization_id IS NOT NULL
			AND workspace.status = 'active' AND ${scope.sql}${guardrailFilter}`;
	const total = (await mysqlQueryRows<RowDataPacket & { total: string | number }>(client.raw,
		`SELECT COUNT(*) AS total ${from}`, values))[0];
	const rows = await mysqlQueryRows<MySqlMemberAssignment>(client.raw, `SELECT ${MEMBER_COLUMNS} ${from}
		ORDER BY assignment.created_at DESC, assignment.id ASC LIMIT ? OFFSET ?`,
	[...values, page.limit, page.offset]);
	return { data: rows.map((row) => mapMember(row, true)), totalCount: Number(total?.total ?? 0) };
}

function auditPayload(
	action: AssignmentAction,
	kind: AssignmentKind,
	guardrailReference: string,
	requestedCount: number,
	affectedCount: number,
): string {
	return JSON.stringify({
		v: 1,
		action,
		assignment_kind: kind,
		guardrail_id: guardrailReference,
		requested_count: requestedCount,
		affected_count: affectedCount,
	});
}

function d1ActiveKeyPredicate(principal: ManagementGuardrailMutationPrincipal, alias = 'management_key') {
	assertManagementApiKeyAccount(principal.account);
	const accountValue = principal.account.accountType === 'personal'
		? principal.account.personalOwnerUserId : principal.account.organizationId;
	return principal.account.accountType === 'personal'
		? {
			sql: `${alias}.id = ? AND ${alias}.status = 'active'
				AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > datetime('now'))
				AND ${alias}.account_type = 'personal' AND ${alias}.personal_owner_user_id = ?
				AND ${alias}.organization_id IS NULL`,
			values: [principal.keyId, accountValue],
		}
		: {
			sql: `${alias}.id = ? AND ${alias}.status = 'active'
				AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > datetime('now'))
				AND ${alias}.account_type = 'organization' AND ${alias}.personal_owner_user_id IS NULL
				AND ${alias}.organization_id = ?`,
			values: [principal.keyId, accountValue],
		};
}

async function mutateD1(
	client: Extract<GatewayDatabaseClient, { driver: 'd1' }>,
	principal: ManagementGuardrailMutationPrincipal,
	guardrailReference: string,
	kind: AssignmentKind,
	action: AssignmentAction,
	values: string[],
	nowIso: string,
): Promise<ManagementGuardrailAssignmentMutationResult> {
	const scope = d1AccountPredicate(principal.account);
	const key = d1ActiveKeyPredicate(principal);
	const authorized = await client.raw.prepare(`SELECT guardrail.workspace_id
		FROM guardrails guardrail
		JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
		JOIN management_api_keys management_key ON ${key.sql}
		JOIN users creator ON creator.id = ? AND creator.status = 'active'
		WHERE guardrail.id = ? AND guardrail.status = 'active'
			AND guardrail.is_workspace_default = 0 AND guardrail.is_account_default = 0
			AND workspace.status = 'active' AND ${scope.sql}`)
		.bind(...key.values, principal.createdByUserId, guardrailReference, ...scope.values)
		.first<{ workspace_id: string }>();
	if (!authorized) return { status: 'not_found' };

	const placeholders = values.map(() => '?').join(', ');
	const targets = kind === 'keys'
		? await client.raw.prepare(`SELECT api_key.id FROM api_keys api_key
			WHERE api_key.workspace_id = ? AND api_key.key_hash IN (${placeholders})
			ORDER BY api_key.id`).bind(authorized.workspace_id, ...values.map((hash) => `sha256:${hash}`)).all<TargetRow>()
		: await client.raw.prepare(`SELECT DISTINCT membership.user_id AS id
			FROM organization_memberships membership
			JOIN users member ON member.id = membership.user_id${action === 'assign' ? " AND member.status = 'active'" : ''}
			WHERE membership.organization_id = ?${action === 'assign' ? " AND membership.status = 'active'" : ''}
				AND membership.user_id IS NOT NULL AND membership.subject IN (${placeholders})
			ORDER BY membership.user_id`).bind(principal.account.organizationId, ...values).all<TargetRow>();
	const targetIds = [...new Set((targets.results ?? []).map((row) => row.id))];
	if (targetIds.length === 0) return { status: 'ok', count: 0 };

	const scopeType = kind === 'keys' ? 'api_key' : 'user';
	const auditEvent = kind === 'keys' ? 'guardrail_key_assignments_updated' : 'guardrail_member_assignments_updated';
	if (action === 'unassign') {
		const targetPlaceholders = targetIds.map(() => '?').join(', ');
		const audit = client.raw.prepare(`INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) SELECT ?, ?, NULL, ?, 'service',
			json_object('v', 1, 'action', 'unassign', 'assignment_kind', ?,
				'guardrail_id', ?, 'requested_count', ?, 'affected_count', COUNT(*)),
			'gateway_management_guardrails', ?, ?, ?, ?
			FROM guardrail_assignments assignment
			WHERE assignment.workspace_id = ? AND assignment.guardrail_id = ?
				AND assignment.scope_type = ? AND assignment.scope_id IN (${targetPlaceholders})
				AND EXISTS (SELECT 1 FROM management_api_keys management_key
					JOIN users creator ON creator.id = ? AND creator.status = 'active'
					WHERE ${key.sql}) HAVING COUNT(*) > 0`)
			.bind(crypto.randomUUID(), principal.createdByUserId, auditEvent, kind,
				guardrailReference, values.length, `service:management_key:${principal.keyId}`,
				`guardrail_${kind}_unassign`, `Guardrail ${kind} unassigned through Management API`,
				nowIso, authorized.workspace_id, guardrailReference, scopeType, ...targetIds,
				principal.createdByUserId, ...key.values);
		const remove = client.raw.prepare(`DELETE FROM guardrail_assignments
			WHERE workspace_id = ? AND guardrail_id = ? AND scope_type = ?
				AND scope_id IN (${targetPlaceholders})
				AND EXISTS (SELECT 1 FROM management_api_keys management_key
					JOIN users creator ON creator.id = ? AND creator.status = 'active'
					WHERE ${key.sql})`)
			.bind(authorized.workspace_id, guardrailReference, scopeType, ...targetIds,
				principal.createdByUserId, ...key.values);
		const results = await client.raw.batch([audit, remove]);
		return { status: 'ok', count: Number(results[1]?.meta.changes ?? 0) };
	}

	const statements = [];
	for (const targetId of targetIds) {
		const targetJoin = kind === 'keys'
			? 'JOIN api_keys target ON target.id = ? AND target.workspace_id = guardrail.workspace_id'
			: `JOIN organization_memberships target_membership
					ON target_membership.organization_id = workspace.organization_id
					AND target_membership.user_id = ? AND target_membership.status = 'active'
				JOIN users target_member ON target_member.id = target_membership.user_id
					AND target_member.status = 'active'`;
		statements.push(client.raw.prepare(`INSERT INTO guardrail_assignments (
				id, workspace_id, guardrail_id, scope_type, scope_id, created_by_user_id,
				management_source, assigned_by_user_id, created_at
			) SELECT ?, guardrail.workspace_id, guardrail.id, ?, ?, NULL,
				'management_api', ?, ? FROM guardrails guardrail
				JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
				${targetJoin}
				JOIN management_api_keys management_key ON ${key.sql}
				JOIN users creator ON creator.id = ? AND creator.status = 'active'
				WHERE guardrail.id = ? AND guardrail.status = 'active'
					AND guardrail.is_workspace_default = 0 AND guardrail.is_account_default = 0
					AND workspace.status = 'active' AND ${scope.sql}
				ON CONFLICT(workspace_id, scope_type, scope_id) DO UPDATE SET
					guardrail_id = excluded.guardrail_id, created_by_user_id = NULL,
					management_source = 'management_api', assigned_by_user_id = excluded.assigned_by_user_id,
					created_at = excluded.created_at`)
			.bind(crypto.randomUUID(), scopeType, targetId, principal.createdByUserId, nowIso,
				targetId, ...key.values, principal.createdByUserId, guardrailReference, ...scope.values));
	}
	const targetPlaceholders = targetIds.map(() => '?').join(', ');
	const affectedTargetJoin = kind === 'keys'
		? 'JOIN api_keys target ON target.id = assignment.scope_id AND target.workspace_id = assignment.workspace_id'
		: `JOIN workspaces target_workspace ON target_workspace.id = assignment.workspace_id
			JOIN organization_memberships target_membership
				ON target_membership.organization_id = target_workspace.organization_id
				AND target_membership.user_id = assignment.scope_id AND target_membership.status = 'active'
			JOIN users target_member ON target_member.id = target_membership.user_id
				AND target_member.status = 'active'`;
	statements.push(client.raw.prepare(`INSERT INTO user_audit_logs (
		id, user_id, api_key_id, event_type, actor_type, change_payload,
		source, actor_id, reason_code, reason_text, created_at
	) SELECT ?, ?, NULL, ?, 'service',
		json_object('v', 1, 'action', 'assign', 'assignment_kind', ?,
			'guardrail_id', ?, 'requested_count', ?, 'affected_count', affected.affected_count),
		'gateway_management_guardrails', ?, ?, ?, ?
		FROM (SELECT COUNT(*) AS affected_count FROM guardrail_assignments assignment
			${affectedTargetJoin}
			WHERE assignment.workspace_id = ? AND assignment.guardrail_id = ?
				AND assignment.scope_type = ? AND assignment.scope_id IN (${targetPlaceholders})) affected
		WHERE affected.affected_count > 0
			AND EXISTS (SELECT 1 FROM management_api_keys management_key
			JOIN users creator ON creator.id = ? AND creator.status = 'active'
			JOIN guardrails guardrail ON guardrail.id = ? AND guardrail.status = 'active'
				AND guardrail.is_workspace_default = 0 AND guardrail.is_account_default = 0
			JOIN workspaces workspace ON workspace.id = guardrail.workspace_id AND workspace.status = 'active'
			WHERE ${key.sql} AND ${scope.sql})`)
		.bind(crypto.randomUUID(), principal.createdByUserId, auditEvent, kind,
			guardrailReference, values.length,
			`service:management_key:${principal.keyId}`,
			`guardrail_${kind}_${action}`,
			`Guardrail ${kind} ${action}ed through Management API`, nowIso,
			authorized.workspace_id, guardrailReference, scopeType, ...targetIds,
			principal.createdByUserId, guardrailReference, ...key.values, ...scope.values));
	const results = await client.raw.batch(statements);
	const count = results.slice(0, targetIds.length)
		.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);
	return { status: 'ok', count };
}

async function mutatePostgres(
	client: Extract<GatewayDatabaseClient, { driver: 'postgres' }>,
	principal: ManagementGuardrailMutationPrincipal,
	guardrailReference: string,
	kind: AssignmentKind,
	action: AssignmentAction,
	values: string[],
	nowIso: string,
): Promise<ManagementGuardrailAssignmentMutationResult> {
	const accountValue = principal.account.accountType === 'personal'
		? principal.account.personalOwnerUserId : principal.account.organizationId;
	return client.raw.begin(async (transaction) => {
		const accountSql = principal.account.accountType === 'personal'
			? `workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = $2 AND workspace.organization_id IS NULL
				AND management_key.account_type = 'personal' AND management_key.personal_owner_user_id = $2 AND management_key.organization_id IS NULL`
			: `workspace.scope_type = 'organization' AND workspace.personal_owner_user_id IS NULL AND workspace.organization_id = $2
				AND management_key.account_type = 'organization' AND management_key.personal_owner_user_id IS NULL AND management_key.organization_id = $2`;
		const authorized = (await transaction.unsafe<Array<{ workspace_id: string }>>(`SELECT guardrail.workspace_id
			FROM guardrails guardrail
			JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
			JOIN management_api_keys management_key ON management_key.id = $3
				AND management_key.status = 'active'
				AND (management_key.expires_at IS NULL OR management_key.expires_at > CURRENT_TIMESTAMP)
			JOIN users creator ON creator.id = $4 AND creator.status = 'active'
			WHERE guardrail.id = $1 AND guardrail.status = 'active'
				AND NOT guardrail.is_workspace_default AND NOT guardrail.is_account_default
				AND workspace.status = 'active' AND ${accountSql}
			FOR UPDATE OF guardrail, workspace, management_key, creator`,
		[guardrailReference, accountValue, principal.keyId, principal.createdByUserId]))[0];
		if (!authorized) return { status: 'not_found' };

		const first = 2;
		const placeholders = values.map((_, index) => `$${first + index}`).join(', ');
		const targetParams: unknown[] = [authorized.workspace_id, ...values.map((value) => kind === 'keys' ? `sha256:${value}` : value)];
		const targets = kind === 'keys'
			? await transaction.unsafe<TargetRow[]>(`SELECT api_key.id FROM api_keys api_key
				WHERE api_key.workspace_id = $1 AND api_key.key_hash IN (${placeholders})
				ORDER BY api_key.id FOR UPDATE`, targetParams as never[])
			: await transaction.unsafe<TargetRow[]>(`SELECT membership.user_id AS id
				FROM organization_memberships membership
				JOIN users member ON member.id = membership.user_id${action === 'assign' ? " AND member.status = 'active'" : ''}
				WHERE membership.organization_id = $1${action === 'assign' ? " AND membership.status = 'active'" : ''}
					AND membership.user_id IS NOT NULL AND membership.subject IN (${placeholders})
				ORDER BY membership.user_id FOR UPDATE OF membership, member`,
				[principal.account.organizationId, ...values]);
		const targetIds = [...new Set(targets.map((row) => row.id))];
		if (targetIds.length === 0) return { status: 'ok', count: 0 };
		const scopeType = kind === 'keys' ? 'api_key' : 'user';
		const assignmentPlaceholders = targetIds.map((_, index) => `$${index + 3}`).join(', ');
		await transaction.unsafe(`SELECT id FROM guardrail_assignments
			WHERE workspace_id = $1 AND scope_type = $2 AND scope_id IN (${assignmentPlaceholders})
			ORDER BY scope_id FOR UPDATE`, [authorized.workspace_id, scopeType, ...targetIds]);

		let count = 0;
		if (action === 'assign') {
			for (const targetId of targetIds) {
				const rows = await transaction.unsafe<Array<{ id: string }>>(`INSERT INTO guardrail_assignments (
					id, workspace_id, guardrail_id, scope_type, scope_id, created_by_user_id,
					management_source, assigned_by_user_id, created_at
				) VALUES ($1, $2, $3, $4, $5, NULL, 'management_api', $6, $7)
				ON CONFLICT (workspace_id, scope_type, scope_id) DO UPDATE SET
					guardrail_id = EXCLUDED.guardrail_id, created_by_user_id = NULL,
					management_source = 'management_api', assigned_by_user_id = EXCLUDED.assigned_by_user_id,
					created_at = EXCLUDED.created_at RETURNING id`,
				[crypto.randomUUID(), authorized.workspace_id, guardrailReference, scopeType,
					targetId, principal.createdByUserId, nowIso]);
				count += rows.length;
			}
		} else {
			const deleted = await transaction.unsafe<Array<{ id: string }>>(`DELETE FROM guardrail_assignments
				WHERE workspace_id = $1 AND guardrail_id = $2 AND scope_type = $3
					AND scope_id IN (${targetIds.map((_, index) => `$${index + 4}`).join(', ')}) RETURNING id`,
			[authorized.workspace_id, guardrailReference, scopeType, ...targetIds]);
			count = deleted.length;
		}
		if (count > 0) {
			const event = kind === 'keys' ? 'guardrail_key_assignments_updated' : 'guardrail_member_assignments_updated';
			await transaction.unsafe(`INSERT INTO user_audit_logs (
				id, user_id, api_key_id, event_type, actor_type, change_payload,
				source, actor_id, reason_code, reason_text, created_at
			) VALUES ($1, $2, NULL, $3, 'service', $4, 'gateway_management_guardrails', $5, $6, $7, $8)`, [
				crypto.randomUUID(), principal.createdByUserId, event,
				auditPayload(action, kind, guardrailReference, values.length, count),
				`service:management_key:${principal.keyId}`, `guardrail_${kind}_${action}`,
				`Guardrail ${kind} ${action}ed through Management API`, nowIso,
			]);
		}
		return { status: 'ok', count };
	});
}

async function mutateMySql(
	client: Extract<GatewayDatabaseClient, { driver: 'mysql' }>,
	principal: ManagementGuardrailMutationPrincipal,
	guardrailReference: string,
	kind: AssignmentKind,
	action: AssignmentAction,
	values: string[],
	nowIso: string,
): Promise<ManagementGuardrailAssignmentMutationResult> {
	const connection = await client.raw.getConnection();
	try {
		await connection.beginTransaction();
		const accountValue = principal.account.accountType === 'personal'
			? principal.account.personalOwnerUserId : principal.account.organizationId;
		const accountSql = principal.account.accountType === 'personal'
			? `workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = ? AND workspace.organization_id IS NULL
				AND management_key.account_type = 'personal' AND management_key.personal_owner_user_id = ? AND management_key.organization_id IS NULL`
			: `workspace.scope_type = 'organization' AND workspace.personal_owner_user_id IS NULL AND workspace.organization_id = ?
				AND management_key.account_type = 'organization' AND management_key.personal_owner_user_id IS NULL AND management_key.organization_id = ?`;
		const authorized = (await mysqlQueryRows<MySqlTargetRow>(connection, `SELECT guardrail.workspace_id AS id
			FROM guardrails guardrail
			JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
			JOIN management_api_keys management_key ON management_key.id = ?
				AND management_key.status = 'active'
				AND (management_key.expires_at IS NULL OR management_key.expires_at > UTC_TIMESTAMP(6))
			JOIN users creator ON creator.id = ? AND creator.status = 'active'
			WHERE guardrail.id = ? AND guardrail.status = 'active'
				AND guardrail.is_workspace_default = FALSE AND guardrail.is_account_default = FALSE
				AND workspace.status = 'active' AND ${accountSql} FOR UPDATE`,
		[principal.keyId, principal.createdByUserId, guardrailReference, accountValue, accountValue]))[0];
		if (!authorized) {
			await connection.rollback();
			return { status: 'not_found' };
		}
		const placeholders = values.map(() => '?').join(', ');
		const targets = kind === 'keys'
			? await mysqlQueryRows<MySqlTargetRow>(connection, `SELECT api_key.id FROM api_keys api_key
				WHERE api_key.workspace_id = ? AND api_key.key_hash IN (${placeholders})
				ORDER BY api_key.id FOR UPDATE`, [authorized.id, ...values.map((hash) => `sha256:${hash}`)])
			: await mysqlQueryRows<MySqlTargetRow>(connection, `SELECT membership.user_id AS id
				FROM organization_memberships membership
				JOIN users member ON member.id = membership.user_id${action === 'assign' ? " AND member.status = 'active'" : ''}
				WHERE membership.organization_id = ?${action === 'assign' ? " AND membership.status = 'active'" : ''}
					AND membership.user_id IS NOT NULL AND membership.subject IN (${placeholders})
				ORDER BY membership.user_id FOR UPDATE`, [principal.account.organizationId, ...values]);
		const targetIds = [...new Set(targets.map((row) => row.id))];
		if (targetIds.length === 0) {
			await connection.commit();
			return { status: 'ok', count: 0 };
		}
		const scopeType = kind === 'keys' ? 'api_key' : 'user';
		await mysqlQueryRows<MySqlTargetRow>(connection, `SELECT id FROM guardrail_assignments
			WHERE workspace_id = ? AND scope_type = ? AND scope_id IN (${targetIds.map(() => '?').join(', ')})
			ORDER BY scope_id FOR UPDATE`, [authorized.id, scopeType, ...targetIds]);
		let count = 0;
		if (action === 'assign') {
			const mysqlNow = toMySqlDateTime(nowIso);
			for (const targetId of targetIds) {
				await mysqlExecute(connection, `INSERT INTO guardrail_assignments (
					id, workspace_id, workspace_key, guardrail_id, scope_type, scope_id,
					created_by_user_id, management_source, assigned_by_user_id, created_at
				) VALUES (?, ?, SHA2(?, 256), ?, ?, ?, NULL, 'management_api', ?, ?)
				ON DUPLICATE KEY UPDATE guardrail_id = VALUES(guardrail_id),
					created_by_user_id = NULL, management_source = 'management_api',
					assigned_by_user_id = VALUES(assigned_by_user_id), created_at = VALUES(created_at)`,
				[crypto.randomUUID(), authorized.id, authorized.id, guardrailReference, scopeType,
					targetId, principal.createdByUserId, mysqlNow]);
				count += 1;
			}
		} else {
			const result = await mysqlExecute(connection, `DELETE FROM guardrail_assignments
				WHERE workspace_id = ? AND guardrail_id = ? AND scope_type = ?
					AND scope_id IN (${targetIds.map(() => '?').join(', ')})`,
			[authorized.id, guardrailReference, scopeType, ...targetIds]);
			count = result.affectedRows;
		}
		if (count > 0) {
			const event = kind === 'keys' ? 'guardrail_key_assignments_updated' : 'guardrail_member_assignments_updated';
			await mysqlExecute(connection, `INSERT INTO user_audit_logs (
				id, user_id, api_key_id, event_type, actor_type, change_payload,
				source, actor_id, reason_code, reason_text, created_at
			) VALUES (?, ?, NULL, ?, 'service', ?, 'gateway_management_guardrails', ?, ?, ?, ?)`, [
				crypto.randomUUID(), principal.createdByUserId, event,
				auditPayload(action, kind, guardrailReference, values.length, count),
				`service:management_key:${principal.keyId}`, `guardrail_${kind}_${action}`,
				`Guardrail ${kind} ${action}ed through Management API`, toMySqlDateTime(nowIso),
			]);
		}
		await connection.commit();
		return { status: 'ok', count };
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}
}

async function mutateAssignments(
	client: GatewayDatabaseClient,
	principal: ManagementGuardrailMutationPrincipal,
	guardrailReference: string,
	kind: AssignmentKind,
	action: AssignmentAction,
	values: string[],
	options: { nowIso?: string } = {},
): Promise<ManagementGuardrailAssignmentMutationResult> {
	if (!principal.createdByUserId) return { status: 'creator_unavailable' };
	assertManagementApiKeyAccount(principal.account);
	if (kind === 'members' && principal.account.accountType !== 'organization') {
		throw new TypeError('member assignments require an organization account');
	}
	const normalizedId = guardrailId(guardrailReference);
	const nowIso = isoTimestamp(options.nowIso ?? new Date().toISOString());
	if (client.driver === 'd1') return mutateD1(client, principal, normalizedId, kind, action, values, nowIso);
	if (client.driver === 'postgres') return mutatePostgres(client, principal, normalizedId, kind, action, values, nowIso);
	return mutateMySql(client, principal, normalizedId, kind, action, values, nowIso);
}

export async function assignManagementGuardrailKeys(
	client: GatewayDatabaseClient,
	principal: ManagementGuardrailMutationPrincipal,
	guardrailReference: string,
	keyHashes: string[],
): Promise<ManagementGuardrailAssignmentMutationResult> {
	return mutateAssignments(client, principal, guardrailReference, 'keys', 'assign', keyHashes);
}

export async function unassignManagementGuardrailKeys(
	client: GatewayDatabaseClient,
	principal: ManagementGuardrailMutationPrincipal,
	guardrailReference: string,
	keyHashes: string[],
): Promise<ManagementGuardrailAssignmentMutationResult> {
	return mutateAssignments(client, principal, guardrailReference, 'keys', 'unassign', keyHashes);
}

export async function assignManagementGuardrailMembers(
	client: GatewayDatabaseClient,
	principal: ManagementGuardrailMutationPrincipal,
	guardrailReference: string,
	memberUserIds: string[],
): Promise<ManagementGuardrailAssignmentMutationResult> {
	return mutateAssignments(client, principal, guardrailReference, 'members', 'assign', memberUserIds);
}

export async function unassignManagementGuardrailMembers(
	client: GatewayDatabaseClient,
	principal: ManagementGuardrailMutationPrincipal,
	guardrailReference: string,
	memberUserIds: string[],
): Promise<ManagementGuardrailAssignmentMutationResult> {
	return mutateAssignments(client, principal, guardrailReference, 'members', 'unassign', memberUserIds);
}
