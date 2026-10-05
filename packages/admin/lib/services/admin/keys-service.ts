/**
 * 管理后台 API 密钥：列表（JOIN users，预算只读）、创建（须关联已有 user 或外部身份对）、
 * 详情、日志、密钥级 metadata/status/name 更新、吊销墓碑。预算与邮箱在 `/admin/users`。
 */
import {
	defaultWorkspaceId,
	type GatewayRepositories,
	type RequestLogsByKeyIdFilter,
} from "@octafuse/core";
import { createKey } from "@octafuse/core/services/key-service";
import {
	getKeyInfo,
	getOrCreateUser,
} from "@octafuse/core/services/user-service";
import {
	API_KEY_LIST_SORT_FIELDS,
	API_KEY_LIST_SORT_ORDERS,
	type ApiKeyListSortField,
	type ApiKeyListSortOrder,
} from "@octafuse/core/db/api-keys-list-sort";
import { filterAllowedRequestLogStatuses } from "@octafuse/core/db/request-log-status-filter";
import { userBudgetAuditToInsertRowFull } from "@octafuse/core/db/user-budget-audit-mapper";
import { snapshotToJson } from "@octafuse/core/db/user-audit-snapshot";
import {
	auditAdminKeyPatch,
	commitAdminKeyMutation,
	expectedAdminKeyProfile,
	planAdminKeyPatch,
	readAdminKeyAuditUser,
} from "./admin-key-atomic";
import { badRequest, notFound } from "./errors";
import {
	gatewayKeyRevision,
	keyBody,
	keyId,
	keyMetadata,
	keyMetadataProjection,
	keyName,
	keyPage,
	keyReason,
	keyText,
	requireGatewayKeyRevision,
	safeGatewayKeyPreview,
} from "./gateway-key-contract";
import type {
	AdminKeyCreateInput,
	AdminKeyCreateOutput,
	AdminKeyDetailOutput,
	AdminKeyListItem,
	AdminKeyListOutput,
	AdminKeyLogsOutput,
	AdminKeyUpdateInput,
	AdminKeyUpdateOutput,
} from "./types";

/** `sk-` 开头按密钥查，否则按行 id 查（不区分 status，供更新前定位行）。 */
async function resolveKeyRow(repos: GatewayRepositories, idOrKey: string) {
	keyId(idOrKey);
	if (idOrKey.startsWith("sk-")) {
		return repos.apiKeys.getApiKeyWithUserByKey(idOrKey);
	}
	return repos.apiKeys.getApiKeyWithUserById(idOrKey);
}

/** 含已吊销：按 sk- 查时不过滤 status，供治理与审计。 */
async function resolveKeyRowAnyStatus(
	repos: GatewayRepositories,
	idOrKey: string
) {
	keyId(idOrKey);
	if (idOrKey.startsWith("sk-")) {
		const k = await repos.apiKeys.getApiKeyByKeyAnyStatus(idOrKey);
		if (!k) return null;
		return repos.apiKeys.getApiKeyWithUserById(k.id);
	}
	return repos.apiKeys.getApiKeyWithUserById(idOrKey);
}

/**
 * 密钥分页列表（`user_id`、`email` 筛选；预算来自 JOIN users，只读）。
 */
export async function listAdminKeys(
	repos: GatewayRepositories,
	input: {
		page?: number;
		page_size?: number;
		email?: string;
		user_id?: string;
		sort?: ApiKeyListSortField;
		order?: ApiKeyListSortOrder;
	}
): Promise<AdminKeyListOutput> {
	const page = keyPage(input.page, "page", 1, 1_000_000);
	const pageSize = keyPage(input.page_size, "page_size", 20, 100);
	if (input.user_id !== undefined) keyId(input.user_id, "user_id");
	if (input.email !== undefined) keyText(input.email, "email", 320);
	if (
		input.sort !== undefined &&
		!(API_KEY_LIST_SORT_FIELDS as readonly unknown[]).includes(input.sort)
	)
		throw badRequest("Invalid sort");
	if (
		input.order !== undefined &&
		!(API_KEY_LIST_SORT_ORDERS as readonly unknown[]).includes(input.order)
	)
		throw badRequest("Invalid order");

	const result = await repos.apiKeys.getAllApiKeys({
		email: input.email,
		userId: input.user_id,
		page,
		pageSize,
		sort: input.sort,
		order: input.order,
	});

	return {
		data: await Promise.all(
			result.keys.map(
				async (row): Promise<AdminKeyListItem> => ({
					id: row.id,
					key: safeGatewayKeyPreview(row.key),
					user_id: row.user_id,
					workspace_id: row.workspace_id,
					name: row.name,
					user_email: row.user_email,
					status: row.status,
					budget_max: row.budget_max,
					budget_base: row.budget_base,
					budget_spent: row.budget_spent,
					budget_period: row.budget_period,
					budget_reset_at: row.budget_reset_at,
					created_at: row.created_at,
					updated_at: row.updated_at,
					metadata_preview: keyMetadataProjection(row.metadata)
						.metadata_preview,
					metadata_unavailable: keyMetadataProjection(row.metadata)
						.metadata_unavailable,
					profile_revision: await gatewayKeyRevision(row),
				})
			)
		),
		total: Number(result.total),
		page,
		page_size: pageSize,
	};
}

