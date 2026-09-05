import type { RowDataPacket } from 'mysql2/promise';
import {
	BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER,
	BYOK_MAX_RUNTIME_KEYS,
	byokAccountFromPrincipal,
	isByokPortalUserPrincipal,
	type ByokKeyInsertParams,
	type ByokKeyListPage,
	type ByokKeyPatch,
	type ByokKeyReorder,
	type ByokKeyReorderParams,
	type ByokKeyRow,
	type ByokKeyUpdateParams,
	type ByokManagementMutation,
	type ByokMutationPrincipal,
	type ByokRuntimeKeyRow,
	type ByokRuntimeLookup,
} from '../db/byok-keys-types';
import {
	assertManagementApiKeyAccount,
	type ManagementApiKeyAccount,
	type ManagementApiKeyPrincipal,
} from '../db/management-api-keys-types';
import {
	fromMySqlDateTime,
	mysqlExecute,
	mysqlQueryRows,
	toMySqlDateTime,
} from '../db/mysql/mysql2-compat';
import { isEncryptedSharedKeySecret } from '../lib/shared-key-encryption';
import type { ByokKeysRepository } from './gateway-repository-interfaces';
import type { GatewayDatabaseClient } from './database-client';

type RawByokKeyRow = {
	id: string;
	workspace_id: string;
	provider: string;
	name: string | null;
	api_key?: string;
	label: string;
	disabled: boolean | number;
	is_fallback: boolean | number;
	always_use_for_provider: boolean | number;
	always_use_for_matching_models: boolean | number;
	sort_order: number;
	allowed_models_json: string | null;
	allowed_user_ids_json: string | null;
	allowed_api_key_hashes_json: string | null;
	created_by_management_key_id: string | null;
	created_at: string | Date;
	updated_at: string | Date;
};

type MySqlByokKeyRow = RawByokKeyRow & RowDataPacket;
type MySqlCountRow = RowDataPacket & { total_count: number | string };
type SqlValue = string | number | boolean | null;

const MAX_PAGE_OFFSET = 1_000_000;
const METADATA_COLUMNS = `byok.id, byok.workspace_id, byok.provider, byok.name,
	byok.label, byok.disabled, byok.is_fallback, byok.always_use_for_provider,
	byok.always_use_for_matching_models, byok.sort_order,
	byok.allowed_models_json, byok.allowed_user_ids_json,
	byok.allowed_api_key_hashes_json, byok.created_by_management_key_id,
	byok.created_at, byok.updated_at`;
const RUNTIME_COLUMNS = `${METADATA_COLUMNS}, byok.api_key_encrypted AS api_key`;

function isoTimestamp(value: string | Date, mysql = false): string {
	if (mysql) return fromMySqlDateTime(value);
	if (value instanceof Date) return value.toISOString();
	const parsed = Date.parse(String(value));
	if (!Number.isFinite(parsed)) throw new Error('BYOK timestamp is invalid');
	return new Date(parsed).toISOString();
}

/** Invalid stored filters fail closed to an empty allowlist, never unrestricted access. */
function parseAllowlist(value: string | null): string[] | null {
	if (value === null) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (
			!Array.isArray(parsed) ||
			parsed.length > 100 ||
			parsed.some((item) => typeof item !== 'string')
		) {
			return [];
		}
		return parsed;
	} catch {
		return [];
	}
}

function mapMetadata(row: RawByokKeyRow, mysql = false): ByokKeyRow {
	return {
		id: row.id,
		workspace_id: row.workspace_id,
		provider: row.provider,
		name: row.name,
		label: row.label,
		disabled: row.disabled === true || Number(row.disabled) === 1,
		is_fallback: row.is_fallback === true || Number(row.is_fallback) === 1,
		always_use_for_provider:
			row.always_use_for_provider === true || Number(row.always_use_for_provider) === 1,
		always_use_for_matching_models:
			row.always_use_for_matching_models === true
			|| Number(row.always_use_for_matching_models) === 1,
		sort_order: Number(row.sort_order),
		allowed_models: parseAllowlist(row.allowed_models_json),
		allowed_user_ids: parseAllowlist(row.allowed_user_ids_json),
		allowed_api_key_hashes: parseAllowlist(row.allowed_api_key_hashes_json),
		created_by_management_key_id: row.created_by_management_key_id,
		created_at: isoTimestamp(row.created_at, mysql),
		updated_at: isoTimestamp(row.updated_at, mysql),
	};
}

function mapRuntime(row: RawByokKeyRow, mysql = false): ByokRuntimeKeyRow {
	if (typeof row.api_key !== 'string' || !row.api_key) {
		throw new Error('Active BYOK credential lost its encrypted key material');
	}
	return { ...mapMetadata(row, mysql), api_key: row.api_key };
}

function json(value: string[] | null): string | null {
	return value === null ? null : JSON.stringify(value);
}

function assertPage(offset: number, limit: number): void {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET) {
		throw new TypeError('offset must be a non-negative integer no greater than 1000000');
	}
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new TypeError('limit must be an integer between 1 and 100');
	}
}

function assertIdentifier(value: string, field: string, max: number): void {
	if (!value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
		throw new TypeError(`${field} is invalid`);
	}
}

function assertInsert(params: ByokKeyInsertParams): void {
	assertMutationPrincipal(params.principal);
	assertIdentifier(params.id, 'BYOK id', 64);
	assertIdentifier(params.input.workspaceId, 'workspace_id', 600);
	assertIdentifier(params.input.provider, 'provider', 128);
	if (
		isByokPortalUserPrincipal(params.principal)
		&& params.input.workspaceId !== params.principal.workspaceId
	) {
		throw new TypeError('Portal BYOK mutations must target the selected workspace');
	}
	if (!isEncryptedSharedKeySecret(params.input.apiKey)) {
		throw new Error('BYOK credential must be encrypted before storage');
	}
	assertSharedCapacityPolicyState(
		params.input.isFallback,
		params.input.alwaysUseForProvider,
		params.input.alwaysUseForMatchingModels,
	);
	isoTimestamp(params.nowIso);
}

function assertSharedCapacityPolicyState(
	isFallback: boolean,
	alwaysUseForProvider: boolean,
	alwaysUseForMatchingModels: boolean,
): void {
	if (isFallback && (alwaysUseForProvider || alwaysUseForMatchingModels)) {
		throw new TypeError('shared-capacity policies are only valid for prioritized BYOK keys');
	}
	if (alwaysUseForProvider && alwaysUseForMatchingModels) {
		throw new TypeError('shared-capacity policies are mutually exclusive');
	}
}

function assertAlwaysUsePatch(current: ByokKeyRow, patch: ByokKeyPatch): void {
	assertSharedCapacityPolicyState(
		patch.isFallback ?? current.is_fallback,
		patch.alwaysUseForProvider ?? current.always_use_for_provider,
		patch.alwaysUseForMatchingModels ?? current.always_use_for_matching_models,
	);
}

function assertMutation(params: ByokManagementMutation): void {
	assertMutationPrincipal(params.principal);
	assertIdentifier(params.id, 'BYOK id', 64);
	isoTimestamp(params.nowIso);
}

function assertReorder(params: ByokKeyReorderParams): void {
	assertMutationPrincipal(params.principal);
	assertIdentifier(params.input.workspaceId, 'workspace_id', 600);
	assertIdentifier(params.input.provider, 'provider', 128);
	if (
		isByokPortalUserPrincipal(params.principal)
		&& params.input.workspaceId !== params.principal.workspaceId
	) {
		throw new TypeError('Portal BYOK mutations must target the selected workspace');
	}
	if (
		params.input.keys.length < 1 ||
		params.input.keys.length > BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER
	) {
		throw new TypeError('BYOK reorder must contain between 1 and 100 keys');
	}
	const ids = new Set<string>();
	let reachedFallback = false;
	for (const item of params.input.keys) {
		assertIdentifier(item.id, 'BYOK id', 64);
		if (ids.has(item.id)) throw new TypeError('BYOK reorder contains duplicate ids');
		ids.add(item.id);
		if (reachedFallback && !item.isFallback) {
			throw new TypeError('Prioritized BYOK keys must precede fallback keys');
		}
		reachedFallback ||= item.isFallback;
	}
	isoTimestamp(params.nowIso);
}

function assertMutationPrincipal(principal: ByokMutationPrincipal): void {
	assertManagementApiKeyAccount(principal);
	if (!isByokPortalUserPrincipal(principal)) return;
	assertIdentifier(principal.userId, 'portal user id', 512);
	assertIdentifier(principal.workspaceId, 'portal workspace id', 600);
}

function mutationAccount(principal: ByokMutationPrincipal): ManagementApiKeyAccount {
	return byokAccountFromPrincipal(principal);
}

function requireManagementPrincipal(
	principal: ByokMutationPrincipal,
): ManagementApiKeyPrincipal {
	if (isByokPortalUserPrincipal(principal)) {
		throw new Error('Portal principal cannot enter the Management-key authorization path');
	}
	return principal;
}

