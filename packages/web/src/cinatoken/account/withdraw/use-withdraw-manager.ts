import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { accountQueryKey, CinaTokenApiError } from '../../api'
import { useCinaTokenSession } from '../../session-context'
import type { WalletApi } from '../../wallet-api'
import type { WithdrawalsApi } from '../../withdrawal-api'
import {
	hasActiveWithdrawal,
	type WithdrawalQuoteContext,
} from '../../withdrawal-contracts'
import {
	invalidatesAccountAccess,
	isAccountContextMismatch,
	requiresSessionRevalidation,
} from '../account-access'
import {
	browserEvmProvider,
	WalletConnection,
	WalletConnectionError,
	type WalletPhase,
} from './wallet-connection'

export type WithdrawalScope = {
	userId: string
	workspaceId: string
	scopeVersion: number
	walletAccess: boolean
	withdrawalAccess: boolean
}
export function withdrawalErrorKey(error: unknown): string {
	if (error instanceof WalletConnectionError) return error.reason
	if (error instanceof CinaTokenApiError) {
		if (error.code === 'user-mismatch') return 'sessionChanged'
		if (error.code === 'workspace-mismatch') return 'mismatch'
		if (error.serverCode === 'withdrawal_quote_changed') return 'quoteChanged'
		if (error.serverCode === 'withdrawal_dispatch_unconfirmed')
			return 'dispatchUnconfirmed'
		if (error.status === 401) return 'sessionExpired'
		if (error.status === 403) return 'forbidden'
		if (error.status === 409) return 'conflict'
		if (error.status === 429) return 'dailyLimitError'
		if (error.status === 400) return 'invalid'
		if (error.code === 'cancelled') return 'cancelled'
	}
	return 'requestFailed'
}
export function useWithdrawManager(
	api: WalletApi & WithdrawalsApi,
	scope: WithdrawalScope
) {
	const session = useCinaTokenSession()
	const client = useQueryClient()
	const active = useRef(false)
	const flow = useRef(new WalletConnection())
	const writeController = useRef<AbortController | null>(null)
	const pendingAmount = useRef<number | null>(null)
	const pendingQuote = useRef<WithdrawalQuoteContext | null>(null)
	const [page, setPage] = useState(1)
	const [quote, setQuote] = useState<WithdrawalQuoteContext | null>(null)
	const [phase, setPhase] = useState<WalletPhase | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [blocked, setBlocked] = useState<string | null>(null)
	const options = useMemo(
		() => ({
			expectedUserId: scope.userId,
			expectedWorkspaceId: scope.workspaceId,
		}),
		[scope.userId, scope.workspaceId]
	)
	const baseKey = useMemo(
		() =>
			accountQueryKey(
				scope.userId,
				scope.workspaceId,
				'withdraw',
				scope.scopeVersion,
				options
			),
		[scope.userId, scope.workspaceId, scope.scopeVersion, options]
	)
	const walletKey = useMemo(
		() => [...baseKey, 'wallet', options],
		[baseKey, options]
	)
	const listOptions = useMemo(
		() => ({ ...options, page, pageSize: 20 }),
		[options, page]
	)
	const listKey = useMemo(
		() => [...baseKey, 'history', listOptions],
		[baseKey, listOptions]
	)
	const wallet = useQuery({
		queryKey: walletKey,
		queryFn: ({ signal }) => api.wallet({ ...options, signal }),
		enabled: scope.walletAccess,
		retry: false,
	})
	const history = useQuery({
		queryKey: listKey,
		queryFn: ({ signal }) => api.withdrawals({ ...listOptions, signal }),
		enabled: scope.withdrawalAccess,
		retry: false,
		staleTime: 10000,
		refetchInterval: (current) =>
			current.state.data &&
			hasActiveWithdrawal(current.state.data.activeWithdrawal) &&
			!current.state.error &&
			!blocked
				? 15000
				: false,
	})
	const clear = useCallback(() => {
		flow.current.cancel()
		writeController.current?.abort()
		pendingAmount.current = null
		pendingQuote.current = null
		setQuote(null)
		setPhase(null)
	}, [])
	const handle = useCallback(
		(error: unknown) => {
			if (!active.current) return
			if (invalidatesAccountAccess(error)) {
				clear()
				setBlocked(withdrawalErrorKey(error))
				if (
					isAccountContextMismatch(error) ||
					requiresSessionRevalidation(error)
				)
					void session.revalidateScope().catch(() => undefined)
			}
		},
		[clear, session]
	)
	async function refreshData() {
		await client.invalidateQueries({ queryKey: baseKey })
	}
	const connect = useMutation({
		mutationFn: async (): Promise<void> => {
			if (
				!scope.walletAccess ||
				blocked ||
				!wallet.data ||
				wallet.isError ||
				wallet.data.availability !== 'available'
			)
				return
			setNotice(null)
			setQuote(null)
			pendingQuote.current = null
			await flow.current.connect(
				api,
				options,
				browserEvmProvider(),
				(value) => {
					if (active.current) setPhase(value)
				}
			)
			if (active.current) {
				setNotice('walletVerified')
				await refreshData()
			}
		},
		onError: handle,
		onSettled: () => {
			if (active.current) {
				setPhase(null)
				void refreshData()
			}
		},
	})
	const review = useMutation({
		mutationFn: async (): Promise<void> => {
			const amount = pendingAmount.current
			pendingAmount.current = null
			if (amount === null || blocked || !scope.withdrawalAccess) return
			const controller = new AbortController()
			writeController.current = controller
			try {
				const result = await api.quoteWithdrawal(
					{ amount },
					{ ...options, signal: controller.signal }
				)
				if (active.current && !controller.signal.aborted) {
					pendingQuote.current = result
					setQuote(result)
				}
			} finally {
				if (writeController.current === controller)
					writeController.current = null
			}
		},
		onError: handle,
	})
	const create = useMutation({
		mutationFn: async (): Promise<void> => {
			const approved = pendingQuote.current
			pendingQuote.current = null
			setQuote(null)
			if (!approved || blocked || !scope.withdrawalAccess) return
			const controller = new AbortController()
			writeController.current = controller
			try {
				await api.createWithdrawal(
					{
						amount: approved.data.amount,
						expectedQuote: approved.data.fingerprint,
					},
					{ ...options, signal: controller.signal }
				)
				if (active.current && !controller.signal.aborted) setNotice('submitted')
			} finally {
				if (writeController.current === controller)
					writeController.current = null
				if (active.current && !controller.signal.aborted) await refreshData()
			}
		},
		onError: handle,
	})
	useEffect(() => {
		active.current = true
		const connection = flow.current
		return () => {
			active.current = false
			connection.cancel()
			writeController.current?.abort()
			pendingAmount.current = null
			pendingQuote.current = null
			void client.cancelQueries({ queryKey: baseKey })
			client.removeQueries({ queryKey: baseKey })
		}
	}, [baseKey, client])
	useEffect(
		() =>
			client.getQueryCache().subscribe((event) => {
				if (
					event.type !== 'updated' ||
					event.action.type !== 'error' ||
					![walletKey, listKey].some(
						(key) =>
							client.getQueryCache().find({ queryKey: key, exact: true }) ===
							event.query
					)
				)
					return
				handle(event.query.state.error)
			}),
		[client, walletKey, listKey, handle]
	)
	async function refresh() {
		clear()
		connect.reset()
		review.reset()
		create.reset()
		setNotice(null)
		if (
			blocked === 'mismatch' ||
			blocked === 'sessionChanged' ||
			blocked === 'sessionExpired'
		) {
			await session.revalidateScope()
			if (!active.current) return
		}
		const results = await Promise.all([
			scope.walletAccess ? wallet.refetch() : null,
			scope.withdrawalAccess ? history.refetch() : null,
		])
		if (
			active.current &&
			results.every((result) => result === null || result.isSuccess)
		)
			setBlocked(null)
	}
	return {
		wallet,
		history,
		page,
		setPage,
		quote,
		phase,
		notice,
		blocked,
		connect,
		review,
		create,
		refresh,
		requestReview(amount: number) {
			if (review.isPending || create.isPending || connect.isPending || blocked)
				return
			pendingAmount.current = amount
			setNotice(null)
			review.reset()
			create.reset()
			review.mutate()
		},
		cancelWallet() {
			flow.current.cancel()
			setPhase(null)
		},
		cancelQuote() {
			pendingQuote.current = null
			setQuote(null)
		},
	}
}
