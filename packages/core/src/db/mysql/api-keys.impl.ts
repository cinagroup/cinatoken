/**
 * MySQL：`api_keys`（预算在 `users`）。
 */
import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	like,
	lte,
	or,
	sql,
} from "drizzle-orm";
import type { ApiKeyRow, ResolvedGatewayKeyRow } from "../../types";
import { roundGatewayMoney } from "../../lib/money-precision";
import {
	hashLookupKey,
	prepareGatewayApiKeyForStorage,
	resolveGatewayApiKeyPreview,
} from "../../lib/key-hash";
import type { MySqlDatabaseClient } from "../../storage/database-client";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { ApiKeysRepository } from "../../storage/gateway-repository-interfaces";
import {
	apiKeysTable as myApiKeysTable,
	organizationMembershipsTable as myOrganizationMembershipsTable,
	organizationsTable as myOrganizationsTable,
	usersTable as myUsersTable,
	workspaceMembershipsTable as myWorkspaceMembershipsTable,
	workspacesTable as myWorkspacesTable,
} from "../../storage/drizzle/schema.mysql";
import type {
	BudgetFilter,
	InsertKeyParams,
	ManagementGatewayKeyListParams,
	ManagementGatewayKeyLookupParams,
	ManagementGatewayKeyRow,
} from "../api-keys-types";
import { assertGatewayKeyLookupHash } from "../api-keys-types";
import {
	DEFAULT_API_KEY_LIST_ORDER,
	DEFAULT_API_KEY_LIST_SORT,
	type ApiKeyListSortField,
	type ApiKeyListSortOrder,
} from "../api-keys-list-sort";
import type { AdminApiKeyListItem } from "../../storage/repository-dtos";
import { parseMoney } from "../../storage/critical-write-paths-utils";
import { fromMySqlDateTime, toMySqlDateTime } from "./mysql2-compat";
import { normalizeGatewayKeyLimitReset } from "../../gateway-key-limits";

function apiKeyListOrderBy(
	sort: ApiKeyListSortField,
	order: ApiKeyListSortOrder
) {
	const isAsc = order === "asc";
	if (sort === "budget_reset_at") {
		const col = myUsersTable.budgetResetAt;
		return isAsc ? sql`${col} ASC NULLS LAST` : sql`${col} DESC NULLS FIRST`;
	}
	if (sort === "budget_spent") {
		return isAsc
			? asc(myUsersTable.budgetSpent)
			: desc(myUsersTable.budgetSpent);
	}
	return isAsc ? asc(myApiKeysTable.createdAt) : desc(myApiKeysTable.createdAt);
}

function mapMyKeyRow(r: {
	id: string;
	key: string;
	keyPreview: string | null;
	userId: string;
	workspaceId: string;
	name: string | null;
	status: string;
	metadata: string | null;
	expiresAt: string | null;
	limitMicros: number | null;
	limitReset: string | null;
	includeByokInLimit: number;
	limitEpoch: number;
	lastUsedAt: string | null;
	createdAt: string;
	updatedAt: string;
}): ApiKeyRow {
	return {
		id: r.id,
		key: resolveGatewayApiKeyPreview(r.key, r.keyPreview),
		user_id: r.userId,
		workspace_id: r.workspaceId,
		name: r.name,
		status: r.status,
		metadata: r.metadata,
		expires_at: r.expiresAt === null ? null : fromMySqlDateTime(r.expiresAt),
		limit_micros: r.limitMicros === null ? null : Number(r.limitMicros),
		limit_reset: normalizeGatewayKeyLimitReset(r.limitReset),
		include_byok_in_limit: r.includeByokInLimit === 1,
		limit_epoch: Number(r.limitEpoch),
		last_used_at: r.lastUsedAt,
		created_at: r.createdAt,
		updated_at: r.updatedAt,
	};
}

function mapMyResolvedRow(r: {
	id: string;
	key: string;
	keyPreview: string | null;
	userId: string;
	workspaceId: string;
	name: string | null;
	status: string;
	metadata: string | null;
	expiresAt: string | null;
	limitMicros: number | null;
	limitReset: string | null;
	includeByokInLimit: number;
	limitEpoch: number;
	lastUsedAt: string | null;
	createdAt: string;
	updatedAt: string;
	userEmail: string | null;
	budgetMax: string | null;
	budgetBase: string;
	budgetSpent: string;
	budgetPeriod: string;
	budgetResetAt: string | null;
	budgetEpoch: number;
	budgetReservedMicros: number;
	userMetadata: string | null;
	userChargedCostFactors: string | null;
}): ResolvedGatewayKeyRow {
	const k = mapMyKeyRow(r);
	return {
		...k,
		user_email: r.userEmail,
		user_metadata: r.userMetadata,
		user_charged_cost_factors: r.userChargedCostFactors ?? null,
		budget_max: r.budgetMax == null ? null : parseMoney(r.budgetMax),
		budget_base: parseMoney(r.budgetBase),
		budget_spent: parseMoney(r.budgetSpent),
		budget_period: r.budgetPeriod,
		budget_reset_at: r.budgetResetAt,
		budget_epoch: Number(r.budgetEpoch),
		budget_reserved_micros: Number(r.budgetReservedMicros),
	};
}

