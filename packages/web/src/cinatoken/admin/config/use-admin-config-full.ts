/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
	adminConfigAccessRecovery,
	configAccessIdentityKey,
} from './config-access-recovery'
import type { AdminConfigApi } from './config-api'
import {
	billingCurrencyWrite,
	normalizeBusinessTimezoneWrite,
	normalizeWebhookWrite,
	routeStrategyName,
	type AdminConfigBillingCurrency,
	type AdminConfigOverview,
	type AdminConfigRouteStrategy,
	type AdminConfigRevision,
	type AdminConfigWebhookChannel,
} from './config-contracts'
import {
	configAccessLost,
	configInvalidResponse,
	configWriteUncertain,
} from './config-errors'
import { configFullErrorKey } from './config-full-errors'
import {
	reconcileConfigWrite,
	type PendingConfigWrite,
} from './config-full-reconciliation'
import { adminConfigFullWriteRecovery } from './config-full-write-recovery'
import { adminConfigWriteRecovery } from './config-write-recovery'

export type ConfigField =
	'timezone' | 'currency' | 'strategy' | AdminConfigWebhookChannel
export type ConfigIntent =
	| { field: 'timezone'; kind: 'timezone'; value: string }
	| { field: 'currency'; kind: 'currency'; value: AdminConfigBillingCurrency }
	| { field: 'strategy'; kind: 'strategy'; value: AdminConfigRouteStrategy }
	| {
			field: AdminConfigWebhookChannel
			kind: 'webhook-replace' | 'webhook-clear'
	  }
type ConfigWriteIntent = ConfigIntent & {
	expectedRevision: AdminConfigRevision
}

export type AdminConfigFullProps = {
	api: AdminConfigApi
	scopeKey: string
	/** Stable user ID, verified Console subject and portal epoch. */
	reconciliationKey: string
	canWrite: boolean
	revalidate: () => Promise<void>
}

const fields: ConfigField[] = [
	'timezone',
	'currency',
	'strategy',
	'wecom',
	'feishu',
]

function pendingFromIntent(chosen: ConfigIntent): PendingConfigWrite {
	if (chosen.kind === 'timezone')
		return { kind: 'timezone', value: chosen.value, acknowledged: false }
	if (chosen.kind === 'currency')
		return { kind: 'currency', value: chosen.value, acknowledged: false }
	if (chosen.kind === 'strategy')
		return { kind: 'strategy', value: chosen.value, acknowledged: false }
	return { kind: chosen.kind, channel: chosen.field, acknowledged: false }
}

function revisionFor(
	data: AdminConfigOverview,
	field: ConfigField
): AdminConfigRevision {
	if (field === 'timezone') return data.businessTimezone.revision
	if (field === 'currency') return data.billingCurrency.revision
	if (field === 'strategy') return data.routeStrategy.revision
	return data.webhooks[field].revision
}

