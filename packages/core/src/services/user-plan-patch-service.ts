/**
 * 管理端精确修改用户预算计划。
 *
 * 与带结转语义的 `budget-transition-service` 不同，这里严格保留历史
 * `updateUserPlan` 的 PATCH 语义；预算行和对应 user audit 必须通过同一
 * critical-write 事务提交。
 */
import type { BudgetPeriod, UserRow } from '../types';
import type { GatewayRepositories } from '../storage/repositories';
import { roundGatewayMoney } from '../lib/money-precision';
import {
	changedFieldsToJson,
	computeChangedFields,
	snapshotToJson,
	userRowToSnapshot,
} from '../db/user-audit-snapshot';
import { userBudgetAuditToInsertRowFull } from '../db/user-budget-audit-mapper';
import { applyUserBudgetTransitionWithAuditTx } from '../storage/critical-write-paths';
import { computeFirstReset } from './user-service';

export type UserPlanMetadataMutation =
	| { kind: 'merge'; value: Record<string, unknown> }
	| { kind: 'replace'; value: string | null };

export type UserPlanPatchWithAuditParams = {
	budget_max?: number | null;
	budget_period?: BudgetPeriod;
	reset_budget?: boolean;
	budget_reset_at?: string | null;
	budget_spent?: number | null;
	budget_base?: number | null;
	metadata?: UserPlanMetadataMutation;
	reason?: string;
};

export type UserPlanPatchWithAuditResult = {
	before: UserRow;
	after: UserRow;
	/** False only for an effective no-op, where there is no mutation to audit. */
	audited: boolean;
};

export class UserPlanPatchConflictError extends Error {
	constructor() {
		super('User budget changed concurrently; retry the request');
		this.name = 'UserPlanPatchConflictError';
	}
}

type ApplyTransition = typeof applyUserBudgetTransitionWithAuditTx;

export type UserPlanPatchServiceDependencies = {
	applyTransition: ApplyTransition;
};

const DEFAULT_DEPENDENCIES: UserPlanPatchServiceDependencies = {
	applyTransition: applyUserBudgetTransitionWithAuditTx,
};

function assertValidInput(input: UserPlanPatchWithAuditParams): void {
	const period = input.budget_period;
	if (period !== undefined && !['none', 'daily', 'weekly', 'monthly'].includes(period)) {
		throw new Error('Invalid user budget period');
	}
	const amounts: Array<[string, number | null | undefined]> = [
		['budget_max', input.budget_max],
		['budget_base', input.budget_base],
		['budget_spent', input.budget_spent],
	];
	for (const [name, value] of amounts) {
		if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) {
			throw new Error(`Invalid ${name}`);
		}
	}
	if (
		input.budget_reset_at !== undefined &&
		input.budget_reset_at !== null &&
		Number.isNaN(new Date(input.budget_reset_at).getTime())
	) {
		throw new Error('Invalid budget_reset_at');
	}
}

function parseMetadata(raw: string | null): unknown {
	if (raw === null || raw === '') return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return raw;
	}
}

function resolveMetadata(row: UserRow, mutation: UserPlanMetadataMutation | undefined): string | null {
	if (!mutation) return row.metadata;
	if (mutation.kind === 'replace') return mutation.value;
	let current: Record<string, unknown> = {};
	if (row.metadata) {
		try {
			const parsed = JSON.parse(row.metadata) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				current = parsed as Record<string, unknown>;
			}
		} catch {
			// A malformed legacy value is replaced by the validated object merge.
		}
	}
	return JSON.stringify({ ...current, ...mutation.value });
}

function metadataChangePayload(
	before: string | null,
	after: string | null,
	mutation: UserPlanMetadataMutation | undefined,
): string | null {
	if (!mutation || before === after) return null;
	return JSON.stringify({
		metadata: {
			operation: mutation.kind,
			from: parseMetadata(before),
			to: parseMetadata(after),
		},
	});
}

function computeAfterRow(row: UserRow, input: UserPlanPatchWithAuditParams): UserRow {
	const resetEpoch = input.budget_spent !== undefined || (input.reset_budget ?? true);
	if (resetEpoch && row.budget_epoch >= Number.MAX_SAFE_INTEGER) {
		throw new Error('User budget epoch exhausted');
	}
	const nextSpent =
		input.budget_spent !== undefined
			? roundGatewayMoney(input.budget_spent ?? 0)
			: resetEpoch
				? 0
				: roundGatewayMoney(row.budget_spent);
	const nextPeriod = input.budget_period ?? row.budget_period;
	let nextResetAt: string | null;
	if (input.budget_reset_at !== undefined) {
		nextResetAt = input.budget_reset_at;
	} else if (input.budget_period !== undefined && input.budget_period !== row.budget_period) {
		nextResetAt = input.budget_period === 'none' ? null : computeFirstReset(input.budget_period);
	} else {
		nextResetAt = row.budget_reset_at;
	}
	return {
		...row,
		budget_max:
			input.budget_max === undefined
				? row.budget_max
				: input.budget_max === null
					? null
					: roundGatewayMoney(input.budget_max),
		budget_base:
			input.budget_base === undefined
				? roundGatewayMoney(row.budget_base)
				: roundGatewayMoney(input.budget_base ?? 0),
		budget_spent: nextSpent,
		budget_period: nextPeriod,
		budget_reset_at: nextResetAt,
		budget_epoch: resetEpoch ? row.budget_epoch + 1 : row.budget_epoch,
		budget_reserved_micros: resetEpoch ? 0 : row.budget_reserved_micros,
		metadata: resolveMetadata(row, input.metadata),
	};
}