export async function scrubLegacyGatewayKeySecrets(
	repos: GatewayRepositories,
	limit?: number
): Promise<{ scrubbed: number; remaining: number }> {
	return repos.apiKeys.scrubLegacyApiKeySecrets(limit);
}

/**
 * 在已有用户下新建密钥；无 `user_id` 时须提供 `external_system` + `external_user_id` + `email` 以幂等取/建用户。
 */
export async function createAdminKey(
	repos: GatewayRepositories,
	input: AdminKeyCreateInput,
	actorId: string
): Promise<AdminKeyCreateOutput> {
	keyBody(input, [
		"user_id",
		"external_system",
		"external_user_id",
		"email",
		"name",
		"metadata",
		"reason",
	]);
	const metaString =
		input.metadata === undefined ? null : keyMetadata(input.metadata);
	const name = input.name === undefined ? null : keyName(input.name);
	const reason = keyReason(input.reason);
	const hasUser = input.user_id !== undefined;
	if (
		hasUser &&
		[input.external_system, input.external_user_id, input.email].some(
			(v) => v !== undefined
		)
	)
		throw badRequest("Use user_id or external ownership, not both");

	let userId: string;
	if (hasUser) {
		userId = keyId(input.user_id, "user_id");
		const u = await repos.users.getById(userId);
		if (!u) throw badRequest("user not found");
	} else {
		const extS = keyText(input.external_system, "external_system", 255);
		const extU = keyText(input.external_user_id, "external_user_id");
		const emailTrim = keyText(input.email, "email", 320);
		if (!/^[^\s@]+@[^\s@]+$/u.test(emailTrim))
			throw badRequest("Invalid email");
		const u = await getOrCreateUser(repos, {
			external_system: extS,
			external_user_id: extU,
			email: emailTrim,
			budget_max: 0,
			budget_period: "none",
			budget_base: 0,
			metadata: null,
			audit_actor: { type: "admin", id: actorId, source: "admin_keys" },
		});
		userId = u.id;
	}

	const result = await createKey(repos, {
		user_id: userId,
		workspace_id: defaultWorkspaceId("personal", userId),
		name,
		metadata: metaString ?? null,
		provision_reason: reason,
		actor_id: actorId,
	});

	const row = await repos.apiKeys.getApiKeyWithUserById(result.key_id);
	const owner = await repos.users.getById(userId);
	if (
		!row ||
		!owner ||
		row.user_id !== userId ||
		row.workspace_id !== result.workspace_id
	)
		throw new Error("Created key confirmation is unavailable");
	return {
		id: row.id,
		key: result.key,
		key_id: result.key_id,
		user_id: userId,
		workspace_id: result.workspace_id,
		status: row.status,
		name: row.name,
		profile_revision: await gatewayKeyRevision(row),
		owner: {
			email: owner.email,
			external_system: owner.external_system,
			external_user_id: owner.external_user_id,
		},
	};
}

/**
 * 单密钥请求日志分页。
 */
export async function getAdminKeyLogs(
	repos: GatewayRepositories,
	idOrKey: string,
	input: {
		page?: number;
		page_size?: number;
		exclude_status?: string;
		include_statuses?: string;
	}
): Promise<AdminKeyLogsOutput> {
	const row = await resolveKeyRow(repos, idOrKey);
	if (!row) throw notFound("Key not found");

	const page = keyPage(input.page, "page", 1, 1_000_000);
	const page_size = keyPage(input.page_size, "page_size", 20, 100);

	let filter: RequestLogsByKeyIdFilter | undefined;
	if (input.include_statuses !== undefined && input.include_statuses !== null) {
		const parsed = input.include_statuses
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const includeStatuses = filterAllowedRequestLogStatuses(parsed);
		if (includeStatuses.length === 0) {
			return { logs: [], total: 0, page, page_size };
		}
		filter = { includeStatuses };
	} else if (input.exclude_status) {
		filter = { excludeStatus: input.exclude_status };
	}

	const { logs, total } = await repos.requestLogs.getRequestLogsByKeyId(
		row.id,
		page,
		page_size,
		filter
	);
	return { logs, total, page, page_size };
}

/**
 * 部分更新：`name`、`metadata`（合并或整体替换）、`status`。预算字段须走 `/admin/users`。
 */