export function useAdminConfigFull(props: AdminConfigFullProps) {
	const client = useQueryClient()
	const accessKey = configAccessIdentityKey(props.reconciliationKey)
	const queryKey = useMemo(
		() => ['cinatoken', 'admin', props.scopeKey, 'config-overview'] as const,
		[props.scopeKey]
	)
	const keys = useMemo(
		() =>
			Object.fromEntries(
				fields.map((field) => [
					field,
					field === 'wecom' || field === 'feishu'
						? `${accessKey}:full:${field}`
						: `${props.reconciliationKey}:full:${field}`,
				])
			) as Record<ConfigField, string>,
		[accessKey, props.reconciliationKey]
	)
	const recovery = adminConfigFullWriteRecovery(props.api)
	const timezoneRecovery = adminConfigWriteRecovery(props.api)
	const access = adminConfigAccessRecovery(props.api)
	const accessRevoked = useSyncExternalStore(
		access.subscribe,
		() => access.getSnapshot(accessKey),
		() => access.getSnapshot(accessKey)
	)
	const timezoneLocked = useSyncExternalStore(
		timezoneRecovery.subscribe,
		() => timezoneRecovery.getSnapshot(accessKey),
		() => timezoneRecovery.getSnapshot(accessKey)
	)
	const currencyLocked = useSyncExternalStore(
		recovery.subscribe,
		() => recovery.getSnapshot(keys.currency),
		() => recovery.getSnapshot(keys.currency)
	)
	const strategyLocked = useSyncExternalStore(
		recovery.subscribe,
		() => recovery.getSnapshot(keys.strategy),
		() => recovery.getSnapshot(keys.strategy)
	)
	const wecomLocked = useSyncExternalStore(
		recovery.subscribe,
		() => recovery.getSnapshot(keys.wecom),
		() => recovery.getSnapshot(keys.wecom)
	)
	const feishuLocked = useSyncExternalStore(
		recovery.subscribe,
		() => recovery.getSnapshot(keys.feishu),
		() => recovery.getSnapshot(keys.feishu)
	)
	const locked: Record<ConfigField, boolean> = {
		timezone: timezoneLocked,
		currency: currencyLocked,
		strategy: strategyLocked,
		wecom: wecomLocked,
		feishu: feishuLocked,
	}
	const [timezoneDraft, setTimezoneDraft] = useState<string | null>(null)
	const [currencyDraft, setCurrencyDraft] =
		useState<AdminConfigBillingCurrency | null>(null)
	const [strategyDraft, setStrategyDraft] =
		useState<AdminConfigRouteStrategy | null>(null)
	const [webhookDraft, setWebhookDraft] = useState<
		Record<AdminConfigWebhookChannel, string>
	>({ wecom: '', feishu: '' })
	const [editingWebhook, setEditingWebhook] =
		useState<AdminConfigWebhookChannel | null>(null)
	const [revealed, setRevealed] = useState<{
		channel: AdminConfigWebhookChannel
		value: string
	} | null>(null)
	const [confirmation, setConfirmation] = useState<ConfigWriteIntent | null>(
		null
	)
	const [resolutionChannel, setResolutionChannel] =
		useState<AdminConfigWebhookChannel | null>(null)
	const [errorKey, setErrorKey] = useState<string | null>(null)
	const [statusKey, setStatusKey] = useState<string | null>(null)
	const [refreshing, setRefreshing] = useState(false)
	const [revealing, setRevealing] = useState<AdminConfigWebhookChannel | null>(
		null
	)
	const [verifying, setVerifying] = useState<AdminConfigWebhookChannel | null>(
		null
	)
	const [readFailed, setReadFailed] = useState(false)
	const [reconciled, setReconciled] = useState<
		Record<AdminConfigWebhookChannel, boolean>
	>({ wecom: false, feishu: false })
	const [candidateAvailable, setCandidateAvailable] = useState<
		Record<AdminConfigWebhookChannel, boolean>
	>({ wecom: false, feishu: false })
	const candidate = useRef<Record<AdminConfigWebhookChannel, string | null>>({
		wecom: null,
		feishu: null,
	})
	const intent = useRef<ConfigWriteIntent | null>(null)
	const active = useRef(true)
	const epoch = useRef(0)
	const revealGeneration = useRef(0)
	const controller = useRef<AbortController | null>(null)
	const overview = useQuery({
		queryKey,
		queryFn: ({ signal }) => props.api.configOverview({ signal }),
		enabled: !accessRevoked,
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	const pendingFor = (field: ConfigField): PendingConfigWrite | null =>
		field === 'timezone'
			? timezoneRecovery.getPending(accessKey)
			: recovery.getPending(keys[field])
	const settle = (field: ConfigField): void => {
		if (field === 'timezone') timezoneRecovery.settle(accessKey)
		else recovery.settle(keys[field])
	}

	const clearSecrets = useCallback(() => {
		revealGeneration.current += 1
		candidate.current.wecom = null
		candidate.current.feishu = null
		setCandidateAvailable({ wecom: false, feishu: false })
		setWebhookDraft({ wecom: '', feishu: '' })
		setRevealed(null)
		setRevealing(null)
		setEditingWebhook(null)
		setResolutionChannel(null)
	}, [])
	const revoke = useCallback(
		(error: unknown) => {
			if (!configAccessLost(error) && !configInvalidResponse(error)) return
			epoch.current += 1
			const firstDenial = access.block(accessKey)
			clearSecrets()
			setConfirmation(null)
			controller.current?.abort()
			void client.cancelQueries({ queryKey })
			client.removeQueries({ queryKey })
			if (configAccessLost(error) && firstDenial)
				void props.revalidate().catch(() => undefined)
		},
		[access, accessKey, clearSecrets, client, props, queryKey]
	)
	useEffect(
		() =>
			client.getQueryCache().subscribe((event) => {
				if (event.type !== 'updated' || event.action.type !== 'error') return
				if (event.query.queryKey.length !== queryKey.length) return
				if (
					!queryKey.every((part, index) => event.query.queryKey[index] === part)
				)
					return
				revoke(event.query.state.error)
			}),
		[client, queryKey, revoke]
	)
	useEffect(() => {
		active.current = true
		const candidates = candidate.current
		return () => {
			active.current = false
			epoch.current += 1
			revealGeneration.current += 1
			controller.current?.abort()
			candidates.wecom = null
			candidates.feishu = null
			intent.current = null
			void client.cancelQueries({ queryKey })
			client.removeQueries({ queryKey })
		}
	}, [client, queryKey])
	useEffect(() => {
		const clearOnHide = () => {
			if (document.hidden) clearSecrets()
		}
		window.addEventListener('pagehide', clearSecrets)
		document.addEventListener('visibilitychange', clearOnHide)
		return () => {
			window.removeEventListener('pagehide', clearSecrets)
			document.removeEventListener('visibilitychange', clearOnHide)
		}
	}, [clearSecrets])

	const readFresh = useCallback(
		async (allowRevoked = false): Promise<AdminConfigOverview | null> => {
			const abort = new AbortController()
			const startingEpoch = epoch.current
			controller.current = abort
			try {
				await client.cancelQueries({ queryKey })
				const fresh = await props.api.configOverview({ signal: abort.signal })
				if (
					!active.current ||
					abort.signal.aborted ||
					epoch.current !== startingEpoch ||
					(accessRevoked && !allowRevoked)
				)
					return null
				client.setQueryData(queryKey, fresh)
				revealGeneration.current += 1
				setRevealed(null)
				setRevealing(null)
				if (!fresh.canReveal) {
					candidate.current.wecom = null
					candidate.current.feishu = null
					setCandidateAvailable({ wecom: false, feishu: false })
					setRevealed(null)
				}
				if (!fresh.canWrite) {
					setWebhookDraft({ wecom: '', feishu: '' })
					setEditingWebhook(null)
				}
				setReadFailed(false)
				setErrorKey(null)
				return fresh
			} catch (error) {
				if (active.current && !abort.signal.aborted) {
					revealGeneration.current += 1
					revoke(error)
					setReadFailed(true)
					setErrorKey(configFullErrorKey(error))
					setRevealed(null)
					setRevealing(null)
				}
				return null
			} finally {
				if (controller.current === abort) controller.current = null
			}
		},
		[accessRevoked, client, props.api, queryKey, revoke]
	)

	const mutation = useMutation<void, Error, ConfigField>({
		mutationKey: [...queryKey, 'full-config-write'],
		retry: false,
		gcTime: 0,
		mutationFn: async (field) => {
			const chosen = intent.current
			if (!chosen || chosen.field !== field) return
			const abort = new AbortController()
			controller.current = abort
			const startingEpoch = epoch.current
			try {
				if (chosen.kind === 'timezone')
					await props.api.updateBusinessTimezone(
						chosen.value,
						chosen.expectedRevision,
						{
							signal: abort.signal,
						}
					)
				if (chosen.kind === 'currency')
					await props.api.updateBillingCurrency(
						chosen.value,
						chosen.expectedRevision,
						{
							signal: abort.signal,
						}
					)
				if (chosen.kind === 'strategy')
					await props.api.updateRouteStrategy(
						chosen.value,
						chosen.expectedRevision,
						{
							signal: abort.signal,
						}
					)
				if (chosen.kind === 'webhook-clear')
					await props.api.clearWebhook(chosen.field, chosen.expectedRevision, {
						signal: abort.signal,
					})
				if (chosen.kind === 'webhook-replace') {
					const value = candidate.current[chosen.field]
					if (value === null) {
						recovery.settle(keys[field])
						setErrorKey('cinatoken.adminConfigFull.requestFailed')
						return
					}
					await props.api.replaceWebhook(
						chosen.field,
						value,
						chosen.expectedRevision,
						{
							signal: abort.signal,
						}
					)
				}
				if (
					!active.current ||
					abort.signal.aborted ||
					epoch.current !== startingEpoch
				)
					return
				if (field !== 'timezone') recovery.acknowledge(keys[field])
				const fresh = await readFresh()
				if (fresh) {
					const pending = pendingFor(field)
					const decision = pending
						? reconcileConfigWrite(
								pending,
								fresh,
								undefined,
								field === 'wecom' || field === 'feishu'
									? candidate.current[field] !== null
									: true
							)
						: 'differs'
					if (decision === 'requires-verification') {
						setReconciled((prior) => ({ ...prior, [field]: true }))
						setStatusKey('cinatoken.adminConfigFull.refreshPending')
						return
					}
					settle(field)
					if (field === 'wecom' || field === 'feishu') {
						candidate.current[field] = null
						setCandidateAvailable((prior) => ({ ...prior, [field]: false }))
					}
					setReconciled((prior) => ({ ...prior, [field]: false }))
					setStatusKey(
						`cinatoken.adminConfigFull.${decision === 'matches' ? 'saved' : 'currentDiffers'}`
					)
				}
			} catch (error) {
				if (active.current && !abort.signal.aborted) {
					revoke(error)
					if (
						typeof error === 'object' &&
						error !== null &&
						'status' in error &&
						error.status === 412
					)
						setReadFailed(true)
					if (!configWriteUncertain(error)) {
						settle(field)
						if (field === 'wecom' || field === 'feishu') {
							candidate.current[field] = null
							setCandidateAvailable((prior) => ({ ...prior, [field]: false }))
						}
					}
					setErrorKey(configFullErrorKey(error))
				}
				throw error
			} finally {
				intent.current = null
				if (controller.current === abort) controller.current = null
			}
		},
	})

	async function refresh(): Promise<void> {
		if (refreshing || mutation.isPending || revealing || verifying) return
		setRefreshing(true)
		setStatusKey(null)
		revealGeneration.current += 1
		setRevealed(null)
		setRevealing(null)
		try {
			const fresh = await readFresh(accessRevoked)
			if (!fresh) return
			access.settle(accessKey)
			let matched = false
			let differed = false
			let awaitingVerification = false
			for (const field of fields) {
				const isTimezonePending =
					field === 'timezone' && timezoneRecovery.getSnapshot(accessKey)
				const pending = pendingFor(field)
				if (!pending) {
					if (isTimezonePending) settle(field)
					continue
				}
				const decision = reconcileConfigWrite(
					pending,
					fresh,
					undefined,
					field === 'wecom' || field === 'feishu'
						? candidate.current[field] !== null
						: true
				)
				if (decision === 'requires-verification') {
					awaitingVerification = true
					if (field === 'wecom' || field === 'feishu')
						setReconciled((prior) => ({ ...prior, [field]: true }))
					continue
				}
				if (decision === 'matches') matched = true
				if (decision === 'differs') differed = true
				settle(field)
				if (field === 'wecom' || field === 'feishu') {
					candidate.current[field] = null
					setCandidateAvailable((prior) => ({ ...prior, [field]: false }))
				}
			}
			if (differed) setStatusKey('cinatoken.adminConfigFull.currentDiffers')
			else if (awaitingVerification)
				setStatusKey('cinatoken.adminConfigFull.refreshPending')
			else if (matched) setStatusKey('cinatoken.adminConfigFull.currentMatches')
			else setStatusKey('cinatoken.adminConfigFull.refreshed')
		} catch (error) {
			if (active.current) setErrorKey(configFullErrorKey(error))
		} finally {
			if (active.current) setRefreshing(false)
		}
	}

	function askConfirmation(action: ConfigIntent): void {
		if (
			!data ||
			!props.canWrite ||
			!data.canWrite ||
			locked[action.field] ||
			mutation.isPending ||
			refreshing ||
			revealing ||
			verifying
		)
			return
		try {
			if (action.kind === 'timezone')
				action.value = normalizeBusinessTimezoneWrite(action.value)
			if (
				action.kind === 'currency' &&
				!billingCurrencyWrite.safeParse(action.value).success
			)
				return
			if (
				action.kind === 'strategy' &&
				!routeStrategyName.safeParse(action.value).success
			)
				return
			if (action.kind === 'webhook-replace')
				normalizeWebhookWrite(action.field, webhookDraft[action.field])
			setErrorKey(null)
			setStatusKey(null)
			setConfirmation({
				...action,
				expectedRevision: revisionFor(data, action.field),
			})
		} catch (error) {
			setErrorKey(configFullErrorKey(error))
		}
	}

	function confirm(): void {
		const chosen = confirmation
		if (
			!chosen ||
			!data ||
			!props.canWrite ||
			!data.canWrite ||
			locked[chosen.field] ||
			mutation.isPending ||
			refreshing
		)
			return
		try {
			const replacement =
				chosen.kind === 'webhook-replace'
					? normalizeWebhookWrite(chosen.field, webhookDraft[chosen.field])
					: null
			if (chosen.field === 'timezone')
				timezoneRecovery.mark(accessKey, pendingFromIntent(chosen))
			else recovery.mark(keys[chosen.field], pendingFromIntent(chosen))
			revealGeneration.current += 1
			setRevealed(null)
			setRevealing(null)
			if (chosen.kind === 'webhook-replace') {
				candidate.current[chosen.field] = replacement
				setCandidateAvailable((prior) => ({ ...prior, [chosen.field]: true }))
				setWebhookDraft((prior) => ({ ...prior, [chosen.field]: '' }))
				setEditingWebhook(null)
			}
			if (chosen.kind === 'webhook-clear') {
				candidate.current[chosen.field] = null
				setCandidateAvailable((prior) => ({ ...prior, [chosen.field]: false }))
				setRevealed(null)
			}
			intent.current = chosen
			setConfirmation(null)
			setErrorKey(null)
			setStatusKey(null)
			setReconciled((prior) => ({ ...prior, [chosen.field]: false }))
			void mutation.mutateAsync(chosen.field).catch(() => undefined)
		} catch (error) {
			intent.current = null
			setConfirmation(null)
			setErrorKey(configFullErrorKey(error))
		}
	}

	async function reveal(channel: AdminConfigWebhookChannel): Promise<void> {
		if (
			!data?.canReveal ||
			!data.webhooks[channel].configured ||
			refreshing ||
			mutation.isPending ||
			revealing ||
			verifying
		)
			return
		const abort = new AbortController()
		const startingEpoch = epoch.current
		const startingRevealGeneration = ++revealGeneration.current
		controller.current = abort
		setRevealed(null)
		setRevealing(channel)
		try {
			const value = await props.api.revealWebhook(channel, {
				signal: abort.signal,
			})
			if (
				!active.current ||
				abort.signal.aborted ||
				startingEpoch !== epoch.current ||
				startingRevealGeneration !== revealGeneration.current
			)
				return
			setRevealed({ channel, value })
			setErrorKey(null)
		} catch (error) {
			if (
				active.current &&
				!abort.signal.aborted &&
				startingRevealGeneration === revealGeneration.current
			) {
				revoke(error)
				setErrorKey(configFullErrorKey(error))
			}
		} finally {
			if (controller.current === abort) controller.current = null
			if (
				active.current &&
				startingRevealGeneration === revealGeneration.current
			)
				setRevealing(null)
		}
	}

	async function verify(channel: AdminConfigWebhookChannel): Promise<void> {
		const value = candidate.current[channel]
		if (
			!value ||
			!data?.canReveal ||
			!locked[channel] ||
			!reconciled[channel] ||
			refreshing ||
			mutation.isPending ||
			verifying
		)
			return
		const abort = new AbortController()
		const startingEpoch = epoch.current
		controller.current = abort
		setVerifying(channel)
		try {
			const result = await props.api.verifyWebhook(channel, value, {
				signal: abort.signal,
			})
			if (
				!active.current ||
				abort.signal.aborted ||
				startingEpoch !== epoch.current
			)
				return
			const fresh = await readFresh()
			if (!fresh) return
			if (result.matched && !fresh.webhooks[channel].configured) return
			recovery.settle(keys[channel])
			candidate.current[channel] = null
			setCandidateAvailable((prior) => ({ ...prior, [channel]: false }))
			setReconciled((prior) => ({ ...prior, [channel]: false }))
			setStatusKey(
				`cinatoken.adminConfigFull.${result.matched ? 'currentMatches' : 'currentDiffers'}`
			)
		} catch (error) {
			if (active.current && !abort.signal.aborted) {
				revoke(error)
				setErrorKey(configFullErrorKey(error))
			}
		} finally {
			if (controller.current === abort) controller.current = null
			if (active.current) setVerifying(null)
		}
	}

	function reviewCurrent(channel: AdminConfigWebhookChannel): void {
		if (
			!data?.canReveal ||
			!locked[channel] ||
			!reconciled[channel] ||
			candidateAvailable[channel] ||
			(data.webhooks[channel].configured && revealed?.channel !== channel) ||
			refreshing ||
			mutation.isPending ||
			revealing ||
			verifying
		)
			return
		setResolutionChannel(channel)
	}

	function acceptCurrent(): void {
		const channel = resolutionChannel
		if (
			!channel ||
			!data?.canReveal ||
			!locked[channel] ||
			!reconciled[channel] ||
			candidateAvailable[channel] ||
			(data.webhooks[channel].configured && revealed?.channel !== channel)
		)
			return
		try {
			recovery.settle(keys[channel])
			candidate.current[channel] = null
			setResolutionChannel(null)
			setRevealed(null)
			setReconciled((prior) => ({ ...prior, [channel]: false }))
			setStatusKey('cinatoken.adminConfigFull.currentReviewed')
			setErrorKey(null)
		} catch (error) {
			setErrorKey(configFullErrorKey(error))
		}
	}

	const data =
		accessRevoked || readFailed || overview.error || overview.isFetching
			? null
			: overview.data
	const canEdit = (field: ConfigField): boolean =>
		Boolean(
			data?.canWrite &&
			props.canWrite &&
			!locked[field] &&
			!refreshing &&
			!mutation.isPending &&
			!revealing &&
			!verifying
		)
	return {
		data,
		overview,
		locked,
		recovery,
		keys,
		accessRevoked,
		errorKey,
		statusKey,
		timezoneDraft,
		setTimezoneDraft,
		currencyDraft,
		setCurrencyDraft,
		strategyDraft,
		setStrategyDraft,
		webhookDraft,
		setWebhookDraft,
		editingWebhook,
		setEditingWebhook,
		revealed,
		setRevealed,
		confirmation,
		setConfirmation,
		resolutionChannel,
		setResolutionChannel,
		refreshing,
		revealing,
		verifying,
		reconciled,
		candidateAvailable,
		mutation,
		canEdit,
		askConfirmation,
		confirm,
		refresh,
		reveal,
		verify,
		reviewCurrent,
		acceptCurrent,
	}
}
