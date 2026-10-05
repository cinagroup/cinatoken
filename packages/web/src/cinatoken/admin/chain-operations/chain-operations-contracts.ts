/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { withdrawalStatuses, nftMintStatuses } from './chain-operations-search'

export const chainRecordIdSchema = z
	.string()
	.min(1)
	.max(128)
	.refine(
		(value) =>
			!/[\s/?#%\\\p{Cc}\p{Cf}]/u.test(value) &&
			!/^(?:sk-|enc:|sha256:)/u.test(value)
	)
const publicText = (maximum: number) =>
	z
		.string()
		.min(1)
		.max(maximum)
		.refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
const amount = z.number().finite().nonnegative()
const timestamp = z
	.string()
	.max(64)
	.refine((value) => Number.isFinite(Date.parse(value)))
const txHash = publicText(256).nullable()
const chainId = z.number().int().positive().safe().nullable()
const walletAddress = publicText(256)
const common = {
	id: chainRecordIdSchema,
	userId: publicText(600),
	walletAddress,
	txHash,
	chainId,
	failureReason: publicText(10000).nullable(),
	createdAt: timestamp,
	confirmedAt: timestamp.nullable(),
}
/** Explicit projection drops unknown storage or provider properties before Query. */
export const adminWithdrawalRowSchema = z
	.object({
		...common,
		amount,
		fee: amount,
		netAmount: amount,
		currency: z.string().regex(/^[A-Z]{3}$/u),
		status: z.enum(withdrawalStatuses),
		tokenAmount: amount.nullable(),
		updatedAt: timestamp,
	})
	.superRefine((row, context) => {
		if (
			row.fee > row.amount ||
			Math.abs(Math.round((row.amount - row.fee) * 1e6) / 1e6 - row.netAmount) >
				1e-9 ||
			Date.parse(row.updatedAt) < Date.parse(row.createdAt) ||
			(row.confirmedAt !== null && row.status !== 'confirmed')
		)
			context.addIssue({
				code: 'custom',
				message: 'Invalid withdrawal ledger record',
			})
	})
export const adminNftMintRowSchema = z
	.object({
		...common,
		badgeTokenId: z.number().int().nonnegative().safe(),
		tierName: publicText(256),
		status: z.enum(nftMintStatuses),
		valueSnapshot: amount,
	})
	.superRefine((row, context) => {
		if (row.confirmedAt !== null && row.status !== 'confirmed')
			context.addIssue({ code: 'custom', message: 'Invalid NFT confirmation' })
	})
export const adminWithdrawalListSchema = z.object({
	success: z.literal(true),
	data: z.array(adminWithdrawalRowSchema),
	total: z.number().int().nonnegative().safe(),
	meta: z.object({
		scope: z.literal('global_portal_ledger'),
		withdrawalCurrencySource: z.literal('stored_row'),
		nftValueSnapshotCurrency: z.literal('USD'),
		nftValueSnapshotCurrencySource: z.literal('seller_contribution_ledger'),
		amountUnit: z.literal('major'),
		queueConfigured: z.boolean(),
		processEligibleStatuses: z.tuple([
			z.literal('requested'),
			z.literal('submitted'),
		]),
		rejectEligibleStatus: z.literal('requested'),
	}),
})
export const adminNftMintListSchema = z.object({
	success: z.literal(true),
	data: z.array(adminNftMintRowSchema),
	total: z.number().int().nonnegative().safe(),
	meta: z.object({
		scope: z.literal('global_portal_ledger'),
		withdrawalCurrencySource: z.literal('stored_row'),
		nftValueSnapshotCurrency: z.literal('USD'),
		nftValueSnapshotCurrencySource: z.literal('seller_contribution_ledger'),
		amountUnit: z.literal('major'),
		queueConfigured: z.boolean(),
		processEligibleStatuses: z.tuple([z.literal('pending')]),
	}),
})
export const chainProcessResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({ queued: z.number().int().min(0).max(20) }),
	meta: z.object({
		result: z.literal('queued'),
		chainConfirmation: z.literal(false),
	}),
})
export const chainRejectResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		withdrawalId: chainRecordIdSchema,
		status: z.literal('failed'),
		result: z.literal('rejected_and_refunded'),
	}),
})
export const chainRejectReasonSchema = z
	.string()
	.trim()
	.min(1)
	.refine(
		(value) => Array.from(value).length <= 500 && !/[\p{Cc}\p{Cf}]/u.test(value)
	)
export type AdminWithdrawalRow = z.infer<typeof adminWithdrawalRowSchema>
export type AdminNftMintRow = z.infer<typeof adminNftMintRowSchema>
export type ChainRecord = AdminWithdrawalRow | AdminNftMintRow
export type ChainList =
	| z.infer<typeof adminWithdrawalListSchema>
	| z.infer<typeof adminNftMintListSchema>

export function chainTransactionUrl(
	row: Pick<ChainRecord, 'txHash' | 'chainId'>
): string | null {
	if (!row.txHash || !/^0x[0-9a-fA-F]{64}$/u.test(row.txHash)) return null
	if (row.chainId === 84532)
		return 'https://sepolia.basescan.org/tx/' + row.txHash
	if (row.chainId === 8453) return 'https://basescan.org/tx/' + row.txHash
	return null
}

/** Processing can already have a signed/broadcast chain claim. Never offer a refund. */
export function canRejectChainWithdrawal(
	row: ChainRecord
): row is AdminWithdrawalRow {
	return 'netAmount' in row && row.status === 'requested' && row.txHash === null
}