export async function updateAdminKey(
	repos: GatewayRepositories,
	idOrKey: string,
	input: AdminKeyUpdateInput,
	actorId: string,
	requireRevision = false
): Promise<AdminKeyUpdateOutput> {
	keyBody(input, [
		"name",
		"metadata",
		"metadata_replace",
		"status",
		"reason",
		"expected_revision",
	]);
	const raw = input as Record<string, unknown>;
	for (const k of [
		"budget_max",
		"budget_base",
		"budget_spent",
		"budget_period",
		"reset_budget",
		"budget_reset_at",
		"user_email",
	]) {
		if (raw[k] !== undefined) {
			throw badRequest(
				`Field ${k} is not allowed on keys; use PATCH /admin/users/:id`
			);
		}
	}

	const row = await resolveKeyRow(repos, idOrKey);
	if (!row) throw notFound("Key not found");
	await requireGatewayKeyRevision(
		row,
		input.expected_revision,
		requireRevision
	);

	const plan = planAdminKeyPatch(row, input);
	if (!plan.hasAnyField) {
		throw badRequest(
			"Provide at least one of name, metadata, metadata_replace, status"
		);
	}
	const reasonText = keyReason(input.reason) ?? "Admin key update";
	const userSnapshot =
		plan.nameChanged || plan.statusChanged || plan.metadataChanged
			? await readAdminKeyAuditUser(repos, row.user_id)
			: null;
	await commitAdminKeyMutation(repos, {
		id: row.id,
		expected: expectedAdminKeyProfile(row),
		patch: plan.patch,
		expectedUserSnapshot: userSnapshot,
		audit: auditAdminKeyPatch(row, plan, userSnapshot, {
			actorId,
			reasonText,
			source: "admin_keys",
		}),
	});

	return { ...(await getAdminKeyById(repos, row.id)), key_id: row.id };
}

/**
 * 密钥详情（含懒预算重置后的用户预算字段，只读）。
 */
export async function getAdminKeyById(
	repos: GatewayRepositories,
	idOrKey: string
): Promise<AdminKeyDetailOutput> {
	const row = await resolveKeyRow(repos, idOrKey);
	if (!row) throw notFound("Key not found");

	const info = await getKeyInfo(repos, row.id);
	if (!info) throw notFound("Key not found");

	return {
		id: info.id,
		key: safeGatewayKeyPreview(info.key),
		user_id: info.user_id,
		workspace_id: info.workspace_id,
		name: info.name,
		user_email: info.user_email,
		budget_max: info.budget_max,
		budget_base: info.budget_base,
		budget_spent: info.budget_spent,
		budget_period: info.budget_period,
		budget_reset_at: info.budget_reset_at,
		status: info.status,
		...keyMetadataProjection(info.metadata_raw),
		profile_revision: await gatewayKeyRevision({
			...info,
			metadata: info.metadata_raw,
		}),
		created_at: info.created_at,
		updated_at: info.updated_at,
		spend: info.budget_spent,
		max_budget: info.budget_max,
	};
}

/**
 * DELETE is implemented as a revocation tombstone. A request can already be
 * authenticated (including an unlimited account with no budget reservation)
 * when an administrator removes the key. Physically deleting the FK target at
 * that point can make the eventual request/audit critical write fail.
 */
export async function deleteAdminKey(
	repos: GatewayRepositories,
	idOrKey: string,
	actorId: string,
	input: { expected_revision?: string; reason?: string } = {},
	requireRevision = false
): Promise<AdminKeyDetailOutput> {
	keyBody(input, ["expected_revision", "reason"]);
	const row = await resolveKeyRowAnyStatus(repos, idOrKey);
	if (!row) throw notFound("Key not found");
	await requireGatewayKeyRevision(
		row,
		input.expected_revision,
		requireRevision
	);
	const reasonText =
		keyReason(input.reason) ??
		"API key revoked and retained as an audit tombstone";
	const userSnapshot = await readAdminKeyAuditUser(repos, row.user_id);
	const userSnapJson = snapshotToJson(userSnapshot);
	const spent = userSnapshot.budget_spent;
	const bmax = userSnapshot.budget_max;
	const bbase = userSnapshot.budget_base;
	const bperiod = userSnapshot.budget_period;
	const breset = userSnapshot.budget_reset_at;
	await commitAdminKeyMutation(repos, {
		id: row.id,
		expected: expectedAdminKeyProfile(row),
		patch: { status: "revoked" },
		expectedUserSnapshot: userSnapshot,
		audit: userBudgetAuditToInsertRowFull(row.user_id, {
			id: crypto.randomUUID(),
			apiKeyId: row.id,
			eventType: "key_revoked",
			actorType: "admin",
			actorId,
			reasonCode: "admin_key_delete_tombstone",
			reasonText,
			beforeSpent: spent,
			deltaSpent: 0,
			afterSpent: spent,
			beforeBudgetMax: bmax,
			afterBudgetMax: bmax,
			beforeBudgetBase: bbase,
			afterBudgetBase: bbase,
			beforeBudgetPeriod: bperiod,
			afterBudgetPeriod: bperiod,
			beforeBudgetResetAt: breset,
			afterBudgetResetAt: breset,
			changePayloadMerge: JSON.stringify({
				key_id: row.id,
				name: row.name,
				status: row.status,
			}),
			beforeUserSnapshot: userSnapJson,
			afterUserSnapshot: userSnapJson,
			changedFields: null,
			source: "admin_keys",
			correlationId: crypto.randomUUID(),
		}),
	});
	return getAdminKeyById(repos, row.id);
}
