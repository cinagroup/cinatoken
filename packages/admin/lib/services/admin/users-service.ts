/**
 * 管理端 `/admin/users`：列表、按外部对幂等创建、详情（懒重置预算）、计划/资料 PATCH、
 * 物理删除、子资源 keys / request-logs / audit-logs。
 */
import {
	defaultWorkspaceId,
	type BudgetPeriod,
	type GatewayRepositories,
	type UserRow,
} from "@octafuse/core";
import type {
	UserListSortField,
	UserListSortOrder,
} from "@octafuse/core/db/users-list-sort";
import { createKey } from "@octafuse/core/services/key-service";
import {
	getKeyInfo,
	getOrCreateUser,
	getUserInfo,
} from "@octafuse/core/services/user-service";
import {
	applyBudgetTransition,
	BudgetTransitionInvalidTargetError,
	BudgetTransitionStalePreviewError,
	previewBudgetTransition,
	type BudgetTransitionParams,
} from "@octafuse/core/services/budget-transition-service";
import {
	applyUserPlanPatchWithAudit,
	UserPlanPatchConflictError,
	type UserPlanPatchWithAuditParams,
} from "@octafuse/core/services/user-plan-patch-service";
import { userBudgetAuditToInsertRowFull } from "@octafuse/core/db/user-budget-audit-mapper";
import { roundGatewayMoney } from "@octafuse/core/lib/money-precision";
import {
	changedFieldsToJson,
	computeChangedFields,
	snapshotToJson,
	userRowToSnapshot,
} from "@octafuse/core/db/user-audit-snapshot";
import { buildMetadataAuditChange } from "./admin-profile-audit-metadata";
import {
	auditAdminKeyPatch,
	commitAdminKeyMutation,
	expectedAdminKeyProfile,
	planAdminKeyPatch,
	readAdminKeyAuditUser,
} from "./admin-key-atomic";
import {
	keyMetadataProjection,
	safeGatewayKeyPreview,
} from "./gateway-key-contract";
import { isSharedKeyEarningHistoryDeleteError } from "@/lib/shared-key-history-error";
import { resolveAdminChargedCostFactorsInput } from "./user-charged-cost-factors";
import { parseUserChargedCostFactors } from "@octafuse/core";
import { badRequest, conflict, notFound } from "./errors";
import { normalizeMetadataInput } from "./shared";
import type {
	AdminUserCreateInput,
	AdminUserUpdateInput,
	AdminBudgetTransitionInput,
	JsonObject,
} from "./types";

type UpdateAdminUserDependencies = {
	applyPlanPatch: typeof applyUserPlanPatchWithAudit;
};

const UPDATE_ADMIN_USER_DEPENDENCIES: UpdateAdminUserDependencies = {
	applyPlanPatch: applyUserPlanPatchWithAudit,
};

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * `:id` 为 uuid，或 `ext:` + `urlencode(system)` + `/` + `urlencode(external_user_id)`，
 * 或 `ext:` + `urlencode(system)` + `\x1f` + `urlencode(external_user_id)`（推荐，避免 system 含 `/` 歧义）。
 */
export function parseAdminUserRouteId(
	raw: string
):
	| { kind: "uuid"; id: string }
	| { kind: "external"; externalSystem: string; externalUserId: string }
	| null {
	const id = raw.trim();
	if (!id) return null;
	if (UUID_RE.test(id)) return { kind: "uuid", id };
	if (!id.startsWith("ext:")) return null;
	const rest = id.slice(4);
	const unit = "\x1f";
	if (rest.includes(unit)) {
		const [a, b] = rest.split(unit);
		if (!a || b === undefined) return null;
		try {
			return {
				kind: "external",
				externalSystem: decodeURIComponent(a),
				externalUserId: decodeURIComponent(b),
			};
		} catch {
			return null;
		}
	}
	const slash = rest.indexOf("/");
	if (slash < 0) return null;
	try {
		return {
			kind: "external",
			externalSystem: decodeURIComponent(rest.slice(0, slash)),
			externalUserId: decodeURIComponent(rest.slice(slash + 1)),
		};
	} catch {
		return null;
	}
}

export async function resolveAdminUserId(
	repos: GatewayRepositories,
	raw: string
): Promise<string> {
	const parsed = parseAdminUserRouteId(raw);
	if (!parsed) throw notFound("User not found");
	if (parsed.kind === "uuid") {
		const u = await repos.users.getById(parsed.id);
		if (!u) throw notFound("User not found");
		return u.id;
	}
	const u = await repos.users.getByExternalPair(
		parsed.externalSystem,
		parsed.externalUserId
	);
	if (!u) throw notFound("User not found");
	return u.id;
}

