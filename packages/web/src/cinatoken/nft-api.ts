import type { z } from 'zod'
import type { RequestOptions } from './api'
import {
	nftMintResponseSchema,
	nftMintsResponseSchema,
	nftTierIdSchema,
	nftTiersResponseSchema,
	type NftMint,
} from './nft-contracts'

export type NftRequestOptions = RequestOptions & {
	expectedUserId: string
	expectedWorkspaceId: string
}
type NftTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RequestOptions
	): Promise<T>
	checkWorkspace(actual: string, options: RequestOptions): void
	invalidResponse(message: string): never
}
export function createNftApi(transport: NftTransport) {
	function options(value: NftRequestOptions): void {
		if (!value.expectedUserId || !value.expectedWorkspaceId)
			throw new TypeError('NFT user and workspace context required')
	}
	function check<T extends { sellerUserId: string; workspaceId: string }>(
		value: T,
		scope: NftRequestOptions,
		mints: readonly NftMint[]
	): T {
		transport.checkWorkspace(value.workspaceId, scope)
		if (
			value.sellerUserId !== scope.expectedUserId ||
			mints.some((row) => row.userId !== scope.expectedUserId)
		)
			transport.invalidResponse('Server returned another NFT asset owner')
		if (new Set(mints.map((row) => row.id)).size !== mints.length)
			transport.invalidResponse('Server returned duplicate NFT mint records')
		return value
	}
	return {
		nftTiers: async (scope: NftRequestOptions) => {
			options(scope)
			const value = await transport.send(
				'/api/user/nft/tiers',
				nftTiersResponseSchema,
				{},
				scope
			)
			check(value, scope, value.data.mints)
			if (
				new Set(value.data.tiers.map((tier) => tier.badgeTokenId)).size !==
				value.data.tiers.length
			)
				transport.invalidResponse('Server returned duplicate NFT tiers')
			return value
		},
		nftMints: async (scope: NftRequestOptions) => {
			options(scope)
			const value = await transport.send(
				'/api/user/nft/mints',
				nftMintsResponseSchema,
				{},
				scope
			)
			return check(value, scope, value.data)
		},
		mintNft: async (
			input: { badgeTokenId: number },
			scope: NftRequestOptions
		) => {
			options(scope)
			const id = nftTierIdSchema.parse(input.badgeTokenId)
			const value = await transport.send(
				'/api/user/nft/mint',
				nftMintResponseSchema,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ badgeTokenId: id }),
				},
				scope
			)
			check(value, scope, value.data ? [value.data] : [])
			if (value.data && value.data.badgeTokenId !== id)
				transport.invalidResponse('Server returned another NFT tier')
			return value
		},
	}
}
export type NftApi = ReturnType<typeof createNftApi>
