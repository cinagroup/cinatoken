import { z } from 'zod'

const identifier = z.string().min(1).max(600)
const amount = z.number().finite().nonnegative()
const count = z.number().int().nonnegative().safe()

/** These are USD major units, already converted from storage micros by the repository.
 * BILLING_CURRENCY belongs to request charging and must never relabel this ledger.
 */
export const earningsSummarySchema = z
	.object({
		userId: identifier,
		balance: amount,
		lockedAmount: amount,
		lifetimeEarned: amount,
		lifetimeWithdrawn: amount,
		contributionValue: amount,
		walletAddress: z.string().nullable(),
		walletVerifiedAt: z.string().nullable(),
		highestBadgeTier: count,
		updatedAt: z.string(),
	})
	.strict()

/** The current ledger has recorded entries, not per-request pending/failed states. */
export const earningSchema = z
	.object({
		id: identifier,
		requestLogId: identifier,
		sharedKeyId: identifier,
		sellerUserId: identifier,
		inputTokens: count,
		outputTokens: count,
		cacheReadTokens: count,
		cacheWriteTokens: count,
		grossAmount: amount,
		platformFee: amount,
		netAmount: amount,
		currency: z.string().regex(/^[A-Z]{3}$/u),
		createdAt: z.string(),
	})
	.strict()

const identity = {
	sellerUserId: identifier,
	workspaceId: identifier,
	earningsCurrency: z.literal('USD'),
	amountUnit: z.literal('major'),
}

export const earningsSummaryResponseSchema = z
	.object({
		success: z.literal(true),
		data: earningsSummarySchema.nullable(),
		...identity,
		availability: z.enum(['available', 'unavailable']),
	})
	.strict()
	.refine(
		(value) => (value.data !== null) === (value.availability === 'available')
	)

export const earningsQuerySchema = z
	.object({
		page: z.number().int().min(1).max(100_000).default(1),
		pageSize: z.number().int().min(1).max(100).default(20),
	})
	.strict()

export const earningsResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.array(earningSchema),
		total: count,
		page: z.number().int().positive(),
		pageSize: z.number().int().min(1).max(100),
		...identity,
	})
	.strict()

export type EarningsSummary = z.infer<typeof earningsSummarySchema>
export type Earning = z.infer<typeof earningSchema>
export type EarningsQuery = z.input<typeof earningsQuerySchema>
export type EarningsSummaryContext = Omit<
	z.infer<typeof earningsSummaryResponseSchema>,
	'success'
>
export type EarningsPage = Omit<
	z.infer<typeof earningsResponseSchema>,
	'success'
>