export async function listAdminUsers(
	repos: GatewayRepositories,
	input: {
		page?: number;
		page_size?: number;
		email?: string;
		external_system?: string;
		external_user_id?: string;
		max_budget?: string;
		status?: string;
		sort?: UserListSortField;
		order?: UserListSortOrder;
	}
) {
	const page = Number.isFinite(input.page) ? Number(input.page) : 1;
	const pageSize = Number.isFinite(input.page_size)
		? Number(input.page_size)
		: 20;
	const maxBudget = input.max_budget;
	const { users, total } = await repos.users.list({
		email: input.email,
		externalSystem: input.external_system,
		externalUserId: input.external_user_id,
		status: input.status,
		maxBudget:
			maxBudget === "positive" ||
			maxBudget === "zero_or_negative" ||
			maxBudget === "null"
				? maxBudget
				: undefined,
		page,
		pageSize,
		sort: input.sort,
		order: input.order,
	});
	const data = await Promise.all(
		users.map(async (u) => {
			const keys = await repos.apiKeys.listKeysByUserId(u.id);
			return {
				...u,
				charged_cost_factors: parseUserChargedCostFactors(
					u.charged_cost_factors
				),
				active_keys_count: keys.filter((key) => key.status === "active").length,
				keys_count: keys.length,
			};
		})
	);
	return { data, total: Number(total), page, page_size: pageSize };
}

/** D1/SQLite 或 Postgres 在 `(external_system, email)` 唯一索引冲突时的错误识别。 */
function isExternalSystemEmailUniqueViolation(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return (
		msg.includes("uk_users_external_system_email") ||
		(msg.includes("UNIQUE constraint") &&
			msg.includes("external_system") &&
			msg.includes("email")) ||
		(msg.includes("duplicate key") &&
			msg.includes("external_system") &&
			msg.includes("email"))
	);
}

export async function createAdminUser(
	repos: GatewayRepositories,
	input: AdminUserCreateInput,
	actorId: string
) {
	const emailTrim = String(input.email ?? "").trim();
	if (!emailTrim) {
		throw badRequest("email is required");
	}
	const budget_period = (input.budget_period ?? "none") as BudgetPeriod;
	const budget_max = input.budget_max === undefined ? 0 : input.budget_max;
	const budget_base =
		input.budget_base === undefined
			? budget_max == null
				? 0
				: roundGatewayMoney(Number(budget_max))
			: roundGatewayMoney(Number(input.budget_base ?? 0));

	let metaString: string | null = null;
	if (input.metadata !== undefined && input.metadata !== null) {
		if (typeof input.metadata === "string") {
			const parsed = normalizeMetadataInput(input.metadata);
			if (!parsed.ok) throw badRequest(parsed.message);
			metaString = parsed.value;
		} else if (
			typeof input.metadata === "object" &&
			!Array.isArray(input.metadata)
		) {
			try {
				metaString = JSON.stringify(input.metadata);
			} catch {
				throw badRequest("metadata must be JSON-serializable");
			}
		} else {
			throw badRequest("metadata must be a JSON object or JSON string");
		}
	}

	let user;
	try {
		user = await getOrCreateUser(repos, {
			external_system: input.external_system ?? null,
			external_user_id: input.external_user_id ?? null,
			email: emailTrim,
			budget_max,
			budget_period,
			budget_base,
			metadata: metaString,
			audit_actor: { type: "admin", id: actorId, source: "admin_users" },
		});
	} catch (error) {
		if (isExternalSystemEmailUniqueViolation(error)) {
			const system = String(input.external_system ?? "").trim() || "(unknown)";
			throw conflict(
				`email "${emailTrim}" is already linked to another user under external_system "${system}"`
			);
		}
		throw error;
	}

	if (Object.prototype.hasOwnProperty.call(input, "charged_cost_factors")) {
		const factorsJson = await resolveAdminChargedCostFactorsInput(
			repos,
			input.charged_cost_factors
		);
		await repos.users.setUserChargedCostFactorsById(user.id, factorsJson);
	}

	const info = await getUserInfo(repos, user.id);
	if (!info) throw notFound("User not found");
	return info;
}

export async function getAdminUserByRouteId(
	repos: GatewayRepositories,
	raw: string
) {
	const userId = await resolveAdminUserId(repos, raw);
	const info = await getUserInfo(repos, userId);
	if (!info) throw notFound("User not found");
	return info;
}

function assertAdminBudgetAmount(
	name: string,
	value: number | null | undefined
): void {
	if (
		value !== undefined &&
		value !== null &&
		(!Number.isFinite(value) || value < 0)
	) {
		throw badRequest(`${name} must be a non-negative finite number or null`);
	}
}

