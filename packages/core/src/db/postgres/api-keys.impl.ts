/**
 * Postgres：`api_keys`（预算在 `users`）。
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
import type { PostgresDatabaseClient } from "../../storage/database-client";
import {
	hashLookupKey,
	prepareGatewayApiKeyForStorage,
	resolveGatewayApiKeyPreview,
} from "../../lib/key-hash";
import type { ApiKeysRepository } from "../../storage/gateway-repository-interfaces";
import {
	apiKeysTable as pgApiKeysTable,
	organizationMembershipsTable as pgOrganizationMembershipsTable,
	organizationsTable as pgOrganizationsTable,
	usersTable as pgUsersTable,
	workspaceMembershipsTable as pgWorkspaceMembershipsTable,
	workspacesTable as pgWorkspacesTable,
} from "../../storage/drizzle/schema.pg";
import type {
	BudgetFilter,
	InsertKeyParams,
	ManagementGatewayKeyListParams,
	ManagementGatewayKeyLookupParams,
	ManagementGatewayKeyRow,
} from "../api-keys-types";
import {
	DEFAULT_API_KEY_LIST_ORDER,
	DEFAULT_API_KEY_LIST_SORT,
	type ApiKeyListSortField,
	type ApiKeyListSortOrder,
} from "../api-keys-list-sort";
import type { AdminApiKeyListItem } from "../../storage/repository-dtos";
import { parseMoney } from "../../storage/critical-write-paths-utils";
import { normalizeGatewayKeyLimitReset } from "../../gateway-key-limits";

function apiKeyListOrderBy(
	sort: ApiKeyListSortField,
	order: ApiKeyListSortOrder
) {
	const isAsc = order === "asc";
	if (sort === "budget_reset_at") {
		const col = pgUsersTable.budgetResetAt;
		return isAsc ? sql`${col} ASC NULLS LAST` : sql`${col} DESC NULLS FIRST`;
	}
	if (sort === "budget_spent") {
		return isAsc
			? asc(pgUsersTable.budgetSpent)
			: desc(pgUsersTable.budgetSpent);
	}
	return isAsc ? asc(pgApiKeysTable.createdAt) : desc(pgApiKeysTable.createdAt);
}

function mapPgKeyRow(r: {
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
	includeByokInLimit: boolean;
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
		expires_at: r.expiresAt,
		limit_micros: r.limitMicros === null ? null : Number(r.limitMicros),
		limit_reset: normalizeGatewayKeyLimitReset(r.limitReset),
		include_byok_in_limit: r.includeByokInLimit,
		limit_epoch: Number(r.limitEpoch),
		last_used_at: r.lastUsedAt,
		created_at: r.createdAt,
		updated_at: r.updatedAt,
	};
}

function mapPgResolvedRow(r: {
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
	includeByokInLimit: boolean;
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
	const k = mapPgKeyRow(r);
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

function mapPgAdminListRow(r: {
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

type PgManagementGatewayKeyRow = Omit<
	ManagementGatewayKeyRow,
	"limit_micros" | "include_byok_in_limit" | "limit_epoch" | "usage" | "usage_daily" | "usage_weekly" | "usage_monthly"
> & {
	limit_micros: string | number | null;
	include_byok_in_limit: boolean;
	limit_epoch: string | number;
	usage: string | number;
	usage_daily: string | number;
	usage_weekly: string | number;
	usage_monthly: string | number;
};

function mapPgManagementGatewayKeyRow(
	row: PgManagementGatewayKeyRow
): ManagementGatewayKeyRow {
	return {
		...row,
		limit_micros: row.limit_micros === null ? null : Number(row.limit_micros),
		include_byok_in_limit: row.include_byok_in_limit,
		limit_epoch: Number(row.limit_epoch),
		usage: roundGatewayMoney(Number(row.usage ?? 0)),
		usage_daily: roundGatewayMoney(Number(row.usage_daily ?? 0)),
		usage_weekly: roundGatewayMoney(Number(row.usage_weekly ?? 0)),
		usage_monthly: roundGatewayMoney(Number(row.usage_monthly ?? 0)),
	};
}

function pgManagementAccountPredicate(
	params: ManagementGatewayKeyListParams | ManagementGatewayKeyLookupParams,
	placeholder: number
): { sql: string; value: string } {
	if (
		params.accountType === "personal" &&
		params.personalOwnerUserId &&
		params.organizationId === null
	) {
		return {
			sql: `w.scope_type = 'personal' AND w.personal_owner_user_id = $${placeholder} AND w.organization_id IS NULL`,
			value: params.personalOwnerUserId,
		};
	}
	if (
		params.accountType === "organization" &&
		params.personalOwnerUserId === null &&
		params.organizationId
	) {
		return {
			sql: `w.scope_type = 'organization' AND w.personal_owner_user_id IS NULL AND w.organization_id = $${placeholder}`,
			value: params.organizationId,
		};
	}
	throw new TypeError("management gateway key account scope is invalid");
}

const pgManagementUsageSelect = `
	SELECT k.id, k.key_hash, COALESCE(k.key_preview, 'sk-…') AS key_preview,
		k.user_id, k.workspace_id, k.name, k.status, k.expires_at,
		k.limit_micros, k.limit_reset, k.include_byok_in_limit, k.limit_epoch,
		k.created_at, k.updated_at,
		COALESCE((SELECT SUM(log.charged_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id), 0) AS usage,
		COALESCE((SELECT SUM(log.charged_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.created_at >= date_trunc('day', CURRENT_TIMESTAMP)), 0) AS usage_daily,
		COALESCE((SELECT SUM(log.charged_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.created_at >= date_trunc('week', CURRENT_TIMESTAMP)), 0) AS usage_weekly,
		COALESCE((SELECT SUM(log.charged_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.created_at >= date_trunc('month', CURRENT_TIMESTAMP)), 0) AS usage_monthly
	FROM api_keys k INNER JOIN workspaces w ON w.id = k.workspace_id`;

const resolvedCols = {
	id: pgApiKeysTable.id,
	key: pgApiKeysTable.key,
	keyPreview: pgApiKeysTable.keyPreview,
	userId: pgApiKeysTable.userId,
	workspaceId: pgApiKeysTable.workspaceId,
	name: pgApiKeysTable.name,
	status: pgApiKeysTable.status,
	metadata: pgApiKeysTable.metadata,
	expiresAt: pgApiKeysTable.expiresAt,
	limitMicros: pgApiKeysTable.limitMicros,
	limitReset: pgApiKeysTable.limitReset,
	includeByokInLimit: pgApiKeysTable.includeByokInLimit,
	limitEpoch: pgApiKeysTable.limitEpoch,
	lastUsedAt: pgApiKeysTable.lastUsedAt,
	createdAt: pgApiKeysTable.createdAt,
	updatedAt: pgApiKeysTable.updatedAt,
	userEmail: pgUsersTable.email,
	budgetMax: pgUsersTable.budgetMax,
	budgetBase: pgUsersTable.budgetBase,
	budgetSpent: pgUsersTable.budgetSpent,
	budgetPeriod: pgUsersTable.budgetPeriod,
	budgetResetAt: pgUsersTable.budgetResetAt,
	budgetEpoch: pgUsersTable.budgetEpoch,
	budgetReservedMicros: pgUsersTable.budgetReservedMicros,
	userMetadata: pgUsersTable.metadata,
	userChargedCostFactors: pgUsersTable.chargedCostFactors,
} as const;

const activeWorkspaceFilter = and(
	eq(pgWorkspacesTable.status, "active"),
	or(
		isNull(pgApiKeysTable.expiresAt),
		gt(pgApiKeysTable.expiresAt, sql`CURRENT_TIMESTAMP`)
	),
	or(
		eq(pgWorkspacesTable.scopeType, "personal"),
		inArray(pgOrganizationsTable.status, ["active", "pending"])
	)
);

const activeGatewayAuthorizationFilter = and(
	eq(pgWorkspacesTable.status, "active"),
	or(
		isNull(pgApiKeysTable.expiresAt),
		gt(pgApiKeysTable.expiresAt, sql`CURRENT_TIMESTAMP`)
	),
	or(
		and(
			eq(pgWorkspacesTable.scopeType, "personal"),
			eq(pgWorkspacesTable.personalOwnerUserId, pgApiKeysTable.userId)
		),
		and(
			eq(pgWorkspacesTable.scopeType, "organization"),
			inArray(pgOrganizationsTable.status, ["active", "pending"]),
			eq(pgUsersTable.externalSystem, "cinaauth"),
			isNotNull(pgUsersTable.externalUserId),
			sql<boolean>`EXISTS (
				SELECT 1 FROM ${pgOrganizationMembershipsTable}
				WHERE ${pgOrganizationMembershipsTable.organizationId} = ${pgWorkspacesTable.organizationId}
					AND ${pgOrganizationMembershipsTable.subject} = ${pgUsersTable.externalUserId}
					AND ${pgOrganizationMembershipsTable.status} = 'active'
			)`,
			or(
				eq(pgWorkspacesTable.isDefault, true),
				sql<boolean>`EXISTS (
					SELECT 1 FROM ${pgWorkspaceMembershipsTable}
					WHERE ${pgWorkspaceMembershipsTable.workspaceId} = ${pgWorkspacesTable.id}
						AND ${pgWorkspaceMembershipsTable.subject} = ${pgUsersTable.externalUserId}
						AND ${pgWorkspaceMembershipsTable.status} = 'active'
				)`
			)
		)
	)
);

export function createPostgresApiKeysRepository(
	db: PostgresDatabaseClient
): ApiKeysRepository {
	const drizzle = db.drizzle;
	const raw = db.raw;
	return {
		async getCurrentById(id) {
			const rows = await raw.unsafe<PgManagementGatewayKeyRow[]>(
				`${pgManagementUsageSelect}
				WHERE k.id = $1 AND k.status = 'active' AND w.status = 'active'
					AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP) LIMIT 1`,
				[id]
			);
			return rows[0] ? mapPgManagementGatewayKeyRow(rows[0]) : null;
		},

		async listForManagement(params) {
			const account = pgManagementAccountPredicate(params, 2);
			const statusSql = params.includeDisabled
				? ""
				: " AND k.status = 'active'";
			const rows = await raw.unsafe<PgManagementGatewayKeyRow[]>(
				`${pgManagementUsageSelect}
				WHERE k.workspace_id = $1 AND k.key_hash IS NOT NULL
					AND w.status = 'active' AND ${account.sql}${statusSql}
				ORDER BY k.created_at DESC, k.id DESC LIMIT 100 OFFSET $3`,
				[params.workspaceId, account.value, params.offset]
			);
			return rows.map(mapPgManagementGatewayKeyRow);
		},

		async getByHashForManagement(params) {
			const account = pgManagementAccountPredicate(params, 2);
			const rows = await raw.unsafe<PgManagementGatewayKeyRow[]>(
				`${pgManagementUsageSelect}
				WHERE k.key_hash = $1 AND w.status = 'active' AND ${account.sql} LIMIT 1`,
				[params.keyHash, account.value]
			);
			return rows[0] ? mapPgManagementGatewayKeyRow(rows[0]) : null;
		},

		async updateByHashForManagement(params, patch) {
			const sets: string[] = [];
			const values: unknown[] = [];
			if (patch.name !== undefined) {
				sets.push(`name = $${values.length + 1}`);
				values.push(patch.name);
			}
			if (patch.status !== undefined) {
				sets.push(`status = $${values.length + 1}`);
				values.push(patch.status);
			}
			let limitChanged = false;
			if (patch.limitMicros !== undefined) {
				sets.push(`limit_micros = $${values.length + 1}`);
				values.push(patch.limitMicros);
				limitChanged = true;
			}
			if (patch.limitReset !== undefined) {
				sets.push(`limit_reset = $${values.length + 1}`);
				values.push(patch.limitReset);
				limitChanged = true;
			}
			if (patch.includeByokInLimit !== undefined) {
				sets.push(`include_byok_in_limit = $${values.length + 1}`);
				values.push(patch.includeByokInLimit);
				limitChanged = true;
			}
			if (sets.length === 0) return false;
			if (limitChanged) sets.push("limit_epoch = limit_epoch + 1");
			sets.push("updated_at = CURRENT_TIMESTAMP");
			const hashPlaceholder = values.length + 1;
			values.push(params.keyHash);
			const account = pgManagementAccountPredicate(params, values.length + 1);
			values.push(account.value);
			const rows = await raw.unsafe<{ id: string }[]>(
				`UPDATE api_keys SET ${sets.join(", ")}
				WHERE key_hash = $${hashPlaceholder} AND EXISTS (
					SELECT 1 FROM workspaces w WHERE w.id = api_keys.workspace_id
						AND w.status = 'active' AND ${account.sql}
				) RETURNING id`,
				values as never[]
			);
			return rows.length === 1;
		},

		async deleteByHashForManagement(params) {
			const account = pgManagementAccountPredicate(params, 2);
			const rows = await raw.unsafe<{ id: string }[]>(
				`DELETE FROM api_keys WHERE key_hash = $1
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
					) RETURNING id`,
				[params.keyHash, account.value]
			);
			return rows.length === 1;
		},

		async getApiKeyByKey(key: string): Promise<ApiKeyRow | null> {
			const keyHash = await hashLookupKey(key);
			const byHash = await drizzle
				.select()
				.from(pgApiKeysTable)
				.innerJoin(
					pgWorkspacesTable,
					eq(pgApiKeysTable.workspaceId, pgWorkspacesTable.id)
				)
				.leftJoin(
					pgOrganizationsTable,
					eq(pgWorkspacesTable.organizationId, pgOrganizationsTable.id)
				)
				.where(
					and(
						eq(pgApiKeysTable.keyHash, keyHash),
						eq(pgApiKeysTable.status, "active"),
						activeWorkspaceFilter
					)
				)
				.limit(1);
			if (byHash[0]) return mapPgKeyRow(byHash[0].api_keys);
			const legacy = await drizzle
				.select()
				.from(pgApiKeysTable)
				.innerJoin(
					pgWorkspacesTable,
					eq(pgApiKeysTable.workspaceId, pgWorkspacesTable.id)
				)
				.leftJoin(
					pgOrganizationsTable,
					eq(pgWorkspacesTable.organizationId, pgOrganizationsTable.id)
				)
				.where(
					and(
						eq(pgApiKeysTable.key, key),
						eq(pgApiKeysTable.status, "active"),
						activeWorkspaceFilter
					)
				)
				.limit(1);
			if (!legacy[0]) return null;
			const legacyKey = legacy[0].api_keys;
			const prepared = await prepareGatewayApiKeyForStorage(key);
			await drizzle
				.update(pgApiKeysTable)
				.set({
					key: prepared.storageKey,
					keyHash: prepared.keyHash,
					keyPreview: prepared.keyPreview,
				})
				.where(
					and(eq(pgApiKeysTable.id, legacyKey.id), eq(pgApiKeysTable.key, key))
				);
			return mapPgKeyRow({
				...legacyKey,
				key: prepared.storageKey,
				keyPreview: prepared.keyPreview,
			});
		},

		async getApiKeyByKeyAnyStatus(key: string): Promise<ApiKeyRow | null> {
			const keyHash = await hashLookupKey(key);
			const byHash = await drizzle
				.select()
				.from(pgApiKeysTable)
				.where(eq(pgApiKeysTable.keyHash, keyHash))
				.limit(1);
			if (byHash[0]) return mapPgKeyRow(byHash[0]);
			const legacy = await drizzle
				.select()
				.from(pgApiKeysTable)
				.where(eq(pgApiKeysTable.key, key))
				.limit(1);
			if (!legacy[0]) return null;
			const prepared = await prepareGatewayApiKeyForStorage(key);
			await drizzle
				.update(pgApiKeysTable)
				.set({
					key: prepared.storageKey,
					keyHash: prepared.keyHash,
					keyPreview: prepared.keyPreview,
				})
				.where(
					and(eq(pgApiKeysTable.id, legacy[0].id), eq(pgApiKeysTable.key, key))
				);
			return mapPgKeyRow({
				...legacy[0],
				key: prepared.storageKey,
				keyPreview: prepared.keyPreview,
			});
		},

		async getApiKeyById(id: string): Promise<ApiKeyRow | null> {
			const rows = await drizzle
				.select()
				.from(pgApiKeysTable)
				.where(eq(pgApiKeysTable.id, id))
				.limit(1);
			return rows[0] ? mapPgKeyRow(rows[0]) : null;
		},

		async getApiKeyWithUserByKey(
			key: string
		): Promise<ResolvedGatewayKeyRow | null> {
			// 审计 M2-3：哈希优先查找；miss 回退明文（迁移窗口），命中即惰性回填。
			const keyHash = await hashLookupKey(key);
			const byHash = await drizzle
				.select(resolvedCols)
				.from(pgApiKeysTable)
				.innerJoin(pgUsersTable, eq(pgApiKeysTable.userId, pgUsersTable.id))
				.innerJoin(
					pgWorkspacesTable,
					eq(pgApiKeysTable.workspaceId, pgWorkspacesTable.id)
				)
				.leftJoin(
					pgOrganizationsTable,
					eq(pgWorkspacesTable.organizationId, pgOrganizationsTable.id)
				)
				.where(
					and(
						eq(pgApiKeysTable.keyHash, keyHash),
						eq(pgApiKeysTable.status, "active"),
						eq(pgUsersTable.status, "active"),
						activeGatewayAuthorizationFilter
					)
				)
				.limit(1);
			if (byHash[0]) return mapPgResolvedRow(byHash[0]);
			const rows = await drizzle
				.select(resolvedCols)
				.from(pgApiKeysTable)
				.innerJoin(pgUsersTable, eq(pgApiKeysTable.userId, pgUsersTable.id))
				.innerJoin(
					pgWorkspacesTable,
					eq(pgApiKeysTable.workspaceId, pgWorkspacesTable.id)
				)
				.leftJoin(
					pgOrganizationsTable,
					eq(pgWorkspacesTable.organizationId, pgOrganizationsTable.id)
				)
				.where(
					and(
						eq(pgApiKeysTable.key, key),
						eq(pgApiKeysTable.status, "active"),
						eq(pgUsersTable.status, "active"),
						activeGatewayAuthorizationFilter
					)
				)
				.limit(1);
			if (rows[0]) {
				const prepared = await prepareGatewayApiKeyForStorage(key);
				await drizzle
					.update(pgApiKeysTable)
					.set({
						key: prepared.storageKey,
						keyHash: prepared.keyHash,
						keyPreview: prepared.keyPreview,
					})
					.where(
						and(eq(pgApiKeysTable.id, rows[0].id), eq(pgApiKeysTable.key, key))
					);
				return mapPgResolvedRow({
					...rows[0],
					key: prepared.storageKey,
					keyPreview: prepared.keyPreview,
				});
			}
			return null;
		},

		async getApiKeyWithUserById(
			id: string
		): Promise<ResolvedGatewayKeyRow | null> {
			const rows = await drizzle
				.select(resolvedCols)
				.from(pgApiKeysTable)
				.innerJoin(pgUsersTable, eq(pgApiKeysTable.userId, pgUsersTable.id))
				.where(eq(pgApiKeysTable.id, id))
				.limit(1);
			return rows[0] ? mapPgResolvedRow(rows[0]) : null;
		},

		async listKeysByUserId(
			userId: string,
			options?: { status?: string }
		): Promise<ApiKeyRow[]> {
			const where = options?.status
				? and(
						eq(pgApiKeysTable.userId, userId),
						eq(pgApiKeysTable.status, options.status)
				  )
				: eq(pgApiKeysTable.userId, userId);
			const rows = await drizzle
				.select()
				.from(pgApiKeysTable)
				.where(where)
				.orderBy(pgApiKeysTable.createdAt);
			return rows.map(mapPgKeyRow);
		},

		async listKeysByWorkspaceId(
			workspaceId: string,
			options?: { status?: string; creatorUserId?: string }
		): Promise<ApiKeyRow[]> {
			const conditions = [eq(pgApiKeysTable.workspaceId, workspaceId)];
			if (options?.creatorUserId)
				conditions.push(eq(pgApiKeysTable.userId, options.creatorUserId));
			if (options?.status)
				conditions.push(eq(pgApiKeysTable.status, options.status));
			const rows = await drizzle
				.select()
				.from(pgApiKeysTable)
				.where(and(...conditions))
				.orderBy(pgApiKeysTable.createdAt);
			return rows.map(mapPgKeyRow);
		},

		async getApiKeyByIdInWorkspace(
			id: string,
			workspaceId: string
		): Promise<ApiKeyRow | null> {
			const rows = await drizzle
				.select()
				.from(pgApiKeysTable)
				.where(
					and(
						eq(pgApiKeysTable.id, id),
						eq(pgApiKeysTable.workspaceId, workspaceId)
					)
				)
				.limit(1);
			return rows[0] ? mapPgKeyRow(rows[0]) : null;
		},

		async insertApiKey(params: InsertKeyParams): Promise<void> {
			const now = new Date().toISOString();
			const status = params.status ?? "active";
			const prepared = await prepareGatewayApiKeyForStorage(params.key);
			await drizzle.insert(pgApiKeysTable).values({
				id: params.id,
				key: prepared.storageKey,
				keyHash: prepared.keyHash,
				keyPreview: prepared.keyPreview,
				userId: params.userId,
				workspaceId: params.workspaceId,
				name: params.name ?? null,
				status,
				metadata: params.metadata ?? null,
				expiresAt: params.expiresAt ?? null,
				limitMicros: params.limitMicros ?? null,
				limitReset: params.limitReset ?? null,
				includeByokInLimit: params.includeByokInLimit ?? false,
				limitEpoch: 0,
				lastUsedAt: null,
				createdAt: now,
				updatedAt: now,
			});
		},

		async revokeApiKey(id: string): Promise<boolean> {
			const now = new Date().toISOString();
			const updated = await drizzle
				.update(pgApiKeysTable)
				.set({ status: "revoked", updatedAt: now })
				.where(eq(pgApiKeysTable.id, id))
				.returning({ id: pgApiKeysTable.id });
			return updated.length > 0;
		},

		async revokeApiKeyInWorkspace(
			id: string,
			workspaceId: string,
			creatorUserId?: string
		): Promise<boolean> {
			const conditions = [
				eq(pgApiKeysTable.id, id),
				eq(pgApiKeysTable.workspaceId, workspaceId),
			];
			if (creatorUserId)
				conditions.push(eq(pgApiKeysTable.userId, creatorUserId));
			const updated = await drizzle
				.update(pgApiKeysTable)
				.set({ status: "revoked", updatedAt: new Date().toISOString() })
				.where(and(...conditions))
				.returning({ id: pgApiKeysTable.id });
			return updated.length > 0;
		},

		async deleteApiKeyHard(id: string, _secretKey: string): Promise<boolean> {
			const deleted = await raw.unsafe<Array<{ id: string }>>(
				`DELETE FROM api_keys
				WHERE id = $1
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
					)
				RETURNING id`,
				[id]
			);
			return deleted.length > 0;
		},

		async updateApiKeyStatusById(id: string, status: string): Promise<boolean> {
			const now = new Date().toISOString();
			const updated = await drizzle
				.update(pgApiKeysTable)
				.set({ status, updatedAt: now })
				.where(eq(pgApiKeysTable.id, id))
				.returning({ id: pgApiKeysTable.id });
			return updated.length > 0;
		},

		async setApiKeyMetadataById(
			id: string,
			metadataJson: string | null
		): Promise<boolean> {
			const now = new Date().toISOString();
			const updated = await drizzle
				.update(pgApiKeysTable)
				.set({ metadata: metadataJson, updatedAt: now })
				.where(eq(pgApiKeysTable.id, id))
				.returning({ id: pgApiKeysTable.id });
			return updated.length > 0;
		},

		async scrubLegacyApiKeySecrets(
			limit = 100
		): Promise<{ scrubbed: number; remaining: number }> {
			const batchSize = Math.min(1000, Math.max(1, Math.floor(limit)));
			const rows = await drizzle
				.select({ id: pgApiKeysTable.id, key: pgApiKeysTable.key })
				.from(pgApiKeysTable)
				.where(sql`${pgApiKeysTable.key} NOT LIKE 'hashref:sha256:%'`)
				.orderBy(pgApiKeysTable.createdAt)
				.limit(batchSize);
			let scrubbed = 0;
			for (const row of rows) {
				const prepared = await prepareGatewayApiKeyForStorage(row.key);
				const updated = await drizzle
					.update(pgApiKeysTable)
					.set({
						key: prepared.storageKey,
						keyHash: prepared.keyHash,
						keyPreview: prepared.keyPreview,
						updatedAt: new Date().toISOString(),
					})
					.where(
						and(eq(pgApiKeysTable.id, row.id), eq(pgApiKeysTable.key, row.key))
					)
					.returning({ id: pgApiKeysTable.id });
				scrubbed += updated.length;
			}
			const remainingRows = await drizzle
				.select({ total: count() })
				.from(pgApiKeysTable)
				.where(sql`${pgApiKeysTable.key} NOT LIKE 'hashref:sha256:%'`);
			return { scrubbed, remaining: Number(remainingRows[0]?.total ?? 0) };
		},

		async updateApiKeyName(id: string, name: string | null): Promise<boolean> {
			const now = new Date().toISOString();
			const updated = await drizzle
				.update(pgApiKeysTable)
				.set({ name, updatedAt: now })
				.where(eq(pgApiKeysTable.id, id))
				.returning({ id: pgApiKeysTable.id });
			return updated.length > 0;
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
				conditions.push(like(pgUsersTable.email, `%${options.email}%`));
			}
			if (options?.userId) {
				conditions.push(eq(pgApiKeysTable.userId, options.userId));
			}
			if (options?.workspaceId) {
				conditions.push(eq(pgApiKeysTable.workspaceId, options.workspaceId));
			}
			if (options?.maxBudget === "positive") {
				conditions.push(
					and(
						isNotNull(pgUsersTable.budgetMax),
						gt(pgUsersTable.budgetMax, "0")
					)!
				);
			} else if (options?.maxBudget === "zero_or_negative") {
				conditions.push(
					and(
						isNotNull(pgUsersTable.budgetMax),
						lte(pgUsersTable.budgetMax, "0")
					)!
				);
			} else if (options?.maxBudget === "null") {
				conditions.push(isNull(pgUsersTable.budgetMax));
			}
			const whereExpr = conditions.length > 0 ? and(...conditions) : undefined;

			let countQ = drizzle
				.select({ total: count() })
				.from(pgApiKeysTable)
				.innerJoin(pgUsersTable, eq(pgApiKeysTable.userId, pgUsersTable.id));
			if (whereExpr) countQ = countQ.where(whereExpr) as typeof countQ;
			const total = Number((await countQ)[0]?.total ?? 0);

			let listQ = drizzle
				.select({
					id: pgApiKeysTable.id,
					key: pgApiKeysTable.key,
					key_preview: pgApiKeysTable.keyPreview,
					user_id: pgApiKeysTable.userId,
					workspace_id: pgApiKeysTable.workspaceId,
					name: pgApiKeysTable.name,
					user_email: pgUsersTable.email,
					budget_max: pgUsersTable.budgetMax,
					budget_base: pgUsersTable.budgetBase,
					budget_spent: pgUsersTable.budgetSpent,
					budget_period: pgUsersTable.budgetPeriod,
					budget_reset_at: pgUsersTable.budgetResetAt,
					status: pgApiKeysTable.status,
					metadata: pgApiKeysTable.metadata,
					created_at: pgApiKeysTable.createdAt,
					updated_at: pgApiKeysTable.updatedAt,
				})
				.from(pgApiKeysTable)
				.innerJoin(pgUsersTable, eq(pgApiKeysTable.userId, pgUsersTable.id));
			if (whereExpr) listQ = listQ.where(whereExpr) as typeof listQ;

			const sort = options?.sort ?? DEFAULT_API_KEY_LIST_SORT;
			const order = options?.order ?? DEFAULT_API_KEY_LIST_ORDER;
			const rows = await listQ
				.orderBy(apiKeyListOrderBy(sort, order))
				.limit(pageSize)
				.offset(offset);
			return { keys: rows.map(mapPgAdminListRow), total };
		},

		async getActiveApiKeysCount(): Promise<number> {
			const row = await drizzle
				.select({ c: count() })
				.from(pgApiKeysTable)
				.where(eq(pgApiKeysTable.status, "active"));
			return Number(row[0]?.c ?? 0);
		},

		async getApiKeysCount() {
			const row = await drizzle
				.select({
					total: count(),
					active: sql<number>`SUM(CASE WHEN ${pgApiKeysTable.status} = 'active' THEN 1 ELSE 0 END)`,
				})
				.from(pgApiKeysTable);
			return {
				total: Number(row[0]?.total ?? 0),
				active: Number(row[0]?.active ?? 0),
			};
		},
	};
}
