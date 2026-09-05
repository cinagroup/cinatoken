import type { RowDataPacket } from 'mysql2/promise';
import {
	assertManagementApiKeyAccount,
	type ManagementApiKeyAccount,
} from '../db/management-api-keys-types';
import { fromMySqlDateTime, mysqlExecute, mysqlQueryRows, toMySqlDateTime } from '../db/mysql/mysql2-compat';
import type {
	ManagementGuardrailCreate,
	ManagementGuardrailMutationPrincipal,
	ManagementGuardrailMutationResult,
	ManagementGuardrailPage,
	ManagementGuardrailPatch,
	ManagementGuardrailRow,
} from '../management-guardrails';
import type { GatewayDatabaseClient } from './database-client';

type RawManagementGuardrailRow = Omit<ManagementGuardrailRow, 'created_at' | 'updated_at' | 'is_workspace_default' | 'is_account_default'> & {
	is_workspace_default: boolean | number;
	is_account_default: boolean | number;
	created_at: string | Date;
	updated_at: string | Date;
};
type MySqlManagementGuardrailRow = RawManagementGuardrailRow & RowDataPacket;

const MAX_PAGE_OFFSET = 1_000_000;
const MAX_GUARDRAIL_ID_LENGTH = 128;
const SELECT_COLUMNS = `guardrail.id, guardrail.workspace_id, guardrail.owner_user_id,
	guardrail.name, guardrail.description, guardrail.status, guardrail.is_workspace_default,
	guardrail.is_account_default, guardrail.account_scope_key, guardrail.designated_version,
	guardrail.latest_version, version.config_json, guardrail.created_at, guardrail.updated_at`;

function isoTimestamp(value: string | Date, mysql = false): string {
	if (mysql) return fromMySqlDateTime(value);
	if (value instanceof Date) return value.toISOString();
	const parsed = Date.parse(String(value));
	if (!Number.isFinite(parsed)) throw new TypeError('Guardrail timestamp is invalid');
	return new Date(parsed).toISOString();
}

function mapRow(row: RawManagementGuardrailRow, mysql = false): ManagementGuardrailRow {
	return {
		...row,
		is_workspace_default: row.is_workspace_default === true || Number(row.is_workspace_default) === 1,
		is_account_default: row.is_account_default === true || Number(row.is_account_default) === 1,
		created_at: isoTimestamp(row.created_at, mysql),
		updated_at: isoTimestamp(row.updated_at, mysql),
	};
}

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