function mapMyAdminListRow(r: {
	id: string;
	key: string;
	key_preview: string | null;
	user_id: string;
	workspace_id: string;
	name: string | null;
	user_email: string | null;
	budget_max: string | null;
	budget_base: string | null;
	budget_spent: string;
	budget_period: string;
	budget_reset_at: string | null;
	status: string;
	metadata: string | null;
	created_at: string;
	updated_at: string;
}): AdminApiKeyListItem {
	return {
		id: r.id,
		key: resolveGatewayApiKeyPreview(r.key, r.key_preview),
		user_id: r.user_id,
		workspace_id: r.workspace_id,
		name: r.name,
		user_email: r.user_email,
		budget_max:
			r.budget_max == null ? null : roundGatewayMoney(Number(r.budget_max)),
		budget_base:
			r.budget_base == null ? 0 : roundGatewayMoney(Number(r.budget_base)),
		budget_spent: roundGatewayMoney(Number(r.budget_spent)),
		budget_period: r.budget_period,
		budget_reset_at: r.budget_reset_at,
		status: r.status,
		metadata: r.metadata,
		created_at: r.created_at,
		updated_at: r.updated_at,
	};
}

type MyManagementGatewayKeyRow = Omit<
	ManagementGatewayKeyRow,
	| "created_at"
	| "updated_at"
	| "expires_at"
	| "limit_micros"
	| "include_byok_in_limit"
	| "limit_epoch"
	| "limit_consumed_micros"
	| "usage"
	| "usage_daily"
	| "usage_weekly"
	| "usage_monthly"
	| "byok_usage"
	| "byok_usage_daily"
	| "byok_usage_weekly"
	| "byok_usage_monthly"
> &
	RowDataPacket & {
		created_at: string | Date;
		updated_at: string | Date;
		expires_at: string | Date | null;
		limit_micros: string | number | null;
		include_byok_in_limit: string | number;
		limit_epoch: string | number;
		limit_consumed_micros: string | number;
		usage: string | number;
		usage_daily: string | number;
		usage_weekly: string | number;
		usage_monthly: string | number;
		byok_usage: string | number;
		byok_usage_daily: string | number;
		byok_usage_weekly: string | number;
		byok_usage_monthly: string | number;
	};

function mapMyManagementGatewayKeyRow(
	row: MyManagementGatewayKeyRow
): ManagementGatewayKeyRow {
	return {
		id: row.id,
		key_hash: row.key_hash,
		key_preview: row.key_preview,
		user_id: row.user_id,
		workspace_id: row.workspace_id,
		name: row.name,
		status: row.status,
		expires_at:
			row.expires_at === null ? null : fromMySqlDateTime(row.expires_at),
		limit_micros: row.limit_micros === null ? null : Number(row.limit_micros),
		limit_reset: row.limit_reset,
		include_byok_in_limit: Number(row.include_byok_in_limit) === 1,
		limit_epoch: Number(row.limit_epoch),
		limit_consumed_micros: Number(row.limit_consumed_micros ?? 0),
		created_at:
			row.created_at instanceof Date
				? row.created_at.toISOString()
				: String(row.created_at),
		updated_at:
			row.updated_at instanceof Date
				? row.updated_at.toISOString()
				: String(row.updated_at),
		usage: roundGatewayMoney(Number(row.usage ?? 0)),
		usage_daily: roundGatewayMoney(Number(row.usage_daily ?? 0)),
		usage_weekly: roundGatewayMoney(Number(row.usage_weekly ?? 0)),
		usage_monthly: roundGatewayMoney(Number(row.usage_monthly ?? 0)),
		byok_usage: roundGatewayMoney(Number(row.byok_usage ?? 0)),
		byok_usage_daily: roundGatewayMoney(Number(row.byok_usage_daily ?? 0)),
		byok_usage_weekly: roundGatewayMoney(Number(row.byok_usage_weekly ?? 0)),
		byok_usage_monthly: roundGatewayMoney(Number(row.byok_usage_monthly ?? 0)),
	};
}

function myManagementAccountPredicate(
	params: ManagementGatewayKeyListParams | ManagementGatewayKeyLookupParams
): { sql: string; value: string } {
	if (
		params.accountType === "personal" &&
		params.personalOwnerUserId &&
		params.organizationId === null
	) {
		return {
			sql: "w.scope_type = 'personal' AND w.personal_owner_user_id = ? AND w.organization_id IS NULL",
			value: params.personalOwnerUserId,
		};
	}
	if (
		params.accountType === "organization" &&
		params.personalOwnerUserId === null &&
		params.organizationId
	) {
		return {
			sql: "w.scope_type = 'organization' AND w.personal_owner_user_id IS NULL AND w.organization_id = ?",
			value: params.organizationId,
		};
	}
	throw new TypeError("management gateway key account scope is invalid");
}

