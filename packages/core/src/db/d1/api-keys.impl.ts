/**
 * D1：`api_keys` 表实现（预算在 `users`）。
 */
import type {
	D1Database,
	D1PreparedStatement,
} from "@cloudflare/workers-types";
import type { ApiKeyRow, ResolvedGatewayKeyRow } from "../../types";
import { roundGatewayMoney } from "../../lib/money-precision";
import {
	hashLookupKey,
	prepareGatewayApiKeyForStorage,
	resolveGatewayApiKeyPreview,
} from "../../lib/key-hash";
import type { D1DatabaseClient } from "../../storage/database-client";
import type { ApiKeysRepository } from "../../storage/gateway-repository-interfaces";
import type { ApiKeysD1Statements } from "./d1-repository-extras";
import type {
	BudgetFilter,
	InsertKeyParams,
	ManagementGatewayKeyListParams,
	ManagementGatewayKeyLookupParams,
	ManagementGatewayKeyRow,
} from "../api-keys-types";
import {
	buildD1ApiKeyListOrderByClause,
	DEFAULT_API_KEY_LIST_ORDER,
	DEFAULT_API_KEY_LIST_SORT,
	type ApiKeyListSortField,
	type ApiKeyListSortOrder,
} from "../api-keys-list-sort";
import type { AdminApiKeyListItem } from "../../storage/repository-dtos";

type KeySqlRow = {
	id: string;
	key: string;
	key_preview: string | null;
	user_id: string;
	workspace_id: string;
	name: string | null;
	status: string;
	metadata: string | null;
	expires_at: string | null;
	limit_micros: number | null;
	limit_reset: "daily" | "weekly" | "monthly" | null;
	include_byok_in_limit: number;
	limit_epoch: number;
	last_used_at: string | null;
	created_at: string;
	updated_at: string;
};

function mapKeyRow(r: KeySqlRow): ApiKeyRow {
	return {
		id: r.id,
		key: resolveGatewayApiKeyPreview(r.key, r.key_preview),
		user_id: r.user_id,
		workspace_id: r.workspace_id,
		name: r.name,
		status: r.status,
		metadata: r.metadata,
		expires_at: r.expires_at,
		limit_micros: r.limit_micros === null ? null : Number(r.limit_micros),
		limit_reset: r.limit_reset,
		include_byok_in_limit: r.include_byok_in_limit === 1,
		limit_epoch: Number(r.limit_epoch),
		last_used_at: r.last_used_at,
		created_at: r.created_at,
		updated_at: r.updated_at,
	};
}

type ResolvedSqlRow = KeySqlRow & {
	user_email: string | null;
	user_metadata: string | null;
	user_charged_cost_factors: string | null;
	budget_max: number | null;
	budget_base: number;
	budget_spent: number;
	budget_period: string;
	budget_reset_at: string | null;
	budget_epoch: number;
	budget_reserved_micros: number;
};

function mapResolvedRow(r: ResolvedSqlRow): ResolvedGatewayKeyRow {
	const base = mapKeyRow(r);
	return {
		...base,
		user_email: r.user_email,
		user_metadata: r.user_metadata,
		user_charged_cost_factors: r.user_charged_cost_factors ?? null,
		budget_max:
			r.budget_max == null ? null : roundGatewayMoney(Number(r.budget_max)),
		budget_base: roundGatewayMoney(Number(r.budget_base ?? 0)),
		budget_spent: roundGatewayMoney(Number(r.budget_spent)),
		budget_period: r.budget_period,
		budget_reset_at: r.budget_reset_at,
		budget_epoch: Number(r.budget_epoch),
		budget_reserved_micros: Number(r.budget_reserved_micros),
	};
}

type ManagementGatewayKeySqlRow = Omit<
	ManagementGatewayKeyRow,
	"limit_micros" | "include_byok_in_limit" | "limit_epoch" | "usage" | "usage_daily" | "usage_weekly" | "usage_monthly"
> & {
	limit_micros: number | string | null;
	include_byok_in_limit: number;
	limit_epoch: number | string;
	usage: number | string;
	usage_daily: number | string;
	usage_weekly: number | string;
	usage_monthly: number | string;
};