/** Resolve the legacy PATCH contract before any profile mutation is attempted. */
export function resolveAdminUserPlanPatch(
	input: AdminUserUpdateInput,
	metadataReplace: string | null | undefined
): UserPlanPatchWithAuditParams {
	assertAdminBudgetAmount("budget_max", input.budget_max);
	assertAdminBudgetAmount("budget_base", input.budget_base);
	assertAdminBudgetAmount("budget_spent", input.budget_spent);
	if (
		input.budget_period !== undefined &&
		!["none", "daily", "weekly", "monthly"].includes(input.budget_period)
	) {
		throw badRequest("budget_period must be none, daily, weekly, or monthly");
	}
	if (
		input.reset_budget !== undefined &&
		typeof input.reset_budget !== "boolean"
	) {
		throw badRequest("reset_budget must be a boolean");
	}
	if (
		input.budget_reset_at !== undefined &&
		input.budget_reset_at !== null &&
		(typeof input.budget_reset_at !== "string" ||
			Number.isNaN(new Date(input.budget_reset_at).getTime()))
	) {
		throw badRequest("budget_reset_at must be a valid ISO datetime or null");
	}

	let resetBudget: boolean;
	if (input.reset_budget !== undefined) {
		resetBudget = input.reset_budget;
	} else if (
		input.budget_period === undefined &&
		input.budget_reset_at === undefined
	) {
		resetBudget = false;
	} else {
		resetBudget = true;
	}

	let metadata: UserPlanPatchWithAuditParams["metadata"];
	if (metadataReplace !== undefined) {
		metadata = { kind: "replace", value: metadataReplace };
	} else if (
		input.metadata !== undefined &&
		typeof input.metadata === "object" &&
		input.metadata !== null &&
		!Array.isArray(input.metadata)
	) {
		metadata = { kind: "merge", value: input.metadata as JsonObject };
	}

	return {
		budget_max: input.budget_max,
		budget_base: input.budget_base,
		budget_spent: input.budget_spent,
		budget_period: input.budget_period,
		budget_reset_at: input.budget_reset_at,
		reset_budget: resetBudget,
		metadata,
		reason: input.reason,
	};
}