const myManagementUsageSelect = `
	SELECT k.id, k.key_hash, COALESCE(k.key_preview, 'sk-…') AS key_preview,
		k.user_id, k.workspace_id, k.name, k.status, k.expires_at,
		k.limit_micros, k.limit_reset, k.include_byok_in_limit, k.limit_epoch,
		k.created_at, k.updated_at,
		COALESCE((SELECT budget_window.unreserved_micros + budget_window.settled_micros
			FROM guardrail_budget_windows budget_window
			WHERE budget_window.workspace_id = k.workspace_id
				AND budget_window.scope_type = 'api_key' AND budget_window.scope_id = k.id
				AND budget_window.period = COALESCE(k.limit_reset, 'lifetime')
				AND budget_window.period_start <= UTC_TIMESTAMP(6)
				AND budget_window.period_end > UTC_TIMESTAMP(6)
			ORDER BY budget_window.period_start DESC LIMIT 1), 0) AS limit_consumed_micros,
		COALESCE((SELECT SUM(log.charged_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id), 0) AS usage,
		COALESCE((SELECT SUM(log.charged_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.created_at >= UTC_DATE()), 0) AS usage_daily,
		COALESCE((SELECT SUM(log.charged_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.created_at >= DATE_SUB(UTC_DATE(), INTERVAL WEEKDAY(UTC_DATE()) DAY)), 0) AS usage_weekly,
		COALESCE((SELECT SUM(log.charged_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.created_at >= DATE_FORMAT(UTC_DATE(), '%Y-%m-01')), 0) AS usage_monthly,
		COALESCE((SELECT SUM(log.standard_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.is_byok = 1), 0) AS byok_usage,
		COALESCE((SELECT SUM(log.standard_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.is_byok = 1
				AND log.created_at >= UTC_DATE()), 0) AS byok_usage_daily,
		COALESCE((SELECT SUM(log.standard_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.is_byok = 1
				AND log.created_at >= DATE_SUB(UTC_DATE(), INTERVAL WEEKDAY(UTC_DATE()) DAY)), 0) AS byok_usage_weekly,
		COALESCE((SELECT SUM(log.standard_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.is_byok = 1
				AND log.created_at >= DATE_FORMAT(UTC_DATE(), '%Y-%m-01')), 0) AS byok_usage_monthly
	FROM api_keys k INNER JOIN workspaces w ON w.id = k.workspace_id`;

const resolvedCols = {
	id: myApiKeysTable.id,
	key: myApiKeysTable.key,
	keyPreview: myApiKeysTable.keyPreview,
	userId: myApiKeysTable.userId,
	workspaceId: myApiKeysTable.workspaceId,
	name: myApiKeysTable.name,
	status: myApiKeysTable.status,
	metadata: myApiKeysTable.metadata,
	expiresAt: myApiKeysTable.expiresAt,
	limitMicros: myApiKeysTable.limitMicros,
	limitReset: myApiKeysTable.limitReset,
	includeByokInLimit: myApiKeysTable.includeByokInLimit,
	limitEpoch: myApiKeysTable.limitEpoch,
	lastUsedAt: myApiKeysTable.lastUsedAt,
	createdAt: myApiKeysTable.createdAt,
	updatedAt: myApiKeysTable.updatedAt,
	userEmail: myUsersTable.email,
	budgetMax: myUsersTable.budgetMax,
	budgetBase: myUsersTable.budgetBase,
	budgetSpent: myUsersTable.budgetSpent,
	budgetPeriod: myUsersTable.budgetPeriod,
	budgetResetAt: myUsersTable.budgetResetAt,
	budgetEpoch: myUsersTable.budgetEpoch,
	budgetReservedMicros: myUsersTable.budgetReservedMicros,
	userMetadata: myUsersTable.metadata,
	userChargedCostFactors: myUsersTable.chargedCostFactors,
} as const;

const activeWorkspaceFilter = and(
	eq(myWorkspacesTable.status, "active"),
	or(
		isNull(myApiKeysTable.expiresAt),
		gt(myApiKeysTable.expiresAt, sql`UTC_TIMESTAMP(6)`)
	),
	or(
		eq(myWorkspacesTable.scopeType, "personal"),
		inArray(myOrganizationsTable.status, ["active", "pending"])
	)
);

