import { z } from 'zod'

const identifier = z.string().min(1).max(600)
const amount = z.number().finite().nonnegative()
export const nftTierIdSchema = z.number().int().nonnegative().safe()
export const nftStatusSchema = z.enum([
	'pending',
	'processing',
	'submitted',
	'confirmed',
	'failed',
])
export const nftTierSchema = z.object({
	badgeTokenId: nftTierIdSchema,
	tierName: z.string().min(1).max(200),
	threshold: amount,
	eligible: z.boolean(),
	minted: z.boolean(),
	progress: z.number().finite().min(0).max(1),
})
export const nftMintSchema = z.object({
	id: identifier,
	userId: identifier,
	badgeTokenId: nftTierIdSchema,
	tierName: z.string().min(1).max(200),
	walletAddress: z.string().min(1).max(256),
	status: nftStatusSchema,
	txHash: z.string().nullable(),
	chainId: z.number().int().positive().safe().nullable(),
	valueSnapshot: amount,
	failureReason: z.string().nullable(),
	createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
	confirmedAt: z
		.string()
		.nullable()
		.refine((value) => value === null || Number.isFinite(Date.parse(value))),
})
const metadata = {
	success: z.literal(true),
	sellerUserId: identifier,
	workspaceId: identifier,
	contributionCurrency: z.literal('USD'),
	amountUnit: z.literal('major'),
	availability: z.enum(['available', 'unavailable']),
}
export const nftTiersResponseSchema = z.object({
	...metadata,
	data: z.object({
		contributionValue: amount,
		highestBadgeTier: z.number().int().nonnegative().safe(),
		tiers: z.array(nftTierSchema),
		mints: z.array(nftMintSchema),
		chainConfigured: z.boolean(),
		walletBound: z.boolean(),
	}),
})
export const nftMintsResponseSchema = z.object({
	...metadata,
	data: z.array(nftMintSchema),
})
export const nftMintResponseSchema = z.object({
	...metadata,
	data: nftMintSchema.nullable(),
})
export type NftTier = z.infer<typeof nftTierSchema>
export type NftMint = z.infer<typeof nftMintSchema>
export type NftTiersResponse = z.infer<typeof nftTiersResponseSchema>
export type NftStatus = z.infer<typeof nftStatusSchema>

/** Existing uniqueness forbids another request for the same user/tier, including failed rows. */
export function canRequestNft(
	snapshot: NftTiersResponse,
	tier: NftTier
): boolean {
	return (
		snapshot.availability === 'available' &&
		snapshot.data.chainConfigured &&
		snapshot.data.walletBound &&
		tier.eligible &&
		!tier.minted &&
		!snapshot.data.mints.some((row) => row.badgeTokenId === tier.badgeTokenId)
	)
}
export function hasPendingNft(mints: readonly NftMint[]): boolean {
	return mints.some((row) =>
		['pending', 'processing', 'submitted'].includes(row.status)
	)
}
/** Only the existing supported explorer is used; an unknown chain never gets a guessed link. */
export function nftTransactionUrl(
	mint: Pick<NftMint, 'txHash' | 'chainId'>
): string | null {
	return mint.chainId === 84532 &&
		mint.txHash &&
		/^0x[a-fA-F0-9]{64}$/.test(mint.txHash)
		? `https://sepolia.basescan.org/tx/${mint.txHash}`
		: null
}