function mapManagementGatewayKeyRow(
	row: ManagementGatewayKeySqlRow
): ManagementGatewayKeyRow {
	return {
		...row,
		limit_micros: row.limit_micros === null ? null : Number(row.limit_micros),
		include_byok_in_limit: row.include_byok_in_limit === 1,
		limit_epoch: Number(row.limit_epoch),
		usage: roundGatewayMoney(Number(row.usage ?? 0)),
		usage_daily: roundGatewayMoney(Number(row.usage_daily ?? 0)),
		usage_weekly: roundGatewayMoney(Number(row.usage_weekly ?? 0)),
		usage_monthly: roundGatewayMoney(Number(row.usage_monthly ?? 0)),
	};
}

function managementAccountPredicate(
	params: ManagementGatewayKeyListParams | ManagementGatewayKeyLookupParams
): { sql: string; values: string[] } {
	if (
		params.accountType === "personal" &&
		params.personalOwnerUserId &&
		params.organizationId === null
	) {
		return {
			sql: "w.scope_type = 'personal' AND w.personal_owner_user_id = ? AND w.organization_id IS NULL",
			values: [params.personalOwnerUserId],
		};
	}
	if (
		params.accountType === "organization" &&
		params.personalOwnerUserId === null &&
		params.organizationId
	) {
		return {
			sql: "w.scope_type = 'organization' AND w.personal_owner_user_id IS NULL AND w.organization_id = ?",
			values: [params.organizationId],
		};
	}
	throw new TypeError("management gateway key account scope is invalid");
}

const managementUsageSelect = `
	SELECT k.id, k.key_hash, COALESCE(k.key_preview, 'sk-…') AS key_preview,
		k.user_id, k.workspace_id, k.name, k.status, k.expires_at,
		k.limit_micros, k.limit_reset, k.include_byok_in_limit, k.limit_epoch,
		k.created_at, k.updated_at,
		COALESCE((SELECT SUM(log.charged_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id), 0) AS usage,
		COALESCE((SELECT SUM(log.charged_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.created_at >= datetime('now', 'start of day')), 0) AS usage_daily,
		COALESCE((SELECT SUM(log.charged_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.created_at >= datetime('now', 'start of day', '-' || ((CAST(strftime('%w', 'now') AS INTEGER) + 6) % 7) || ' days')), 0) AS usage_weekly,
		COALESCE((SELECT SUM(log.charged_cost) FROM api_key_request_logs log
			WHERE log.api_key_id = k.id AND log.created_at >= datetime('now', 'start of month')), 0) AS usage_monthly
	FROM api_keys k INNER JOIN workspaces w ON w.id = k.workspace_id`;