const activeGatewayAuthorizationFilter = and(
	eq(myWorkspacesTable.status, "active"),
	or(
		isNull(myApiKeysTable.expiresAt),
		gt(myApiKeysTable.expiresAt, sql`UTC_TIMESTAMP(6)`)
	),
	or(
		and(
			eq(myWorkspacesTable.scopeType, "personal"),
			eq(myWorkspacesTable.personalOwnerUserId, myApiKeysTable.userId)
		),
		and(
			eq(myWorkspacesTable.scopeType, "organization"),
			inArray(myOrganizationsTable.status, ["active", "pending"]),
			eq(myUsersTable.externalSystem, "cinaauth"),
			isNotNull(myUsersTable.externalUserId),
			sql<boolean>`EXISTS (
				SELECT 1 FROM ${myOrganizationMembershipsTable}
				WHERE ${myOrganizationMembershipsTable.organizationId} = ${myWorkspacesTable.organizationId}
					AND ${myOrganizationMembershipsTable.subject} = ${myUsersTable.externalUserId}
					AND ${myOrganizationMembershipsTable.status} = 'active'
			)`,
			or(
				eq(myWorkspacesTable.isDefault, 1),
				sql<boolean>`EXISTS (
					SELECT 1 FROM ${myWorkspaceMembershipsTable}
					WHERE ${myWorkspaceMembershipsTable.workspaceId} = ${myWorkspacesTable.id}
						AND ${myWorkspaceMembershipsTable.subject} = ${myUsersTable.externalUserId}
						AND ${myWorkspaceMembershipsTable.status} = 'active'
				)`
			)
		)
	)
);