export async function updateAdminUser(
	repos: GatewayRepositories,
	raw: string,
	input: AdminUserUpdateInput,
	actorId: string,
	dependencies: UpdateAdminUserDependencies = UPDATE_ADMIN_USER_DEPENDENCIES
) {
	const userId = await resolveAdminUserId(repos, raw);
	const row = await repos.users.getById(userId);
	if (!row) throw notFound("User not found");

	const budget_max_in = input.budget_max;
	const budget_base_in = input.budget_base;
	const budget_period_in = input.budget_period;
	const budget_spent_in = input.budget_spent;
	const hasBudgetField =
		budget_max_in !== undefined ||
		budget_base_in !== undefined ||
		budget_period_in !== undefined ||
		budget_spent_in !== undefined ||
		input.reset_budget !== undefined ||
		input.budget_reset_at !== undefined;

	let metadataReplaceStr: string | null | undefined;
	const rawReplace =
		input.metadata_replace !== undefined ? input.metadata_replace : undefined;
	if (rawReplace !== undefined) {
		const parsed = normalizeMetadataInput(rawReplace);
		if (!parsed.ok) throw badRequest(parsed.message);
		metadataReplaceStr = parsed.value;
	} else if (
		input.metadata !== undefined &&
		typeof input.metadata === "string"
	) {
		const parsed = normalizeMetadataInput(input.metadata);
		if (!parsed.ok) throw badRequest(parsed.message);
		metadataReplaceStr = parsed.value;
	}

	const hasMetaObjectMerge =
		input.metadata !== undefined &&
		typeof input.metadata === "object" &&
		input.metadata !== null &&
		!Array.isArray(input.metadata);

	const hasStatus = input.status !== undefined;
	const hasMetaReplace = metadataReplaceStr !== undefined;
	const userEmailRaw = input.email;
	const hasEmail = userEmailRaw !== undefined;
	const nextEmail =
		userEmailRaw === undefined || userEmailRaw === null
			? null
			: String(userEmailRaw).trim() === ""
			? null
			: String(userEmailRaw).trim().toLowerCase();

	const hasExternalSystem = Object.prototype.hasOwnProperty.call(
		input,
		"external_system"
	);
	const hasExternalUserId = Object.prototype.hasOwnProperty.call(
		input,
		"external_user_id"
	);
	const hasExternalIdentity = hasExternalSystem || hasExternalUserId;
	const normalizeExternalString = (raw: unknown): string | null => {
		if (raw == null) return null;
		const s = String(raw).trim();
		return s === "" ? null : s;
	};
	const nextExternalSystem = hasExternalSystem
		? normalizeExternalString(input.external_system)
		: row.external_system;
	const nextExternalUserId = hasExternalUserId
		? normalizeExternalString(input.external_user_id)
		: row.external_user_id;
	if (hasExternalIdentity) {
		const bothNull = nextExternalSystem === null && nextExternalUserId === null;
		const bothSet = nextExternalSystem !== null && nextExternalUserId !== null;
		if (!bothNull && !bothSet) {
			throw badRequest(
				"external_system and external_user_id must both be set or both empty"
			);
		}
	}

	const hasChargedCostFactors = Object.prototype.hasOwnProperty.call(
		input,
		"charged_cost_factors"
	);
	let nextChargedCostFactorsJson: string | null | undefined;
	if (hasChargedCostFactors) {
		nextChargedCostFactorsJson = await resolveAdminChargedCostFactorsInput(
			repos,
			input.charged_cost_factors
		);
	}

	if (
		!hasBudgetField &&
		!hasMetaObjectMerge &&
		!hasMetaReplace &&
		!hasStatus &&
		!hasEmail &&
		!hasExternalIdentity &&
		!hasChargedCostFactors
	) {
		throw badRequest(
			"Provide at least one of email, budget_max, budget_base, budget_spent, budget_period, reset_budget, budget_reset_at, metadata, metadata_replace, status, external_system, external_user_id, charged_cost_factors"
		);
	}

	if (hasMetaObjectMerge && hasMetaReplace) {
		throw badRequest(
			"Use either metadata (object merge or string replace) or metadata_replace, not both"
		);
	}
	// Resolve and validate the entire budget mutation before applying any of the
	// independently persisted profile fields below.
	const resolvedPlanPatch = hasBudgetField
		? resolveAdminUserPlanPatch(input, metadataReplaceStr)
		: null;
	let metadataAuditedWithBudget = false;
	if (resolvedPlanPatch) {
		try {
			const result = await dependencies.applyPlanPatch(
				repos,
				userId,
				resolvedPlanPatch,
				actorId
			);
			if (!result) throw notFound("User not found");
			metadataAuditedWithBudget =
				result.audited && resolvedPlanPatch.metadata !== undefined;
		} catch (error) {
			if (error instanceof UserPlanPatchConflictError) {
				throw conflict(error.message);
			}
			throw error;
		}
	}

	if (hasStatus) {
		await repos.users.updateUserStatus(userId, String(input.status));
	}
	if (hasEmail) {
		if (nextEmail === null) {
			throw badRequest("email cannot be empty");
		}
		const ok = await repos.users.setUserEmailById(userId, nextEmail);
		if (!ok) throw new Error("Failed to update user");
	}
	if (hasExternalIdentity) {
		const ok = await repos.users.setUserExternalIdentityById(
			userId,
			nextExternalSystem,
			nextExternalUserId
		);
		if (!ok) throw new Error("Failed to update user");
	}
	if (hasChargedCostFactors && nextChargedCostFactorsJson !== undefined) {
		const ok = await repos.users.setUserChargedCostFactorsById(
			userId,
			nextChargedCostFactorsJson
		);
		if (!ok) throw new Error("Failed to update user");
	}

	if (!resolvedPlanPatch && hasMetaObjectMerge) {
		const existing: JsonObject = row.metadata
			? (JSON.parse(row.metadata) as JsonObject)
			: {};
		const merged = JSON.stringify({
			...existing,
			...(input.metadata as JsonObject),
		});
		const ok = await repos.users.setUserMetadataById(userId, merged);
		if (!ok) throw new Error("Failed to update user");
	} else if (!resolvedPlanPatch && hasMetaReplace) {
		const ok = await repos.users.setUserMetadataById(
			userId,
			metadataReplaceStr ?? null
		);
		if (!ok) throw new Error("Failed to update user");
	}

	const rowAfter = await repos.users.getById(userId);
	if (!rowAfter) throw notFound("User not found");

	const reasonText =
		typeof input.reason === "string" && input.reason.trim() !== ""
			? input.reason.trim()
			: "Admin update";

	const budgetChanged =
		Number(rowAfter.budget_spent ?? 0) !== Number(row.budget_spent ?? 0) ||
		(rowAfter.budget_max ?? null) !== (row.budget_max ?? null) ||
		Number(rowAfter.budget_base ?? 0) !== Number(row.budget_base ?? 0) ||
		(rowAfter.budget_period ?? null) !== (row.budget_period ?? null) ||
		(rowAfter.budget_reset_at ?? null) !== (row.budget_reset_at ?? null) ||
		Number(rowAfter.budget_epoch) !== Number(row.budget_epoch) ||
		Number(rowAfter.budget_reserved_micros) !==
			Number(row.budget_reserved_micros);

	const metadataChanged = (row.metadata ?? "") !== (rowAfter.metadata ?? "");
	const profileMetadataChanged = metadataChanged && !metadataAuditedWithBudget;
	const statusChanged = (row.status ?? "") !== (rowAfter.status ?? "");
	const emailChanged = (row.email ?? null) !== (rowAfter.email ?? null);
	const externalSystemChanged =
		(row.external_system ?? null) !== (rowAfter.external_system ?? null);
	const externalUserIdChanged =
		(row.external_user_id ?? null) !== (rowAfter.external_user_id ?? null);
	const externalChanged = externalSystemChanged || externalUserIdChanged;
	const chargedCostFactorsChanged =
		(row.charged_cost_factors ?? null) !==
		(rowAfter.charged_cost_factors ?? null);

	let profileAuditPayload: Record<string, unknown> | null = null;
	if (
		profileMetadataChanged ||
		statusChanged ||
		emailChanged ||
		externalChanged ||
		chargedCostFactorsChanged
	) {
		profileAuditPayload = {};
		if (emailChanged) {
			profileAuditPayload.email = {
				from: row.email ?? null,
				to: rowAfter.email ?? null,
			};
		}
		if (statusChanged) {
			profileAuditPayload.status = {
				from: row.status ?? null,
				to: rowAfter.status ?? null,
			};
		}
		if (externalSystemChanged) {
			profileAuditPayload.external_system = {
				from: row.external_system ?? null,
				to: rowAfter.external_system ?? null,
			};
		}
		if (externalUserIdChanged) {
			profileAuditPayload.external_user_id = {
				from: row.external_user_id ?? null,
				to: rowAfter.external_user_id ?? null,
			};
		}
		if (profileMetadataChanged) {
			let operation: "merge" | "replace" | "update" = "update";
			let touchedKeys: string[] | undefined;
			if (
				hasMetaObjectMerge &&
				input.metadata &&
				typeof input.metadata === "object" &&
				!Array.isArray(input.metadata)
			) {
				operation = "merge";
				touchedKeys = Object.keys(input.metadata as JsonObject);
			} else if (
				hasMetaReplace ||
				(input.metadata !== undefined && typeof input.metadata === "string")
			) {
				operation = "replace";
			}
			profileAuditPayload.metadata = buildMetadataAuditChange(
				row.metadata,
				rowAfter.metadata,
				operation,
				touchedKeys
			);
		}
		if (chargedCostFactorsChanged) {
			profileAuditPayload.charged_cost_factors = {
				from: parseUserChargedCostFactors(row.charged_cost_factors),
				to: parseUserChargedCostFactors(rowAfter.charged_cost_factors),
			};
		}
	}

	const profileAuditJson =
		profileAuditPayload && Object.keys(profileAuditPayload).length > 0
			? JSON.stringify(profileAuditPayload)
			: null;

	// Budget and metadata included in the atomic plan audit are neutralized in a
	// separate profile audit, so its changed_fields never claims a second debit/reset.
	const profileBeforeRow: UserRow = {
		...row,
		...(budgetChanged
			? {
					budget_max: rowAfter.budget_max,
					budget_base: rowAfter.budget_base,
					budget_spent: rowAfter.budget_spent,
					budget_period: rowAfter.budget_period,
					budget_reset_at: rowAfter.budget_reset_at,
					budget_epoch: rowAfter.budget_epoch,
					budget_reserved_micros: rowAfter.budget_reserved_micros,
			  }
			: {}),
		...(metadataAuditedWithBudget ? { metadata: rowAfter.metadata } : {}),
	};
	const beforeUserSnap = snapshotToJson(userRowToSnapshot(profileBeforeRow));
	const afterUserSnap = snapshotToJson(userRowToSnapshot(rowAfter));
	const userChangedFieldsJson = changedFieldsToJson(
		computeChangedFields(
			userRowToSnapshot(profileBeforeRow),
			userRowToSnapshot(rowAfter)
		)
	);

	if (
		profileMetadataChanged ||
		statusChanged ||
		emailChanged ||
		externalChanged ||
		chargedCostFactorsChanged
	) {
		let reasonCode = "admin_patch_profile";
		if (
			profileMetadataChanged &&
			!statusChanged &&
			!emailChanged &&
			!externalChanged &&
			!chargedCostFactorsChanged
		) {
			reasonCode = "admin_patch_metadata";
		} else if (
			statusChanged &&
			!profileMetadataChanged &&
			!emailChanged &&
			!externalChanged &&
			!chargedCostFactorsChanged
		) {
			reasonCode = "admin_patch_status";
		} else if (
			emailChanged &&
			!profileMetadataChanged &&
			!statusChanged &&
			!externalChanged &&
			!chargedCostFactorsChanged
		) {
			reasonCode = "admin_patch_email";
		} else if (
			externalChanged &&
			!profileMetadataChanged &&
			!statusChanged &&
			!emailChanged &&
			!chargedCostFactorsChanged
		) {
			reasonCode = "admin_patch_external_identity";
		} else if (
			chargedCostFactorsChanged &&
			!profileMetadataChanged &&
			!statusChanged &&
			!emailChanged &&
			!externalChanged
		) {
			reasonCode = "admin_patch_charged_cost_factors";
		}
		const spent = Number(rowAfter.budget_spent ?? 0);
		const bmax = rowAfter.budget_max ?? null;
		const bbase = rowAfter.budget_base ?? null;
		const bperiod = rowAfter.budget_period ?? null;
		const breset = rowAfter.budget_reset_at ?? null;
		await repos.userAuditLogs.insertUserAuditLog(
			userBudgetAuditToInsertRowFull(userId, {
				id: crypto.randomUUID(),
				apiKeyId: null,
				eventType: "admin_adjust",
				actorType: "admin",
				actorId,
				reasonCode,
				reasonText: reasonText,
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
				changePayloadMerge: profileAuditJson,
				beforeUserSnapshot: beforeUserSnap,
				afterUserSnapshot: afterUserSnap,
				changedFields: userChangedFieldsJson,
				source: "admin_users",
				correlationId: crypto.randomUUID(),
			})
		);
	}

	return getUserInfo(repos, userId);
}

