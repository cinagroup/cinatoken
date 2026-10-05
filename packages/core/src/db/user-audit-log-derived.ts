/**
 * 从 `before_user_snapshot` / `after_user_snapshot` 派生预算金额列（与已删除的表列语义对齐）。
 */
import { roundGatewayMoney } from '../lib/money-precision';
import type { UserAuditLogRow } from '../types';
import type { UserAuditSnapshot } from './user-audit-snapshot';

type ParsedUserAuditSnapshot = { snapshot: UserAuditSnapshot; hasBudgetMax: boolean };

/** 宽松解析快照 JSON（历史行或回填行可能字段不全）。 */
function parseUserAuditSnapshotWithPresence(raw: string | null | undefined): ParsedUserAuditSnapshot | null {
	if (raw == null || String(raw).trim() === '') return null;
	try {
		const o = JSON.parse(String(raw)) as Record<string, unknown>;
		if (!o || typeof o !== 'object') return null;
		const id = typeof o.id === 'string' ? o.id : '';
		const email = typeof o.email === 'string' ? o.email : '';
		const budget_spent = roundGatewayMoney(Number(o.budget_spent ?? 0));
		let budget_max: number | null = null;
		if (o.budget_max !== undefined && o.budget_max !== null && o.budget_max !== 'null') {
			const n = Number(o.budget_max);
			budget_max = Number.isFinite(n) ? roundGatewayMoney(n) : null;
		}
		const budget_base = roundGatewayMoney(Number(o.budget_base ?? 0));
		const budget_period = typeof o.budget_period === 'string' && o.budget_period !== '' ? o.budget_period : 'none';
		const budget_reset_at =
			o.budget_reset_at === undefined || o.budget_reset_at === null || o.budget_reset_at === ''
				? null
				: String(o.budget_reset_at);
		const budget_epoch = Number.isSafeInteger(Number(o.budget_epoch))
			? Math.max(0, Number(o.budget_epoch))
			: 0;
		const budget_reserved_micros = Number.isSafeInteger(Number(o.budget_reserved_micros))
			? Math.max(0, Number(o.budget_reserved_micros))
			: 0;
		const status = typeof o.status === 'string' ? o.status : '';
		const metadata = o.metadata === undefined || o.metadata === null ? null : String(o.metadata);
		const charged_cost_factors =
			o.charged_cost_factors === undefined || o.charged_cost_factors === null
				? null
				: String(o.charged_cost_factors);
		const external_system =
			o.external_system === undefined || o.external_system === null ? null : String(o.external_system);
		const external_user_id =
			o.external_user_id === undefined || o.external_user_id === null ? null : String(o.external_user_id);
		return {
			hasBudgetMax: Object.hasOwn(o, 'budget_max'),
			snapshot: {
				id,
				email,
				budget_max,
				budget_base,
				budget_spent,
				budget_period,
				budget_reset_at,
				budget_epoch,
				budget_reserved_micros,
				status,
				metadata,
				charged_cost_factors,
				external_system,
				external_user_id,
			},
		};
	} catch {
		return null;
	}
}

export function parseUserAuditSnapshotFromJson(raw: string | null | undefined): UserAuditSnapshot | null {
	return parseUserAuditSnapshotWithPresence(raw)?.snapshot ?? null;
}

export type DerivedUserAuditBudgetFields = Pick<
	UserAuditLogRow,
	| 'before_spent'
	| 'delta_spent'
	| 'after_spent'
	| 'before_budget_max'
	| 'after_budget_max'
	| 'before_budget_base'
	| 'after_budget_base'
>;

/**
 * 由前后快照推导 spent / budget_max；整侧快照缺失时沿用另一侧。
 * budget_max 字段缺失时才跨侧回退，显式 null 保留无限额语义。
 */
export function deriveUserAuditBudgetFromSnapshots(
	beforeSnapshot: string | null | undefined,
	afterSnapshot: string | null | undefined
): DerivedUserAuditBudgetFields {
	const beforeParsed = parseUserAuditSnapshotWithPresence(beforeSnapshot);
	const afterParsed = parseUserAuditSnapshotWithPresence(afterSnapshot);
	const before = beforeParsed?.snapshot;
	const after = afterParsed?.snapshot;
	const beforeSpent = roundGatewayMoney(before?.budget_spent ?? after?.budget_spent ?? 0);
	const afterSpent = roundGatewayMoney(after?.budget_spent ?? before?.budget_spent ?? 0);
	const beforeMaxValue = beforeParsed?.hasBudgetMax ? beforeParsed.snapshot.budget_max : undefined;
	const afterMaxValue = afterParsed?.hasBudgetMax ? afterParsed.snapshot.budget_max : undefined;
	const beforeMax = beforeMaxValue === undefined ? afterMaxValue ?? null : beforeMaxValue;
	const afterMax = afterMaxValue === undefined ? beforeMaxValue ?? null : afterMaxValue;
	const beforeBase = roundGatewayMoney(before?.budget_base ?? after?.budget_base ?? 0);
	const afterBase = roundGatewayMoney(after?.budget_base ?? before?.budget_base ?? 0);
	return {
		before_spent: beforeSpent,
		after_spent: afterSpent,
		delta_spent: roundGatewayMoney(afterSpent - beforeSpent),
		before_budget_max: beforeMax,
		after_budget_max: afterMax,
		before_budget_base: beforeBase,
		after_budget_base: afterBase,
	};
}
