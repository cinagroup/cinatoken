import type { RowDataPacket } from 'mysql2/promise';
import {
	assertManagementApiKeyAccount,
	type ManagementApiKeyAccount,
} from '../db/management-api-keys-types';
import { fromMySqlDateTime, mysqlExecute, mysqlQueryRows, toMySqlDateTime } from '../db/mysql/mysql2-compat';
import {
	managementWorkspaceSettingsJson,
	mergeManagementWorkspaceSettings,
	parseManagementWorkspaceSettings,
	type ManagementWorkspaceCreate,
	type ManagementWorkspaceDeleteResult,
	type ManagementWorkspaceListPage,
	type ManagementWorkspaceMutationPrincipal,
	type ManagementWorkspacePatch,
	type ManagementWorkspaceRow,
} from '../management-workspaces';
import type { WorkspaceScopeType } from '../workspaces';
import type { GatewayDatabaseClient } from './database-client';

type RawManagementWorkspaceRow = {
	id: string;
	scope_type: WorkspaceScopeType;
	organization_id: string | null;
	personal_owner_user_id: string | null;
	name: string;
	slug: string;
	description: string | null;
	is_default: boolean | number;
	status: 'active' | 'archived';
	settings_json: string | null;
	created_by_user_id: string | null;
	created_by: string | null;
	created_at: string | Date;
	updated_at: string | Date;
};

type MySqlManagementWorkspaceRow = RawManagementWorkspaceRow & RowDataPacket;

const MAX_WORKSPACE_IDENTIFIER_LENGTH = 600;
const MAX_PAGE_OFFSET = 1_000_000;

function isoTimestamp(value: string | Date, mysql = false): string {
	if (mysql) return fromMySqlDateTime(value);
	if (value instanceof Date) return value.toISOString();
	const parsed = Date.parse(String(value));
	if (!Number.isFinite(parsed)) throw new TypeError('Workspace timestamp is invalid');
	return new Date(parsed).toISOString();
}

