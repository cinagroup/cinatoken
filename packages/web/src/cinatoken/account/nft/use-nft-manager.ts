import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { accountQueryKey, CinaTokenApiError } from '../../api'
import type { NftApi } from '../../nft-api'
import { canRequestNft, hasPendingNft, type NftTier } from '../../nft-contracts'
import { useCinaTokenSession } from '../../session-context'
import {
	invalidatesAccountAccess,
	isAccountContextMismatch,
	requiresSessionRevalidation,
} from '../account-access'

export type NftScope = {
	userId: string
	workspaceId: string
	scopeVersion: number
}
export function nftErrorKey(error: unknown): string {
	if (error instanceof CinaTokenApiError) {
		if (error.code === 'user-mismatch') return 'sessionChanged'
		if (error.code === 'workspace-mismatch') return 'mismatch'
		if (error.status === 401) return 'sessionExpired'
		if (error.status === 409) return 'conflict'
		if (error.status === 503) return 'unavailable'
		if (error.status === 400) return 'invalid'
		if (error.status === 403) return 'forbidden'
		if (error.status === 404) return 'tierMissing'
	}
	return 'mintFailed'
}
export function useNftManager(api: NftApi, scope: NftScope) {
	const session = useCinaTokenSession()
	const client = useQueryClient()
	const active = useRef(false)
	const mutationController = useRef<AbortController | null>(null)
	const [minting, setMinting] = useState<number | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [mutationError, setMutationError] = useState<unknown>(null)
	const [blocked, setBlocked] = useState<string | null>(null)
	const options = useMemo(
		() => ({
			expectedUserId: scope.userId,
			expectedWorkspaceId: scope.workspaceId,
		}),
		[scope.userId, scope.workspaceId]
	)
	const queryKey = useMemo(
		() =>
			accountQueryKey(
				scope.userId,
				scope.workspaceId,
				'nft',
				scope.scopeVersion,
				options
			),
		[scope.userId, scope.workspaceId, scope.scopeVersion, options]
	)
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => api.nftTiers({ ...options, signal }),
		retry: false,
		staleTime: 15_000,
		refetchInterval: (current) =>
			current.state.data &&
			hasPendingNft(current.state.data.data.mints) &&
			!current.state.error
				? 15_000
				: false,
	})
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
			mutationController.current?.abort()
			void client.cancelQueries({ queryKey, exact: true })
			client.removeQueries({ queryKey, exact: true })
		}
	}, [client, queryKey])
	useEffect(
		() =>
			client.getQueryCache().subscribe((event) => {
				if (
					event.type !== 'updated' ||
					event.action.type !== 'error' ||
					client.getQueryCache().find({ queryKey, exact: true }) !== event.query
				)
					return
				const error = event.query.state.error
				if (invalidatesAccountAccess(error)) {
					setBlocked(nftErrorKey(error))
					mutationController.current?.abort()
					if (
						isAccountContextMismatch(error) ||
						requiresSessionRevalidation(error)
					)
						void session.revalidateScope().catch(() => undefined)
				}
			}),
		[client, queryKey, session]
	)
	async function mint(tier: NftTier): Promise<void> {
		if (
			!active.current ||
			mutationController.current ||
			blocked ||
			!query.data ||
			query.isError ||
			!canRequestNft(query.data, tier)
		)
			return
		const controller = new AbortController()
		mutationController.current = controller
		setMinting(tier.badgeTokenId)
		setMutationError(null)
		setNotice(null)
		try {
			await api.mintNft(
				{ badgeTokenId: tier.badgeTokenId },
				{ ...options, signal: controller.signal }
			)
			if (active.current && !controller.signal.aborted)
				setNotice('mintSubmitted')
		} catch (error) {
			if (!active.current || controller.signal.aborted) return
			setMutationError(error)
			if (invalidatesAccountAccess(error)) {
				setBlocked(nftErrorKey(error))
				if (
					isAccountContextMismatch(error) ||
					requiresSessionRevalidation(error)
				)
					void session.revalidateScope().catch(() => undefined)
			}
		} finally {
			if (mutationController.current === controller)
				mutationController.current = null
			if (active.current && !controller.signal.aborted) {
				setMinting(null)
				// A failed network/queue response may still have inserted a pending row.
				// Re-read history, never blindly replay the request.
				await client.invalidateQueries({ queryKey, exact: true })
			}
		}
	}
	async function refresh() {
		const result = await query.refetch()
		if (active.current && result.isSuccess) setBlocked(null)
	}
	return { query, mint, minting, notice, mutationError, blocked, refresh }
}