const VALID_BUDGET_PERIODS = new Set<BudgetPeriod>([
	"none",
	"daily",
	"weekly",
	"monthly",
]);
const VALID_CARRYOVER = new Set(["remaining_or_overage", "none"]);
const MIN_TRANSITION_RESET_LEAD_MS = 5 * 60_000;
function validUtcTransitionTime(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
	);
}

function parseAdminBudgetTransitionInput(
	input: AdminBudgetTransitionInput
): BudgetTransitionParams {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw badRequest("budget transition input must be an object");
	}
	const base = input.target_budget_base;
	if (typeof base !== "number" || !Number.isFinite(base) || base < 0) {
		throw badRequest("target_budget_base must be a non-negative finite number");
	}
	const period = input.budget_period;
	if (!VALID_BUDGET_PERIODS.has(period)) {
		throw badRequest("budget_period must be none, daily, weekly, or monthly");
	}
	const strategy = input.carryover_strategy ?? "remaining_or_overage";
	if (!VALID_CARRYOVER.has(strategy)) {
		throw badRequest("carryover_strategy must be remaining_or_overage or none");
	}
	if (input.budget_reset_at !== undefined && input.budget_reset_at !== null) {
		if (!validUtcTransitionTime(input.budget_reset_at)) {
			throw badRequest("budget_reset_at must be a valid ISO datetime or null");
		}
		const t = Date.parse(input.budget_reset_at);
		if (period === "none") {
			throw badRequest(
				"budget_reset_at must be null when budget_period is none"
			);
		}
		if (t < Date.now() + MIN_TRANSITION_RESET_LEAD_MS) {
			throw badRequest(
				"budget_reset_at must be at least five minutes in the future"
			);
		}
	}
	if (
		input.reset_spent !== undefined &&
		typeof input.reset_spent !== "boolean"
	) {
		throw badRequest("reset_spent must be a boolean");
	}
	if (
		input.reason !== undefined &&
		(typeof input.reason !== "string" || input.reason.length > 256)
	) {
		throw badRequest("reason must be a string of at most 256 characters");
	}
	let metadata: Record<string, unknown> | undefined;
	if (input.metadata !== undefined) {
		if (
			typeof input.metadata !== "object" ||
			input.metadata === null ||
			Array.isArray(input.metadata)
		) {
			throw badRequest("metadata must be a JSON object");
		}
		metadata = input.metadata as Record<string, unknown>;
	}
	const expected = input.expected_before;
	if (expected !== undefined) {
		if (
			!expected ||
			typeof expected !== "object" ||
			Array.isArray(expected) ||
			!(
				expected.budget_max === null ||
				(typeof expected.budget_max === "number" &&
					Number.isFinite(expected.budget_max) &&
					expected.budget_max >= 0)
			) ||
			typeof expected.budget_base !== "number" ||
			!Number.isFinite(expected.budget_base) ||
			expected.budget_base < 0 ||
			typeof expected.budget_spent !== "number" ||
			!Number.isFinite(expected.budget_spent) ||
			expected.budget_spent < 0 ||
			!VALID_BUDGET_PERIODS.has(expected.budget_period as BudgetPeriod) ||
			!(
				expected.budget_reset_at === null ||
				validUtcTransitionTime(expected.budget_reset_at)
			) ||
			!Number.isSafeInteger(expected.budget_epoch) ||
			expected.budget_epoch < 0 ||
			!Number.isSafeInteger(expected.budget_reserved_micros) ||
			expected.budget_reserved_micros < 0
		) {
			throw badRequest(
				"expected_before must be a valid budget transition snapshot"
			);
		}
	}
	return {
		target_budget_base: base,
		budget_period: period,
		budget_reset_at: input.budget_reset_at,
		carryover_strategy: strategy,
		reset_spent: input.reset_spent,
		metadata,
		reason: input.reason,
		expected_before: expected,
	};
}