function accountScopeKey(account: ManagementApiKeyAccount): string {
	assertManagementApiKeyAccount(account);
	return account.accountType === 'personal'
		? `personal:${account.personalOwnerUserId}`
		: `organization:${account.organizationId}`;
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

function d1ActiveKeyPredicate(principal: ManagementGuardrailMutationPrincipal, alias = 'management_key') {
	assertManagementApiKeyAccount(principal.account);
	return principal.account.accountType === 'personal'
		? {
			sql: `${alias}.id = ? AND ${alias}.status = 'active'
				AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > datetime('now'))
				AND ${alias}.account_type = 'personal'
				AND ${alias}.personal_owner_user_id = ? AND ${alias}.organization_id IS NULL
				AND EXISTS (SELECT 1 FROM users owner WHERE owner.id = ${alias}.personal_owner_user_id AND owner.status = 'active')`,
			values: [principal.keyId, principal.account.personalOwnerUserId],
		}
		: {
			sql: `${alias}.id = ? AND ${alias}.status = 'active'
				AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > datetime('now'))
				AND ${alias}.account_type = 'organization'
				AND ${alias}.personal_owner_user_id IS NULL AND ${alias}.organization_id = ?
				AND EXISTS (SELECT 1 FROM organizations owner WHERE owner.id = ${alias}.organization_id AND owner.status IN ('active', 'pending'))`,
			values: [principal.keyId, principal.account.organizationId],
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

function postgresActiveKeyPredicate(
	principal: ManagementGuardrailMutationPrincipal,
	alias: string,
	parameter: number,
) {
	assertManagementApiKeyAccount(principal.account);
	return principal.account.accountType === 'personal'
		? {
			sql: `${alias}.id = $${parameter} AND ${alias}.status = 'active'
				AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > CURRENT_TIMESTAMP)
				AND ${alias}.account_type = 'personal'
				AND ${alias}.personal_owner_user_id = $${parameter + 1} AND ${alias}.organization_id IS NULL
				AND EXISTS (SELECT 1 FROM users owner WHERE owner.id = ${alias}.personal_owner_user_id AND owner.status = 'active')`,
			values: [principal.keyId, principal.account.personalOwnerUserId],
		}
		: {
			sql: `${alias}.id = $${parameter} AND ${alias}.status = 'active'
				AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > CURRENT_TIMESTAMP)
				AND ${alias}.account_type = 'organization'
				AND ${alias}.personal_owner_user_id IS NULL AND ${alias}.organization_id = $${parameter + 1}
				AND EXISTS (SELECT 1 FROM organizations owner WHERE owner.id = ${alias}.organization_id AND owner.status IN ('active', 'pending'))`,
			values: [principal.keyId, principal.account.organizationId],
		};
}

function auditPayload(action: 'created' | 'updated' | 'deleted', row: {
	id: string;
	workspace_id: string;
	name: string;
	description: string | null;
	version: number;
}): string {
	return JSON.stringify({
		v: 1,
		action,
		guardrail_id: row.id,
		workspace_id: row.workspace_id,
		name: row.name,
		description_present: row.description !== null,
		version: row.version,
	});
}

export async function listManagementGuardrails(
	client: GatewayDatabaseClient,
	account: ManagementApiKeyAccount,
	workspaceId: string,
	page: { offset: number; limit: number },
): Promise<ManagementGuardrailPage> {
	assertPage(page.offset, page.limit);
	if (client.driver === 'd1') {
		const scope = d1AccountPredicate(account);
		const requestedScope = d1AccountPredicate(account, 'requested_workspace');
		const values = [workspaceId, accountScopeKey(account), ...scope.values,
			workspaceId, ...requestedScope.values];
		const total = await client.raw.prepare(`SELECT COUNT(*) AS total FROM guardrails guardrail
			JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
			WHERE (guardrail.workspace_id = ?
					OR (guardrail.is_account_default = 1 AND guardrail.account_scope_key = ?))
				AND guardrail.status = 'active' AND workspace.status = 'active' AND ${scope.sql}
				AND EXISTS (SELECT 1 FROM workspaces requested_workspace
					WHERE requested_workspace.id = ? AND requested_workspace.status = 'active'
						AND ${requestedScope.sql})`).bind(...values).first<{ total: number }>();
		const rows = await client.raw.prepare(`SELECT ${SELECT_COLUMNS}
			FROM guardrails guardrail
			JOIN guardrail_versions version ON version.guardrail_id = guardrail.id
				AND version.version = guardrail.designated_version
			JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
			WHERE (guardrail.workspace_id = ?
					OR (guardrail.is_account_default = 1 AND guardrail.account_scope_key = ?))
				AND guardrail.status = 'active' AND workspace.status = 'active' AND ${scope.sql}
				AND EXISTS (SELECT 1 FROM workspaces requested_workspace
					WHERE requested_workspace.id = ? AND requested_workspace.status = 'active'
						AND ${requestedScope.sql})
			ORDER BY guardrail.is_account_default DESC, guardrail.created_at DESC, guardrail.id ASC LIMIT ? OFFSET ?`)
			.bind(...values, page.limit, page.offset).all<RawManagementGuardrailRow>();
		return { data: (rows.results ?? []).map((row) => mapRow(row)), totalCount: Number(total?.total ?? 0) };
	}

	if (client.driver === 'postgres') {
		const scope = postgresAccountPredicate(account, 'workspace', 2);
		const requestedScope = postgresAccountPredicate(account, 'requested_workspace', 2);
		const [totalRows, rows] = await Promise.all([
			client.raw.unsafe<Array<{ total: number | string }>>(`SELECT COUNT(*) AS total FROM guardrails guardrail
				JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
				WHERE (guardrail.workspace_id = $1
						OR (guardrail.is_account_default AND guardrail.account_scope_key = $3))
					AND guardrail.status = 'active' AND workspace.status = 'active' AND ${scope.sql}
					AND EXISTS (SELECT 1 FROM workspaces requested_workspace
						WHERE requested_workspace.id = $1 AND requested_workspace.status = 'active'
							AND ${requestedScope.sql})`, [workspaceId, scope.value, accountScopeKey(account)]),
			client.raw.unsafe<RawManagementGuardrailRow[]>(`SELECT ${SELECT_COLUMNS}
				FROM guardrails guardrail
				JOIN guardrail_versions version ON version.guardrail_id = guardrail.id
					AND version.version = guardrail.designated_version
				JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
				WHERE (guardrail.workspace_id = $1
						OR (guardrail.is_account_default AND guardrail.account_scope_key = $3))
					AND guardrail.status = 'active' AND workspace.status = 'active' AND ${scope.sql}
					AND EXISTS (SELECT 1 FROM workspaces requested_workspace
						WHERE requested_workspace.id = $1 AND requested_workspace.status = 'active'
							AND ${requestedScope.sql})
				ORDER BY guardrail.is_account_default DESC, guardrail.created_at DESC, guardrail.id ASC LIMIT $4 OFFSET $5`,
			[workspaceId, scope.value, accountScopeKey(account), page.limit, page.offset]),
		]);
		return { data: rows.map((row) => mapRow(row)), totalCount: Number(totalRows[0]?.total ?? 0) };
	}

	assertManagementApiKeyAccount(account);
	const scopeSql = account.accountType === 'personal'
		? `workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = ? AND workspace.organization_id IS NULL`
		: `workspace.scope_type = 'organization' AND workspace.personal_owner_user_id IS NULL AND workspace.organization_id = ?`;
	const scopeValue = account.accountType === 'personal' ? account.personalOwnerUserId : account.organizationId;
	const scopeKey = accountScopeKey(account);
	const totalRows = await mysqlQueryRows<RowDataPacket & { total: number | string }>(client.raw, `SELECT COUNT(*) AS total FROM guardrails guardrail
		JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
		WHERE (guardrail.workspace_id = ?
				OR (guardrail.is_account_default = TRUE AND guardrail.account_scope_key = ?))
			AND guardrail.status = 'active' AND workspace.status = 'active' AND ${scopeSql}
			AND EXISTS (SELECT 1 FROM workspaces requested_workspace
				WHERE requested_workspace.id = ? AND requested_workspace.status = 'active'
					AND ${scopeSql.replaceAll('workspace.', 'requested_workspace.')})`,
	[workspaceId, scopeKey, scopeValue, workspaceId, scopeValue]);
	const rows = await mysqlQueryRows<MySqlManagementGuardrailRow>(client.raw, `SELECT ${SELECT_COLUMNS}
		FROM guardrails guardrail
		JOIN guardrail_versions version ON version.guardrail_id = guardrail.id
			AND version.version = guardrail.designated_version
		JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
		WHERE (guardrail.workspace_id = ?
				OR (guardrail.is_account_default = TRUE AND guardrail.account_scope_key = ?))
			AND guardrail.status = 'active' AND workspace.status = 'active' AND ${scopeSql}
			AND EXISTS (SELECT 1 FROM workspaces requested_workspace
				WHERE requested_workspace.id = ? AND requested_workspace.status = 'active'
					AND ${scopeSql.replaceAll('workspace.', 'requested_workspace.')})
		ORDER BY guardrail.is_account_default DESC, guardrail.created_at DESC, guardrail.id ASC LIMIT ? OFFSET ?`,
	[workspaceId, scopeKey, scopeValue, workspaceId, scopeValue, page.limit, page.offset]);
	return { data: rows.map((row) => mapRow(row, true)), totalCount: Number(totalRows[0]?.total ?? 0) };
}

export async function getManagementGuardrail(
	client: GatewayDatabaseClient,
	account: ManagementApiKeyAccount,
	id: string,
): Promise<ManagementGuardrailRow | null> {
	const normalizedId = guardrailId(id);
	if (client.driver === 'd1') {
		const scope = d1AccountPredicate(account);
		const row = await client.raw.prepare(`SELECT ${SELECT_COLUMNS}
			FROM guardrails guardrail
			JOIN guardrail_versions version ON version.guardrail_id = guardrail.id
				AND version.version = guardrail.designated_version
			JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
			WHERE guardrail.id = ? AND guardrail.status = 'active'
				AND workspace.status = 'active' AND ${scope.sql}`)
			.bind(normalizedId, ...scope.values).first<RawManagementGuardrailRow>();
		return row ? mapRow(row) : null;
	}
	if (client.driver === 'postgres') {
		const scope = postgresAccountPredicate(account, 'workspace', 2);
		const rows = await client.raw.unsafe<RawManagementGuardrailRow[]>(`SELECT ${SELECT_COLUMNS}
			FROM guardrails guardrail
			JOIN guardrail_versions version ON version.guardrail_id = guardrail.id
				AND version.version = guardrail.designated_version
			JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
			WHERE guardrail.id = $1 AND guardrail.status = 'active'
				AND workspace.status = 'active' AND ${scope.sql}`, [normalizedId, scope.value]);
		return rows[0] ? mapRow(rows[0]) : null;
	}
	assertManagementApiKeyAccount(account);
	const scopeSql = account.accountType === 'personal'
		? `workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = ? AND workspace.organization_id IS NULL`
		: `workspace.scope_type = 'organization' AND workspace.personal_owner_user_id IS NULL AND workspace.organization_id = ?`;
	const scopeValue = account.accountType === 'personal' ? account.personalOwnerUserId : account.organizationId;
	const rows = await mysqlQueryRows<MySqlManagementGuardrailRow>(client.raw, `SELECT ${SELECT_COLUMNS}
		FROM guardrails guardrail
		JOIN guardrail_versions version ON version.guardrail_id = guardrail.id
			AND version.version = guardrail.designated_version
		JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
		WHERE guardrail.id = ? AND guardrail.status = 'active'
			AND workspace.status = 'active' AND ${scopeSql}`, [normalizedId, scopeValue]);
	return rows[0] ? mapRow(rows[0], true) : null;
}

export async function createManagementGuardrail(
	client: GatewayDatabaseClient,
	principal: ManagementGuardrailMutationPrincipal,
	input: ManagementGuardrailCreate,
	options: { id?: string; versionId?: string; nowIso?: string } = {},
): Promise<ManagementGuardrailMutationResult> {
	if (!principal.createdByUserId) return { status: 'creator_unavailable' };
	const id = guardrailId(options.id ?? crypto.randomUUID());
	const versionId = guardrailId(options.versionId ?? crypto.randomUUID());
	const nowIso = isoTimestamp(options.nowIso ?? new Date().toISOString());
	const payload = auditPayload('created', {
		id, workspace_id: input.workspaceId, name: input.name,
		description: input.description, version: 1,
	});

	if (client.driver === 'd1') {
		const scope = d1AccountPredicate(principal.account);
		const key = d1ActiveKeyPredicate(principal);
		const insert = client.raw.prepare(`INSERT INTO guardrails (
			id, workspace_id, owner_user_id, name, description, status,
			designated_version, latest_version, created_at, updated_at
		) SELECT ?, workspace.id, ?, ?, ?, 'active', 1, 1, ?, ?
		FROM workspaces workspace JOIN management_api_keys management_key ON ${key.sql}
		WHERE workspace.id = ? AND workspace.status = 'active' AND ${scope.sql}
			AND EXISTS (SELECT 1 FROM users creator WHERE creator.id = ? AND creator.status = 'active')`)
			.bind(id, principal.createdByUserId, input.name, input.description, nowIso, nowIso,
				...key.values, input.workspaceId, ...scope.values, principal.createdByUserId);
		const version = client.raw.prepare(`INSERT INTO guardrail_versions (
			id, guardrail_id, version, config_json, created_by_user_id, created_at
		) SELECT ?, guardrail.id, 1, ?, ?, ? FROM guardrails guardrail WHERE guardrail.id = ?`)
			.bind(versionId, input.configJson, principal.createdByUserId, nowIso, id);
		const audit = client.raw.prepare(`INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) SELECT ?, ?, NULL, 'guardrail_created', 'service', ?,
			'gateway_management_guardrails', ?, 'guardrail_create',
			'Guardrail created through Management API', ?
		FROM guardrails guardrail WHERE guardrail.id = ?`)
			.bind(crypto.randomUUID(), principal.createdByUserId, payload,
				`service:management_key:${principal.keyId}`, nowIso, id);
		const results = await client.raw.batch([insert, version, audit]);
		if ((results[0]?.meta.changes ?? 0) !== 1) return { status: 'not_found' };
		const row = await getManagementGuardrail(client, principal.account, id);
		return row ? { status: 'ok', row } : { status: 'not_found' };
	}

	if (client.driver === 'postgres') {
		const created = await client.raw.begin(async (transaction) => {
			const scope = postgresAccountPredicate(principal.account, 'workspace', 2);
			const key = postgresActiveKeyPredicate(principal, 'management_key', 3);
			const authorized = await transaction.unsafe<Array<{ id: string }>>(`SELECT workspace.id
				FROM workspaces workspace JOIN management_api_keys management_key ON ${key.sql}
				WHERE workspace.id = $1 AND workspace.status = 'active' AND ${scope.sql}
					AND EXISTS (SELECT 1 FROM users creator WHERE creator.id = $5 AND creator.status = 'active')
				FOR UPDATE OF workspace, management_key`,
			[input.workspaceId, scope.value, ...key.values, principal.createdByUserId]);
			if (authorized.length !== 1) return false;
			await transaction.unsafe(`INSERT INTO guardrails (
				id, workspace_id, owner_user_id, name, description, status,
				designated_version, latest_version, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, 'active', 1, 1, $6, $6)`,
			[id, input.workspaceId, principal.createdByUserId, input.name, input.description, nowIso]);
			await transaction.unsafe(`INSERT INTO guardrail_versions (
				id, guardrail_id, version, config_json, created_by_user_id, created_at
			) VALUES ($1, $2, 1, $3, $4, $5)`,
			[versionId, id, input.configJson, principal.createdByUserId, nowIso]);
			await transaction.unsafe(`INSERT INTO user_audit_logs (
				id, user_id, api_key_id, event_type, actor_type, change_payload,
				source, actor_id, reason_code, reason_text, created_at
			) VALUES ($1, $2, NULL, 'guardrail_created', 'service', $3,
				'gateway_management_guardrails', $4, 'guardrail_create',
				'Guardrail created through Management API', $5)`,
			[crypto.randomUUID(), principal.createdByUserId, payload,
				`service:management_key:${principal.keyId}`, nowIso]);
			return true;
		});
		if (!created) return { status: 'not_found' };
		const row = await getManagementGuardrail(client, principal.account, id);
		return row ? { status: 'ok', row } : { status: 'not_found' };
	}

	assertManagementApiKeyAccount(principal.account);
	const connection = await client.raw.getConnection();
	try {
		await connection.beginTransaction();
		const scopeSql = principal.account.accountType === 'personal'
			? `workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = ? AND workspace.organization_id IS NULL`
			: `workspace.scope_type = 'organization' AND workspace.personal_owner_user_id IS NULL AND workspace.organization_id = ?`;
		const scopeValue = principal.account.accountType === 'personal'
			? principal.account.personalOwnerUserId : principal.account.organizationId;
		const keySql = principal.account.accountType === 'personal'
			? `management_key.id = ? AND management_key.status = 'active'
				AND (management_key.expires_at IS NULL OR management_key.expires_at > UTC_TIMESTAMP(6))
				AND management_key.account_type = 'personal' AND management_key.personal_owner_user_id = ?
				AND management_key.organization_id IS NULL`
			: `management_key.id = ? AND management_key.status = 'active'
				AND (management_key.expires_at IS NULL OR management_key.expires_at > UTC_TIMESTAMP(6))
				AND management_key.account_type = 'organization' AND management_key.personal_owner_user_id IS NULL
				AND management_key.organization_id = ?`;
		const accountValue = principal.account.accountType === 'personal'
			? principal.account.personalOwnerUserId : principal.account.organizationId;
		const authorized = await mysqlQueryRows<RowDataPacket & { id: string }>(connection, `SELECT workspace.id
			FROM workspaces workspace JOIN management_api_keys management_key ON ${keySql}
			WHERE workspace.id = ? AND workspace.status = 'active' AND ${scopeSql}
				AND EXISTS (SELECT 1 FROM users creator WHERE creator.id = ? AND creator.status = 'active')
			FOR UPDATE`, [principal.keyId, accountValue, input.workspaceId, scopeValue, principal.createdByUserId]);
		if (authorized.length !== 1) {
			await connection.rollback();
			return { status: 'not_found' };
		}
		const mysqlNow = toMySqlDateTime(nowIso);
		await mysqlExecute(connection, `INSERT INTO guardrails (
			id, workspace_id, workspace_key, owner_user_id, name, description, status,
			designated_version, latest_version, created_at, updated_at
		) VALUES (?, ?, SHA2(?, 256), ?, ?, ?, 'active', 1, 1, ?, ?)`,
		[id, input.workspaceId, input.workspaceId, principal.createdByUserId,
			input.name, input.description, mysqlNow, mysqlNow]);
		await mysqlExecute(connection, `INSERT INTO guardrail_versions (
			id, guardrail_id, version, config_json, created_by_user_id, created_at
		) VALUES (?, ?, 1, ?, ?, ?)`,
		[versionId, id, input.configJson, principal.createdByUserId, mysqlNow]);
		await mysqlExecute(connection, `INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) VALUES (?, ?, NULL, 'guardrail_created', 'service', ?,
			'gateway_management_guardrails', ?, 'guardrail_create',
			'Guardrail created through Management API', ?)`,
		[crypto.randomUUID(), principal.createdByUserId, payload,
			`service:management_key:${principal.keyId}`, mysqlNow]);
		await connection.commit();
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}
	const row = await getManagementGuardrail(client, principal.account, id);
	return row ? { status: 'ok', row } : { status: 'not_found' };
}

export async function updateManagementGuardrail(
	client: GatewayDatabaseClient,
	principal: ManagementGuardrailMutationPrincipal,
	id: string,
	patch: ManagementGuardrailPatch,
	options: { versionId?: string; nowIso?: string } = {},
): Promise<ManagementGuardrailMutationResult> {
	if (!principal.createdByUserId) return { status: 'creator_unavailable' };
	const normalizedId = guardrailId(id);
	const versionId = guardrailId(options.versionId ?? crypto.randomUUID());
	const nowIso = isoTimestamp(options.nowIso ?? new Date().toISOString());
	const nextVersion = patch.expectedVersion + 1;

	if (client.driver === 'd1') {
		const scope = d1AccountPredicate(principal.account);
		const key = d1ActiveKeyPredicate(principal);
		const version = client.raw.prepare(`INSERT INTO guardrail_versions (
			id, guardrail_id, version, config_json, created_by_user_id, created_at
		) SELECT ?, guardrail.id, ?, ?, ?, ? FROM guardrails guardrail
		JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
		JOIN management_api_keys management_key ON ${key.sql}
		WHERE guardrail.id = ? AND guardrail.status = 'active' AND guardrail.latest_version = ?
			AND workspace.status = 'active' AND ${scope.sql}
			AND EXISTS (SELECT 1 FROM users creator WHERE creator.id = ? AND creator.status = 'active')`)
			.bind(versionId, nextVersion, patch.configJson, principal.createdByUserId, nowIso,
				...key.values, normalizedId, patch.expectedVersion, ...scope.values, principal.createdByUserId);
		const update = client.raw.prepare(`UPDATE guardrails SET
			name = CASE WHEN is_workspace_default = 1 OR is_account_default = 1 THEN name ELSE ? END,
			description = ?,
			designated_version = ?, latest_version = ?, updated_at = ?
			WHERE id = ? AND status = 'active' AND latest_version = ?
				AND EXISTS (SELECT 1 FROM guardrail_versions version
					WHERE version.id = ? AND version.guardrail_id = guardrails.id AND version.version = ?)`)
			.bind(patch.name, patch.description, nextVersion, nextVersion, nowIso,
				normalizedId, patch.expectedVersion, versionId, nextVersion);
		const payload = auditPayload('updated', {
			id: normalizedId, workspace_id: '', name: patch.name,
			description: patch.description, version: nextVersion,
		});
		const audit = client.raw.prepare(`INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) SELECT ?, ?, NULL, 'guardrail_updated', 'service',
			json_set(?, '$.workspace_id', guardrail.workspace_id),
			'gateway_management_guardrails', ?, 'guardrail_update',
			'Guardrail updated through Management API', ?
		FROM guardrails guardrail WHERE guardrail.id = ? AND guardrail.latest_version = ?`)
			.bind(crypto.randomUUID(), principal.createdByUserId, payload,
				`service:management_key:${principal.keyId}`, nowIso, normalizedId, nextVersion);
		const results = await client.raw.batch([version, update, audit]);
		if ((results[0]?.meta.changes ?? 0) !== 1) {
			const current = await getManagementGuardrail(client, principal.account, normalizedId);
			return current ? { status: 'conflict' } : { status: 'not_found' };
		}
		const row = await getManagementGuardrail(client, principal.account, normalizedId);
		return row ? { status: 'ok', row } : { status: 'not_found' };
	}

	if (client.driver === 'postgres') {
		const status = await client.raw.begin(async (transaction) => {
			const scope = postgresAccountPredicate(principal.account, 'workspace', 2);
			const key = postgresActiveKeyPredicate(principal, 'management_key', 3);
			const rows = await transaction.unsafe<Array<{ workspace_id: string; latest_version: number }>>(`SELECT
				guardrail.workspace_id, guardrail.latest_version FROM guardrails guardrail
				JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
				JOIN management_api_keys management_key ON ${key.sql}
				WHERE guardrail.id = $1 AND guardrail.status = 'active'
					AND workspace.status = 'active' AND ${scope.sql}
					AND EXISTS (SELECT 1 FROM users creator WHERE creator.id = $5 AND creator.status = 'active')
				FOR UPDATE OF guardrail, workspace, management_key`,
			[normalizedId, scope.value, ...key.values, principal.createdByUserId]);
			const current = rows[0];
			if (!current) return 'not_found' as const;
			if (Number(current.latest_version) !== patch.expectedVersion) return 'conflict' as const;
			await transaction.unsafe(`INSERT INTO guardrail_versions (
				id, guardrail_id, version, config_json, created_by_user_id, created_at
			) VALUES ($1, $2, $3, $4, $5, $6)`,
			[versionId, normalizedId, nextVersion, patch.configJson, principal.createdByUserId, nowIso]);
			await transaction.unsafe(`UPDATE guardrails SET
				name = CASE WHEN is_workspace_default OR is_account_default THEN name ELSE $1 END,
				description = $2,
				designated_version = $3, latest_version = $3, updated_at = $4 WHERE id = $5`,
			[patch.name, patch.description, nextVersion, nowIso, normalizedId]);
			await transaction.unsafe(`INSERT INTO user_audit_logs (
				id, user_id, api_key_id, event_type, actor_type, change_payload,
				source, actor_id, reason_code, reason_text, created_at
			) VALUES ($1, $2, NULL, 'guardrail_updated', 'service', $3,
				'gateway_management_guardrails', $4, 'guardrail_update',
				'Guardrail updated through Management API', $5)`, [
				crypto.randomUUID(), principal.createdByUserId,
				auditPayload('updated', {
					id: normalizedId, workspace_id: current.workspace_id, name: patch.name,
					description: patch.description, version: nextVersion,
				}),
				`service:management_key:${principal.keyId}`, nowIso,
			]);
			return 'ok' as const;
		});
		if (status !== 'ok') return { status };
		const row = await getManagementGuardrail(client, principal.account, normalizedId);
		return row ? { status: 'ok', row } : { status: 'not_found' };
	}

	assertManagementApiKeyAccount(principal.account);
	const connection = await client.raw.getConnection();
	try {
		await connection.beginTransaction();
		const scopeSql = principal.account.accountType === 'personal'
			? `workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = ? AND workspace.organization_id IS NULL`
			: `workspace.scope_type = 'organization' AND workspace.personal_owner_user_id IS NULL AND workspace.organization_id = ?`;
		const scopeValue = principal.account.accountType === 'personal'
			? principal.account.personalOwnerUserId : principal.account.organizationId;
		const keySql = principal.account.accountType === 'personal'
			? `management_key.id = ? AND management_key.status = 'active'
				AND (management_key.expires_at IS NULL OR management_key.expires_at > UTC_TIMESTAMP(6))
				AND management_key.account_type = 'personal' AND management_key.personal_owner_user_id = ?
				AND management_key.organization_id IS NULL`
			: `management_key.id = ? AND management_key.status = 'active'
				AND (management_key.expires_at IS NULL OR management_key.expires_at > UTC_TIMESTAMP(6))
				AND management_key.account_type = 'organization' AND management_key.personal_owner_user_id IS NULL
				AND management_key.organization_id = ?`;
		const accountValue = principal.account.accountType === 'personal'
			? principal.account.personalOwnerUserId : principal.account.organizationId;
		const rows = await mysqlQueryRows<RowDataPacket & { workspace_id: string; latest_version: number }>(connection, `SELECT
			guardrail.workspace_id, guardrail.latest_version FROM guardrails guardrail
			JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
			JOIN management_api_keys management_key ON ${keySql}
			WHERE guardrail.id = ? AND guardrail.status = 'active'
				AND workspace.status = 'active' AND ${scopeSql}
				AND EXISTS (SELECT 1 FROM users creator WHERE creator.id = ? AND creator.status = 'active')
			FOR UPDATE`, [principal.keyId, accountValue, normalizedId, scopeValue, principal.createdByUserId]);
		const current = rows[0];
		if (!current) {
			await connection.rollback();
			return { status: 'not_found' };
		}
		if (Number(current.latest_version) !== patch.expectedVersion) {
			await connection.rollback();
			return { status: 'conflict' };
		}
		const mysqlNow = toMySqlDateTime(nowIso);
		await mysqlExecute(connection, `INSERT INTO guardrail_versions (
			id, guardrail_id, version, config_json, created_by_user_id, created_at
		) VALUES (?, ?, ?, ?, ?, ?)`,
		[versionId, normalizedId, nextVersion, patch.configJson, principal.createdByUserId, mysqlNow]);
		await mysqlExecute(connection, `UPDATE guardrails SET
			name = IF(is_workspace_default = TRUE OR is_account_default = TRUE, name, ?),
			description = ?,
			designated_version = ?, latest_version = ?, updated_at = ? WHERE id = ?`,
		[patch.name, patch.description, nextVersion, nextVersion, mysqlNow, normalizedId]);
		await mysqlExecute(connection, `INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) VALUES (?, ?, NULL, 'guardrail_updated', 'service', ?,
			'gateway_management_guardrails', ?, 'guardrail_update',
			'Guardrail updated through Management API', ?)`, [
			crypto.randomUUID(), principal.createdByUserId,
			auditPayload('updated', {
				id: normalizedId, workspace_id: current.workspace_id, name: patch.name,
				description: patch.description, version: nextVersion,
			}),
			`service:management_key:${principal.keyId}`, mysqlNow,
		]);
		await connection.commit();
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}
	const row = await getManagementGuardrail(client, principal.account, normalizedId);
	return row ? { status: 'ok', row } : { status: 'not_found' };
}

export async function deleteManagementGuardrail(
	client: GatewayDatabaseClient,
	principal: ManagementGuardrailMutationPrincipal,
	id: string,
	options: { nowIso?: string } = {},
): Promise<'deleted' | 'not_found' | 'creator_unavailable'> {
	if (!principal.createdByUserId) return 'creator_unavailable';
	const normalizedId = guardrailId(id);
	const nowIso = isoTimestamp(options.nowIso ?? new Date().toISOString());
	if (client.driver === 'd1') {
		const scope = d1AccountPredicate(principal.account);
		const key = d1ActiveKeyPredicate(principal);
		const audit = client.raw.prepare(`INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) SELECT ?, ?, NULL, 'guardrail_deleted', 'service',
			json_object('v', 1, 'action', 'deleted', 'guardrail_id', guardrail.id,
				'workspace_id', guardrail.workspace_id, 'name', guardrail.name,
				'description_present', guardrail.description IS NOT NULL,
				'version', guardrail.designated_version),
			'gateway_management_guardrails', ?, 'guardrail_delete',
			'Guardrail deleted through Management API', ?
		FROM guardrails guardrail
		JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
		JOIN management_api_keys management_key ON ${key.sql}
		WHERE guardrail.id = ? AND guardrail.status = 'active'
			AND guardrail.is_workspace_default = 0 AND guardrail.is_account_default = 0
			AND workspace.status = 'active' AND ${scope.sql}
			AND EXISTS (SELECT 1 FROM users creator WHERE creator.id = ? AND creator.status = 'active')`)
			.bind(crypto.randomUUID(), principal.createdByUserId,
				`service:management_key:${principal.keyId}`, nowIso,
				...key.values, normalizedId, ...scope.values, principal.createdByUserId);
		const remove = client.raw.prepare(`DELETE FROM guardrails WHERE id = ?
			AND is_workspace_default = 0 AND is_account_default = 0 AND EXISTS (
			SELECT 1 FROM workspaces workspace JOIN management_api_keys management_key ON ${key.sql}
			WHERE workspace.id = guardrails.workspace_id AND workspace.status = 'active' AND ${scope.sql}
				AND EXISTS (SELECT 1 FROM users creator WHERE creator.id = ? AND creator.status = 'active')
		)`).bind(normalizedId, ...key.values, ...scope.values, principal.createdByUserId);
		const results = await client.raw.batch([audit, remove]);
		return (results[1]?.meta.changes ?? 0) === 1 ? 'deleted' : 'not_found';
	}

	if (client.driver === 'postgres') {
		return client.raw.begin(async (transaction) => {
			const scope = postgresAccountPredicate(principal.account, 'workspace', 2);
			const key = postgresActiveKeyPredicate(principal, 'management_key', 3);
			const rows = await transaction.unsafe<Array<{
				workspace_id: string; name: string; description: string | null; designated_version: number;
				is_workspace_default: boolean; is_account_default: boolean;
			}>>(`SELECT guardrail.workspace_id, guardrail.name, guardrail.description,
				guardrail.designated_version, guardrail.is_workspace_default,
				guardrail.is_account_default FROM guardrails guardrail
				JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
				JOIN management_api_keys management_key ON ${key.sql}
				WHERE guardrail.id = $1 AND guardrail.status = 'active'
					AND workspace.status = 'active' AND ${scope.sql}
					AND EXISTS (SELECT 1 FROM users creator WHERE creator.id = $5 AND creator.status = 'active')
				FOR UPDATE OF guardrail, workspace, management_key`,
			[normalizedId, scope.value, ...key.values, principal.createdByUserId]);
			const current = rows[0];
			if (!current) return 'not_found';
			if (current.is_workspace_default || current.is_account_default) return 'not_found';
			await transaction.unsafe(`INSERT INTO user_audit_logs (
				id, user_id, api_key_id, event_type, actor_type, change_payload,
				source, actor_id, reason_code, reason_text, created_at
			) VALUES ($1, $2, NULL, 'guardrail_deleted', 'service', $3,
				'gateway_management_guardrails', $4, 'guardrail_delete',
				'Guardrail deleted through Management API', $5)`, [
				crypto.randomUUID(), principal.createdByUserId,
				auditPayload('deleted', {
					id: normalizedId, workspace_id: current.workspace_id, name: current.name,
					description: current.description, version: current.designated_version,
				}),
				`service:management_key:${principal.keyId}`, nowIso,
			]);
			await transaction.unsafe(`DELETE FROM guardrails WHERE id = $1`, [normalizedId]);
			return 'deleted';
		});
	}

	assertManagementApiKeyAccount(principal.account);
	const connection = await client.raw.getConnection();
	try {
		await connection.beginTransaction();
		const scopeSql = principal.account.accountType === 'personal'
			? `workspace.scope_type = 'personal' AND workspace.personal_owner_user_id = ? AND workspace.organization_id IS NULL`
			: `workspace.scope_type = 'organization' AND workspace.personal_owner_user_id IS NULL AND workspace.organization_id = ?`;
		const scopeValue = principal.account.accountType === 'personal'
			? principal.account.personalOwnerUserId : principal.account.organizationId;
		const keySql = principal.account.accountType === 'personal'
			? `management_key.id = ? AND management_key.status = 'active'
				AND (management_key.expires_at IS NULL OR management_key.expires_at > UTC_TIMESTAMP(6))
				AND management_key.account_type = 'personal' AND management_key.personal_owner_user_id = ?
				AND management_key.organization_id IS NULL`
			: `management_key.id = ? AND management_key.status = 'active'
				AND (management_key.expires_at IS NULL OR management_key.expires_at > UTC_TIMESTAMP(6))
				AND management_key.account_type = 'organization' AND management_key.personal_owner_user_id IS NULL
				AND management_key.organization_id = ?`;
		const accountValue = principal.account.accountType === 'personal'
			? principal.account.personalOwnerUserId : principal.account.organizationId;
		const rows = await mysqlQueryRows<RowDataPacket & {
			workspace_id: string; name: string; description: string | null; designated_version: number;
			is_workspace_default: number; is_account_default: number;
		}>(connection, `SELECT guardrail.workspace_id, guardrail.name, guardrail.description,
			guardrail.designated_version, guardrail.is_workspace_default,
			guardrail.is_account_default FROM guardrails guardrail
			JOIN workspaces workspace ON workspace.id = guardrail.workspace_id
			JOIN management_api_keys management_key ON ${keySql}
		WHERE guardrail.id = ? AND guardrail.status = 'active'
			AND workspace.status = 'active' AND ${scopeSql}
			AND EXISTS (SELECT 1 FROM users creator WHERE creator.id = ? AND creator.status = 'active')
		FOR UPDATE`,
		[principal.keyId, accountValue, normalizedId, scopeValue, principal.createdByUserId]);
		const current = rows[0];
		if (!current) {
			await connection.rollback();
			return 'not_found';
		}
		if (Number(current.is_workspace_default) === 1 || Number(current.is_account_default) === 1) {
			await connection.rollback();
			return 'not_found';
		}
		const mysqlNow = toMySqlDateTime(nowIso);
		await mysqlExecute(connection, `INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) VALUES (?, ?, NULL, 'guardrail_deleted', 'service', ?,
			'gateway_management_guardrails', ?, 'guardrail_delete',
			'Guardrail deleted through Management API', ?)`, [
			crypto.randomUUID(), principal.createdByUserId,
			auditPayload('deleted', {
				id: normalizedId, workspace_id: current.workspace_id, name: current.name,
				description: current.description, version: current.designated_version,
			}),
			`service:management_key:${principal.keyId}`, mysqlNow,
		]);
		await mysqlExecute(connection, `DELETE FROM guardrails WHERE id = ?`, [normalizedId]);
		await connection.commit();
		return 'deleted';
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}
}