export async function buildInsertApiKeyStatement(
	db: D1Database,
	params: InsertKeyParams
): Promise<D1PreparedStatement> {
	const status = params.status ?? "active";
	// 审计 M2-3：新写入同步落哈希（认证路径哈希优先）。
	const prepared = await prepareGatewayApiKeyForStorage(params.key);
	return db
		.prepare(
			`INSERT INTO api_keys (id, key, key_hash, key_preview, user_id, workspace_id, name, status, metadata, expires_at,
				limit_micros, limit_reset, include_byok_in_limit, limit_epoch, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
		)
		.bind(
			params.id,
			prepared.storageKey,
			prepared.keyHash,
			prepared.keyPreview,
			params.userId,
			params.workspaceId,
			params.name ?? null,
			status,
			params.metadata ?? null,
			params.expiresAt ?? null,
			params.limitMicros ?? null,
			params.limitReset ?? null,
			params.includeByokInLimit ? 1 : 0
		);
}

export function createD1ApiKeysRepository(
	db: D1DatabaseClient
): ApiKeysRepository & ApiKeysD1Statements {
	const raw = db.raw;
	const resolvedSelect = `SELECT k.id, k.key, k.key_preview, k.user_id, k.workspace_id, k.name, k.status, k.metadata, k.expires_at,
		k.limit_micros, k.limit_reset, k.include_byok_in_limit, k.limit_epoch,
		k.last_used_at, k.created_at, k.updated_at,
		u.email AS user_email, u.metadata AS user_metadata, u.charged_cost_factors AS user_charged_cost_factors, u.budget_max, u.budget_base, u.budget_spent, u.budget_period, u.budget_reset_at, u.budget_epoch, u.budget_reserved_micros
		FROM api_keys k
		INNER JOIN users u ON u.id = k.user_id
		INNER JOIN workspaces w ON w.id = k.workspace_id
		LEFT JOIN organizations o ON o.id = w.organization_id`;
	const activeWorkspacePredicate = `w.status = 'active'
		AND (k.expires_at IS NULL OR k.expires_at > datetime('now'))
		AND (w.scope_type = 'personal' OR o.status IN ('active', 'pending'))`;
	const activeGatewayAuthorizationPredicate = `w.status = 'active'
		AND (k.expires_at IS NULL OR k.expires_at > datetime('now'))
		AND (
			(w.scope_type = 'personal' AND w.personal_owner_user_id = k.user_id)
			OR (
				w.scope_type = 'organization'
				AND o.status IN ('active', 'pending')
				AND u.external_system = 'cinaauth'
				AND u.external_user_id IS NOT NULL
				AND EXISTS (
					SELECT 1 FROM organization_memberships om
					WHERE om.organization_id = w.organization_id
						AND om.subject = u.external_user_id
						AND om.status = 'active'
				)
				AND (
					w.is_default = 1
					OR EXISTS (
						SELECT 1 FROM workspace_memberships wm
						WHERE wm.workspace_id = w.id
							AND wm.subject = u.external_user_id
							AND wm.status = 'active'
					)
				)
			)
		)`;

	return {
		buildInsertApiKeyStatement,

		async getCurrentById(id) {
			const row = await raw
				.prepare(
					`${managementUsageSelect}
					WHERE k.id = ? AND k.status = 'active' AND w.status = 'active'
						AND (k.expires_at IS NULL OR k.expires_at > datetime('now')) LIMIT 1`
				)
				.bind(id)
				.first<ManagementGatewayKeySqlRow>();
			return row ? mapManagementGatewayKeyRow(row) : null;
		},

		async listForManagement(params) {
			const account = managementAccountPredicate(params);
			const statusSql = params.includeDisabled
				? ""
				: " AND k.status = 'active'";
			const rows = await raw
				.prepare(
					`${managementUsageSelect}
					WHERE k.workspace_id = ? AND k.key_hash IS NOT NULL
						AND w.status = 'active' AND ${account.sql}${statusSql}
					ORDER BY k.created_at DESC, k.id DESC LIMIT 100 OFFSET ?`
				)
				.bind(params.workspaceId, ...account.values, params.offset)
				.all<ManagementGatewayKeySqlRow>();
			return (rows.results ?? []).map(mapManagementGatewayKeyRow);
		},

		async getByHashForManagement(params) {
			const account = managementAccountPredicate(params);
			const row = await raw
				.prepare(
					`${managementUsageSelect}
					WHERE k.key_hash = ? AND w.status = 'active' AND ${account.sql} LIMIT 1`
				)
				.bind(params.keyHash, ...account.values)
				.first<ManagementGatewayKeySqlRow>();
			return row ? mapManagementGatewayKeyRow(row) : null;
		},

		async updateByHashForManagement(params, patch) {
			const account = managementAccountPredicate(params);
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
			sets.push("updated_at = datetime('now')");
			const result = await raw
				.prepare(
					`UPDATE api_keys SET ${sets.join(", ")}
					WHERE key_hash = ? AND EXISTS (
						SELECT 1 FROM workspaces w WHERE w.id = api_keys.workspace_id
							AND w.status = 'active' AND ${account.sql}
					)`
				)
				.bind(...values, params.keyHash, ...account.values)
				.run();
			return (result.meta.changes ?? 0) === 1;
		},

		async deleteByHashForManagement(params) {
			const account = managementAccountPredicate(params);
			const result = await raw
				.prepare(
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
					)`
				)
				.bind(params.keyHash, ...account.values)
				.run();
			return (result.meta.changes ?? 0) === 1;
		},

		async getApiKeyByKey(key: string): Promise<ApiKeyRow | null> {
			const keyHash = await hashLookupKey(key);
			const byHash = await raw
				.prepare(
					`SELECT k.* FROM api_keys k INNER JOIN workspaces w ON w.id = k.workspace_id
					LEFT JOIN organizations o ON o.id = w.organization_id
					WHERE k.key_hash = ? AND k.status = ? AND ${activeWorkspacePredicate}`
				)
				.bind(keyHash, "active")
				.first<KeySqlRow>();
			if (byHash) return mapKeyRow(byHash);
			const legacy = await raw
				.prepare(
					`SELECT k.* FROM api_keys k INNER JOIN workspaces w ON w.id = k.workspace_id
					LEFT JOIN organizations o ON o.id = w.organization_id
					WHERE k.key = ? AND k.status = ? AND ${activeWorkspacePredicate}`
				)
				.bind(key, "active")
				.first<KeySqlRow>();
			if (!legacy) return null;
			const prepared = await prepareGatewayApiKeyForStorage(key);
			await raw
				.prepare(
					"UPDATE api_keys SET key = ?, key_hash = ?, key_preview = ? WHERE id = ? AND key = ?"
				)
				.bind(
					prepared.storageKey,
					prepared.keyHash,
					prepared.keyPreview,
					legacy.id,
					key
				)
				.run();
			return mapKeyRow({
				...legacy,
				key: prepared.storageKey,
				key_preview: prepared.keyPreview,
			});
		},

		async getApiKeyByKeyAnyStatus(key: string): Promise<ApiKeyRow | null> {
			const keyHash = await hashLookupKey(key);
			const byHash = await raw
				.prepare("SELECT * FROM api_keys WHERE key_hash = ?")
				.bind(keyHash)
				.first<KeySqlRow>();
			if (byHash) return mapKeyRow(byHash);
			const legacy = await raw
				.prepare("SELECT * FROM api_keys WHERE key = ?")
				.bind(key)
				.first<KeySqlRow>();
			if (!legacy) return null;
			const prepared = await prepareGatewayApiKeyForStorage(key);
			await raw
				.prepare(
					"UPDATE api_keys SET key = ?, key_hash = ?, key_preview = ? WHERE id = ? AND key = ?"
				)
				.bind(
					prepared.storageKey,
					prepared.keyHash,
					prepared.keyPreview,
					legacy.id,
					key
				)
				.run();
			return mapKeyRow({
				...legacy,
				key: prepared.storageKey,
				key_preview: prepared.keyPreview,
			});
		},

		async getApiKeyById(id: string): Promise<ApiKeyRow | null> {
			const row = await raw
				.prepare("SELECT * FROM api_keys WHERE id = ?")
				.bind(id)
				.first<KeySqlRow>();
			return row ? mapKeyRow(row) : null;
		},

		async getApiKeyWithUserByKey(
			key: string
		): Promise<ResolvedGatewayKeyRow | null> {
			// 哈希优先查找；miss 回退明文（迁移窗口）。密钥和用户
			// 必须同时 active，且创建者在目标 workspace 仍有 CinaAuth 访问权。
			const keyHash = await hashLookupKey(key);
			const byHash = await raw
				.prepare(
					`${resolvedSelect} WHERE k.key_hash = ? AND k.status = ? AND u.status = ? AND ${activeGatewayAuthorizationPredicate}`
				)
				.bind(keyHash, "active", "active")
				.first<ResolvedSqlRow>();
			if (byHash) return mapResolvedRow(byHash);
			const row = await raw
				.prepare(
					`${resolvedSelect} WHERE k.key = ? AND k.status = ? AND u.status = ? AND ${activeGatewayAuthorizationPredicate}`
				)
				.bind(key, "active", "active")
				.first<ResolvedSqlRow>();
			if (!row) return null;
			const prepared = await prepareGatewayApiKeyForStorage(key);
			await raw
				.prepare(
					"UPDATE api_keys SET key = ?, key_hash = ?, key_preview = ? WHERE id = ? AND key = ?"
				)
				.bind(
					prepared.storageKey,
					prepared.keyHash,
					prepared.keyPreview,
					row.id,
					key
				)
				.run();
			return mapResolvedRow({
				...row,
				key: prepared.storageKey,
				key_preview: prepared.keyPreview,
			});
		},

		async getApiKeyWithUserById(
			id: string
		): Promise<ResolvedGatewayKeyRow | null> {
			const row = await raw
				.prepare(`${resolvedSelect} WHERE k.id = ?`)
				.bind(id)
				.first<ResolvedSqlRow>();
			return row ? mapResolvedRow(row) : null;
		},

		async listKeysByUserId(
			userId: string,
			options?: { status?: string }
		): Promise<ApiKeyRow[]> {
			if (options?.status) {
				const rows = await raw
					.prepare(
						"SELECT * FROM api_keys WHERE user_id = ? AND status = ? ORDER BY created_at ASC"
					)
					.bind(userId, options.status)
					.all<KeySqlRow>();
				return (rows.results ?? []).map(mapKeyRow);
			}
			const rows = await raw
				.prepare(
					"SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at ASC"
				)
				.bind(userId)
				.all<KeySqlRow>();
			return (rows.results ?? []).map(mapKeyRow);
		},

		async listKeysByWorkspaceId(
			workspaceId: string,
			options?: { status?: string; creatorUserId?: string }
		): Promise<ApiKeyRow[]> {
			const conditions = ["workspace_id = ?"];
			const values: unknown[] = [workspaceId];
			if (options?.creatorUserId) {
				conditions.push("user_id = ?");
				values.push(options.creatorUserId);
			}
			if (options?.status) {
				conditions.push("status = ?");
				values.push(options.status);
			}
			const rows = await raw
				.prepare(
					`SELECT * FROM api_keys WHERE ${conditions.join(
						" AND "
					)} ORDER BY created_at ASC`
				)
				.bind(...values)
				.all<KeySqlRow>();
			return (rows.results ?? []).map(mapKeyRow);
		},

		async getApiKeyByIdInWorkspace(
			id: string,
			workspaceId: string
		): Promise<ApiKeyRow | null> {
			const row = await raw
				.prepare("SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?")
				.bind(id, workspaceId)
				.first<KeySqlRow>();
			return row ? mapKeyRow(row) : null;
		},

		async insertApiKey(params: InsertKeyParams): Promise<void> {
			await (await buildInsertApiKeyStatement(raw, params)).run();
		},

		async revokeApiKey(id: string): Promise<boolean> {
			const result = await raw
				.prepare(
					'UPDATE api_keys SET status = ?, updated_at = datetime("now") WHERE id = ?'
				)
				.bind("revoked", id)
				.run();
			return result.meta.changes > 0;
		},

		async revokeApiKeyInWorkspace(
			id: string,
			workspaceId: string,
			creatorUserId?: string
		): Promise<boolean> {
			const result = creatorUserId
				? await raw
						.prepare(
							`UPDATE api_keys SET status = ?, updated_at = datetime('now')
					WHERE id = ? AND workspace_id = ? AND user_id = ?`
						)
						.bind("revoked", id, workspaceId, creatorUserId)
						.run()
				: await raw
						.prepare(
							`UPDATE api_keys SET status = ?, updated_at = datetime('now')
					WHERE id = ? AND workspace_id = ?`
						)
						.bind("revoked", id, workspaceId)
						.run();
			return result.meta.changes > 0;
		},

		async deleteApiKeyHard(id: string, _secretKey: string): Promise<boolean> {
			// A dispatched request still needs the key row when the request-log critical
			// write settles its reservation. Historical logs also need the immutable key
			// row for Workspace attribution until request logs carry their own snapshot.
			// Keep every guard in the same D1 statement to avoid detached-read races.
			const result = await raw
				.prepare(
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
					)`
				)
				.bind(id)
				.run();
			return (result.meta.changes ?? 0) > 0;
		},

		async updateApiKeyStatusById(id: string, status: string): Promise<boolean> {
			const result = await raw
				.prepare(
					'UPDATE api_keys SET status = ?, updated_at = datetime("now") WHERE id = ?'
				)
				.bind(status, id)
				.run();
			return result.meta.changes > 0;
		},

		async setApiKeyMetadataById(
			id: string,
			metadataJson: string | null
		): Promise<boolean> {
			const result = await raw
				.prepare(
					'UPDATE api_keys SET metadata = ?, updated_at = datetime("now") WHERE id = ?'
				)
				.bind(metadataJson, id)
				.run();
			return result.meta.changes > 0;
		},

		async scrubLegacyApiKeySecrets(
			limit = 100
		): Promise<{ scrubbed: number; remaining: number }> {
			const batchSize = Math.min(1000, Math.max(1, Math.floor(limit)));
			const rows = await raw
				.prepare(
					"SELECT id, key FROM api_keys WHERE key NOT LIKE 'hashref:sha256:%' ORDER BY created_at ASC LIMIT ?"
				)
				.bind(batchSize)
				.all<{ id: string; key: string }>();
			let scrubbed = 0;
			for (const row of rows.results ?? []) {
				const prepared = await prepareGatewayApiKeyForStorage(row.key);
				const result = await raw
					.prepare(
						'UPDATE api_keys SET key = ?, key_hash = ?, key_preview = ?, updated_at = datetime("now") WHERE id = ? AND key = ?'
					)
					.bind(
						prepared.storageKey,
						prepared.keyHash,
						prepared.keyPreview,
						row.id,
						row.key
					)
					.run();
				scrubbed += result.meta.changes ?? 0;
			}
			const countRow = await raw
				.prepare(
					"SELECT COUNT(*) AS count FROM api_keys WHERE key NOT LIKE 'hashref:sha256:%'"
				)
				.first<{ count: number }>();
			return { scrubbed, remaining: Number(countRow?.count ?? 0) };
		},

		async updateApiKeyName(id: string, name: string | null): Promise<boolean> {
			const result = await raw
				.prepare(
					'UPDATE api_keys SET name = ?, updated_at = datetime("now") WHERE id = ?'
				)
				.bind(name, id)
				.run();
			return result.meta.changes > 0;
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
			const conditions: string[] = [];
			const bindValues: unknown[] = [];
			if (options?.email) {
				conditions.push("u.email LIKE ?");
				bindValues.push(`%${options.email}%`);
			}
			if (options?.userId) {
				conditions.push("k.user_id = ?");
				bindValues.push(options.userId);
			}
			if (options?.workspaceId) {
				conditions.push("k.workspace_id = ?");
				bindValues.push(options.workspaceId);
			}
			if (options?.maxBudget === "positive")
				conditions.push("u.budget_max > 0");
			else if (options?.maxBudget === "zero_or_negative")
				conditions.push("u.budget_max <= 0");
			else if (options?.maxBudget === "null")
				conditions.push("u.budget_max IS NULL");
			const whereClause =
				conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
			const sort = options?.sort ?? DEFAULT_API_KEY_LIST_SORT;
			const order = options?.order ?? DEFAULT_API_KEY_LIST_ORDER;
			const orderBy = buildD1ApiKeyListOrderByClause(sort, order);
			const countRow = await raw
				.prepare(
					`SELECT COUNT(*) as total FROM api_keys k INNER JOIN users u ON u.id = k.user_id ${whereClause}`
				)
				.bind(...bindValues)
				.first<{ total: number }>();
			const total = Number(countRow?.total ?? 0);
			const rows = await raw
				.prepare(
					`SELECT k.id, k.key, k.key_preview, k.user_id, k.workspace_id, k.name, k.status, k.metadata, k.created_at, k.updated_at,
            u.email AS user_email, u.budget_max, u.budget_base, u.budget_spent, u.budget_period, u.budget_reset_at
       FROM api_keys k INNER JOIN users u ON u.id = k.user_id ${whereClause} ${orderBy} LIMIT ? OFFSET ?`
				)
				.bind(...bindValues, pageSize, offset)
				.all<{
					id: string;
					key: string;
					key_preview: string | null;
					user_id: string;
					workspace_id: string;
					name: string | null;
					status: string;
					metadata: string | null;
					created_at: string;
					updated_at: string;
					user_email: string | null;
					budget_max: number | null;
					budget_base: number;
					budget_spent: number;
					budget_period: string;
					budget_reset_at: string | null;
				}>();
			const keys: AdminApiKeyListItem[] = (rows.results ?? []).map((r) => ({
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
			}));
			return { keys, total };
		},

		async getActiveApiKeysCount(): Promise<number> {
			const row = await raw
				.prepare("SELECT COUNT(*) as count FROM api_keys WHERE status = ?")
				.bind("active")
				.first<{ count: number }>();
			return Number(row?.count ?? 0);
		},

		async getApiKeysCount() {
			const row = await raw
				.prepare(
					`SELECT
				COUNT(*) as total,
				SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
			 FROM api_keys`
				)
				.first<{ total: number; active: number }>();
			return {
				total: Number(row?.total ?? 0),
				active: Number(row?.active ?? 0),
			};
		},
	};
}