export async function previewAdminBudgetTransition(
	repos: GatewayRepositories,
	raw: string,
	input: AdminBudgetTransitionInput
) {
	const params = parseAdminBudgetTransitionInput(input);
	const userId = await resolveAdminUserId(repos, raw);
	let preview;
	try {
		preview = await previewBudgetTransition(repos, userId, params);
	} catch (error) {
		if (error instanceof BudgetTransitionInvalidTargetError)
			throw badRequest(error.message);
		throw error;
	}
	if (!preview) throw notFound("User not found");
	return preview;
}

export async function applyAdminBudgetTransition(
	repos: GatewayRepositories,
	raw: string,
	input: AdminBudgetTransitionInput,
	actorId: string
) {
	const params = parseAdminBudgetTransitionInput(input);
	const userId = await resolveAdminUserId(repos, raw);
	let result;
	try {
		result = await applyBudgetTransition(repos, userId, params, actorId);
	} catch (error) {
		if (error instanceof BudgetTransitionInvalidTargetError)
			throw badRequest(error.message);
		if (error instanceof BudgetTransitionStalePreviewError) {
			throw conflict(error.message);
		}
		throw error;
	}
	if (!result) throw notFound("User not found");
	const info = await getUserInfo(repos, userId);
	if (!info) throw notFound("User not found");
	return { transition: result.preview, user: info };
}

