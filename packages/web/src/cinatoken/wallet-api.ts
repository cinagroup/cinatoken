import { z } from 'zod'
import type { RequestOptions } from './api'
import {
	createWalletChallengeInputSchema,
	isWalletChallengeContext,
	verifiedWalletResponseSchema,
	verifyWalletInputSchema,
	walletChallengeResponseSchema,
	walletResponseSchema,
	type CreateWalletChallengeInput,
	type VerifiedWallet,
	type VerifyWalletInput,
	type WalletChallenge,
	type WalletContext,
} from './wallet-contracts'

export type WalletRequestOptions = RequestOptions & {
	expectedUserId: string
	expectedWorkspaceId: string
	expectedOrigin?: string
}
type WalletTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RequestOptions
	): Promise<T>
	checkWorkspace(actual: string, options: RequestOptions): void
	invalidResponse(message: string): never
	sanitizeError(error: unknown): unknown
}
export function createWalletApi(transport: WalletTransport) {
	function scope(options: WalletRequestOptions) {
		z.string().trim().min(1).max(600).parse(options.expectedUserId)
		z.string().trim().min(1).max(600).parse(options.expectedWorkspaceId)
	}
	function check(
		result: { userId: string; workspaceId: string },
		options: WalletRequestOptions
	) {
		transport.checkWorkspace(result.workspaceId, options)
		if (result.userId !== options.expectedUserId)
			transport.invalidResponse('Server returned another wallet owner')
	}
	async function safe<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation()
		} catch (error) {
			throw transport.sanitizeError(error)
		}
	}
	function body(input: unknown): RequestInit {
		return {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input),
		}
	}
	return {
		wallet: async (options: WalletRequestOptions): Promise<WalletContext> => {
			scope(options)
			const result = await transport.send(
				'/api/user/wallet',
				walletResponseSchema,
				{},
				options
			)
			check(result, options)
			const { success: _success, ...context } = result
			return context
		},
		createWalletChallenge: async (
			input: CreateWalletChallengeInput,
			options: WalletRequestOptions
		): Promise<WalletChallenge> =>
			safe(async () => {
				scope(options)
				const parsed = createWalletChallengeInputSchema.parse(input)
				const result = await transport.send(
					'/api/user/wallet/challenge',
					walletChallengeResponseSchema,
					body(parsed),
					options
				)
				check(result, options)
				const origin = options.expectedOrigin ?? globalThis.location?.origin
				if (
					!origin ||
					!isWalletChallengeContext(
						result.data,
						options.expectedUserId,
						origin,
						parsed.walletAddress
					)
				)
					transport.invalidResponse(
						'Server returned an inconsistent wallet challenge'
					)
				return result.data
			}),
		verifyWallet: async (
			input: VerifyWalletInput,
			options: WalletRequestOptions
		): Promise<VerifiedWallet> =>
			safe(async () => {
				scope(options)
				const parsed = verifyWalletInputSchema.parse(input)
				const result = await transport.send(
					'/api/user/wallet/verify',
					verifiedWalletResponseSchema,
					body(parsed),
					options
				)
				check(result, options)
				return result.data
			}),
	}
}
export type WalletApi = ReturnType<typeof createWalletApi>