export function createMySqlApiKeysRepository(
	db: MySqlDatabaseClient
): ApiKeysRepository {
	const drizzle = db.drizzle;
	const raw = db.raw;
	const getActiveByLookupHash = async (
		keyHash: string
	): Promise<ResolvedGatewayKeyRow | null> => {
		assertGatewayKeyLookupHash(keyHash);
		const rows = await drizzle
			.select(resolvedCols)
			.from(myApiKeysTable)
			.innerJoin(myUsersTable, eq(myApiKeysTable.userId, myUsersTable.id))
			.innerJoin(
				myWorkspacesTable,
				eq(myApiKeysTable.workspaceId, myWorkspacesTable.id)
			)
			.leftJoin(
				myOrganizationsTable,
				eq(myWorkspacesTable.organizationId, myOrganizationsTable.id)
			)
			.where(
				and(
					eq(myApiKeysTable.keyHash, keyHash),
					eq(myApiKeysTable.status, "active"),
					eq(myUsersTable.status, "active"),
					activeGatewayAuthorizationFilter
				)
			)
			.limit(1);
		return rows[0] ? mapMyResolvedRow(rows[0]) : null;
	};
	return {
		async getCurrentById(id) {
			const [rows] = await raw.execute<MyManagementGatewayKeyRow[]>(
				`${myManagementUsageSelect}
				WHERE k.id = ? AND k.status = 'active' AND w.status = 'active'
					AND (k.expires_at IS NULL OR k.expires_at > UTC_TIMESTAMP(6)) LIMIT 1`,
				[id]
			);
			return rows[0] ? mapMyManagementGatewayKeyRow(rows[0]) : null;
		},

		async listForManagement(params) {
			const account = myManagementAccountPredicate(params);
			const statusSql = params.includeDisabled
				? ""
				: " AND k.status = 'active'";
			const [rows] = await raw.execute<MyManagementGatewayKeyRow[]>(
				`${myManagementUsageSelect}
				WHERE k.workspace_id = ? AND k.key_hash IS NOT NULL
					AND w.status = 'active' AND ${account.sql}${statusSql}
				ORDER BY k.created_at DESC, k.id DESC LIMIT 100 OFFSET ?`,
				[params.workspaceId, account.value, params.offset]
			);
			return rows.map(mapMyManagementGatewayKeyRow);
		},

		async getByHashForManagement(params) {
			const account = myManagementAccountPredicate(params);
			const [rows] = await raw.execute<MyManagementGatewayKeyRow[]>(
				`${myManagementUsageSelect}
				WHERE k.key_hash = ? AND w.status = 'active' AND ${account.sql} LIMIT 1`,
				[params.keyHash, account.value]
			);
			return rows[0] ? mapMyManagementGatewayKeyRow(rows[0]) : null;
		},

		async updateByHashForManagement(params, patch) {
			const account = myManagementAccountPredicate(params);
			const sets: string[] = [];
			const values: unknown[] = [];
			if (patch.name !== undefined) {
				sets.push("name = ?");
				values.push(patch.name);
			}
			if (patch.status !== undefined) {
				sets.push("status = ?");
				values.push(patch.status);
			}
			let limitChanged = false;
			if (patch.limitMicros !== undefined) {
				sets.push("limit_micros = ?");
				values.push(patch.limitMicros);
				limitChanged = true;
			}
			if (patch.limitReset !== undefined) {
				sets.push("limit_reset = ?");
				values.push(patch.limitReset);
				limitChanged = true;
			}
			if (patch.includeByokInLimit !== undefined) {
				sets.push("include_byok_in_limit = ?");
				values.push(patch.includeByokInLimit ? 1 : 0);
				limitChanged = true;
			}
			if (sets.length === 0) return false;
			if (limitChanged) sets.push("limit_epoch = limit_epoch + 1");
			sets.push("updated_at = UTC_TIMESTAMP(6)");
			const [result] = await raw.execute<ResultSetHeader>(
				`UPDATE api_keys SET ${sets.join(", ")}
				WHERE key_hash = ? AND EXISTS (
					SELECT 1 FROM workspaces w WHERE w.id = api_keys.workspace_id
						AND w.status = 'active' AND ${account.sql}
				)`,
				[...values, params.keyHash, account.value] as never[]
			);
			if (result.affectedRows === 1) return true;
			const current = await this.getByHashForManagement(params);
			return Boolean(
				current &&
					(patch.name === undefined || current.name === patch.name) &&
					(patch.status === undefined || current.status === patch.status)
			);
		},

		async deleteByHashForManagement(params) {
			const account = myManagementAccountPredicate(params);
			const [result] = await raw.execute<ResultSetHeader>(
				`DELETE FROM api_keys WHERE key_hash = ?
					AND EXISTS (
						SELECT 1 FROM workspaces w WHERE w.id = api_keys.workspace_id
							AND w.status = 'active' AND ${account.sql}
					)
					AND NOT EXISTS (
						SELECT 1 FROM user_budget_reservations reservation
						WHERE reservation.api_key_id = api_keys.id
							AND reservation.state IN ('reserved', 'dispatched')
					)
					AND NOT EXISTS (
						SELECT 1 FROM guardrail_budget_reservations reservation
						WHERE reservation.scope_type = 'api_key'
							AND reservation.scope_id = api_keys.id
							AND reservation.state IN ('reserved', 'dispatched')
					)
					AND NOT EXISTS (
						SELECT 1 FROM api_key_request_logs request_log
						WHERE request_log.api_key_id = api_keys.id
					)`,
				[params.keyHash, account.value]
			);
			return result.affectedRows === 1;
		},

		async getApiKeyByKey(key: string): Promise<ApiKeyRow | null> {
			const keyHash = await hashLookupKey(key);
			const byHash = await drizzle
				.select()
				.from(myApiKeysTable)
				.innerJoin(
					myWorkspacesTable,
					eq(myApiKeysTable.workspaceId, myWorkspacesTable.id)
				)
				.leftJoin(
					myOrganizationsTable,
					eq(myWorkspacesTable.organizationId, myOrganizationsTable.id)
				)
				.where(
					and(
						eq(myApiKeysTable.keyHash, keyHash),
						eq(myApiKeysTable.status, "active"),
						activeWorkspaceFilter
					)
				)
				.limit(1);
			if (byHash[0]) return mapMyKeyRow(byHash[0].api_keys);
			const legacy = await drizzle
				.select()
				.from(myApiKeysTable)
				.innerJoin(
					myWorkspacesTable,
					eq(myApiKeysTable.workspaceId, myWorkspacesTable.id)
				)
				.leftJoin(
					myOrganizationsTable,
					eq(myWorkspacesTable.organizationId, myOrganizationsTable.id)
				)
				.where(
					and(
						eq(myApiKeysTable.key, key),
						eq(myApiKeysTable.status, "active"),
						activeWorkspaceFilter
					)
				)
				.limit(1);
			if (!legacy[0]) return null;
			const legacyKey = legacy[0].api_keys;
			const prepared = await prepareGatewayApiKeyForStorage(key);
			await drizzle
				.update(myApiKeysTable)
				.set({
					key: prepared.storageKey,
					keyHash: prepared.keyHash,
					keyPreview: prepared.keyPreview,
				})
				.where(
					and(eq(myApiKeysTable.id, legacyKey.id), eq(myApiKeysTable.key, key))
				);
			return mapMyKeyRow({
				...legacyKey,
				key: prepared.storageKey,
				keyPreview: prepared.keyPreview,
			});
		},

		async getApiKeyByKeyAnyStatus(key: string): Promise<ApiKeyRow | null> {
			const keyHash = await hashLookupKey(key);
			const byHash = await drizzle
				.select()
				.from(myApiKeysTable)
				.where(eq(myApiKeysTable.keyHash, keyHash))
				.limit(1);
			if (byHash[0]) return mapMyKeyRow(byHash[0]);
			const legacy = await drizzle
				.select()
				.from(myApiKeysTable)
				.where(eq(myApiKeysTable.key, key))
				.limit(1);
			if (!legacy[0]) return null;
			const prepared = await prepareGatewayApiKeyForStorage(key);
			await drizzle
				.update(myApiKeysTable)
				.set({
					key: prepared.storageKey,
					keyHash: prepared.keyHash,
					keyPreview: prepared.keyPreview,
				})
				.where(
					and(eq(myApiKeysTable.id, legacy[0].id), eq(myApiKeysTable.key, key))
				);
			return mapMyKeyRow({
				...legacy[0],
				key: prepared.storageKey,
				keyPreview: prepared.keyPreview,
			});
		},

		async getApiKeyById(id: string): Promise<ApiKeyRow | null> {
			const rows = await drizzle
				.select()
				.from(myApiKeysTable)
				.where(eq(myApiKeysTable.id, id))
				.limit(1);
			return rows[0] ? mapMyKeyRow(rows[0]) : null;
		},

		async getApiKeyWithUserByKey(
			key: string
		): Promise<ResolvedGatewayKeyRow | null> {
			// 审计 M2-3：哈希优先查找；miss 回退明文（迁移窗口），命中即惰性回填。
			const keyHash = await hashLookupKey(key);
			const byHash = await getActiveByLookupHash(keyHash);
			if (byHash) return byHash;
			const rows = await drizzle
				.select(resolvedCols)
				.from(myApiKeysTable)
				.innerJoin(myUsersTable, eq(myApiKeysTable.userId, myUsersTable.id))
				.innerJoin(
					myWorkspacesTable,
					eq(myApiKeysTable.workspaceId, myWorkspacesTable.id)
				)
				.leftJoin(
					myOrganizationsTable,
					eq(myWorkspacesTable.organizationId, myOrganizationsTable.id)
				)
				.where(
					and(
						eq(myApiKeysTable.key, key),
						eq(myApiKeysTable.status, "active"),
						eq(myUsersTable.status, "active"),
						activeGatewayAuthorizationFilter
					)
				)
				.limit(1);
			if (rows[0]) {
				const prepared = await prepareGatewayApiKeyForStorage(key);
				await drizzle
					.update(myApiKeysTable)
					.set({
						key: prepared.storageKey,
						keyHash: prepared.keyHash,
						keyPreview: prepared.keyPreview,
					})
					.where(
						and(eq(myApiKeysTable.id, rows[0].id), eq(myApiKeysTable.key, key))
					);
				return mapMyResolvedRow({
					...rows[0],
					key: prepared.storageKey,
					keyPreview: prepared.keyPreview,
				});
			}
			return null;
		},

		async getActiveApiKeyWithUserByLookupHash(keyHash) {
			return getActiveByLookupHash(keyHash);
		},

		async getApiKeyWithUserById(
			id: string
		): Promise<ResolvedGatewayKeyRow | null> {
			const rows = await drizzle
				.select(resolvedCols)
				.from(myApiKeysTable)
				.innerJoin(myUsersTable, eq(myApiKeysTable.userId, myUsersTable.id))
				.where(eq(myApiKeysTable.id, id))
				.limit(1);
			return rows[0] ? mapMyResolvedRow(rows[0]) : null;
		},

		async listKeysByUserId(
			userId: string,
			options?: { status?: string }
		): Promise<ApiKeyRow[]> {
			const where = options?.status
				? and(
						eq(myApiKeysTable.userId, userId),
						eq(myApiKeysTable.status, options.status)
				  )
				: eq(myApiKeysTable.userId, userId);
			const rows = await drizzle
				.select()
				.from(myApiKeysTable)
				.where(where)
				.orderBy(myApiKeysTable.createdAt);
			return rows.map(mapMyKeyRow);
		},

		async listKeysByWorkspaceId(
			workspaceId: string,
			options?: { status?: string; creatorUserId?: string }
		): Promise<ApiKeyRow[]> {
			const conditions = [eq(myApiKeysTable.workspaceId, workspaceId)];
			if (options?.creatorUserId)
				conditions.push(eq(myApiKeysTable.userId, options.creatorUserId));
			if (options?.status)
				conditions.push(eq(myApiKeysTable.status, options.status));
			const rows = await drizzle
				.select()
				.from(myApiKeysTable)
				.where(and(...conditions))
				.orderBy(myApiKeysTable.createdAt);
			return rows.map(mapMyKeyRow);
		},

		async getApiKeyByIdInWorkspace(
			id: string,
			workspaceId: string
		): Promise<ApiKeyRow | null> {
			const rows = await drizzle
				.select()
				.from(myApiKeysTable)
				.where(
					and(
						eq(myApiKeysTable.id, id),
						eq(myApiKeysTable.workspaceId, workspaceId)
					)
				)
				.limit(1);
			return rows[0] ? mapMyKeyRow(rows[0]) : null;
		},

		async insertApiKey(params: InsertKeyParams): Promise<void> {
			const now = new Date().toISOString();
			const status = params.status ?? "active";
			const prepared = await prepareGatewayApiKeyForStorage(params.key);
			await drizzle.insert(myApiKeysTable).values({
				id: params.id,
				key: prepared.storageKey,
				keyHash: prepared.keyHash,
				keyPreview: prepared.keyPreview,
				userId: params.userId,
				workspaceId: params.workspaceId,
				name: params.name ?? null,
				status,
				metadata: params.metadata ?? null,
				expiresAt: params.expiresAt
					? toMySqlDateTime(params.expiresAt)
					: null,
				limitMicros: params.limitMicros ?? null,
				limitReset: params.limitReset ?? null,
				includeByokInLimit: params.includeByokInLimit ? 1 : 0,
				limitEpoch: 0,
				lastUsedAt: null,
				createdAt: now,
				updatedAt: now,
			});
		},

		async revokeApiKey(id: string): Promise<boolean> {
			const existing = await drizzle
				.select({ id: myApiKeysTable.id })
				.from(myApiKeysTable)
				.where(eq(myApiKeysTable.id, id))
				.limit(1);
			if (!existing[0]) return false;
			const now = new Date().toISOString();
			await drizzle
				.update(myApiKeysTable)
				.set({ status: "revoked", updatedAt: now })
				.where(eq(myApiKeysTable.id, id));
			return true;
		},

		async revokeApiKeyInWorkspace(
			id: string,
			workspaceId: string,
			creatorUserId?: string
		): Promise<boolean> {
			const conditions = [
				eq(myApiKeysTable.id, id),
				eq(myApiKeysTable.workspaceId, workspaceId),
			];
			if (creatorUserId)
				conditions.push(eq(myApiKeysTable.userId, creatorUserId));
			const existing = await drizzle
				.select({ id: myApiKeysTable.id })
				.from(myApiKeysTable)
				.where(and(...conditions))
				.limit(1);
			if (!existing[0]) return false;
			await drizzle
				.update(myApiKeysTable)
				.set({ status: "revoked", updatedAt: new Date().toISOString() })
				.where(and(...conditions));
			return true;
		},

		async deleteApiKeyHard(id: string, _secretKey: string): Promise<boolean> {
			const [deleted] = await raw.execute<ResultSetHeader>(
				`DELETE FROM api_keys
				WHERE id = ?
					AND NOT EXISTS (
						SELECT 1 FROM user_budget_reservations
						WHERE api_key_id = api_keys.id
							AND state IN ('reserved', 'dispatched')
					)
					AND NOT EXISTS (
						SELECT 1 FROM guardrail_budget_reservations
						WHERE scope_type = 'api_key'
							AND scope_id = api_keys.id
							AND state IN ('reserved', 'dispatched')
					)
					AND NOT EXISTS (
						SELECT 1 FROM api_key_request_logs
						WHERE api_key_id = api_keys.id
					)`,
				[id]
			);
			return deleted.affectedRows > 0;
		},

		async updateApiKeyStatusById(id: string, status: string): Promise<boolean> {
			const existing = await drizzle
				.select({ id: myApiKeysTable.id })
				.from(myApiKeysTable)
				.where(eq(myApiKeysTable.id, id))
				.limit(1);
			if (!existing[0]) return false;
			const now = new Date().toISOString();
			await drizzle
				.update(myApiKeysTable)
				.set({ status, updatedAt: now })
				.where(eq(myApiKeysTable.id, id));
			return true;
		},

		async setApiKeyMetadataById(
			id: string,
			metadataJson: string | null
		): Promise<boolean> {
			const existing = await drizzle
				.select({ id: myApiKeysTable.id })
				.from(myApiKeysTable)
				.where(eq(myApiKeysTable.id, id))
				.limit(1);
			if (!existing[0]) return false;
			const now = new Date().toISOString();
			await drizzle
				.update(myApiKeysTable)
				.set({ metadata: metadataJson, updatedAt: now })
				.where(eq(myApiKeysTable.id, id));
			return true;
		},

		async scrubLegacyApiKeySecrets(
			limit = 100
		): Promise<{ scrubbed: number; remaining: number }> {
			const batchSize = Math.min(1000, Math.max(1, Math.floor(limit)));
			const rows = await drizzle
				.select({ id: myApiKeysTable.id, key: myApiKeysTable.key })
				.from(myApiKeysTable)
				.where(sql`${myApiKeysTable.key} NOT LIKE 'hashref:sha256:%'`)
				.orderBy(myApiKeysTable.createdAt)
				.limit(batchSize);
			let scrubbed = 0;
			for (const row of rows) {
				const prepared = await prepareGatewayApiKeyForStorage(row.key);
				const existing = await drizzle
					.select({ id: myApiKeysTable.id })
					.from(myApiKeysTable)
					.where(
						and(eq(myApiKeysTable.id, row.id), eq(myApiKeysTable.key, row.key))
					)
					.limit(1);
				if (!existing[0]) continue;
				await drizzle
					.update(myApiKeysTable)
					.set({
						key: prepared.storageKey,
						keyHash: prepared.keyHash,
						keyPreview: prepared.keyPreview,
						updatedAt: new Date().toISOString(),
					})
					.where(
						and(eq(myApiKeysTable.id, row.id), eq(myApiKeysTable.key, row.key))
					);
				scrubbed += 1;
			}
			const remainingRows = await drizzle
				.select({ total: count() })
				.from(myApiKeysTable)
				.where(sql`${myApiKeysTable.key} NOT LIKE 'hashref:sha256:%'`);
			return { scrubbed, remaining: Number(remainingRows[0]?.total ?? 0) };
		},

		async updateApiKeyName(id: string, name: string | null): Promise<boolean> {
			const existing = await drizzle
				.select({ id: myApiKeysTable.id })
				.from(myApiKeysTable)
				.where(eq(myApiKeysTable.id, id))
				.limit(1);
			if (!existing[0]) return false;
			const now = new Date().toISOString();
			await drizzle
				.update(myApiKeysTable)
				.set({ name, updatedAt: now })
				.where(eq(myApiKeysTable.id, id));
			return true;
		},

		async getAllApiKeys(options?: {
			email?: string;
			userId?: string;
			workspaceId?: string;
			maxBudget?: BudgetFilter;
			page?: number;
			pageSize?: number;
			sort?: ApiKeyListSortField;
			order?: ApiKeyListSortOrder;
		}): Promise<{ keys: AdminApiKeyListItem[]; total: number }> {
			const page = options?.page || 1;
			const pageSize = Math.min(options?.pageSize || 20, 100);
			const offset = (page - 1) * pageSize;
			const conditions = [];
			if (options?.email) {
				conditions.push(like(myUsersTable.email, `%${options.email}%`));
			}
			if (options?.userId) {
				conditions.push(eq(myApiKeysTable.userId, options.userId));
			}
			if (options?.workspaceId) {
				conditions.push(eq(myApiKeysTable.workspaceId, options.workspaceId));
			}
			if (options?.maxBudget === "positive") {
				conditions.push(
					and(
						isNotNull(myUsersTable.budgetMax),
						gt(myUsersTable.budgetMax, "0")
					)!
				);
			} else if (options?.maxBudget === "zero_or_negative") {
				conditions.push(
					and(
						isNotNull(myUsersTable.budgetMax),
						lte(myUsersTable.budgetMax, "0")
					)!
				);
			} else if (options?.maxBudget === "null") {
				conditions.push(isNull(myUsersTable.budgetMax));
			}
			const whereExpr = conditions.length > 0 ? and(...conditions) : undefined;

			let countQ = drizzle
				.select({ total: count() })
				.from(myApiKeysTable)
				.innerJoin(myUsersTable, eq(myApiKeysTable.userId, myUsersTable.id));
			if (whereExpr) countQ = countQ.where(whereExpr) as typeof countQ;
			const total = Number((await countQ)[0]?.total ?? 0);

			let listQ = drizzle
				.select({
					id: myApiKeysTable.id,
					key: myApiKeysTable.key,
					key_preview: myApiKeysTable.keyPreview,
					user_id: myApiKeysTable.userId,
					workspace_id: myApiKeysTable.workspaceId,
					name: myApiKeysTable.name,
					user_email: myUsersTable.email,
					budget_max: myUsersTable.budgetMax,
					budget_base: myUsersTable.budgetBase,
					budget_spent: myUsersTable.budgetSpent,
					budget_period: myUsersTable.budgetPeriod,
					budget_reset_at: myUsersTable.budgetResetAt,
					status: myApiKeysTable.status,
					metadata: myApiKeysTable.metadata,
					created_at: myApiKeysTable.createdAt,
					updated_at: myApiKeysTable.updatedAt,
				})
				.from(myApiKeysTable)
				.innerJoin(myUsersTable, eq(myApiKeysTable.userId, myUsersTable.id));
			if (whereExpr) listQ = listQ.where(whereExpr) as typeof listQ;

			const sort = options?.sort ?? DEFAULT_API_KEY_LIST_SORT;
			const order = options?.order ?? DEFAULT_API_KEY_LIST_ORDER;
			const rows = await listQ
				.orderBy(apiKeyListOrderBy(sort, order))
				.limit(pageSize)
				.offset(offset);
			return { keys: rows.map(mapMyAdminListRow), total };
		},

		async getActiveApiKeysCount(): Promise<number> {
			const row = await drizzle
				.select({ c: count() })
				.from(myApiKeysTable)
				.where(eq(myApiKeysTable.status, "active"));
			return Number(row[0]?.c ?? 0);
		},

		async getApiKeysCount() {
			const row = await drizzle
				.select({
					total: count(),
					active: sql<number>`SUM(CASE WHEN ${myApiKeysTable.status} = 'active' THEN 1 ELSE 0 END)`,
				})
				.from(myApiKeysTable);
			return {
				total: Number(row[0]?.total ?? 0),
				active: Number(row[0]?.active ?? 0),
			};
		},
	};
}
