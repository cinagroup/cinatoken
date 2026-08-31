/**
 * 通用用户预算转换：基于当前 `budget_max/budget_spent` 计算结转并写入新周期基线。
 * 供 Admin `POST /users/:id/budget/transition` 使用；不含订阅/支付语义。
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
import {
	budgetLazyResetNeedsPersist,
	computeFirstReset,
	getUserInfo,
	maybeResetBudget,
	persistLazyBudgetResetIfNeeded,
} from './user-service';
import { isSafeUserBudgetMicros, userBudgetAmount } from '../db/user-budget-reservation-types';

export type BudgetCarryoverStrategy = 'remaining_or_overage' | 'none';

export type BudgetTransitionParams = {
	target_budget_base: number;
	budget_period: BudgetPeriod;
	budget_reset_at?: string | null;
	carryover_strategy?: BudgetCarryoverStrategy;
	reset_spent?: boolean;
	metadata?: Record<string, unknown>;
	reason?: string;
};

export type BudgetTransitionSnapshot = {
	budget_max: number | null;
	budget_base: number;
	budget_spent: number;
	budget_period: string;
	budget_reset_at: string | null;
	budget_reserved_micros: number;
};

export type BudgetTransitionPreview = {
	before: BudgetTransitionSnapshot;
	after: BudgetTransitionSnapshot;
	carryover: number;
};

function snapshotFromUserRow(row: UserRow): BudgetTransitionSnapshot {
	const lazy = maybeResetBudget(
		row.budget_period,
		row.budget_reset_at,
		row.budget_spent,
		row.budget_max,
		row.budget_base
	);
	return {
		budget_max: lazy.budget_max,
		budget_base: roundGatewayMoney(Number(row.budget_base ?? 0)),
		budget_spent: lazy.budget_spent,
		budget_period: row.budget_period,
		budget_reset_at: lazy.budget_reset_at,
		budget_reserved_micros: row.budget_reserved_micros,
	};
}

function resolveBudgetResetAt(input: BudgetTransitionParams): string | null {
	if (input.budget_reset_at !== undefined) {
		return input.budget_reset_at;
	}
	if (input.budget_period === 'none') {
		return null;
	}
	return computeFirstReset(input.budget_period);
}

export function computeBudgetTransition(
	before: BudgetTransitionSnapshot,
	input: BudgetTransitionParams
): BudgetTransitionPreview {
	const targetBase = roundGatewayMoney(input.target_budget_base);
	const strategy = input.carryover_strategy ?? 'remaining_or_overage';
	const resetSpent = input.reset_spent ?? true;
	const currentMax = before.budget_max ?? 0;
	const currentSpent = before.budget_spent;
	if (!isSafeUserBudgetMicros(before.budget_reserved_micros)) {
		throw new Error('Invalid ordinary-user reserved budget counter');
	}
	const currentReserved = userBudgetAmount(before.budget_reserved_micros);
	const carryover =
		strategy === 'remaining_or_overage'
			? roundGatewayMoney(currentMax - currentSpent - currentReserved)
			: 0;
	const nextMax = roundGatewayMoney(targetBase + carryover);
	const nextSpent = resetSpent ? 0 : currentSpent;
	const budgetResetAt = resolveBudgetResetAt(input);

	return {
		before,
		after: {
			budget_max: nextMax,
			budget_base: targetBase,
			budget_spent: nextSpent,
			budget_period: input.budget_period,
			budget_reset_at: budgetResetAt,
			budget_reserved_micros: resetSpent ? 0 : before.budget_reserved_micros,
		},
		carryover,
	};
}

function mergeMetadataJson(
	row: UserRow,
	metadataPatch: Record<string, unknown> | undefined
): string | null | undefined {
	if (metadataPatch === undefined) {
		return undefined;
	}
	const existing: Record<string, unknown> = row.metadata
		? (JSON.parse(row.metadata) as Record<string, unknown>)
		: {};
	return JSON.stringify({ ...existing, ...metadataPatch });
}

/**
 * 只读预览：先触发与 `getUserInfo` 一致的懒重置，再计算 before/after。
 */
export async function previewBudgetTransition(
	repos: GatewayRepositories,
	userId: string,
	input: BudgetTransitionParams
): Promise<BudgetTransitionPreview | null> {
	const info = await getUserInfo(repos, userId);
	if (!info) return null;
	const before: BudgetTransitionSnapshot = {
		budget_max: info.budget_max,
		budget_base: info.budget_base,
		budget_spent: info.budget_spent,
		budget_period: info.budget_period,
		budget_reset_at: info.budget_reset_at,
		budget_reserved_micros: info.budget_reserved_micros,
	};
	return computeBudgetTransition(before, input);
}