export async function deleteAdminUser(
	repos: GatewayRepositories,
	raw: string,
	actorId: string
): Promise<void> {
	const userId = await resolveAdminUserId(repos, raw);
	const row = await repos.users.getById(userId);
	if (!row) throw notFound("User not found");
	const beforeUserSnap = snapshotToJson(userRowToSnapshot(row));
	const spent = Number(row.budget_spent ?? 0);
	const bmax = row.budget_max ?? null;
	const bbase = row.budget_base ?? null;
	const bperiod = row.budget_period ?? null;
	const breset = row.budget_reset_at ?? null;
	const deletionAudit = userBudgetAuditToInsertRowFull(userId, {
		id: crypto.randomUUID(),
		apiKeyId: null,
		eventType: "user_deleted",
		actorType: "admin",
		actorId,
		reasonCode: "admin_user_delete",
		reasonText: "User permanently deleted",
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
			deleted_user_id: userId,
			deleted_user_email: row.email ?? null,
		}),
		beforeUserSnapshot: beforeUserSnap,
		afterUserSnapshot: null,
		changedFields: null,
		source: "admin_users",
		correlationId: crypto.randomUUID(),
	});
	if (!repos.users.deleteUserHardWithAudit) {
		throw new Error("Atomic user deletion audit repository is unavailable");
	}
	const result = await repos.users
		.deleteUserHardWithAudit(userId, deletionAudit)
		.catch((error: unknown) => {
			if (isSharedKeyEarningHistoryDeleteError(error))
				throw conflict(
					"User cannot be deleted while credited shared-key earnings reference it"
				);
			throw error;
		});
	if (result === "dispatch_history") {
		throw conflict(
			"User cannot be deleted while dispatch recovery history references it"
		);
	}
	if (result !== "deleted") throw notFound("User not found");
}

export async function listAdminUserKeys(
	repos: GatewayRepositories,
	raw: string
) {
	const userId = await resolveAdminUserId(repos, raw);
	const keys = await repos.apiKeys.listKeysByUserId(userId);
	return keys.map((row) => {
		const metadata = keyMetadataProjection(row.metadata);
		// Ordinary lists never transport exact metadata or trust legacy secret previews.
		// Operators explicitly fetch /admin/keys/:id for the uncached editor instead.
		return {
			id: row.id,
			key: safeGatewayKeyPreview(row.key),
			user_id: row.user_id,
			workspace_id: row.workspace_id,
			name: row.name,
			status: row.status,
			metadata_preview: metadata.metadata_preview,
			metadata_unavailable: metadata.metadata_unavailable,
			last_used_at: row.last_used_at,
			created_at: row.created_at,
			updated_at: row.updated_at,
		};
	});
}

export async function createAdminUserKey(
	repos: GatewayRepositories,
	raw: string,
	input: { name?: string | null; metadata?: unknown; reason?: string },
	actorId: string
) {
	const userId = await resolveAdminUserId(repos, raw);
	let metaString: string | null = null;
	if (input.metadata !== undefined && input.metadata !== null) {
		if (typeof input.metadata === "string") {
			const parsed = normalizeMetadataInput(input.metadata);
			if (!parsed.ok) throw badRequest(parsed.message);
			metaString = parsed.value;
		} else if (
			typeof input.metadata === "object" &&
			!Array.isArray(input.metadata)
		) {
			try {
				metaString = JSON.stringify(input.metadata);
			} catch {
				throw badRequest("metadata must be JSON-serializable");
			}
		} else {
			throw badRequest("metadata must be a JSON object or JSON string");
		}
	}
	return createKey(repos, {
		user_id: userId,
		workspace_id: defaultWorkspaceId("personal", userId),
		name: input.name ?? null,
		metadata: metaString,
		provision_reason: input.reason,
		actor_id: actorId,
	});
}