function mutationActor(principal: ByokMutationPrincipal) {
	return isByokPortalUserPrincipal(principal)
		? {
			userId: principal.userId,
			managementKeyId: null,
			actorType: 'user',
			source: 'gateway_portal_byok',
			actorId: `portal:${principal.userId}`,
			reasonTextSuffix: 'through the account portal',
		}
		: {
			userId: principal.createdByUserId,
			managementKeyId: principal.keyId,
			actorType: 'service',
			source: 'gateway_management_byok',
			actorId: `service:management_key:${principal.keyId}`,
			reasonTextSuffix: 'through Management API',
		};
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

function postgresAccountPredicate(
	account: ManagementApiKeyAccount,
	alias: string,
	parameter: number,
) {
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

function postgresActiveOwnerPredicate(
	principal: ManagementApiKeyPrincipal,
	alias = 'management_key',
): string {
	return principal.accountType === 'personal'
		? `EXISTS (SELECT 1 FROM users owner WHERE owner.id = ${alias}.personal_owner_user_id AND owner.status = 'active')`
		: `EXISTS (SELECT 1 FROM organizations owner WHERE owner.id = ${alias}.organization_id AND owner.status IN ('active', 'pending'))`;
}

function d1ActiveManagementKeyPredicate(
	principal: ManagementApiKeyPrincipal,
	alias = 'management_key',
) {
	const account = d1AccountPredicate(principal, 'workspace');
	const owner = principal.accountType === 'personal'
		? `EXISTS (SELECT 1 FROM users owner WHERE owner.id = ${alias}.personal_owner_user_id AND owner.status = 'active')`
		: `EXISTS (SELECT 1 FROM organizations owner WHERE owner.id = ${alias}.organization_id AND owner.status IN ('active', 'pending'))`;
	return {
		sql: `${alias}.id = ? AND ${alias}.status = 'active'
			AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > datetime('now'))
			AND ${alias}.account_type = ?
			AND ((${alias}.account_type = 'personal' AND ${alias}.personal_owner_user_id = ? AND ${alias}.organization_id IS NULL)
				OR (${alias}.account_type = 'organization' AND ${alias}.personal_owner_user_id IS NULL AND ${alias}.organization_id = ?))
			AND ${owner}`,
		values: [
			principal.keyId,
			principal.accountType,
			principal.personalOwnerUserId,
			principal.organizationId,
		],
		workspaceSql: account.sql,
		workspaceValues: account.values,
	};
}

function d1MutationAccess(
	principal: ByokMutationPrincipal,
	workspaceId: string,
	workspaceAlias = 'workspace',
) {
	if (!isByokPortalUserPrincipal(principal)) {
		const key = d1ActiveManagementKeyPredicate(principal);
		return {
			from: `management_api_keys management_key JOIN workspaces ${workspaceAlias}
				ON ${workspaceAlias}.id = ?`,
			where: `${key.sql} AND ${workspaceAlias}.status = 'active' AND ${key.workspaceSql}`,
			values: [workspaceId, ...key.values, ...key.workspaceValues] as SqlValue[],
			createdBySql: 'management_key.id',
		};
	}
	const owner = d1AccountPredicate(principal, workspaceAlias);
	return {
		from: `workspaces ${workspaceAlias} JOIN users portal_user ON portal_user.id = ?`,
		where: `portal_user.status = 'active' AND ${workspaceAlias}.id = ?
			AND ${workspaceAlias}.status = 'active' AND ${owner.sql}`,
		values: [principal.userId, workspaceId, ...owner.values] as SqlValue[],
		createdBySql: 'NULL',
	};
}

function auditPayload(
	action: 'created' | 'updated' | 'deleted',
	row: Pick<ByokKeyRow, 'id' | 'workspace_id' | 'provider'>,
	changedFields: string[] = [],
): string {
	return JSON.stringify({
		resource_type: 'byok_key',
		byok_key_id: row.id,
		workspace_id: row.workspace_id,
		provider: row.provider,
		action,
		changed_fields: changedFields,
	});
}

function reorderAuditPayload(input: ByokKeyReorder): string {
	return JSON.stringify({
		resource_type: 'byok_key_order',
		workspace_id: input.workspaceId,
		provider: input.provider,
		action: 'reordered',
		keys: input.keys.map((item, sortOrder) => ({
			id: item.id,
			is_fallback: item.isFallback,
			sort_order: sortOrder,
		})),
	});
}

function reorderMapping(input: ByokKeyReorder) {
	const operationId = crypto.randomUUID().replaceAll('-', '');
	return input.keys.map((item, sortOrder) => ({
		id: item.id,
		is_fallback: item.isFallback,
		sort_order: sortOrder,
		temporary_provider: `cinatoken-reorder-${operationId}-${sortOrder}`,
	}));
}

function sameReorderSet(rows: RawByokKeyRow[], input: ByokKeyReorder): boolean {
	if (rows.length !== input.keys.length) return false;
	const expected = new Set(input.keys.map((item) => item.id));
	return rows.every((row) => expected.delete(row.id)) && expected.size === 0;
}

function reorderViolatesAlwaysUse(rows: RawByokKeyRow[], input: ByokKeyReorder): boolean {
	const targetFallback = new Map(input.keys.map((item) => [item.id, item.isFallback]));
	return rows.some((row) =>
		(
			row.always_use_for_provider === true
			|| Number(row.always_use_for_provider) === 1
			|| row.always_use_for_matching_models === true
			|| Number(row.always_use_for_matching_models) === 1
		)
		&& targetFallback.get(row.id) === true
	);
}

function patchFields(patch: ByokKeyPatch): Array<[string, SqlValue]> {
	const fields: Array<[string, SqlValue]> = [];
	if ('name' in patch) fields.push(['name', patch.name ?? null]);
	if ('apiKey' in patch) {
		if (!isEncryptedSharedKeySecret(patch.apiKey!)) {
			throw new Error('BYOK credential rotation must be encrypted before storage');
		}
		fields.push(['api_key_encrypted', patch.apiKey!]);
	}
	if ('label' in patch) fields.push(['label', patch.label!]);
	if ('disabled' in patch) fields.push(['disabled', patch.disabled ? 1 : 0]);
	if ('isFallback' in patch) fields.push(['is_fallback', patch.isFallback ? 1 : 0]);
	if ('alwaysUseForProvider' in patch) {
		fields.push(['always_use_for_provider', patch.alwaysUseForProvider ? 1 : 0]);
	}
	if ('alwaysUseForMatchingModels' in patch) {
		fields.push([
			'always_use_for_matching_models',
			patch.alwaysUseForMatchingModels ? 1 : 0,
		]);
	}
	if ('allowedModels' in patch) fields.push(['allowed_models_json', json(patch.allowedModels!)]);
	if ('allowedUserIds' in patch) fields.push(['allowed_user_ids_json', json(patch.allowedUserIds!)]);
	if ('allowedApiKeyHashes' in patch) {
		fields.push(['allowed_api_key_hashes_json', json(patch.allowedApiKeyHashes!)]);
	}
	return fields;
}

function changedFields(patch: ByokKeyPatch): string[] {
	return [
		...('name' in patch ? ['name'] : []),
		...('apiKey' in patch ? ['key', 'label'] : []),
		...('disabled' in patch ? ['disabled'] : []),
		...('isFallback' in patch ? ['is_fallback'] : []),
		...('alwaysUseForProvider' in patch ? ['always_use_for_provider'] : []),
		...('alwaysUseForMatchingModels' in patch
			? ['always_use_for_matching_models']
			: []),
		...('allowedModels' in patch ? ['allowed_models'] : []),
		...('allowedUserIds' in patch ? ['allowed_user_ids'] : []),
		...('allowedApiKeyHashes' in patch ? ['allowed_api_key_hashes'] : []),
	];
}

function eligible(row: ByokKeyRow, params: ByokRuntimeLookup): boolean {
	return (
		(row.allowed_models === null || row.allowed_models.includes(params.modelId)) &&
		eligibleIdentity(row, params)
	);
}

function eligibleIdentity(row: ByokKeyRow, params: ByokRuntimeLookup): boolean {
	return (
		(row.allowed_user_ids === null || row.allowed_user_ids.includes(params.userId)) &&
		(row.allowed_api_key_hashes === null ||
			row.allowed_api_key_hashes.includes(params.apiKeyHash))
	);
}

function assertRuntimeLookup(params: ByokRuntimeLookup): void {
	assertIdentifier(params.workspaceId, 'workspace_id', 600);
	assertIdentifier(params.provider, 'provider', 128);
	assertIdentifier(params.modelId, 'modelId', 240);
	assertIdentifier(params.userId, 'userId', 512);
	if (!/^[a-f0-9]{64}$/u.test(params.apiKeyHash)) {
		throw new TypeError('apiKeyHash is invalid');
	}
}

function d1AuditStatement(
	client: Extract<GatewayDatabaseClient, { driver: 'd1' }>['raw'],
	params: {
		principal: ByokMutationPrincipal;
		id: string;
		workspaceId: string;
		nowIso: string;
		action: 'created' | 'updated' | 'deleted';
		payload: string;
	},
) {
	const mutationPredicate = params.action === 'created'
		? 'byok.created_at = ? AND byok.updated_at = ?'
		: params.action === 'updated'
			? 'byok.updated_at = ? AND byok.deleted_at IS NULL'
			: 'byok.updated_at = ? AND byok.deleted_at = ?';
	const mutationValues = params.action === 'created'
		? [params.nowIso, params.nowIso]
		: params.action === 'updated'
			? [params.nowIso]
			: [params.nowIso, params.nowIso];
	const actor = mutationActor(params.principal);
	const managementCreatedPredicate = params.action === 'created'
		? 'AND byok.created_by_management_key_id = management_key.id'
		: '';
	if (!isByokPortalUserPrincipal(params.principal)) {
		const key = d1ActiveManagementKeyPredicate(params.principal);
		return client.prepare(`INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) SELECT ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?
		FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
		JOIN management_api_keys management_key ON management_key.id = ?
		WHERE byok.id = ? AND byok.workspace_id = ? AND ${mutationPredicate}
			${managementCreatedPredicate} AND ${key.sql} AND workspace.status = 'active'
			AND ${key.workspaceSql}`).bind(
			crypto.randomUUID(),
			actor.userId,
			`byok_key_${params.action}`,
			actor.actorType,
			params.payload,
			actor.source,
			actor.actorId,
			`byok_key_${params.action}`,
			`BYOK credential ${params.action} ${actor.reasonTextSuffix}`,
			params.nowIso,
			params.principal.keyId,
			params.id,
			params.workspaceId,
			...mutationValues,
			...key.values,
			...key.workspaceValues,
		);
	}
	const owner = d1AccountPredicate(params.principal, 'workspace');
	return client.prepare(`INSERT INTO user_audit_logs (
		id, user_id, api_key_id, event_type, actor_type, change_payload,
		source, actor_id, reason_code, reason_text, created_at
	) SELECT ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?
	FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
	JOIN users portal_user ON portal_user.id = ?
	WHERE byok.id = ? AND byok.workspace_id = ? AND ${mutationPredicate}
		AND portal_user.status = 'active' AND workspace.status = 'active'
		AND ${owner.sql}`).bind(
		crypto.randomUUID(),
		actor.userId,
		`byok_key_${params.action}`,
		actor.actorType,
		params.payload,
		actor.source,
		actor.actorId,
		`byok_key_${params.action}`,
		`BYOK credential ${params.action} ${actor.reasonTextSuffix}`,
		params.nowIso,
		params.principal.userId,
		params.id,
		params.workspaceId,
		...mutationValues,
		...owner.values,
	);
}

function d1ReorderAuditStatement(
	client: Extract<GatewayDatabaseClient, { driver: 'd1' }>['raw'],
	params: ByokKeyReorderParams,
	mappingJson: string,
) {
	const { input } = params;
	const actor = mutationActor(params.principal);
	const tail = `AND (SELECT COUNT(*) FROM byok_keys current
			WHERE current.workspace_id = ? AND current.provider = ?
				AND current.deleted_at IS NULL) = ?
		AND (SELECT COUNT(*) FROM byok_keys current JOIN json_each(?) item
			ON json_extract(item.value, '$.id') = current.id
			WHERE current.workspace_id = ? AND current.provider = ?
				AND current.deleted_at IS NULL AND current.updated_at = ?
				AND current.sort_order = CAST(json_extract(item.value, '$.sort_order') AS INTEGER)
				AND current.is_fallback = CAST(json_extract(item.value, '$.is_fallback') AS INTEGER)) = ?`;
	const tailValues: SqlValue[] = [
		input.workspaceId, input.provider, input.keys.length,
		mappingJson, input.workspaceId, input.provider, params.nowIso, input.keys.length,
	];
	if (!isByokPortalUserPrincipal(params.principal)) {
		const key = d1ActiveManagementKeyPredicate(params.principal);
		return client.prepare(`INSERT INTO user_audit_logs (
			id, user_id, api_key_id, event_type, actor_type, change_payload,
			source, actor_id, reason_code, reason_text, created_at
		) SELECT ?, ?, NULL, 'byok_key_reordered', ?, ?, ?, ?,
			'byok_key_reordered', ?, ?
		FROM management_api_keys management_key JOIN workspaces workspace ON workspace.id = ?
		WHERE ${key.sql} AND workspace.status = 'active' AND ${key.workspaceSql} ${tail}`).bind(
			crypto.randomUUID(), actor.userId, actor.actorType, reorderAuditPayload(input),
			actor.source, actor.actorId, `BYOK credentials reordered ${actor.reasonTextSuffix}`,
			params.nowIso, input.workspaceId,
			...key.values, ...key.workspaceValues, ...tailValues,
		);
	}
	const owner = d1AccountPredicate(params.principal, 'workspace');
	return client.prepare(`INSERT INTO user_audit_logs (
		id, user_id, api_key_id, event_type, actor_type, change_payload,
		source, actor_id, reason_code, reason_text, created_at
	) SELECT ?, ?, NULL, 'byok_key_reordered', ?, ?, ?, ?,
		'byok_key_reordered', ?, ?
	FROM workspaces workspace JOIN users portal_user ON portal_user.id = ?
	WHERE workspace.id = ? AND workspace.status = 'active' AND portal_user.status = 'active'
		AND ${owner.sql} ${tail}`).bind(
		crypto.randomUUID(), actor.userId, actor.actorType, reorderAuditPayload(input),
		actor.source, actor.actorId, `BYOK credentials reordered ${actor.reasonTextSuffix}`,
		params.nowIso, params.principal.userId, input.workspaceId,
		...owner.values, ...tailValues,
	);
}

async function d1CanMutateReorderWorkspace(
	client: Extract<GatewayDatabaseClient, { driver: 'd1' }>['raw'],
	params: ByokKeyReorderParams,
): Promise<boolean> {
	const access = d1MutationAccess(params.principal, params.input.workspaceId);
	const row = await client.prepare(`SELECT workspace.id FROM ${access.from}
		WHERE ${access.where} LIMIT 1`).bind(...access.values).first<{ id: string }>();
	return row !== null;
}

async function listD1(
	client: Extract<GatewayDatabaseClient, { driver: 'd1' }>['raw'],
	account: ManagementApiKeyAccount,
	options: Parameters<ByokKeysRepository['listForAccount']>[1],
): Promise<ByokKeyListPage> {
	const owner = d1AccountPredicate(account);
	const filters = [`byok.deleted_at IS NULL`, `workspace.status = 'active'`, owner.sql];
		const values: SqlValue[] = [...owner.values];
	if (options.workspaceId) {
		filters.push('byok.workspace_id = ?');
		values.push(options.workspaceId);
	}
	if (options.provider) {
		filters.push('byok.provider = ?');
		values.push(options.provider);
	}
	const where = filters.join(' AND ');
	const count = await client.prepare(`SELECT COUNT(*) AS total_count
		FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
		WHERE ${where}`).bind(...values).first<{ total_count: number | string }>();
	const rows = await client.prepare(`SELECT ${METADATA_COLUMNS}
		FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
		WHERE ${where}
		ORDER BY byok.created_at DESC, byok.id DESC LIMIT ? OFFSET ?`)
		.bind(...values, options.limit, options.offset).all<RawByokKeyRow>();
	return {
		data: (rows.results ?? []).map((row) => mapMetadata(row)),
		totalCount: Number(count?.total_count ?? 0),
	};
}

async function getD1(
	client: Extract<GatewayDatabaseClient, { driver: 'd1' }>['raw'],
	id: string,
	account: ManagementApiKeyAccount,
): Promise<ByokKeyRow | null> {
	const owner = d1AccountPredicate(account);
	const row = await client.prepare(`SELECT ${METADATA_COLUMNS}
		FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
		WHERE byok.id = ? AND byok.deleted_at IS NULL AND workspace.status = 'active'
			AND ${owner.sql} LIMIT 1`).bind(id, ...owner.values).first<RawByokKeyRow>();
	return row ? mapMetadata(row) : null;
}

export function createByokKeysRepository(
	client: GatewayDatabaseClient,
): ByokKeysRepository {
	return {
		async listForAccount(account, options) {
			assertManagementApiKeyAccount(account);
			assertPage(options.offset, options.limit);
			if (options.workspaceId) assertIdentifier(options.workspaceId, 'workspace_id', 600);
			if (options.provider) assertIdentifier(options.provider, 'provider', 128);
			if (client.driver === 'd1') return listD1(client.raw, account, options);

			if (client.driver === 'postgres') {
				const owner = postgresAccountPredicate(account, 'workspace', 1);
				const filters = [`byok.deleted_at IS NULL`, `workspace.status = 'active'`, owner.sql];
				const values: SqlValue[] = [owner.value];
				if (options.workspaceId) {
					values.push(options.workspaceId);
					filters.push(`byok.workspace_id = $${values.length}`);
				}
				if (options.provider) {
					values.push(options.provider);
					filters.push(`byok.provider = $${values.length}`);
				}
				const where = filters.join(' AND ');
				const counts = await client.raw.unsafe<Array<{ total_count: number | string }>>(
					`SELECT COUNT(*) AS total_count FROM byok_keys byok
					JOIN workspaces workspace ON workspace.id = byok.workspace_id WHERE ${where}`,
					values,
				);
				values.push(options.limit, options.offset);
				const rows = await client.raw.unsafe<RawByokKeyRow[]>(`SELECT ${METADATA_COLUMNS}
					FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
					WHERE ${where} ORDER BY byok.created_at DESC, byok.id DESC
					LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
				return {
					data: rows.map((row) => mapMetadata(row)),
					totalCount: Number(counts[0]?.total_count ?? 0),
				};
			}

			const owner = d1AccountPredicate(account);
			const filters = [`byok.deleted_at IS NULL`, `workspace.status = 'active'`, owner.sql];
			const values: SqlValue[] = [...owner.values];
			if (options.workspaceId) {
				filters.push('byok.workspace_id = ?');
				values.push(options.workspaceId);
			}
			if (options.provider) {
				filters.push('byok.provider = ?');
				values.push(options.provider);
			}
			const where = filters.join(' AND ');
			const counts = await mysqlQueryRows<MySqlCountRow>(client.raw,
				`SELECT COUNT(*) AS total_count FROM byok_keys byok
				JOIN workspaces workspace ON workspace.id = byok.workspace_id WHERE ${where}`, values);
			const rows = await mysqlQueryRows<MySqlByokKeyRow>(client.raw, `SELECT ${METADATA_COLUMNS}
				FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
				WHERE ${where} ORDER BY byok.created_at DESC, byok.id DESC LIMIT ? OFFSET ?`,
			[...values, options.limit, options.offset]);
			return {
				data: rows.map((row) => mapMetadata(row, true)),
				totalCount: Number(counts[0]?.total_count ?? 0),
			};
		},

		async getByIdInAccount(id, account) {
			assertIdentifier(id, 'BYOK id', 64);
			assertManagementApiKeyAccount(account);
			if (client.driver === 'd1') return getD1(client.raw, id, account);
			if (client.driver === 'postgres') {
				const owner = postgresAccountPredicate(account, 'workspace', 2);
				const rows = await client.raw.unsafe<RawByokKeyRow[]>(`SELECT ${METADATA_COLUMNS}
					FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
					WHERE byok.id = $1 AND byok.deleted_at IS NULL AND workspace.status = 'active'
						AND ${owner.sql} LIMIT 1`, [id, owner.value]);
				return rows[0] ? mapMetadata(rows[0]) : null;
			}
			const owner = d1AccountPredicate(account);
			const rows = await mysqlQueryRows<MySqlByokKeyRow>(client.raw, `SELECT ${METADATA_COLUMNS}
				FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
				WHERE byok.id = ? AND byok.deleted_at IS NULL AND workspace.status = 'active'
					AND ${owner.sql} LIMIT 1`, [id, ...owner.values]);
			return rows[0] ? mapMetadata(rows[0], true) : null;
		},

		async insertForManagement(params) {
			assertInsert(params);
			const { input, principal } = params;
			if (client.driver === 'd1') {
				const access = d1MutationAccess(principal, input.workspaceId);
				const insert = client.raw.prepare(`INSERT INTO byok_keys (
					id, workspace_id, provider, name, api_key_encrypted, label, disabled,
					is_fallback, always_use_for_provider, always_use_for_matching_models,
					sort_order, allowed_models_json, allowed_user_ids_json,
					allowed_api_key_hashes_json, created_by_management_key_id, created_at, updated_at
				) SELECT ?, workspace.id, ?, ?, ?, ?, ?, ?, ?, ?,
					COALESCE((SELECT MAX(existing.sort_order) + 1 FROM byok_keys existing
						WHERE existing.workspace_id = workspace.id AND existing.provider = ?
							AND existing.deleted_at IS NULL), 0),
					?, ?, ?, ${access.createdBySql}, ?, ?
				FROM ${access.from}
				WHERE ${access.where}
					AND (SELECT COUNT(*) FROM byok_keys existing WHERE existing.workspace_id = workspace.id
						AND existing.provider = ? AND existing.deleted_at IS NULL) < ?`).bind(
					params.id, input.provider, input.name, input.apiKey, input.label,
					input.disabled ? 1 : 0, input.isFallback ? 1 : 0,
					input.alwaysUseForProvider ? 1 : 0,
					input.alwaysUseForMatchingModels ? 1 : 0, input.provider,
					json(input.allowedModels), json(input.allowedUserIds), json(input.allowedApiKeyHashes),
					params.nowIso, params.nowIso,
					...access.values,
					input.provider, BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER,
				);
				const payload = auditPayload('created', {
					id: params.id, workspace_id: input.workspaceId, provider: input.provider,
				});
				const results = await client.raw.batch([
					insert,
					d1AuditStatement(client.raw, {
						...params,
						workspaceId: input.workspaceId,
						action: 'created',
						payload,
					}),
				]);
				if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
					return null;
				}
				return getD1(client.raw, params.id, mutationAccount(principal));
			}

			if (client.driver === 'postgres') {
				const created = await client.raw.begin(async (transaction) => {
					const owner = postgresAccountPredicate(
						mutationAccount(principal),
						'workspace',
						isByokPortalUserPrincipal(principal) ? 3 : 6,
					);
					const authorized = isByokPortalUserPrincipal(principal)
						? await transaction.unsafe<Array<{ id: string }>>(`SELECT workspace.id
							FROM workspaces workspace JOIN users portal_user ON portal_user.id = $1
							WHERE portal_user.status = 'active' AND workspace.id = $2
								AND workspace.status = 'active' AND ${owner.sql}
							FOR UPDATE OF workspace`, [principal.userId, input.workspaceId, owner.value])
						: await transaction.unsafe<Array<{ id: string }>>(`SELECT workspace.id
							FROM workspaces workspace JOIN management_api_keys management_key ON management_key.id = $1
							WHERE management_key.status = 'active'
								AND (management_key.expires_at IS NULL OR management_key.expires_at > CURRENT_TIMESTAMP)
								AND management_key.account_type = $2
								AND management_key.personal_owner_user_id IS NOT DISTINCT FROM $3
								AND management_key.organization_id IS NOT DISTINCT FROM $4
								AND ${postgresActiveOwnerPredicate(principal)}
								AND workspace.id = $5 AND workspace.status = 'active' AND ${owner.sql}
							FOR UPDATE OF workspace`, [
							principal.keyId, principal.accountType, principal.personalOwnerUserId,
							principal.organizationId, input.workspaceId, owner.value,
						]);
					if (authorized.length !== 1) return false;
					const count = await transaction.unsafe<Array<{ total_count: number | string }>>(
						`SELECT COUNT(*) AS total_count FROM byok_keys
						WHERE workspace_id = $1 AND provider = $2 AND deleted_at IS NULL`,
						[input.workspaceId, input.provider],
					);
					if (Number(count[0]?.total_count ?? 0) >= BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER) {
						throw new TypeError('BYOK key limit reached for this workspace and provider');
					}
					await transaction.unsafe(`INSERT INTO byok_keys (
						id, workspace_id, provider, name, api_key_encrypted, label, disabled,
						is_fallback, always_use_for_provider, always_use_for_matching_models,
						sort_order, allowed_models_json, allowed_user_ids_json,
						allowed_api_key_hashes_json, created_by_management_key_id, created_at, updated_at
					) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
						COALESCE((SELECT MAX(sort_order) + 1 FROM byok_keys
							WHERE workspace_id = $2 AND provider = $3 AND deleted_at IS NULL), 0),
						$11,$12,$13,$14,$15,$15)`, [
						params.id, input.workspaceId, input.provider, input.name, input.apiKey, input.label,
						input.disabled, input.isFallback, input.alwaysUseForProvider,
						input.alwaysUseForMatchingModels,
						json(input.allowedModels), json(input.allowedUserIds),
						json(input.allowedApiKeyHashes), mutationActor(principal).managementKeyId, params.nowIso,
					]);
					const actor = mutationActor(principal);
					await transaction.unsafe(`INSERT INTO user_audit_logs (
						id, user_id, api_key_id, event_type, actor_type, change_payload, source,
						actor_id, reason_code, reason_text, created_at
					) VALUES ($1,$2,NULL,'byok_key_created',$3,$4,$5,
						$6,'byok_key_created',$7,$8)`, [
						crypto.randomUUID(), actor.userId, actor.actorType,
						auditPayload('created', { id: params.id, workspace_id: input.workspaceId, provider: input.provider }),
						actor.source, actor.actorId,
						`BYOK credential created ${actor.reasonTextSuffix}`, params.nowIso,
					]);
					return true;
				});
				return created ? this.getByIdInAccount(params.id, mutationAccount(principal)) : null;
			}

			const connection = await client.raw.getConnection();
			try {
				await connection.beginTransaction();
				const owner = d1AccountPredicate(mutationAccount(principal), 'workspace');
				const authorized = isByokPortalUserPrincipal(principal)
					? await mysqlQueryRows<RowDataPacket & { id: string }>(connection,
						`SELECT workspace.id FROM workspaces workspace
						JOIN users portal_user ON portal_user.id = ?
						WHERE portal_user.status = 'active' AND workspace.id = ?
							AND workspace.status = 'active' AND ${owner.sql} FOR UPDATE`,
						[principal.userId, input.workspaceId, ...owner.values])
					: await (async () => {
						const key = d1ActiveManagementKeyPredicate(principal);
						return mysqlQueryRows<RowDataPacket & { id: string }>(connection,
							`SELECT workspace.id FROM workspaces workspace
							JOIN management_api_keys management_key ON management_key.id = ?
							WHERE ${key.sql.replaceAll("datetime('now')", 'UTC_TIMESTAMP(6)')}
								AND workspace.id = ? AND workspace.status = 'active' AND ${key.workspaceSql}
							FOR UPDATE`, [principal.keyId, ...key.values.slice(1), input.workspaceId, ...key.workspaceValues]);
					})();
				if (authorized.length !== 1) {
					await connection.rollback();
					return null;
				}
				const count = await mysqlQueryRows<MySqlCountRow>(connection,
					`SELECT COUNT(*) AS total_count FROM byok_keys
					WHERE workspace_id = ? AND provider = ? AND deleted_at IS NULL`,
					[input.workspaceId, input.provider]);
				if (Number(count[0]?.total_count ?? 0) >= BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER) {
					throw new TypeError('BYOK key limit reached for this workspace and provider');
				}
				const mysqlNow = toMySqlDateTime(params.nowIso);
				await mysqlExecute(connection, `INSERT INTO byok_keys (
					id, workspace_id, provider, name, api_key_encrypted, label, disabled,
					is_fallback, always_use_for_provider, always_use_for_matching_models,
					sort_order, allowed_models_json, allowed_user_ids_json,
					allowed_api_key_hashes_json, created_by_management_key_id, created_at, updated_at
				) VALUES (?,?,?,?,?,?,?,?,?,?,
					COALESCE((SELECT next_order FROM (SELECT MAX(sort_order) + 1 AS next_order FROM byok_keys
						WHERE workspace_id = ? AND provider = ? AND deleted_at IS NULL) ordering), 0),
					?,?,?,?,?,?)`, [
					params.id, input.workspaceId, input.provider, input.name, input.apiKey, input.label,
					input.disabled, input.isFallback, input.alwaysUseForProvider,
					input.alwaysUseForMatchingModels,
					input.workspaceId, input.provider,
					json(input.allowedModels), json(input.allowedUserIds), json(input.allowedApiKeyHashes),
					mutationActor(principal).managementKeyId, mysqlNow, mysqlNow,
				]);
				const actor = mutationActor(principal);
				await mysqlExecute(connection, `INSERT INTO user_audit_logs (
					id, user_id, api_key_id, event_type, actor_type, change_payload, source,
					actor_id, reason_code, reason_text, created_at
				) VALUES (?, ?, NULL, 'byok_key_created', ?, ?, ?,
					?, 'byok_key_created', ?, ?)`, [
					crypto.randomUUID(), actor.userId, actor.actorType,
					auditPayload('created', { id: params.id, workspace_id: input.workspaceId, provider: input.provider }),
					actor.source, actor.actorId,
					`BYOK credential created ${actor.reasonTextSuffix}`, mysqlNow,
				]);
				await connection.commit();
			} catch (error) {
				await connection.rollback().catch(() => undefined);
				throw error;
			} finally {
				connection.release();
			}
			return this.getByIdInAccount(params.id, mutationAccount(principal));
		},

		async updateForManagement(params: ByokKeyUpdateParams) {
			assertMutation(params);
			const fields = patchFields(params.patch);
			if (fields.length === 0) throw new TypeError('At least one BYOK field is required');
			const account = mutationAccount(params.principal);
			if (client.driver === 'd1') {
				const current = await getD1(client.raw, params.id, account);
				if (!current) return null;
				assertAlwaysUsePatch(current, params.patch);
				const access = d1MutationAccess(params.principal, current.workspace_id);
				const sets = fields.map(([column]) => `${column} = ?`).join(', ');
				const values = fields.map(([, value]) => value);
				const finalFallbackSql = 'isFallback' in params.patch ? '?' : 'is_fallback';
				const finalAlwaysUseSql = 'alwaysUseForProvider' in params.patch
					? '?'
					: 'always_use_for_provider';
				const finalMatchingModelsSql = 'alwaysUseForMatchingModels' in params.patch
					? '?'
					: 'always_use_for_matching_models';
				const invariantValues = [
					...('isFallback' in params.patch ? [params.patch.isFallback ? 1 : 0] : []),
					...('alwaysUseForProvider' in params.patch
						? [params.patch.alwaysUseForProvider ? 1 : 0]
						: []),
					...('alwaysUseForMatchingModels' in params.patch
						? [params.patch.alwaysUseForMatchingModels ? 1 : 0]
						: []),
					...('alwaysUseForProvider' in params.patch
						? [params.patch.alwaysUseForProvider ? 1 : 0]
						: []),
					...('alwaysUseForMatchingModels' in params.patch
						? [params.patch.alwaysUseForMatchingModels ? 1 : 0]
						: []),
				];
				const update = client.raw.prepare(`UPDATE byok_keys SET ${sets}, updated_at = ?
					WHERE id = ? AND deleted_at IS NULL
						AND NOT (${finalFallbackSql} = 1
							AND (${finalAlwaysUseSql} = 1 OR ${finalMatchingModelsSql} = 1))
						AND NOT (${finalAlwaysUseSql} = 1 AND ${finalMatchingModelsSql} = 1)
						AND EXISTS (
						SELECT 1 FROM ${access.from}
						WHERE workspace.id = byok_keys.workspace_id AND ${access.where}
					)`).bind(
					...values, params.nowIso, params.id, ...invariantValues,
					...access.values,
				);
				const payload = auditPayload('updated', current, changedFields(params.patch));
				const results = await client.raw.batch([
					update,
					d1AuditStatement(client.raw, {
						...params,
						workspaceId: current.workspace_id,
						action: 'updated',
						payload,
					}),
				]);
				if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
					return null;
				}
				return getD1(client.raw, params.id, account);
			}

			if (client.driver === 'postgres') {
				const updated = await client.raw.begin(async (transaction) => {
					const portalPrincipal = isByokPortalUserPrincipal(params.principal)
						? params.principal
						: null;
					const owner = postgresAccountPredicate(account, 'workspace', portalPrincipal ? 4 : 6);
					const rows = portalPrincipal
						? await transaction.unsafe<RawByokKeyRow[]>(`SELECT ${METADATA_COLUMNS}
							FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
							JOIN users portal_user ON portal_user.id = $1
							WHERE byok.id = $2 AND byok.workspace_id = $3 AND byok.deleted_at IS NULL
								AND portal_user.status = 'active' AND workspace.status = 'active'
								AND ${owner.sql} FOR UPDATE OF byok`, [
							portalPrincipal.userId, params.id, portalPrincipal.workspaceId, owner.value,
						])
						: await (async () => {
							const managementPrincipal = requireManagementPrincipal(params.principal);
							return transaction.unsafe<RawByokKeyRow[]>(`SELECT ${METADATA_COLUMNS}
							FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
							JOIN management_api_keys management_key ON management_key.id = $1
							WHERE byok.id = $2 AND byok.deleted_at IS NULL AND workspace.status = 'active'
								AND management_key.status = 'active'
								AND (management_key.expires_at IS NULL OR management_key.expires_at > CURRENT_TIMESTAMP)
								AND management_key.account_type = $3
								AND management_key.personal_owner_user_id IS NOT DISTINCT FROM $4
								AND management_key.organization_id IS NOT DISTINCT FROM $5
								AND ${postgresActiveOwnerPredicate(managementPrincipal)}
								AND ${owner.sql} FOR UPDATE OF byok`, [
							managementPrincipal.keyId, params.id, managementPrincipal.accountType,
							managementPrincipal.personalOwnerUserId, managementPrincipal.organizationId, owner.value,
							]);
						})();
					if (!rows[0]) return false;
					assertAlwaysUsePatch(mapMetadata(rows[0]), params.patch);
					const values = fields.map(([, value]) => typeof value === 'number' ? value === 1 : value);
					values.push(params.nowIso, params.id);
					const sets = fields.map(([column], index) => `${column} = $${index + 1}`).join(', ');
					await transaction.unsafe(`UPDATE byok_keys SET ${sets}, updated_at = $${fields.length + 1}
						WHERE id = $${fields.length + 2}`, values);
					const actor = mutationActor(params.principal);
					await transaction.unsafe(`INSERT INTO user_audit_logs (
						id, user_id, api_key_id, event_type, actor_type, change_payload, source,
						actor_id, reason_code, reason_text, created_at
					) VALUES ($1,$2,NULL,'byok_key_updated',$3,$4,$5,
						$6,'byok_key_updated',$7,$8)`, [
						crypto.randomUUID(), actor.userId, actor.actorType,
						auditPayload('updated', mapMetadata(rows[0]), changedFields(params.patch)),
						actor.source, actor.actorId,
						`BYOK credential updated ${actor.reasonTextSuffix}`, params.nowIso,
					]);
					return true;
				});
				return updated ? this.getByIdInAccount(params.id, account) : null;
			}

			const connection = await client.raw.getConnection();
			try {
				await connection.beginTransaction();
				const owner = d1AccountPredicate(account, 'workspace');
				const rows = isByokPortalUserPrincipal(params.principal)
					? await mysqlQueryRows<MySqlByokKeyRow>(connection, `SELECT ${METADATA_COLUMNS}
						FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
						JOIN users portal_user ON portal_user.id = ?
						WHERE byok.id = ? AND byok.workspace_id = ? AND byok.deleted_at IS NULL
							AND portal_user.status = 'active' AND workspace.status = 'active'
							AND ${owner.sql} FOR UPDATE`, [
						params.principal.userId, params.id, params.principal.workspaceId, ...owner.values,
					])
					: await (async () => {
						const managementPrincipal = requireManagementPrincipal(params.principal);
						const key = d1ActiveManagementKeyPredicate(managementPrincipal);
						return mysqlQueryRows<MySqlByokKeyRow>(connection, `SELECT ${METADATA_COLUMNS}
							FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
							JOIN management_api_keys management_key ON management_key.id = ?
							WHERE byok.id = ? AND byok.deleted_at IS NULL AND workspace.status = 'active'
								AND ${key.sql.replaceAll("datetime('now')", 'UTC_TIMESTAMP(6)')}
								AND ${key.workspaceSql} FOR UPDATE`,
						[managementPrincipal.keyId, params.id, ...key.values.slice(1), ...key.workspaceValues]);
					})();
				if (!rows[0]) {
					await connection.rollback();
					return null;
				}
				assertAlwaysUsePatch(mapMetadata(rows[0], true), params.patch);
				const mysqlFields = fields.map(([column, value]) => [
					column,
					(column === 'disabled' || column === 'is_fallback'
						|| column === 'always_use_for_provider'
						|| column === 'always_use_for_matching_models')
						? Number(value) === 1
						: value,
				] as [string, unknown]);
				const sets = mysqlFields.map(([column]) => `${column} = ?`).join(', ');
				await mysqlExecute(connection, `UPDATE byok_keys SET ${sets}, updated_at = ? WHERE id = ?`, [
					...mysqlFields.map(([, value]) => value), toMySqlDateTime(params.nowIso), params.id,
				]);
				const actor = mutationActor(params.principal);
				await mysqlExecute(connection, `INSERT INTO user_audit_logs (
					id, user_id, api_key_id, event_type, actor_type, change_payload, source,
					actor_id, reason_code, reason_text, created_at
				) VALUES (?, ?, NULL, 'byok_key_updated', ?, ?, ?,
					?, 'byok_key_updated', ?, ?)`, [
					crypto.randomUUID(), actor.userId, actor.actorType,
					auditPayload('updated', mapMetadata(rows[0], true), changedFields(params.patch)),
					actor.source, actor.actorId,
					`BYOK credential updated ${actor.reasonTextSuffix}`, toMySqlDateTime(params.nowIso),
				]);
				await connection.commit();
			} catch (error) {
				await connection.rollback().catch(() => undefined);
				throw error;
			} finally {
				connection.release();
			}
			return this.getByIdInAccount(params.id, account);
		},

		async reorderForManagement(params: ByokKeyReorderParams) {
			assertReorder(params);
			const { input, principal } = params;
			const mapping = reorderMapping(input);
			const mappingJson = JSON.stringify(mapping);
			const keyCount = mapping.length;
			const audit = reorderAuditPayload(input);

			if (client.driver === 'd1') {
				const access = d1MutationAccess(principal, input.workspaceId);
				// Each row first moves into a unique, transaction-local provider namespace.
				// This avoids transient collisions in the active-order unique index even
				// when all 100 sort slots are occupied.
				const moveToTemporaryProviders = client.raw.prepare(`UPDATE byok_keys AS byok
					SET provider = (SELECT json_extract(item.value, '$.temporary_provider')
						FROM json_each(?) item
						WHERE json_extract(item.value, '$.id') = byok.id)
					WHERE byok.workspace_id = ? AND byok.provider = ? AND byok.deleted_at IS NULL
						AND byok.id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
						AND (SELECT COUNT(*) FROM byok_keys current
							WHERE current.workspace_id = ? AND current.provider = ?
								AND current.deleted_at IS NULL) = ?
						AND (SELECT COUNT(*) FROM byok_keys current
							WHERE current.workspace_id = ? AND current.provider = ?
								AND current.deleted_at IS NULL
								AND current.id IN (SELECT json_extract(value, '$.id') FROM json_each(?))) = ?
						AND NOT EXISTS (
							SELECT 1 FROM byok_keys current JOIN json_each(?) item
								ON json_extract(item.value, '$.id') = current.id
							WHERE current.workspace_id = ? AND current.provider = ?
								AND current.deleted_at IS NULL
								AND (current.always_use_for_provider = 1
									OR current.always_use_for_matching_models = 1)
								AND CAST(json_extract(item.value, '$.is_fallback') AS INTEGER) = 1
						)
						AND EXISTS (SELECT 1 FROM ${access.from}
							WHERE workspace.id = byok.workspace_id AND ${access.where})`).bind(
					mappingJson,
					input.workspaceId, input.provider, mappingJson,
					input.workspaceId, input.provider, keyCount,
					input.workspaceId, input.provider, mappingJson, keyCount,
					mappingJson, input.workspaceId, input.provider,
					...access.values,
				);
				const updateOrder = client.raw.prepare(`UPDATE byok_keys AS byok SET
					sort_order = CAST((SELECT json_extract(item.value, '$.sort_order')
						FROM json_each(?) item WHERE json_extract(item.value, '$.id') = byok.id) AS INTEGER),
					is_fallback = CAST((SELECT json_extract(item.value, '$.is_fallback')
						FROM json_each(?) item WHERE json_extract(item.value, '$.id') = byok.id) AS INTEGER),
					updated_at = ?
					WHERE byok.workspace_id = ? AND byok.deleted_at IS NULL
						AND EXISTS (SELECT 1 FROM json_each(?) item
							WHERE json_extract(item.value, '$.id') = byok.id
								AND json_extract(item.value, '$.temporary_provider') = byok.provider)`).bind(
					mappingJson, mappingJson, params.nowIso, input.workspaceId, mappingJson,
				);
				const restoreProvider = client.raw.prepare(`UPDATE byok_keys AS byok SET provider = ?
					WHERE byok.workspace_id = ? AND byok.deleted_at IS NULL
						AND EXISTS (SELECT 1 FROM json_each(?) item
							WHERE json_extract(item.value, '$.id') = byok.id
								AND json_extract(item.value, '$.temporary_provider') = byok.provider)`).bind(
					input.provider, input.workspaceId, mappingJson,
				);
				const results = await client.raw.batch([
					moveToTemporaryProviders,
					updateOrder,
					restoreProvider,
					d1ReorderAuditStatement(client.raw, params, mappingJson),
				]);
				const updated = (results[0]?.meta.changes ?? 0) === keyCount
					&& (results[1]?.meta.changes ?? 0) === keyCount
					&& (results[2]?.meta.changes ?? 0) === keyCount
					&& (results[3]?.meta.changes ?? 0) === 1;
				if (updated) return 'updated';
				return await d1CanMutateReorderWorkspace(client.raw, params)
					? 'conflict'
					: 'not_found';
			}

			if (client.driver === 'postgres') {
				return client.raw.begin(async (transaction) => {
					const owner = postgresAccountPredicate(
						mutationAccount(principal),
						'workspace',
						isByokPortalUserPrincipal(principal) ? 3 : 6,
					);
					const authorized = isByokPortalUserPrincipal(principal)
						? await transaction.unsafe<Array<{ id: string }>>(`SELECT workspace.id
							FROM workspaces workspace JOIN users portal_user ON portal_user.id = $1
							WHERE portal_user.status = 'active' AND workspace.id = $2
								AND workspace.status = 'active' AND ${owner.sql} FOR UPDATE OF workspace`,
						[principal.userId, input.workspaceId, owner.value])
						: await transaction.unsafe<Array<{ id: string }>>(`SELECT workspace.id
							FROM workspaces workspace JOIN management_api_keys management_key ON management_key.id = $1
							WHERE management_key.status = 'active'
								AND (management_key.expires_at IS NULL OR management_key.expires_at > CURRENT_TIMESTAMP)
								AND management_key.account_type = $2
								AND management_key.personal_owner_user_id IS NOT DISTINCT FROM $3
								AND management_key.organization_id IS NOT DISTINCT FROM $4
								AND ${postgresActiveOwnerPredicate(principal)}
								AND workspace.id = $5 AND workspace.status = 'active'
								AND ${owner.sql} FOR UPDATE OF workspace`, [
							principal.keyId, principal.accountType, principal.personalOwnerUserId,
							principal.organizationId, input.workspaceId, owner.value,
						]);
					if (authorized.length !== 1) return 'not_found';
					const rows = await transaction.unsafe<RawByokKeyRow[]>(`SELECT ${METADATA_COLUMNS}
						FROM byok_keys byok WHERE byok.workspace_id = $1 AND byok.provider = $2
							AND byok.deleted_at IS NULL ORDER BY byok.id FOR UPDATE OF byok`,
					[input.workspaceId, input.provider]);
					if (!sameReorderSet(rows, input) || reorderViolatesAlwaysUse(rows, input)) {
						return 'conflict';
					}
					const recordset = `jsonb_to_recordset($1::jsonb) AS mapping(
						id text, temporary_provider text, sort_order integer, is_fallback boolean)`;
					await transaction.unsafe(`UPDATE byok_keys AS byok SET provider = mapping.temporary_provider
						FROM ${recordset} WHERE byok.id = mapping.id AND byok.workspace_id = $2
							AND byok.provider = $3 AND byok.deleted_at IS NULL`,
					[mappingJson, input.workspaceId, input.provider]);
					await transaction.unsafe(`UPDATE byok_keys AS byok SET sort_order = mapping.sort_order,
						is_fallback = mapping.is_fallback, updated_at = $2
						FROM ${recordset} WHERE byok.id = mapping.id AND byok.workspace_id = $3
							AND byok.provider = mapping.temporary_provider AND byok.deleted_at IS NULL`,
					[mappingJson, params.nowIso, input.workspaceId]);
					await transaction.unsafe(`UPDATE byok_keys AS byok SET provider = $2
						FROM ${recordset} WHERE byok.id = mapping.id AND byok.workspace_id = $3
							AND byok.provider = mapping.temporary_provider AND byok.deleted_at IS NULL`,
					[mappingJson, input.provider, input.workspaceId]);
					const actor = mutationActor(principal);
					await transaction.unsafe(`INSERT INTO user_audit_logs (
						id, user_id, api_key_id, event_type, actor_type, change_payload, source,
						actor_id, reason_code, reason_text, created_at
					) VALUES ($1,$2,NULL,'byok_key_reordered',$3,$4,$5,
						$6,'byok_key_reordered',$7,$8)`, [
						crypto.randomUUID(), actor.userId, actor.actorType, audit,
						actor.source, actor.actorId,
						`BYOK credentials reordered ${actor.reasonTextSuffix}`, params.nowIso,
					]);
					return 'updated';
				});
			}

			const connection = await client.raw.getConnection();
			try {
				await connection.beginTransaction();
				const owner = d1AccountPredicate(mutationAccount(principal), 'workspace');
				const authorized = isByokPortalUserPrincipal(principal)
					? await mysqlQueryRows<RowDataPacket & { id: string }>(connection,
						`SELECT workspace.id FROM workspaces workspace
						JOIN users portal_user ON portal_user.id = ?
						WHERE portal_user.status = 'active' AND workspace.id = ?
							AND workspace.status = 'active' AND ${owner.sql} FOR UPDATE`,
						[principal.userId, input.workspaceId, ...owner.values])
					: await (async () => {
						const key = d1ActiveManagementKeyPredicate(principal);
						return mysqlQueryRows<RowDataPacket & { id: string }>(connection,
							`SELECT workspace.id FROM workspaces workspace
							JOIN management_api_keys management_key ON management_key.id = ?
							WHERE ${key.sql.replaceAll("datetime('now')", 'UTC_TIMESTAMP(6)')}
								AND workspace.id = ? AND workspace.status = 'active' AND ${key.workspaceSql}
							FOR UPDATE`, [principal.keyId, ...key.values.slice(1), input.workspaceId, ...key.workspaceValues]);
					})();
				if (authorized.length !== 1) {
					await connection.rollback();
					return 'not_found';
				}
				const rows = await mysqlQueryRows<MySqlByokKeyRow>(connection,
					`SELECT ${METADATA_COLUMNS} FROM byok_keys byok
					WHERE byok.workspace_id = ? AND byok.provider = ? AND byok.deleted_at IS NULL
					ORDER BY byok.id FOR UPDATE`, [input.workspaceId, input.provider]);
				if (!sameReorderSet(rows, input) || reorderViolatesAlwaysUse(rows, input)) {
					await connection.rollback();
					return 'conflict';
				}
				const jsonTable = `JSON_TABLE(?, '$[*]' COLUMNS (
					id VARCHAR(64) PATH '$.id',
					temporary_provider VARCHAR(128) PATH '$.temporary_provider',
					sort_order INT PATH '$.sort_order',
					is_fallback INT PATH '$.is_fallback'
				)) mapping`;
				await mysqlExecute(connection, `UPDATE byok_keys byok JOIN ${jsonTable}
					ON byok.id = mapping.id SET byok.provider = mapping.temporary_provider
					WHERE byok.workspace_id = ? AND byok.provider = ? AND byok.deleted_at IS NULL`,
				[mappingJson, input.workspaceId, input.provider]);
				await mysqlExecute(connection, `UPDATE byok_keys byok JOIN ${jsonTable}
					ON byok.id = mapping.id SET byok.sort_order = mapping.sort_order,
						byok.is_fallback = mapping.is_fallback, byok.updated_at = ?
					WHERE byok.workspace_id = ? AND byok.provider = mapping.temporary_provider
						AND byok.deleted_at IS NULL`,
				[mappingJson, toMySqlDateTime(params.nowIso), input.workspaceId]);
				await mysqlExecute(connection, `UPDATE byok_keys byok JOIN ${jsonTable}
					ON byok.id = mapping.id SET byok.provider = ?
					WHERE byok.workspace_id = ? AND byok.provider = mapping.temporary_provider
						AND byok.deleted_at IS NULL`,
				[mappingJson, input.provider, input.workspaceId]);
				const actor = mutationActor(principal);
				await mysqlExecute(connection, `INSERT INTO user_audit_logs (
					id, user_id, api_key_id, event_type, actor_type, change_payload, source,
					actor_id, reason_code, reason_text, created_at
				) VALUES (?, ?, NULL, 'byok_key_reordered', ?, ?, ?,
					?, 'byok_key_reordered', ?, ?)`, [
					crypto.randomUUID(), actor.userId, actor.actorType, audit,
					actor.source, actor.actorId,
					`BYOK credentials reordered ${actor.reasonTextSuffix}`, toMySqlDateTime(params.nowIso),
				]);
				await connection.commit();
				return 'updated';
			} catch (error) {
				await connection.rollback().catch(() => undefined);
				throw error;
			} finally {
				connection.release();
			}
		},

		async deleteForManagement(params: ByokManagementMutation) {
			assertMutation(params);
			const account = mutationAccount(params.principal);
			if (client.driver === 'd1') {
				const current = await getD1(client.raw, params.id, account);
				if (!current) return false;
				const access = d1MutationAccess(params.principal, current.workspace_id);
				const update = client.raw.prepare(`UPDATE byok_keys SET api_key_encrypted = '',
					label = 'deleted', disabled = 1, allowed_models_json = NULL,
					allowed_user_ids_json = NULL, allowed_api_key_hashes_json = NULL,
					deleted_at = ?, updated_at = ?
					WHERE id = ? AND deleted_at IS NULL AND EXISTS (
						SELECT 1 FROM ${access.from}
						WHERE workspace.id = byok_keys.workspace_id AND ${access.where}
					)`).bind(params.nowIso, params.nowIso, params.id, ...access.values);
				const payload = auditPayload('deleted', current);
				const results = await client.raw.batch([
					update,
					d1AuditStatement(client.raw, {
						...params,
						workspaceId: current.workspace_id,
						action: 'deleted',
						payload,
					}),
				]);
				return (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1;
			}

			if (client.driver === 'postgres') {
				return client.raw.begin(async (transaction) => {
					const portalPrincipal = isByokPortalUserPrincipal(params.principal)
						? params.principal
						: null;
					const owner = postgresAccountPredicate(account, 'workspace', portalPrincipal ? 4 : 6);
					const rows = portalPrincipal
						? await transaction.unsafe<RawByokKeyRow[]>(`SELECT ${METADATA_COLUMNS}
							FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
							JOIN users portal_user ON portal_user.id = $1
							WHERE byok.id = $2 AND byok.workspace_id = $3 AND byok.deleted_at IS NULL
								AND portal_user.status = 'active' AND workspace.status = 'active'
								AND ${owner.sql} FOR UPDATE OF byok`, [
							portalPrincipal.userId, params.id, portalPrincipal.workspaceId, owner.value,
						])
						: await (async () => {
							const managementPrincipal = requireManagementPrincipal(params.principal);
							return transaction.unsafe<RawByokKeyRow[]>(`SELECT ${METADATA_COLUMNS}
							FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
							JOIN management_api_keys management_key ON management_key.id = $1
							WHERE byok.id = $2 AND byok.deleted_at IS NULL AND workspace.status = 'active'
								AND management_key.status = 'active'
								AND (management_key.expires_at IS NULL OR management_key.expires_at > CURRENT_TIMESTAMP)
								AND management_key.account_type = $3
								AND management_key.personal_owner_user_id IS NOT DISTINCT FROM $4
								AND management_key.organization_id IS NOT DISTINCT FROM $5
								AND ${postgresActiveOwnerPredicate(managementPrincipal)}
								AND ${owner.sql} FOR UPDATE OF byok`, [
							managementPrincipal.keyId, params.id, managementPrincipal.accountType,
							managementPrincipal.personalOwnerUserId, managementPrincipal.organizationId, owner.value,
							]);
						})();
					if (!rows[0]) return false;
					await transaction.unsafe(`UPDATE byok_keys SET api_key_encrypted = '', label = 'deleted',
						disabled = TRUE, allowed_models_json = NULL, allowed_user_ids_json = NULL,
						allowed_api_key_hashes_json = NULL, deleted_at = $1, updated_at = $1 WHERE id = $2`,
					[params.nowIso, params.id]);
					const actor = mutationActor(params.principal);
					await transaction.unsafe(`INSERT INTO user_audit_logs (
						id, user_id, api_key_id, event_type, actor_type, change_payload, source,
						actor_id, reason_code, reason_text, created_at
					) VALUES ($1,$2,NULL,'byok_key_deleted',$3,$4,$5,
						$6,'byok_key_deleted',$7,$8)`, [
						crypto.randomUUID(), actor.userId, actor.actorType,
						auditPayload('deleted', mapMetadata(rows[0])),
						actor.source, actor.actorId,
						`BYOK credential deleted ${actor.reasonTextSuffix}`, params.nowIso,
					]);
					return true;
				});
			}

			const connection = await client.raw.getConnection();
			try {
				await connection.beginTransaction();
				const owner = d1AccountPredicate(account, 'workspace');
				const rows = isByokPortalUserPrincipal(params.principal)
					? await mysqlQueryRows<MySqlByokKeyRow>(connection, `SELECT ${METADATA_COLUMNS}
						FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
						JOIN users portal_user ON portal_user.id = ?
						WHERE byok.id = ? AND byok.workspace_id = ? AND byok.deleted_at IS NULL
							AND portal_user.status = 'active' AND workspace.status = 'active'
							AND ${owner.sql} FOR UPDATE`, [
						params.principal.userId, params.id, params.principal.workspaceId, ...owner.values,
					])
					: await (async () => {
						const managementPrincipal = requireManagementPrincipal(params.principal);
						const key = d1ActiveManagementKeyPredicate(managementPrincipal);
						return mysqlQueryRows<MySqlByokKeyRow>(connection, `SELECT ${METADATA_COLUMNS}
							FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
							JOIN management_api_keys management_key ON management_key.id = ?
							WHERE byok.id = ? AND byok.deleted_at IS NULL AND workspace.status = 'active'
								AND ${key.sql.replaceAll("datetime('now')", 'UTC_TIMESTAMP(6)')}
								AND ${key.workspaceSql} FOR UPDATE`,
						[managementPrincipal.keyId, params.id, ...key.values.slice(1), ...key.workspaceValues]);
					})();
				if (!rows[0]) {
					await connection.rollback();
					return false;
				}
				const mysqlNow = toMySqlDateTime(params.nowIso);
				await mysqlExecute(connection, `UPDATE byok_keys SET api_key_encrypted = '',
					label = 'deleted', disabled = TRUE, allowed_models_json = NULL,
					allowed_user_ids_json = NULL, allowed_api_key_hashes_json = NULL,
					deleted_at = ?, updated_at = ? WHERE id = ?`, [mysqlNow, mysqlNow, params.id]);
				const actor = mutationActor(params.principal);
				await mysqlExecute(connection, `INSERT INTO user_audit_logs (
					id, user_id, api_key_id, event_type, actor_type, change_payload, source,
					actor_id, reason_code, reason_text, created_at
				) VALUES (?, ?, NULL, 'byok_key_deleted', ?, ?, ?,
					?, 'byok_key_deleted', ?, ?)`, [
					crypto.randomUUID(), actor.userId, actor.actorType,
					auditPayload('deleted', mapMetadata(rows[0], true)),
					actor.source, actor.actorId,
					`BYOK credential deleted ${actor.reasonTextSuffix}`, mysqlNow,
				]);
				await connection.commit();
				return true;
			} catch (error) {
				await connection.rollback().catch(() => undefined);
				throw error;
			} finally {
				connection.release();
			}
		},

		async listActiveForRequest(params: ByokRuntimeLookup) {
			assertRuntimeLookup(params);
			let rows: ByokRuntimeKeyRow[];
			if (client.driver === 'd1') {
				const result = await client.raw.prepare(`SELECT ${RUNTIME_COLUMNS}
					FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
					WHERE byok.workspace_id = ? AND byok.provider = ? AND byok.disabled = 0
						AND byok.deleted_at IS NULL AND workspace.status = 'active'
					ORDER BY byok.is_fallback ASC, byok.sort_order ASC, byok.id ASC LIMIT ?`)
					.bind(params.workspaceId, params.provider, BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER)
					.all<RawByokKeyRow>();
				rows = (result.results ?? []).map((row) => mapRuntime(row));
			} else if (client.driver === 'postgres') {
				const result = await client.raw.unsafe<RawByokKeyRow[]>(`SELECT ${RUNTIME_COLUMNS}
					FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
					WHERE byok.workspace_id = $1 AND byok.provider = $2 AND byok.disabled = FALSE
						AND byok.deleted_at IS NULL AND workspace.status = 'active'
					ORDER BY byok.is_fallback ASC, byok.sort_order ASC, byok.id ASC LIMIT $3`,
				[params.workspaceId, params.provider, BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER]);
				rows = result.map((row) => mapRuntime(row));
			} else {
				const result = await mysqlQueryRows<MySqlByokKeyRow>(client.raw, `SELECT ${RUNTIME_COLUMNS}
					FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
					WHERE byok.workspace_id = ? AND byok.provider = ? AND byok.disabled = FALSE
						AND byok.deleted_at IS NULL AND workspace.status = 'active'
					ORDER BY byok.is_fallback ASC, byok.sort_order ASC, byok.id ASC LIMIT ?`,
				[params.workspaceId, params.provider, BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER]);
				rows = result.map((row) => mapRuntime(row, true));
			}
			return rows
				.filter((row) => eligible(row, params))
				.slice(0, BYOK_MAX_RUNTIME_KEYS);
		},

		async shouldSuppressSharedCapacityForRequest(params: ByokRuntimeLookup) {
			assertRuntimeLookup(params);
			let rows: ByokKeyRow[];
			if (client.driver === 'd1') {
				const result = await client.raw.prepare(`SELECT ${METADATA_COLUMNS}
					FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
					WHERE byok.workspace_id = ? AND byok.provider = ? AND byok.disabled = 0
						AND byok.is_fallback = 0
						AND (byok.always_use_for_provider = 1
							OR byok.always_use_for_matching_models = 1)
						AND byok.deleted_at IS NULL AND workspace.status = 'active'
					ORDER BY byok.sort_order ASC, byok.id ASC LIMIT ?`)
					.bind(params.workspaceId, params.provider, BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER)
					.all<RawByokKeyRow>();
				rows = (result.results ?? []).map((row) => mapMetadata(row));
			} else if (client.driver === 'postgres') {
				const result = await client.raw.unsafe<RawByokKeyRow[]>(`SELECT ${METADATA_COLUMNS}
					FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
					WHERE byok.workspace_id = $1 AND byok.provider = $2 AND byok.disabled = FALSE
						AND byok.is_fallback = FALSE
						AND (byok.always_use_for_provider = TRUE
							OR byok.always_use_for_matching_models = TRUE)
						AND byok.deleted_at IS NULL AND workspace.status = 'active'
					ORDER BY byok.sort_order ASC, byok.id ASC LIMIT $3`,
				[params.workspaceId, params.provider, BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER]);
				rows = result.map((row) => mapMetadata(row));
			} else {
				const result = await mysqlQueryRows<MySqlByokKeyRow>(client.raw, `SELECT ${METADATA_COLUMNS}
					FROM byok_keys byok JOIN workspaces workspace ON workspace.id = byok.workspace_id
					WHERE byok.workspace_id = ? AND byok.provider = ? AND byok.disabled = FALSE
						AND byok.is_fallback = FALSE
						AND (byok.always_use_for_provider = TRUE
							OR byok.always_use_for_matching_models = TRUE)
						AND byok.deleted_at IS NULL AND workspace.status = 'active'
					ORDER BY byok.sort_order ASC, byok.id ASC LIMIT ?`,
				[params.workspaceId, params.provider, BYOK_MAX_KEYS_PER_WORKSPACE_PROVIDER]);
				rows = result.map((row) => mapMetadata(row, true));
			}
			return rows.some((row) => {
				if (!eligibleIdentity(row, params)) return false;
				// Provider-wide is the strongest policy, so model filters must not
				// narrow it. The middle policy applies only when this model matches.
				return row.always_use_for_provider
					|| (row.always_use_for_matching_models && eligible(row, params));
			});
		},
	};
}
