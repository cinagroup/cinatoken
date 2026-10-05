import { z } from 'zod'

const id = z.string().trim().min(1).max(600)
export const walletAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/u)
const timestamp = z
	.string()
	.refine((value) => Number.isFinite(Date.parse(value)))
const chainId = z.number().int().positive().safe()
const identity = { userId: id, workspaceId: id }
export const walletResponseSchema = z
	.object({
		success: z.literal(true),
		...identity,
		availability: z.enum(['available', 'unavailable']),
		chainId: chainId.nullable(),
		data: z
			.object({
				walletAddress: walletAddressSchema.nullable(),
				walletMasked: z.string().nullable(),
				verifiedAt: timestamp.nullable(),
			})
			.strict(),
	})
	.strict()
	.refine(
		(value) =>
			value.data.walletAddress !== null ||
			(value.data.verifiedAt === null && value.data.walletMasked === null)
	)
export const createWalletChallengeInputSchema = z
	.object({ walletAddress: walletAddressSchema })
	.strict()
export const walletChallengeSchema = z
	.object({
		address: walletAddressSchema,
		message: z.string().min(1).max(4096),
		challengeToken: z
			.string()
			.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
			.max(8192),
		origin: z.string().url(),
		chainId,
		issuedAt: z.string().datetime({ offset: true }),
		expiresAt: z.string().datetime({ offset: true }),
	})
	.strict()
	.refine(
		(value) =>
			Date.parse(value.expiresAt) - Date.parse(value.issuedAt) === 300000
	)
export const walletChallengeResponseSchema = z
	.object({
		success: z.literal(true),
		...identity,
		data: walletChallengeSchema,
	})
	.strict()
export const verifyWalletInputSchema = z
	.object({
		challengeToken: walletChallengeSchema.shape.challengeToken,
		signature: z.string().regex(/^0x(?:[a-fA-F0-9]{128}|[a-fA-F0-9]{130})$/u),
	})
	.strict()
export const verifiedWalletSchema = z
	.object({ walletAddress: walletAddressSchema, verifiedAt: timestamp })
	.strict()
export const verifiedWalletResponseSchema = z
	.object({ success: z.literal(true), ...identity, data: verifiedWalletSchema })
	.strict()
export type WalletContext = Omit<
	z.infer<typeof walletResponseSchema>,
	'success'
>
export type WalletChallenge = z.infer<typeof walletChallengeSchema>
export type VerifiedWallet = z.infer<typeof verifiedWalletSchema>
export type CreateWalletChallengeInput = z.infer<
	typeof createWalletChallengeInputSchema
>
export type VerifyWalletInput = z.infer<typeof verifyWalletInputSchema>

/** Validate the exact EIP-4361 message before asking an EOA provider to sign it. */
export function isWalletChallengeContext(
	challenge: WalletChallenge,
	userId: string,
	origin: string,
	address: string,
	now = Date.now()
): boolean {
	let url: URL
	try {
		url = new URL(challenge.origin)
	} catch {
		return false
	}
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.origin !== challenge.origin ||
		challenge.origin !== origin ||
		challenge.address.toLowerCase() !== address.toLowerCase() ||
		Date.parse(challenge.expiresAt) <= now ||
		Date.parse(challenge.issuedAt) > now + 10000
	)
		return false
	const lines = challenge.message.split('\n')
	const nonce = lines[8]?.replace(/^Nonce: /u, '')
	if (!nonce || !/^[a-f0-9]{32}$/u.test(nonce)) return false
	return (
		challenge.message ===
		`${url.host} wants you to sign in with your Ethereum account:\n${challenge.address}\n\nVerify ownership of this wallet for CinaToken withdrawals.\n\nURI: ${url.origin}\nVersion: 1\nChain ID: ${challenge.chainId}\nNonce: ${nonce}\nIssued At: ${challenge.issuedAt}\nExpiration Time: ${challenge.expiresAt}\nRequest ID: ${userId}`
	)
}
