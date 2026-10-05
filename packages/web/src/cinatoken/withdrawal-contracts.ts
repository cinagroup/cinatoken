import { z } from 'zod'
import { walletAddressSchema } from './wallet-contracts'

const id = z.string().trim().min(1).max(600)
const amount = z.number().finite().nonnegative()
const count = z.number().int().nonnegative().safe()
const time = z.string().refine((value) => Number.isFinite(Date.parse(value)))
export const withdrawalStatusSchema = z.enum([
	'requested',
	'processing',
	'submitted',
	'confirmed',
	'failed',
])
/** Ledger amounts are already USD major units. Token quantity is CINA-C major units,
 * calculated from netAmount after the fee. Billing currency never relabels either. */
export const withdrawalSchema = z
	.object({
		id,
		userId: id,
		amount,
		fee: amount,
		netAmount: amount,
		currency: z.string().regex(/^[A-Z]{3}$/u),
		walletAddress: walletAddressSchema,
		status: withdrawalStatusSchema,
		tokenAmount: amount.nullable(),
		txHash: z
			.string()
			.regex(/^0x[0-9a-fA-F]{64}$/u)
			.nullable(),
		chainId: z.number().int().positive().safe().nullable(),
		failureReason: z.string().nullable(),
		createdAt: time,
		updatedAt: time,
		confirmedAt: time.nullable(),
	})
	.strict()
	.refine(
		(value) =>
			value.amount >= value.fee &&
			Math.abs(
				Math.round((value.amount - value.fee) * 1000000) / 1000000 -
					value.netAmount
			) < 1e-9 &&
			Date.parse(value.updatedAt) >= Date.parse(value.createdAt) &&
			(value.confirmedAt === null ||
				(value.status === 'confirmed' &&
					Date.parse(value.confirmedAt) >= Date.parse(value.createdAt)))
	)
export const withdrawalPolicySchema = z
	.object({
		minAmount: amount,
		fee: amount,
		tokenRate: amount,
		dailyLimit: z.number().int().positive().safe(),
	})
	.strict()
const context = {
	userId: id,
	workspaceId: id,
	withdrawalCurrency: z.literal('USD'),
	amountUnit: z.literal('major'),
	tokenSymbol: z.literal('CINA-C'),
	tokenAmountUnit: z.literal('major'),
	policy: withdrawalPolicySchema,
	availability: z.enum(['available', 'unavailable']),
	queueConfigured: z.boolean(),
	chainId: z.number().int().positive().safe().nullable(),
	balance: amount.nullable(),
	lockedAmount: amount.nullable(),
	walletAddress: walletAddressSchema.nullable(),
	walletVerifiedAt: time.nullable(),
	activeWithdrawal: withdrawalSchema.nullable(),
	dailyRemaining: count,
}
export const withdrawalQuerySchema = z
	.object({
		page: z.number().int().min(1).max(100000).default(1),
		pageSize: z.number().int().min(1).max(100).default(20),
	})
	.strict()
export const withdrawalPageResponseSchema = z
	.object({
		success: z.literal(true),
		...context,
		data: z.array(withdrawalSchema),
		total: count,
		page: z.number().int().positive(),
		pageSize: z.number().int().min(1).max(100),
	})
	.strict()
export const withdrawalAmountSchema = z
	.number()
	.finite()
	.positive()
	.refine(
		(value) =>
			Number.isSafeInteger(Math.round(value * 1000000)) &&
			Math.abs(Math.round(value * 1000000) / 1000000 - value) < 1e-10
	)
export const quoteWithdrawalInputSchema = z
	.object({ amount: withdrawalAmountSchema })
	.strict()
export const withdrawalQuoteSchema = z
	.object({
		amount: withdrawalAmountSchema,
		fee: amount,
		netAmount: amount,
		tokenAmount: amount,
		fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
	})
	.strict()
export const withdrawalQuoteResponseSchema = z
	.object({ success: z.literal(true), ...context, data: withdrawalQuoteSchema })
	.strict()
export const createWithdrawalInputSchema = z
	.object({
		amount: withdrawalAmountSchema,
		expectedQuote: withdrawalQuoteSchema.shape.fingerprint.optional(),
	})
	.strict()
export const createdWithdrawalResponseSchema = z
	.object({ success: z.literal(true), ...context, data: withdrawalSchema })
	.strict()
	.refine((value) => value.data.currency === 'USD')
export type Withdrawal = z.infer<typeof withdrawalSchema>
export type WithdrawalPage = Omit<
	z.infer<typeof withdrawalPageResponseSchema>,
	'success'
>
export type WithdrawalQuoteContext = Omit<
	z.infer<typeof withdrawalQuoteResponseSchema>,
	'success'
>
export type WithdrawalQuery = z.input<typeof withdrawalQuerySchema>
export type CreateWithdrawalInput = z.infer<typeof createWithdrawalInputSchema>
export type QuoteWithdrawalInput = z.infer<typeof quoteWithdrawalInputSchema>
export function hasActiveWithdrawal(
	value: Withdrawal | null | undefined
): boolean {
	return (
		value !== null &&
		value !== undefined &&
		['requested', 'processing', 'submitted'].includes(value.status)
	)
}
export function withdrawalTransactionUrl(value: Withdrawal): string | null {
	if (!value.txHash || !/^0x[0-9a-fA-F]{64}$/u.test(value.txHash)) return null
	if (value.chainId === 84532)
		return `https://sepolia.basescan.org/tx/${value.txHash}`
	if (value.chainId === 8453) return `https://basescan.org/tx/${value.txHash}`
	return null
}
