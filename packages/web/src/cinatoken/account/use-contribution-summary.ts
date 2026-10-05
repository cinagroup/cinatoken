import { useQuery } from '@tanstack/react-query'
import { accountQueryKey, cinatokenApi } from '../api'
import type { PortalMe } from '../contracts'

export type ContributionSummaryScope = {
	user: PortalMe
	workspaceId: string
	scopeVersion: number
}

export function useContributionSummary(scope: ContributionSummaryScope) {
	const canEarn = scope.user.capabilities.includes('earnings.read')
	const canShare = scope.user.capabilities.includes('shared_keys.manage')
	const canNft = scope.user.capabilities.includes('nft.read')
	const options = {
		expectedSellerUserId: scope.user.userId,
		expectedUserId: scope.user.userId,
		expectedWorkspaceId: scope.workspaceId,
	}
	const nftOptions = {
		expectedUserId: scope.user.userId,
		expectedWorkspaceId: scope.workspaceId,
	}
	const key = accountQueryKey(
		scope.user.userId,
		scope.workspaceId,
		'overview-contribution',
		scope.scopeVersion
	)
	const earnings = useQuery({
		queryKey: [...key, 'earnings', options],
		queryFn: ({ signal }) =>
			cinatokenApi.earningsSummary({ ...options, signal }),
		enabled: canEarn,
		retry: false,
		staleTime: 15000,
	})
	const shared = useQuery({
		queryKey: [...key, 'shared', options],
		queryFn: ({ signal }) => cinatokenApi.sharedKeys({ ...options, signal }),
		enabled: canShare,
		retry: false,
		staleTime: 15000,
	})
	const nft = useQuery({
		queryKey: [...key, 'nft', nftOptions],
		queryFn: ({ signal }) => cinatokenApi.nftTiers({ ...nftOptions, signal }),
		enabled: canNft,
		retry: false,
		staleTime: 15000,
	})
	return { canEarn, canShare, canNft, earnings, shared, nft }
}
