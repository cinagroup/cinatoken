/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

export const walletCreditKinds = [
	'topup',
	'signup_bonus',
	'admin_adjust',
	'refund',
] as const
export function walletCreditMicros(value: number): number | null {
	const micros = Math.round(value * 1e6)
	return Number.isFinite(value) &&
		Number.isSafeInteger(micros) &&
		micros / 1e6 === value
		? micros
		: null
}
export function validWalletCreditReference(value: string): boolean {
	return (
		value.length > 0 &&
		Array.from(value).length <= 255 &&
		value.trim().length > 0 &&
		!/[\p{Cc}\p{Cf}]/u.test(value) &&
		!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
			value
		)
	)
}
export const walletCreditInputSchema = z
	.object({
		amount: z.number().refine((v) => v !== 0 && walletCreditMicros(v) !== null),
		kind: z.enum(walletCreditKinds),
		external_ref: z.string().refine(validWalletCreditReference),
		reason: z
			.string()
			.trim()
			.max(2000)
			.refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v))
			.optional(),
	})
	.strict()
export type WalletCreditInput = z.infer<typeof walletCreditInputSchema>
export const walletCreditSnapshotSchema = z
	.object({
		walletGranted: z.number().nonnegative(),
		walletSpent: z.number().nonnegative(),
		walletBalance: z.number(),
	})
	.strict()
	.refine((v) => {
		const granted = walletCreditMicros(v.walletGranted),
			spent = walletCreditMicros(v.walletSpent),
			balance = walletCreditMicros(v.walletBalance)
		return (
			granted !== null &&
			spent !== null &&
			balance !== null &&
			granted - spent === balance
		)
	})
export const walletCreditReceiptSchema = z
	.object({
		version: z.literal(1),
		userId: z.string().uuid(),
		externalRef: z.string().refine(validWalletCreditReference),
		amountMicros: z
			.number()
			.int()
			.safe()
			.refine((v) => v !== 0 && walletCreditMicros(v / 1e6) === v),
		kind: z.enum(walletCreditKinds),
		auditId: z.string().uuid(),
		creditedAt: z.string().datetime({ offset: true }),
		before: walletCreditSnapshotSchema,
		after: walletCreditSnapshotSchema,
	})
	.strict()
	.refine((v) => {
		const before = walletCreditMicros(v.before.walletGranted),
			after = walletCreditMicros(v.after.walletGranted)
		return (
			before !== null &&
			after !== null &&
			Number.isSafeInteger(before + v.amountMicros) &&
			before + v.amountMicros === after &&
			v.before.walletSpent === v.after.walletSpent
		)
	})
export type WalletCreditReceipt = z.infer<typeof walletCreditReceiptSchema>
export const walletCreditObservationSchema = z.discriminatedUnion('status', [
	z
		.object({
			version: z.literal(1),
			status: z.literal('recorded'),
			receipt: walletCreditReceiptSchema,
		})
		.strict(),
	z
		.object({
			version: z.literal(1),
			status: z.enum(['not_found', 'legacy_unverified']),
		})
		.strict(),
])
export type WalletCreditObservation = z.infer<
	typeof walletCreditObservationSchema
>
export function walletCreditMatches(
	receipt: WalletCreditReceipt,
	userId: string,
	input: WalletCreditInput
): boolean {
	return (
		receipt.userId === userId &&
		receipt.externalRef === input.external_ref &&
		receipt.kind === input.kind &&
		receipt.amountMicros === walletCreditMicros(input.amount)
	)
}
export class WalletCreditClientError extends Error {
	constructor(
		readonly code: 'input' | 'legacy' | 'conflict' | 'storage' | 'unavailable'
	) {
		super('Wallet credit could not be verified')
	}
}
export function walletCreditFormInput(value: {
	amount: string
	kind: string
	external_ref: string
	reason: string
}): WalletCreditInput {
	const raw = value.amount.trim()
	if (raw.length > 18 || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(raw))
		throw new WalletCreditClientError('input')
	const negative = raw.startsWith('-')
	const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.')
	const micros =
		(BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))) *
		(negative ? -1n : 1n)
	const numeric = Number(raw)
	if (
		micros > BigInt(Number.MAX_SAFE_INTEGER) ||
		micros < BigInt(-Number.MAX_SAFE_INTEGER) ||
		walletCreditMicros(numeric) !== Number(micros)
	)
		throw new WalletCreditClientError('input')
	const parsed = walletCreditInputSchema.safeParse({
		amount: numeric,
		kind: value.kind,
		external_ref: value.external_ref.trim(),
		reason: value.reason,
	})
	if (!parsed.success) throw new WalletCreditClientError('input')
	return parsed.data
}