async function assertKeyBelongsToUser(
	repos: GatewayRepositories,
	userId: string,
	keyId: string
) {
	const row = await repos.apiKeys.getApiKeyWithUserById(keyId);
	if (!row || row.user_id !== userId) throw notFound("Key not found");
	return row;
}

export async function deleteAdminUserKey(
	repos: GatewayRepositories,
	rawUser: string,
	keyId: string,
	actorId: string
): Promise<void> {
	const userId = await resolveAdminUserId(repos, rawUser);
	const row = await assertKeyBelongsToUser(repos, userId, keyId);
	const userSnapshot = await readAdminKeyAuditUser(repos, userId);
	const userSnapJson = snapshotToJson(userSnapshot);
	const spent = userSnapshot.budget_spent;
	const bmax = userSnapshot.budget_max;
	const bbase = userSnapshot.budget_base;
	const bperiod = userSnapshot.budget_period;
	const breset = userSnapshot.budget_reset_at;
	await commitAdminKeyMutation(repos, {
		id: keyId,
		expected: expectedAdminKeyProfile(row),
		patch: { status: "revoked" },
		expectedUserSnapshot: userSnapshot,
		audit: userBudgetAuditToInsertRowFull(userId, {
			id: crypto.randomUUID(),
			apiKeyId: keyId,
			eventType: "key_revoked",
			actorType: "admin",
			actorId,
			reasonCode: "admin_user_key_delete_tombstone",
			reasonText: "API key revoked and retained as an audit tombstone",
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
			source: "admin_user_key",
			correlationId: crypto.randomUUID(),
		}),
	});
}

export type AdminUserKeyPatchInput = {
	name?: string | null;
	status?: string;
	metadata?: unknown;
	metadata_replace?: unknown;
	reason?: string;
};

export async function patchAdminUserKey(
	repos: GatewayRepositories,
	rawUser: string,
	keyId: string,
	input: AdminUserKeyPatchInput,
	actorId: string
) {
	const userId = await resolveAdminUserId(repos, rawUser);
	const row = await assertKeyBelongsToUser(repos, userId, keyId);

	const hasBudget =
		(input as Record<string, unknown>).budget_max !== undefined ||
		(input as Record<string, unknown>).budget_base !== undefined ||
		(input as Record<string, unknown>).budget_period !== undefined ||
		(input as Record<string, unknown>).budget_spent !== undefined;
	if (hasBudget)
		throw badRequest(
			"budget fields belong on /admin/users; use PATCH /admin/users/:id"
		);

	const plan = planAdminKeyPatch(row, input);
	const reasonText =
		typeof input.reason === "string" && input.reason.trim() !== ""
			? input.reason.trim()
			: "Admin key patch";
	if (plan.hasAnyField) {
		const userSnapshot =
			plan.nameChanged || plan.statusChanged || plan.metadataChanged
				? await readAdminKeyAuditUser(repos, userId)
				: null;
		await commitAdminKeyMutation(repos, {
			id: keyId,
			expected: expectedAdminKeyProfile(row),
			patch: plan.patch,
			expectedUserSnapshot: userSnapshot,
			audit: auditAdminKeyPatch(row, plan, userSnapshot, {
				actorId,
				reasonText,
				source: "admin_user_key",
			}),
		});
	}

	const keyInfo = await getKeyInfo(repos, keyId);
	if (!keyInfo) throw notFound("Key not found");
	// Raw Key metadata is reserved for the global Keys explicit edit contract.
	const { metadata_raw: _metadataRaw, ...publicKeyInfo } = keyInfo;
	return publicKeyInfo;
}

export async function getAdminUserLogs(
	repos: GatewayRepositories,
	rawUser: string,
	input: { page?: number; page_size?: number; status?: string }
) {
	const userId = await resolveAdminUserId(repos, rawUser);
	const page = Math.max(1, Number(input.page ?? 1));
	const page_size = Math.min(100, Math.max(1, Number(input.page_size ?? 20)));
	const status =
		input.status !== undefined &&
		input.status !== null &&
		String(input.status).trim() !== ""
			? String(input.status).trim()
			: undefined;

	const { logs, total } = await repos.requestLogs.getRequestLogs({
		page,
		pageSize: page_size,
		userId,
		status,
	});
	return { logs, total, page, page_size };
}

export async function getAdminUserAuditLogs(
	repos: GatewayRepositories,
	rawUser: string,
	input: { page?: number; page_size?: number }
) {
	const userId = await resolveAdminUserId(repos, rawUser);
	const page = Math.max(1, Number(input.page ?? 1));
	const page_size = Math.min(100, Math.max(1, Number(input.page_size ?? 20)));
	return repos.userAuditLogs.getUserAuditLogsByUserId(userId, page, page_size);
}