function mapRow(row: RawManagementWorkspaceRow, mysql = false): ManagementWorkspaceRow {
	return {
		id: row.id,
		scope_type: row.scope_type,
		organization_id: row.organization_id,
		personal_owner_user_id: row.personal_owner_user_id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		is_default: row.is_default === true || Number(row.is_default) === 1,
		status: row.status,
		created_by: row.created_by,
		created_by_user_id: row.created_by_user_id,
		created_at: isoTimestamp(row.created_at, mysql),
		updated_at: isoTimestamp(row.updated_at, mysql),
		settings: parseManagementWorkspaceSettings(row.settings_json),
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

function identifier(value: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_WORKSPACE_IDENTIFIER_LENGTH) {
		throw new TypeError('workspace id or slug is invalid');
	}
	return normalized;
}

function d1AccountPredicate(account: ManagementApiKeyAccount, alias = 'workspace') {
	assertManagementApiKeyAccount(account);
	if (account.accountType === 'personal') {
		return {
			sql: `${alias}.scope_type = 'personal' AND ${alias}.personal_owner_user_id = ? AND ${alias}.organization_id IS NULL`,
			values: [account.personalOwnerUserId],
		};
	}
	return {
		sql: `${alias}.scope_type = 'organization' AND ${alias}.personal_owner_user_id IS NULL AND ${alias}.organization_id = ?`,
		values: [account.organizationId],
	};
}

function d1ActiveManagementKeyPredicate(principal: ManagementWorkspaceMutationPrincipal, alias = 'management_key') {
	const account = principal.account;
	assertManagementApiKeyAccount(account);
	if (account.accountType === 'personal') {
		return {
			sql: `${alias}.id = ? AND ${alias}.status = 'active'
				AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > datetime('now'))
				AND ${alias}.account_type = 'personal'
				AND ${alias}.personal_owner_user_id = ? AND ${alias}.organization_id IS NULL
				AND EXISTS (SELECT 1 FROM users owner WHERE owner.id = ${alias}.personal_owner_user_id AND owner.status = 'active')`,
			values: [principal.keyId, account.personalOwnerUserId],
		};
	}
	return {
		sql: `${alias}.id = ? AND ${alias}.status = 'active'
			AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > datetime('now'))
			AND ${alias}.account_type = 'organization'
			AND ${alias}.personal_owner_user_id IS NULL AND ${alias}.organization_id = ?
			AND EXISTS (SELECT 1 FROM organizations owner WHERE owner.id = ${alias}.organization_id AND owner.status IN ('active', 'pending'))`,
		values: [principal.keyId, account.organizationId],
	};
}

function postgresAccountPredicate(account: ManagementApiKeyAccount, alias = 'workspace', firstParam = 1) {
	assertManagementApiKeyAccount(account);
	return account.accountType === 'personal'
		? {
			sql: `${alias}.scope_type = 'personal' AND ${alias}.personal_owner_user_id = $${firstParam} AND ${alias}.organization_id IS NULL`,
			value: account.personalOwnerUserId,
		}
		: {
			sql: `${alias}.scope_type = 'organization' AND ${alias}.personal_owner_user_id IS NULL AND ${alias}.organization_id = $${firstParam}`,
			value: account.organizationId,
		};
}

function postgresActiveManagementKeyPredicate(
	principal: ManagementWorkspaceMutationPrincipal,
	alias = 'management_key',
	firstParam = 1,
) {
	const account = principal.account;
	assertManagementApiKeyAccount(account);
	return account.accountType === 'personal'
		? {
			sql: `${alias}.id = $${firstParam} AND ${alias}.status = 'active'
				AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > CURRENT_TIMESTAMP)
				AND ${alias}.account_type = 'personal'
				AND ${alias}.personal_owner_user_id = $${firstParam + 1} AND ${alias}.organization_id IS NULL
				AND EXISTS (SELECT 1 FROM users owner WHERE owner.id = ${alias}.personal_owner_user_id AND owner.status = 'active')`,
			values: [principal.keyId, account.personalOwnerUserId],
		}
		: {
			sql: `${alias}.id = $${firstParam} AND ${alias}.status = 'active'
				AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > CURRENT_TIMESTAMP)
				AND ${alias}.account_type = 'organization'
				AND ${alias}.personal_owner_user_id IS NULL AND ${alias}.organization_id = $${firstParam + 1}
				AND EXISTS (SELECT 1 FROM organizations owner WHERE owner.id = ${alias}.organization_id AND owner.status IN ('active', 'pending'))`,
			values: [principal.keyId, account.organizationId],
		};
}

const SELECT_COLUMNS = `workspace.id, workspace.scope_type, workspace.organization_id,
	workspace.personal_owner_user_id, workspace.name, workspace.slug, workspace.description,
	workspace.is_default, workspace.status, workspace.settings_json, workspace.created_by_user_id,
	COALESCE(creator.external_user_id, workspace.created_by_user_id) AS created_by,
	workspace.created_at, workspace.updated_at`;

function auditPayload(
	action: 'created' | 'updated' | 'deleted',
	workspace: Pick<ManagementWorkspaceRow, 'id' | 'name' | 'slug' | 'scope_type' | 'is_default'>,
): string {
	return JSON.stringify({
		resource_type: 'workspace',
		workspace_id: workspace.id,
		workspace_name: workspace.name,
		workspace_slug: workspace.slug,
		account_type: workspace.scope_type,
		is_default: workspace.is_default,
		action,
	});
}

function duplicateWorkspaceError(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	if (/unique|duplicate/iu.test(message) && /workspace|slug/iu.test(message)) {
		throw new TypeError('Workspace slug already exists in this account');
	}
	throw error;
}

export async function listManagementWorkspaces(
	client: GatewayDatabaseClient,
	account: ManagementApiKeyAccount,
	page: { offset: number; limit: number },
): Promise<ManagementWorkspaceListPage> {
	assertPage(page.offset, page.limit);
	assertManagementApiKeyAccount(account);
	if (client.driver === 'd1') {
		const predicate = d1AccountPredicate(account);
		const count = await client.raw.prepare(`SELECT COUNT(*) AS total_count FROM workspaces workspace
			WHERE workspace.status = 'active' AND ${predicate.sql}`)
			.bind(...predicate.values).first<{ total_count: number | string }>();
		const rows = await client.raw.prepare(`SELECT ${SELECT_COLUMNS}
			FROM workspaces workspace LEFT JOIN users creator ON creator.id = workspace.created_by_user_id
			WHERE workspace.status = 'active' AND ${predicate.sql}
			ORDER BY workspace.created_at ASC, workspace.id ASC LIMIT ? OFFSET ?`)
			.bind(...predicate.values, page.limit, page.offset).all<RawManagementWorkspaceRow>();
		return { data: (rows.results ?? []).map((row) => mapRow(row)), totalCount: Number(count?.total_count ?? 0) };
	}
	if (client.driver === 'postgres') {
		const predicate = postgresAccountPredicate(account);
		const counts = await client.raw.unsafe<Array<{ total_count: number | string }>>(
			`SELECT COUNT(*) AS total_count FROM workspaces workspace WHERE workspace.status = 'active' AND ${predicate.sql}`,
			[predicate.value],
		);
		const rows = await client.raw.unsafe<RawManagementWorkspaceRow[]>(`SELECT ${SELECT_COLUMNS}
			FROM workspaces workspace LEFT JOIN users creator ON creator.id = workspace.created_by_user_id
			WHERE workspace.status = 'active' AND ${predicate.sql}
			ORDER BY workspace.created_at ASC, workspace.id ASC LIMIT $2 OFFSET $3`,
		[predicate.value, page.limit, page.offset]);
		return { data: rows.map((row) => mapRow(row)), totalCount: Number(counts[0]?.total_count ?? 0) };
	}
	const predicate = d1AccountPredicate(account);
	const counts = await mysqlQueryRows<RowDataPacket & { total_count: number | string }>(client.raw,
		`SELECT COUNT(*) AS total_count FROM workspaces workspace WHERE workspace.status = 'active' AND ${predicate.sql}`,
		predicate.values);
	const rows = await mysqlQueryRows<MySqlManagementWorkspaceRow>(client.raw, `SELECT ${SELECT_COLUMNS}
		FROM workspaces workspace LEFT JOIN users creator ON creator.id = workspace.created_by_user_id
		WHERE workspace.status = 'active' AND ${predicate.sql}
		ORDER BY workspace.created_at ASC, workspace.id ASC LIMIT ? OFFSET ?`,
	[...predicate.values, page.limit, page.offset]);
	return { data: rows.map((row) => mapRow(row, true)), totalCount: Number(counts[0]?.total_count ?? 0) };
}

export async function getManagementWorkspace(
	client: GatewayDatabaseClient,
	account: ManagementApiKeyAccount,
	idOrSlug: string,
): Promise<ManagementWorkspaceRow | null> {
	const resolved = identifier(idOrSlug);
	assertManagementApiKeyAccount(account);
	if (client.driver === 'd1') {
		const predicate = d1AccountPredicate(account);
		const row = await client.raw.prepare(`SELECT ${SELECT_COLUMNS}
			FROM workspaces workspace LEFT JOIN users creator ON creator.id = workspace.created_by_user_id
			WHERE workspace.status = 'active' AND (workspace.id = ? OR workspace.slug = ?) AND ${predicate.sql}
			ORDER BY CASE WHEN workspace.id = ? THEN 0 ELSE 1 END LIMIT 1`)
			.bind(resolved, resolved, ...predicate.values, resolved).first<RawManagementWorkspaceRow>();
		return row ? mapRow(row) : null;
	}
	if (client.driver === 'postgres') {
		const predicate = postgresAccountPredicate(account, 'workspace', 2);
		const rows = await client.raw.unsafe<RawManagementWorkspaceRow[]>(`SELECT ${SELECT_COLUMNS}
			FROM workspaces workspace LEFT JOIN users creator ON creator.id = workspace.created_by_user_id
			WHERE workspace.status = 'active' AND (workspace.id = $1 OR workspace.slug = $1) AND ${predicate.sql}
			ORDER BY CASE WHEN workspace.id = $1 THEN 0 ELSE 1 END LIMIT 1`, [resolved, predicate.value]);
		return rows[0] ? mapRow(rows[0]) : null;
	}
	const predicate = d1AccountPredicate(account);
	const rows = await mysqlQueryRows<MySqlManagementWorkspaceRow>(client.raw, `SELECT ${SELECT_COLUMNS}
		FROM workspaces workspace LEFT JOIN users creator ON creator.id = workspace.created_by_user_id
		WHERE workspace.status = 'active' AND (workspace.id = ? OR workspace.slug = ?) AND ${predicate.sql}
		ORDER BY CASE WHEN workspace.id = ? THEN 0 ELSE 1 END LIMIT 1`,
	[resolved, resolved, ...predicate.values, resolved]);
	return rows[0] ? mapRow(rows[0], true) : null;
}

export async function createManagementWorkspace(
	client: GatewayDatabaseClient,
	principal: ManagementWorkspaceMutationPrincipal,
	input: ManagementWorkspaceCreate,
	options: { id?: string; nowIso?: string } = {},
): Promise<ManagementWorkspaceRow | null> {
	assertManagementApiKeyAccount(principal.account);
	if (!principal.createdByUserId) return null;
	const id = options.id ?? crypto.randomUUID();
	if (!id || id.length > MAX_WORKSPACE_IDENTIFIER_LENGTH) throw new TypeError('workspace id is invalid');
	const defaultGuardrailId = crypto.randomUUID();
	const defaultGuardrailVersionId = crypto.randomUUID();
	const defaultGuardrailName = `Workspace ${id.slice(0, 180)} Default`;
	const nowIso = isoTimestamp(options.nowIso ?? new Date().toISOString());
	const settingsJson = managementWorkspaceSettingsJson(input.settings);
	const account = principal.account;
	try {
		if (client.driver === 'd1') {
			const key = d1ActiveManagementKeyPredicate(principal);
			const create = client.raw.prepare(`INSERT INTO workspaces (
				id, scope_type, organization_id, personal_owner_user_id, name, slug, description,
				is_default, default_scope_key, status, settings_json, created_by_user_id, created_at, updated_at
			) SELECT ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'active', ?,
				CASE WHEN EXISTS (SELECT 1 FROM users creator WHERE creator.id = ? AND creator.status = 'active') THEN ? ELSE NULL END,
				?, ? FROM management_api_keys management_key WHERE ${key.sql}`)
				.bind(
					id, account.accountType, account.organizationId, account.personalOwnerUserId,
					input.name, input.slug, input.description, settingsJson,
					principal.createdByUserId, principal.createdByUserId, nowIso, nowIso,
					...key.values,
				);
			const payload = JSON.stringify({ resource_type: 'workspace', workspace_id: id, action: 'created' });
			const defaultGuardrail = client.raw.prepare(`INSERT INTO guardrails (
				id, workspace_id, owner_user_id, name, description, status,
				designated_version, latest_version, created_at, updated_at, is_workspace_default
			) SELECT ?, workspace.id, ?, ?, NULL, 'active', 1, 1, ?, ?, 1
			FROM workspaces workspace JOIN users creator ON creator.id = ? AND creator.status = 'active'
			WHERE workspace.id = ? AND workspace.status = 'active'`)
				.bind(defaultGuardrailId, principal.createdByUserId, defaultGuardrailName,
					nowIso, nowIso, principal.createdByUserId, id);
			const defaultVersion = client.raw.prepare(`INSERT INTO guardrail_versions (
				id, guardrail_id, version, config_json, created_by_user_id, created_at
			) SELECT ?, guardrail.id, 1, '{}', ?, ? FROM guardrails guardrail
			WHERE guardrail.id = ? AND guardrail.is_workspace_default = 1`)
				.bind(defaultGuardrailVersionId, principal.createdByUserId, nowIso, defaultGuardrailId);
			const audit = client.raw.prepare(`INSERT INTO user_audit_logs (
				id, user_id, api_key_id, event_type, actor_type, change_payload,
				source, actor_id, reason_code, reason_text, created_at
			) SELECT ?, ?, NULL, 'workspace_created', 'service', ?,
				'gateway_management_workspaces', ?, 'workspace_create',
				'Workspace created through Management API', ?
			FROM workspaces workspace JOIN management_api_keys management_key ON ${key.sql}
			WHERE workspace.id = ? AND workspace.status = 'active'`)
				.bind(
					crypto.randomUUID(), principal.createdByUserId, payload,
					`service:management_key:${principal.keyId}`, nowIso,
					...key.values, id,
				);
			const results = await client.raw.batch([create, defaultGuardrail, defaultVersion, audit]);
			if (results.slice(0, 3).some((result) => (result?.meta.changes ?? 0) !== 1)) return null;
			return getManagementWorkspace(client, account, id);
		}

		if (client.driver === 'postgres') {
			const created = await client.raw.begin(async (transaction) => {
				const key = postgresActiveManagementKeyPredicate(principal, 'management_key', 11);
				const rows = await transaction.unsafe<Array<{ id: string }>>(`INSERT INTO workspaces (
					id, scope_type, organization_id, personal_owner_user_id, name, slug, description,
					is_default, default_scope_key, status, settings_json, created_by_user_id, created_at, updated_at
				) SELECT $1, $2, $3, $4, $5, $6, $7, FALSE, NULL, 'active', $8,
					CASE WHEN EXISTS (SELECT 1 FROM users creator WHERE creator.id = $9 AND creator.status = 'active') THEN $9 ELSE NULL END,
					$10, $10 FROM management_api_keys management_key WHERE ${key.sql}
				RETURNING id`, [
					id, account.accountType, account.organizationId, account.personalOwnerUserId,
					input.name, input.slug, input.description, settingsJson,
					principal.createdByUserId, nowIso, ...key.values,
				]);
				if (rows.length !== 1) return false;
				await transaction.unsafe(`INSERT INTO guardrails (
					id, workspace_id, owner_user_id, name, description, status,
					designated_version, latest_version, created_at, updated_at, is_workspace_default
				) VALUES ($1, $2, $3, $4, NULL, 'active', 1, 1, $5, $5, TRUE)`, [
					defaultGuardrailId, id, principal.createdByUserId, defaultGuardrailName, nowIso,
				]);
				await transaction.unsafe(`INSERT INTO guardrail_versions (
					id, guardrail_id, version, config_json, created_by_user_id, created_at
				) VALUES ($1, $2, 1, '{}', $3, $4)`, [
					defaultGuardrailVersionId, defaultGuardrailId, principal.createdByUserId, nowIso,
				]);
				await transaction.unsafe(`INSERT INTO user_audit_logs (
					id, user_id, api_key_id, event_type, actor_type, change_payload,
					source, actor_id, reason_code, reason_text, created_at
				) VALUES ($1, $2, NULL, 'workspace_created', 'service', $3,
					'gateway_management_workspaces', $4, 'workspace_create',
					'Workspace created through Management API', $5)`, [
					crypto.randomUUID(), principal.createdByUserId,
					JSON.stringify({ resource_type: 'workspace', workspace_id: id, action: 'created' }),
					`service:management_key:${principal.keyId}`, nowIso,
				]);
				return true;
			});
			return created ? getManagementWorkspace(client, account, id) : null;
		}

		const connection = await client.raw.getConnection();
		try {
			await connection.beginTransaction();
			const key = d1ActiveManagementKeyPredicate(principal);
			const mysqlNow = toMySqlDateTime(nowIso);
			const inserted = await mysqlExecute(connection, `INSERT INTO workspaces (
				id, scope_type, organization_id, personal_owner_user_id, name, slug, description,
				is_default, default_scope_key, status, settings_json, created_by_user_id, created_at, updated_at
			) SELECT ?, ?, ?, ?, ?, ?, ?, FALSE, NULL, 'active', ?,
				CASE WHEN EXISTS (SELECT 1 FROM users creator WHERE creator.id = ? AND creator.status = 'active') THEN ? ELSE NULL END,
				?, ? FROM management_api_keys management_key WHERE ${key.sql.replaceAll("datetime('now')", 'UTC_TIMESTAMP(6)')}`,
			[
				id, account.accountType, account.organizationId, account.personalOwnerUserId,
				input.name, input.slug, input.description, settingsJson,
				principal.createdByUserId, principal.createdByUserId, mysqlNow, mysqlNow,
				...key.values,
			]);
			if (inserted.affectedRows !== 1) {
				await connection.rollback();
				return null;
			}
			await mysqlExecute(connection, `INSERT INTO guardrails (
				id, workspace_id, workspace_key, owner_user_id, name, description, status,
				designated_version, latest_version, created_at, updated_at, is_workspace_default
			) VALUES (?, ?, SHA2(?, 256), ?, ?, NULL, 'active', 1, 1, ?, ?, TRUE)`, [
				defaultGuardrailId, id, id, principal.createdByUserId,
				defaultGuardrailName, mysqlNow, mysqlNow,
			]);
			await mysqlExecute(connection, `INSERT INTO guardrail_versions (
				id, guardrail_id, version, config_json, created_by_user_id, created_at
			) VALUES (?, ?, 1, '{}', ?, ?)`, [
				defaultGuardrailVersionId, defaultGuardrailId, principal.createdByUserId, mysqlNow,
			]);
			await mysqlExecute(connection, `INSERT INTO user_audit_logs (
				id, user_id, api_key_id, event_type, actor_type, change_payload,
				source, actor_id, reason_code, reason_text, created_at
			) VALUES (?, ?, NULL, 'workspace_created', 'service', ?,
				'gateway_management_workspaces', ?, 'workspace_create',
				'Workspace created through Management API', ?)`, [
				crypto.randomUUID(), principal.createdByUserId,
				JSON.stringify({ resource_type: 'workspace', workspace_id: id, action: 'created' }),
				`service:management_key:${principal.keyId}`, mysqlNow,
			]);
			await connection.commit();
		} catch (error) {
			await connection.rollback().catch(() => undefined);
			throw error;
		} finally {
			connection.release();
		}
		return getManagementWorkspace(client, account, id);
	} catch (error) {
		duplicateWorkspaceError(error);
	}
}

export async function updateManagementWorkspace(
	client: GatewayDatabaseClient,
	principal: ManagementWorkspaceMutationPrincipal,
	idOrSlug: string,
	patch: ManagementWorkspacePatch,
	options: { nowIso?: string } = {},
): Promise<ManagementWorkspaceRow | null> {
	const resolved = identifier(idOrSlug);
	const account = principal.account;
	assertManagementApiKeyAccount(account);
	const nowIso = isoTimestamp(options.nowIso ?? new Date().toISOString());
	try {
		if (client.driver === 'd1') {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const current = await getManagementWorkspace(client, account, resolved);
				if (!current) return null;
				const settings = mergeManagementWorkspaceSettings(current.settings, patch.settings);
				const owner = d1AccountPredicate(account);
				const key = d1ActiveManagementKeyPredicate(principal);
				const payload = auditPayload('updated', {
					...current,
					name: patch.name ?? current.name,
					slug: patch.slug ?? current.slug,
				});
				const update = client.raw.prepare(`UPDATE workspaces AS workspace SET
					name = ?, slug = ?, description = ?, settings_json = ?, updated_at = ?
				WHERE workspace.id = ? AND workspace.status = 'active' AND workspace.updated_at = ?
					AND ${owner.sql} AND EXISTS (
						SELECT 1 FROM management_api_keys management_key WHERE ${key.sql}
					)`)
					.bind(
						patch.name ?? current.name, patch.slug ?? current.slug,
						patch.description === undefined ? current.description : patch.description,
						managementWorkspaceSettingsJson(settings), nowIso,
						current.id, current.updated_at, ...owner.values, ...key.values,
					);
				const audit = client.raw.prepare(`INSERT INTO user_audit_logs (
					id, user_id, api_key_id, event_type, actor_type, change_payload,
					source, actor_id, reason_code, reason_text, created_at
				) SELECT ?, ?, NULL, 'workspace_updated', 'service', ?,
					'gateway_management_workspaces', ?, 'workspace_update',
					'Workspace updated through Management API', ?
				FROM workspaces workspace WHERE workspace.id = ? AND workspace.updated_at = ?`)
					.bind(
						crypto.randomUUID(), principal.createdByUserId, payload,
						`service:management_key:${principal.keyId}`, nowIso, current.id, nowIso,
					);
				const results = await client.raw.batch([update, audit]);
				if ((results[0]?.meta.changes ?? 0) === 1) {
					return getManagementWorkspace(client, account, current.id);
				}
			}
			throw new Error('Workspace changed concurrently; retry the request');
		}

		if (client.driver === 'postgres') {
			const workspaceId = await client.raw.begin(async (transaction) => {
				const accountPredicate = postgresAccountPredicate(account, 'workspace', 2);
				const currentRows = await transaction.unsafe<RawManagementWorkspaceRow[]>(`SELECT ${SELECT_COLUMNS}
					FROM workspaces workspace LEFT JOIN users creator ON creator.id = workspace.created_by_user_id
					WHERE workspace.status = 'active' AND (workspace.id = $1 OR workspace.slug = $1)
						AND ${accountPredicate.sql}
					ORDER BY CASE WHEN workspace.id = $1 THEN 0 ELSE 1 END LIMIT 1 FOR UPDATE OF workspace`,
				[resolved, accountPredicate.value]);
				if (!currentRows[0]) return null;
				const current = mapRow(currentRows[0]);
				const key = postgresActiveManagementKeyPredicate(principal, 'management_key', 7);
				const updated = await transaction.unsafe<Array<{ id: string }>>(`UPDATE workspaces AS workspace SET
					name = $1, slug = $2, description = $3, settings_json = $4, updated_at = $5
				WHERE workspace.id = $6 AND EXISTS (
					SELECT 1 FROM management_api_keys management_key WHERE ${key.sql}
				) RETURNING workspace.id`, [
					patch.name ?? current.name, patch.slug ?? current.slug,
					patch.description === undefined ? current.description : patch.description,
					managementWorkspaceSettingsJson(mergeManagementWorkspaceSettings(current.settings, patch.settings)),
					nowIso, current.id, ...key.values,
				]);
				if (updated.length !== 1) return null;
				await transaction.unsafe(`INSERT INTO user_audit_logs (
					id, user_id, api_key_id, event_type, actor_type, change_payload,
					source, actor_id, reason_code, reason_text, created_at
				) VALUES ($1, $2, NULL, 'workspace_updated', 'service', $3,
					'gateway_management_workspaces', $4, 'workspace_update',
					'Workspace updated through Management API', $5)`, [
					crypto.randomUUID(), principal.createdByUserId,
					auditPayload('updated', { ...current, name: patch.name ?? current.name, slug: patch.slug ?? current.slug }),
					`service:management_key:${principal.keyId}`, nowIso,
				]);
				return current.id;
			});
			return workspaceId ? getManagementWorkspace(client, account, workspaceId) : null;
		}

		const connection = await client.raw.getConnection();
		let workspaceId: string | null = null;
		try {
			await connection.beginTransaction();
			const owner = d1AccountPredicate(account);
			const currentRows = await mysqlQueryRows<MySqlManagementWorkspaceRow>(connection, `SELECT ${SELECT_COLUMNS}
				FROM workspaces workspace LEFT JOIN users creator ON creator.id = workspace.created_by_user_id
				WHERE workspace.status = 'active' AND (workspace.id = ? OR workspace.slug = ?) AND ${owner.sql}
				ORDER BY CASE WHEN workspace.id = ? THEN 0 ELSE 1 END LIMIT 1 FOR UPDATE`,
			[resolved, resolved, ...owner.values, resolved]);
			if (!currentRows[0]) {
				await connection.rollback();
				return null;
			}
			const current = mapRow(currentRows[0], true);
			const key = d1ActiveManagementKeyPredicate(principal);
			const updated = await mysqlExecute(connection, `UPDATE workspaces AS workspace SET
				name = ?, slug = ?, description = ?, settings_json = ?, updated_at = ?
			WHERE workspace.id = ? AND EXISTS (
				SELECT 1 FROM management_api_keys management_key WHERE ${key.sql.replaceAll("datetime('now')", 'UTC_TIMESTAMP(6)')}
			)`, [
				patch.name ?? current.name, patch.slug ?? current.slug,
				patch.description === undefined ? current.description : patch.description,
				managementWorkspaceSettingsJson(mergeManagementWorkspaceSettings(current.settings, patch.settings)),
				toMySqlDateTime(nowIso), current.id, ...key.values,
			]);
			if (updated.affectedRows !== 1) {
				await connection.rollback();
				return null;
			}
			await mysqlExecute(connection, `INSERT INTO user_audit_logs (
				id, user_id, api_key_id, event_type, actor_type, change_payload,
				source, actor_id, reason_code, reason_text, created_at
			) VALUES (?, ?, NULL, 'workspace_updated', 'service', ?,
				'gateway_management_workspaces', ?, 'workspace_update',
				'Workspace updated through Management API', ?)`, [
				crypto.randomUUID(), principal.createdByUserId,
				auditPayload('updated', { ...current, name: patch.name ?? current.name, slug: patch.slug ?? current.slug }),
				`service:management_key:${principal.keyId}`, toMySqlDateTime(nowIso),
			]);
			await connection.commit();
			workspaceId = current.id;
		} catch (error) {
			await connection.rollback().catch(() => undefined);
			throw error;
		} finally {
			connection.release();
		}
		return workspaceId ? getManagementWorkspace(client, account, workspaceId) : null;
	} catch (error) {
		duplicateWorkspaceError(error);
	}
}