async function applyBudgetTransitionAttempt(
	repos: GatewayRepositories,
	userId: string,
	input: BudgetTransitionParams,
	actorId: string,
	retriesRemaining: number,
): Promise<{ preview: BudgetTransitionPreview; applied: BudgetTransitionSnapshot } | null> {
	const initialRow = await repos.users.getById(userId);
	if (!initialRow) return null;

	// A due lazy reset is itself a real accounting-period transition. Persist it
	// before applying an admin transition so even `reset_spent: false` cannot
	// carry old-epoch reservations into the new period.
	await persistLazyBudgetResetIfNeeded(repos, {
		budgetRow: initialRow,
		userId: initialRow.id,
		expectedBudgetResetAt: initialRow.budget_reset_at,
		apiKeyId: null,
		snapshotUserRow: initialRow,
		kind: 'budget_transition',
	});
	const row = await repos.users.getById(userId);
	if (!row) return null;

	const before = snapshotFromUserRow(row);
	if (budgetLazyResetNeedsPersist(
		{
			budget_spent: row.budget_spent,
			budget_reset_at: row.budget_reset_at,
			budget_max: row.budget_max,
		},
		{
			budget_spent: before.budget_spent,
			budget_reset_at: before.budget_reset_at,
			budget_max: before.budget_max,
		},
	)) {
		if (retriesRemaining > 0) {
			return applyBudgetTransitionAttempt(repos, userId, input, actorId, retriesRemaining - 1);
		}
		throw new Error('Failed to persist due budget reset before budget transition');
	}
	const preview = computeBudgetTransition(before, input);
	const resetEpoch = input.reset_spent ?? true;
	const metadataJson = mergeMetadataJson(row, input.metadata);
	const reasonText =
		typeof input.reason === 'string' && input.reason.trim() !== '' ? input.reason.trim() : 'Budget transition';

	const beforeSnap = snapshotToJson(userRowToSnapshot(row));
	const afterRowForSnap: UserRow = {
		...row,
		budget_max: preview.after.budget_max,
		budget_base: preview.after.budget_base,
		budget_spent: preview.after.budget_spent,
		budget_period: preview.after.budget_period,
		budget_reset_at: preview.after.budget_reset_at,
		budget_epoch: resetEpoch ? row.budget_epoch + 1 : row.budget_epoch,
		budget_reserved_micros: preview.after.budget_reserved_micros,
		metadata: metadataJson === undefined ? row.metadata : metadataJson,
	};
	const afterSnap = snapshotToJson(userRowToSnapshot(afterRowForSnap));
	const changedFieldsJson = changedFieldsToJson(
		computeChangedFields(userRowToSnapshot(row), userRowToSnapshot(afterRowForSnap))
	);

	const ok = await applyUserBudgetTransitionWithAuditTx(repos, {
		userId,
		expectedBudgetMax: row.budget_max,
		expectedBudgetBase: row.budget_base,
		expectedBudgetEpoch: row.budget_epoch,
		expectedBudgetReservedMicros: row.budget_reserved_micros,
		expectedBudgetSpent: row.budget_spent,
		expectedBudgetPeriod: row.budget_period,
		expectedBudgetResetAt: row.budget_reset_at,
		budgetMax: preview.after.budget_max,
		budgetBase: preview.after.budget_base,
		budgetSpent: preview.after.budget_spent,
		budgetPeriod: preview.after.budget_period,
		budgetResetAt: preview.after.budget_reset_at,
		resetEpoch,
		metadata: metadataJson,
		audit: userBudgetAuditToInsertRowFull(userId, {
			id: crypto.randomUUID(),
			apiKeyId: null,
			eventType: 'admin_adjust',
			actorType: 'admin',
			actorId,
			reasonCode: 'budget_transition',
			reasonText,
			beforeSpent: before.budget_spent,
			deltaSpent: preview.after.budget_spent - before.budget_spent,
			afterSpent: preview.after.budget_spent,
			beforeBudgetMax: before.budget_max,
			afterBudgetMax: preview.after.budget_max,
			beforeBudgetBase: before.budget_base,
			afterBudgetBase: preview.after.budget_base,
			beforeBudgetPeriod: before.budget_period,
			afterBudgetPeriod: preview.after.budget_period,
			beforeBudgetResetAt: before.budget_reset_at,
			afterBudgetResetAt: preview.after.budget_reset_at,
			changePayloadMerge: JSON.stringify({
				carryover: preview.carryover,
				carryover_strategy: input.carryover_strategy ?? 'remaining_or_overage',
				target_budget_base: roundGatewayMoney(input.target_budget_base),
			}),
			beforeUserSnapshot: beforeSnap,
			afterUserSnapshot: afterSnap,
			changedFields: changedFieldsJson,
			source: 'admin_budget_transition',
			correlationId: crypto.randomUUID(),
		}),
	});
	if (!ok) {
		if (retriesRemaining > 0) {
			return applyBudgetTransitionAttempt(repos, userId, input, actorId, retriesRemaining - 1);
		}
		throw new Error('Failed to apply budget transition');
	}
	return { preview, applied: preview.after };
}

/**
 * 乐观并发应用：每次尝试都重新读取预算 epoch/spent/reserved 快照；关键写事务仅在快照仍一致时写入并审计。
 */
export async function applyBudgetTransition(
	repos: GatewayRepositories,
	userId: string,
	input: BudgetTransitionParams,
	actorId: string = 'master_key',
): Promise<{ preview: BudgetTransitionPreview; applied: BudgetTransitionSnapshot } | null> {
	return applyBudgetTransitionAttempt(repos, userId, input, actorId, 2);
}