function hasEffectiveChange(before: UserRow, after: UserRow): boolean {
	return computeChangedFields(userRowToSnapshot(before), userRowToSnapshot(after)).length > 0;
}

async function applyAttempt(
	repos: GatewayRepositories,
	userId: string,
	input: UserPlanPatchWithAuditParams,
	actorId: string,
	retriesRemaining: number,
	dependencies: UserPlanPatchServiceDependencies,
): Promise<UserPlanPatchWithAuditResult | null> {
	const row = await repos.users.getById(userId);
	if (!row) return null;
	const after = computeAfterRow(row, input);
	if (!hasEffectiveChange(row, after)) {
		return { before: row, after: row, audited: false };
	}

	const beforeSnapshot = userRowToSnapshot(row);
	const afterSnapshot = userRowToSnapshot(after);
	const resetEpoch = after.budget_epoch !== row.budget_epoch;
	const reasonText =
		typeof input.reason === 'string' && input.reason.trim() !== ''
			? input.reason.trim()
			: 'Admin update';

	const applied = await dependencies.applyTransition(repos, {
		userId,
		expectedBudgetMax: row.budget_max,
		expectedBudgetBase: row.budget_base,
		expectedBudgetSpent: row.budget_spent,
		expectedBudgetPeriod: row.budget_period,
		expectedBudgetResetAt: row.budget_reset_at,
		expectedBudgetEpoch: row.budget_epoch,
		expectedBudgetReservedMicros: row.budget_reserved_micros,
		budgetMax: after.budget_max,
		budgetBase: after.budget_base,
		budgetSpent: after.budget_spent,
		budgetPeriod: after.budget_period,
		budgetResetAt: after.budget_reset_at,
		resetEpoch,
		metadata: input.metadata === undefined ? undefined : after.metadata,
		audit: userBudgetAuditToInsertRowFull(userId, {
			id: crypto.randomUUID(),
			apiKeyId: null,
			eventType: 'admin_adjust',
			actorType: 'admin',
			actorId,
			reasonCode: 'admin_patch_budget',
			reasonText,
			beforeSpent: row.budget_spent,
			deltaSpent: after.budget_spent - row.budget_spent,
			afterSpent: after.budget_spent,
			beforeBudgetMax: row.budget_max,
			afterBudgetMax: after.budget_max,
			beforeBudgetBase: row.budget_base,
			afterBudgetBase: after.budget_base,
			beforeBudgetPeriod: row.budget_period,
			afterBudgetPeriod: after.budget_period,
			beforeBudgetResetAt: row.budget_reset_at,
			afterBudgetResetAt: after.budget_reset_at,
			changePayloadMerge: metadataChangePayload(row.metadata, after.metadata, input.metadata),
			beforeUserSnapshot: snapshotToJson(beforeSnapshot),
			afterUserSnapshot: snapshotToJson(afterSnapshot),
			changedFields: changedFieldsToJson(computeChangedFields(beforeSnapshot, afterSnapshot)),
			source: 'admin_users',
			correlationId: crypto.randomUUID(),
		}),
	});
	if (!applied) {
		if (retriesRemaining > 0) {
			return applyAttempt(repos, userId, input, actorId, retriesRemaining - 1, dependencies);
		}
		throw new UserPlanPatchConflictError();
	}
	return { before: row, after, audited: true };
}

/**
 * 在完整预算快照 CAS 下应用精确 PATCH。CAS 失败会重新读取并重算两次；
 * 超出重试预算时显式抛出 {@link UserPlanPatchConflictError}。
 */
export async function applyUserPlanPatchWithAudit(
	repos: GatewayRepositories,
	userId: string,
	input: UserPlanPatchWithAuditParams,
	actorId: string,
	dependencies: UserPlanPatchServiceDependencies = DEFAULT_DEPENDENCIES,
): Promise<UserPlanPatchWithAuditResult | null> {
	assertValidInput(input);
	return applyAttempt(repos, userId, input, actorId, 2, dependencies);
}