export async function deleteManagementWorkspace(
	client: GatewayDatabaseClient,
	principal: ManagementWorkspaceMutationPrincipal,
	idOrSlug: string,
	confirmDefaultDeletion: boolean,
	options: { nowIso?: string } = {},
): Promise<ManagementWorkspaceDeleteResult> {
	const resolved = identifier(idOrSlug);
	const account = principal.account;
	assertManagementApiKeyAccount(account);
	const nowIso = isoTimestamp(options.nowIso ?? new Date().toISOString());

	if (client.driver === 'd1') {
		const current = await getManagementWorkspace(client, account, resolved);
		if (!current) return 'not_found';
		if (current.is_default && !confirmDefaultDeletion) return 'confirmation_required';
		const active = await client.raw.prepare(`SELECT 1 AS present FROM api_keys
			WHERE workspace_id = ? AND status = 'active' LIMIT 1`).bind(current.id).first<{ present: number }>();
		if (active) return 'active_keys';
		const accountDefault = await client.raw.prepare(`SELECT id FROM guardrails
			WHERE workspace_id = ? AND is_account_default = 1 LIMIT 1`)
			.bind(current.id).first<{ id: string }>();
		let accountDefaultAnchor: string | null = null;
		if (accountDefault) {
			const alternative = await client.raw.prepare(`SELECT id FROM workspaces
				WHERE id <> ? AND status = 'active' AND scope_type = ?
					AND ((? = 'personal' AND personal_owner_user_id = ? AND organization_id IS NULL)
						OR (? = 'organization' AND organization_id = ? AND personal_owner_user_id IS NULL))
				ORDER BY is_default DESC, created_at, id LIMIT 1`)
				.bind(current.id, current.scope_type,
					current.scope_type, current.personal_owner_user_id,
					current.scope_type, current.organization_id)
				.first<{ id: string }>();
			if (!alternative) return 'account_default_anchor';
			accountDefaultAnchor = alternative.id;
		}
		const owner = d1AccountPredicate(account);
		const key = d1ActiveManagementKeyPredicate(principal);
		const statements = [];
		if (accountDefaultAnchor) {
			statements.push(client.raw.prepare(`UPDATE guardrails SET workspace_id = ?, updated_at = ?
				WHERE workspace_id = ? AND is_account_default = 1`)
				.bind(accountDefaultAnchor, nowIso, current.id));
		}
		const deleteIndex = statements.length;
		statements.push(
			client.raw.prepare(`DELETE FROM workspaces AS workspace
				WHERE workspace.id = ? AND workspace.status = 'active' AND ${owner.sql}
					AND NOT EXISTS (SELECT 1 FROM api_keys active_key WHERE active_key.workspace_id = workspace.id AND active_key.status = 'active')
					AND EXISTS (SELECT 1 FROM management_api_keys management_key WHERE ${key.sql})`)
				.bind(current.id, ...owner.values, ...key.values),
		);
		if (current.is_default) {
			statements.push(client.raw.prepare(`INSERT INTO workspaces (
				id, scope_type, organization_id, personal_owner_user_id, name, slug, description,
				is_default, default_scope_key, status, settings_json, created_by_user_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, 'archived', NULL, NULL, ?, ?)`)
				.bind(
					current.id, current.scope_type, current.organization_id, current.personal_owner_user_id,
					current.name, current.slug, current.id, current.created_at, nowIso,
				));
		}
		statements.push(client.raw.prepare(`INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) VALUES (?, ?, NULL, 'workspace_deleted', 'service', ?,
			'gateway_management_workspaces', ?, 'workspace_delete',
			'Workspace deleted through Management API', ?)`)
			.bind(
				crypto.randomUUID(), principal.createdByUserId, auditPayload('deleted', current),
				`service:management_key:${principal.keyId}`, nowIso,
			));
		try {
			const results = await client.raw.batch(statements);
			return (results[deleteIndex]?.meta.changes ?? 0) === 1 ? 'deleted' : 'not_found';
		} catch {
			const stillActive = await client.raw.prepare(`SELECT 1 AS present FROM api_keys
				WHERE workspace_id = ? AND status = 'active' LIMIT 1`).bind(current.id).first<{ present: number }>();
			return stillActive ? 'active_keys' : 'not_found';
		}
	}

	if (client.driver === 'postgres') {
		return client.raw.begin(async (transaction) => {
			const owner = postgresAccountPredicate(account, 'workspace', 2);
			const rows = await transaction.unsafe<RawManagementWorkspaceRow[]>(`SELECT ${SELECT_COLUMNS}
				FROM workspaces workspace LEFT JOIN users creator ON creator.id = workspace.created_by_user_id
				WHERE workspace.status = 'active' AND (workspace.id = $1 OR workspace.slug = $1) AND ${owner.sql}
				ORDER BY CASE WHEN workspace.id = $1 THEN 0 ELSE 1 END LIMIT 1 FOR UPDATE OF workspace`,
			[resolved, owner.value]);
			if (!rows[0]) return 'not_found';
			const current = mapRow(rows[0]);
			if (current.is_default && !confirmDefaultDeletion) return 'confirmation_required';
			const active = await transaction.unsafe<Array<{ id: string }>>(
				`SELECT id FROM api_keys WHERE workspace_id = $1 AND status = 'active' LIMIT 1 FOR UPDATE`, [current.id]);
			if (active.length > 0) return 'active_keys';
			const accountDefault = await transaction.unsafe<Array<{ id: string }>>(
				`SELECT id FROM guardrails WHERE workspace_id = $1 AND is_account_default LIMIT 1 FOR UPDATE`,
				[current.id]);
			let accountDefaultAnchor: string | null = null;
			if (accountDefault.length > 0) {
				const alternative = await transaction.unsafe<Array<{ id: string }>>(`SELECT id FROM workspaces
					WHERE id <> $1 AND status = 'active' AND scope_type = $2
						AND (($2 = 'personal' AND personal_owner_user_id = $3 AND organization_id IS NULL)
							OR ($2 = 'organization' AND organization_id = $4 AND personal_owner_user_id IS NULL))
					ORDER BY is_default DESC, created_at, id LIMIT 1 FOR UPDATE`,
				[current.id, current.scope_type, current.personal_owner_user_id, current.organization_id]);
				if (!alternative[0]) return 'account_default_anchor';
				accountDefaultAnchor = alternative[0].id;
			}
			const key = postgresActiveManagementKeyPredicate(principal, 'management_key', 1);
			const authorized = await transaction.unsafe<Array<{ id: string }>>(
				`SELECT management_key.id FROM management_api_keys management_key WHERE ${key.sql} FOR UPDATE`, key.values);
			if (authorized.length !== 1) return 'not_found';
			if (accountDefaultAnchor) {
				await transaction.unsafe(`UPDATE guardrails SET workspace_id = $1, updated_at = $2
					WHERE workspace_id = $3 AND is_account_default`,
				[accountDefaultAnchor, nowIso, current.id]);
			}
			await transaction.unsafe(`DELETE FROM workspaces WHERE id = $1`, [current.id]);
			if (current.is_default) {
				await transaction.unsafe(`INSERT INTO workspaces (
					id, scope_type, organization_id, personal_owner_user_id, name, slug, description,
					is_default, default_scope_key, status, settings_json, created_by_user_id, created_at, updated_at
				) VALUES ($1, $2, $3, $4, $5, $6, NULL, TRUE, $1, 'archived', NULL, NULL, $7, $8)`, [
					current.id, current.scope_type, current.organization_id, current.personal_owner_user_id,
					current.name, current.slug, current.created_at, nowIso,
				]);
			}
			await transaction.unsafe(`INSERT INTO user_audit_logs (
				id, user_id, api_key_id, event_type, actor_type, change_payload,
				source, actor_id, reason_code, reason_text, created_at
			) VALUES ($1, $2, NULL, 'workspace_deleted', 'service', $3,
				'gateway_management_workspaces', $4, 'workspace_delete',
				'Workspace deleted through Management API', $5)`, [
				crypto.randomUUID(), principal.createdByUserId, auditPayload('deleted', current),
				`service:management_key:${principal.keyId}`, nowIso,
			]);
			return 'deleted';
		});
	}

	const connection = await client.raw.getConnection();
	try {
		await connection.beginTransaction();
		const owner = d1AccountPredicate(account);
		const rows = await mysqlQueryRows<MySqlManagementWorkspaceRow>(connection, `SELECT ${SELECT_COLUMNS}
			FROM workspaces workspace LEFT JOIN users creator ON creator.id = workspace.created_by_user_id
			WHERE workspace.status = 'active' AND (workspace.id = ? OR workspace.slug = ?) AND ${owner.sql}
			ORDER BY CASE WHEN workspace.id = ? THEN 0 ELSE 1 END LIMIT 1 FOR UPDATE`,
		[resolved, resolved, ...owner.values, resolved]);
		if (!rows[0]) {
			await connection.rollback();
			return 'not_found';
		}
		const current = mapRow(rows[0], true);
		if (current.is_default && !confirmDefaultDeletion) {
			await connection.rollback();
			return 'confirmation_required';
		}
		const active = await mysqlQueryRows<RowDataPacket & { id: string }>(connection,
			`SELECT id FROM api_keys WHERE workspace_id = ? AND status = 'active' LIMIT 1 FOR UPDATE`, [current.id]);
		if (active.length > 0) {
			await connection.rollback();
			return 'active_keys';
		}
		const accountDefault = await mysqlQueryRows<RowDataPacket & { id: string }>(connection,
			`SELECT id FROM guardrails WHERE workspace_id = ? AND is_account_default = TRUE LIMIT 1 FOR UPDATE`,
			[current.id]);
		let accountDefaultAnchor: string | null = null;
		if (accountDefault.length > 0) {
			const alternative = await mysqlQueryRows<RowDataPacket & { id: string }>(connection, `SELECT id FROM workspaces
				WHERE id <> ? AND status = 'active' AND scope_type = ?
					AND ((? = 'personal' AND personal_owner_user_id = ? AND organization_id IS NULL)
						OR (? = 'organization' AND organization_id = ? AND personal_owner_user_id IS NULL))
				ORDER BY is_default DESC, created_at, id LIMIT 1 FOR UPDATE`,
			[current.id, current.scope_type,
				current.scope_type, current.personal_owner_user_id,
				current.scope_type, current.organization_id]);
			if (!alternative[0]) {
				await connection.rollback();
				return 'account_default_anchor';
			}
			accountDefaultAnchor = alternative[0].id;
		}
		const key = d1ActiveManagementKeyPredicate(principal);
		const authorized = await mysqlQueryRows<RowDataPacket & { id: string }>(connection,
			`SELECT management_key.id FROM management_api_keys management_key
			WHERE ${key.sql.replaceAll("datetime('now')", 'UTC_TIMESTAMP(6)')} FOR UPDATE`, key.values);
		if (authorized.length !== 1) {
			await connection.rollback();
			return 'not_found';
		}
		if (accountDefaultAnchor) {
			await mysqlExecute(connection, `UPDATE guardrails
				SET workspace_id = ?, workspace_key = SHA2(?, 256), updated_at = ?
				WHERE workspace_id = ? AND is_account_default = TRUE`,
			[accountDefaultAnchor, accountDefaultAnchor, toMySqlDateTime(nowIso), current.id]);
		}
		await mysqlExecute(connection, `DELETE FROM workspaces WHERE id = ?`, [current.id]);
		if (current.is_default) {
			await mysqlExecute(connection, `INSERT INTO workspaces (
				id, scope_type, organization_id, personal_owner_user_id, name, slug, description,
				is_default, default_scope_key, status, settings_json, created_by_user_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, NULL, TRUE, ?, 'archived', NULL, NULL, ?, ?)`, [
				current.id, current.scope_type, current.organization_id, current.personal_owner_user_id,
				current.name, current.slug, current.id,
				toMySqlDateTime(current.created_at), toMySqlDateTime(nowIso),
			]);
		}
		await mysqlExecute(connection, `INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) VALUES (?, ?, NULL, 'workspace_deleted', 'service', ?,
			'gateway_management_workspaces', ?, 'workspace_delete',
			'Workspace deleted through Management API', ?)`, [
			crypto.randomUUID(), principal.createdByUserId, auditPayload('deleted', current),
			`service:management_key:${principal.keyId}`, toMySqlDateTime(nowIso),
		]);
		await connection.commit();
		return 'deleted';
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}
}
