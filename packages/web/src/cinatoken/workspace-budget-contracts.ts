import { z } from 'zod'

export const WORKSPACE_BUDGET_INTERVALS = [
	'daily',
	'weekly',
	'monthly',
	'lifetime',
] as const
export const WORKSPACE_BUDGET_MICROS_PER_UNIT = 1_000_000
export const workspaceBudgetIntervalSchema = z.enum(WORKSPACE_BUDGET_INTERVALS)
export const workspaceBudgetScopeSchema = z
	.string()
	.min(1)
	.max(600)
	.refine(
		(value) =>
			value.trim() === value &&
			Array.from(value).every(
				(character) =>
					character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
			)
	)

const timestamp = z
	.string()
	.min(1)
	.refine((value) => Number.isFinite(Date.parse(value)))
const currency = z.string().regex(/^[A-Z]{3}$/u)
// A valid stored integer divided into main units can lose its final fractional
// digit near MAX_SAFE_INTEGER. Do not reject that real response by rescaling it.
const amount = z
	.number()
	.finite()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER / WORKSPACE_BUDGET_MICROS_PER_UNIT)

/** Legacy '*Usd' names carry deployment billing-currency main units, not Generation USD snapshots. */
export const workspaceBudgetSchema = z
	.object({
		id: z.string().min(1),
		workspaceId: workspaceBudgetScopeSchema,
		limitUsd: amount.positive(),
		resetInterval: workspaceBudgetIntervalSchema,
		periodStart: timestamp,
		periodEnd: timestamp,
		spentUsd: amount,
		reservedUsd: amount,
		remainingUsd: amount,
		createdAt: timestamp,
		updatedAt: timestamp,
	})
	.strict()
	.refine(
		(value) => Date.parse(value.periodStart) < Date.parse(value.periodEnd),
		'Budget period is invalid'
	)

/** Preserve the server's rounding policy; it does not reject inputs solely for extra decimal places. */
export const setWorkspaceBudgetInputSchema = z
	.object({
		limit_usd: z
			.number()
			.finite()
			.positive()
			.refine((value) => {
				const micros = Math.round(value * WORKSPACE_BUDGET_MICROS_PER_UNIT)
				return Number.isSafeInteger(micros) && micros > 0
			}, 'Budget limit must round to a positive safe micro-unit integer'),
	})
	.strict()

export const workspaceBudgetsResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.array(workspaceBudgetSchema).max(WORKSPACE_BUDGET_INTERVALS.length),
		workspaceId: workspaceBudgetScopeSchema,
		billingCurrency: currency,
		canManage: z.boolean(),
	})
	.strict()
	.refine(
		(value) =>
			new Set(value.data.map((row) => row.resetInterval)).size ===
				value.data.length &&
			new Set(value.data.map((row) => row.id)).size === value.data.length,
		'Duplicate workspace budget intervals or identities'
	)

export const workspaceBudgetUpdateResponseSchema = z
	.object({
		success: z.literal(true),
		data: workspaceBudgetSchema,
		workspaceId: workspaceBudgetScopeSchema,
		billingCurrency: currency,
	})
	.strict()

export type WorkspaceBudgetInterval = z.infer<
	typeof workspaceBudgetIntervalSchema
>
export type WorkspaceBudget = z.infer<typeof workspaceBudgetSchema>
export type SetWorkspaceBudgetInput = z.input<
	typeof setWorkspaceBudgetInputSchema
>
export type WorkspaceBudgetContext = {
	budgets: WorkspaceBudget[]
	workspaceId: string
	billingCurrency: string
	canManage: boolean
}
export type WorkspaceBudgetUpdate = {
	budget: WorkspaceBudget
	workspaceId: string
	billingCurrency: string
}
