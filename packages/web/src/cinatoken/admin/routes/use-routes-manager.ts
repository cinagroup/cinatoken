/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import {
	useMutation,
	useQuery,
	useQueryClient,
	type QueryCache,
} from '@tanstack/react-query'
import type { AdminDomainRequestOptions } from '../domain-transport'
import {
	AdminDomainWriteError,
	type AdminWriteDomain,
} from '../domain-write-recovery'
import type { ModelsApi } from '../model-api'
import type { ProvidersApi } from '../provider-api'
import {
	useDomainWriteRecovery,
	reserveDomainAutomaticRecheck,
	type AdminDomainSessionProps,
} from '../use-domain-write-recovery'
import {
	routeAccessDenied,
	routeErrorStatus,
	routeInvalidResponse,
} from './route-errors'
import type { RouteWriteTarget } from './route-write-recovery'
import type { RoutesApi } from './routes-api'
import type { AdminRoute } from './routes-contracts'

export type RoutesPageContext = {
	global_route_strategy: string | null
	billing_currency: string
	business_timezone: string
}
export type RoutesUiApi = RoutesApi &
	ModelsApi &
	Pick<ProvidersApi, 'providerList'> & {
		routeContext(options?: {
			signal?: AbortSignal
			timeoutMs?: number
		}): Promise<RoutesPageContext>
	}

export type RoutesManagerProps = AdminDomainSessionProps & {
	api: RoutesUiApi
	scopeKey: string
	/** Stable user ID + Console subject + portal epoch, excluding accessVersion. */
	reconciliationKey: string
	/** Stable user ID + Console subject across automatic portal rechecks. */
	recheckIdentityKey: string
	canWrite: boolean
	revalidate: () => Promise<void>
}

type RouteTask = {
	run: (signal: AbortSignal) => Promise<void>
	authority: RouteWriteTarget
	close?: boolean
}

export function routeErrorObserver(
	cache: QueryCache,
	prefix: readonly unknown[],
	onError: (error: unknown, key: readonly unknown[]) => void
): () => void {
	return cache.subscribe((event) => {
		if (event.type !== 'updated' || event.query.queryKey.length < prefix.length)
			return
		if (
			!event.query.queryKey
				.slice(0, prefix.length)
				.every((part: unknown, index: number) => part === prefix[index])
		)
			return
		if (event.query.state.status === 'error')
			onError(event.query.state.error, event.query.queryKey)
	})
}

export function useRoutesManager(
	props: RoutesManagerProps,
	onClearDrafts?: () => void
) {
	const client = useQueryClient()
	const prefix = useMemo(
		() =>
			['cinatoken', 'admin', props.scopeKey, 'routes', props.canWrite] as const,
		[props.scopeKey, props.canWrite]
	)
	const [revoked, setRevoked] = useState(false)
	const [notice, setNotice] = useState(false)
	const [panel, setPanel] = useState<
		'editor' | 'detail' | 'policy' | 'sticky' | 'modelPolicy' | 'confirm' | null
	>(null)
	const [selected, setSelected] = useState<AdminRoute | null>(null)
	const [action, setAction] = useState<
		'delete' | 'activate' | 'deactivate' | 'resetSticky' | 'clearSticky' | null
	>(null)
	const [duplicating, setDuplicating] = useState(false)
	const active = useRef(true)
	const controller = useRef<AbortController | null>(null)
	const task = useRef<RouteTask | null>(null)
	const revalidating = useRef(false)
	const currentSession = useRef(props)
	useLayoutEffect(() => {
		currentSession.current = props
	}, [props])
	const binding = useDomainWriteRecovery({
		...props,
		domain: 'routes',
		enabled: props.canWrite,
		verify: props.api.verifyAdminDomainSubject,
		observe: async (options) => {
			await props.api.routeList({}, options)
			await props.api.routeContext(options)
			await props.api.modelList(options)
			await props.api.providerList(options)
		},
		onRecovered: recover,
		onFailure: (error) => revoke(error),
		isWriting: () => task.current !== null,
	})
	const modelBinding = useDomainWriteRecovery({
		...props,
		domain: 'models',
		enabled: props.canWrite,
		verify: props.api.verifyAdminDomainSubject,
		observe: (options) => props.api.modelListContext(options),
		onRecovered: recover,
		onFailure: (error) => revoke(error),
		isWriting: () => task.current !== null,
	})
	const writeUnconfirmed = binding.status !== 'ready'
	const list = useQuery({
		queryKey: [...prefix, 'list'],
		queryFn: ({ signal }) =>
			props.api.routeList({}, binding.readOptions(signal)),
		enabled: !revoked,
		retry: false,
	})
	const models = useQuery({
		queryKey: [...prefix, 'models'],
		queryFn: ({ signal }) => props.api.modelList(binding.readOptions(signal)),
		enabled: !revoked,
		retry: false,
	})
	const providers = useQuery({
		queryKey: [...prefix, 'providers'],
		queryFn: ({ signal }) =>
			props.api.providerList(binding.readOptions(signal)),
		enabled: !revoked,
		retry: false,
	})
	const context = useQuery({
		queryKey: [...prefix, 'context'],
		queryFn: ({ signal }) =>
			props.api.routeContext(binding.readOptions(signal)),
		enabled: !revoked,
		retry: false,
	})
	async function readAuthority(target: RouteWriteTarget): Promise<boolean> {
		if (target.kind === 'routes') return !(await list.refetch()).error
		if (target.kind === 'model') {
			const result = await models.refetch()
			return (
				!result.error &&
				Boolean(result.data?.some((row) => row.id === target.id))
			)
		}
		await props.api.stickyBindingsSummary(
			target.poolId,
			binding.readOptions(controller.current?.signal)
		)
		await client.invalidateQueries({ queryKey: [...prefix, 'sticky'] })
		void list.refetch()
		return true
	}
	const revoke = useCallback(
		(error: unknown, key?: readonly unknown[]) => {
			onClearDrafts?.()
			const resource = key?.[prefix.length]
			if (resource !== undefined) {
				setPanel(null)
				setSelected(null)
				setAction(null)
				controller.current?.abort()
			}
			if (
				!routeAccessDenied(error) &&
				!routeInvalidResponse(error) &&
				routeErrorStatus(error) < 500
			)
				return
			const ancillary =
				resource === 'models' ||
				resource === 'providers' ||
				resource === 'context'
			if (ancillary && routeErrorStatus(error) !== 401) {
				controller.current?.abort()
				setPanel(null)
				setSelected(null)
				setAction(null)
				// config.read, models.read or providers.read can be denied while
				// routes.read remains valid; their failed query is the authority.
				return
			}
			setRevoked(true)
			setPanel(null)
			setSelected(null)
			controller.current?.abort()
			void client.cancelQueries({ queryKey: prefix })
			client.removeQueries({ queryKey: prefix })
			if (
				routeAccessDenied(error) &&
				!revalidating.current &&
				reserveDomainAutomaticRecheck(props.reconciliationKey, 'routes')
			) {
				revalidating.current = true
				void props.revalidate().catch(() => undefined)
			}
		},
		[client, prefix, props, onClearDrafts]
	)
	useEffect(
		() => routeErrorObserver(client.getQueryCache(), prefix, revoke),
		[client, prefix, revoke]
	)
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
			controller.current?.abort()
			task.current = null
			void client.cancelQueries({ queryKey: prefix })
			client.removeQueries({ queryKey: prefix })
		}
	}, [client, prefix])
	const mutation = useMutation<void, Error, void>({
		mutationKey: [...prefix, 'operation'],
		retry: false,
		gcTime: 0,
		mutationFn: async () => {
			const pending = task.current
			if (!pending) return
			const abort = new AbortController()
			controller.current = abort
			try {
				await pending.run(abort.signal)
				if (!active.current || abort.signal.aborted) return
				const owner =
					pending.authority.kind === 'model' ? modelBinding : binding
				owner.settleKnown('confirmed-2xx')
				const confirmed = await readAuthority(pending.authority)
				if (!active.current || abort.signal.aborted || !confirmed) return
				if (pending.close) setPanel(null)
				setNotice(true)
			} catch (error) {
				if (active.current) {
					revoke(error)
					setPanel(null)
					setSelected(null)
					setAction(null)
					if (
						error instanceof AdminDomainWriteError &&
						error.code === 'rejected'
					)
						(pending.authority.kind === 'model'
							? modelBinding
							: binding
						).settleKnown('definitive-rejection')
				}
				throw error
			} finally {
				task.current = null
				controller.current = null
			}
		},
	})
	const hidden =
		revoked || routeAccessDenied(list.error) || routeInvalidResponse(list.error)
	const readError =
		list.error || models.error || providers.error || context.error
	const disabled =
		hidden ||
		!props.canWrite ||
		Boolean(list.error) ||
		list.isFetching ||
		mutation.isPending ||
		writeUnconfirmed
	function queue(next: RouteTask): void {
		if (
			hidden ||
			!props.canWrite ||
			list.error ||
			list.isFetching ||
			mutation.isPending ||
			task.current ||
			(next.authority.kind === 'model'
				? modelBinding.status
				: binding.status) !== 'ready'
		)
			return
		task.current = next
		const owner = next.authority.kind === 'model' ? modelBinding : binding
		owner.resetDispatch()
		void mutation.mutateAsync().catch(() => undefined)
	}
	function open(
		next: typeof panel,
		row: AdminRoute | null = null,
		nextAction: typeof action = null,
		duplicate = false
	): void {
		if (hidden || mutation.isPending) return
		mutation.reset()
		setNotice(false)
		setSelected(row)
		setAction(nextAction)
		setDuplicating(duplicate)
		setPanel(next)
	}
	function close(): void {
		if (mutation.isPending) return
		setPanel(null)
		setSelected(null)
		setAction(null)
		setDuplicating(false)
		mutation.reset()
	}
	/** Called only after explicit double verification and the reviewed generation CAS. */
	function recover(): void {
		const isCurrent = () =>
			active.current &&
			currentSession.current.canWrite &&
			currentSession.current.scopeKey === props.scopeKey &&
			currentSession.current.reconciliationKey === props.reconciliationKey
		if (!isCurrent()) return
		onClearDrafts?.()
		controller.current?.abort()
		controller.current = null
		task.current = null
		setRevoked(false)
		setPanel(null)
		setSelected(null)
		setAction(null)
		setDuplicating(false)
		setNotice(false)
		mutation.reset()
		// Clear stale detail data and prior errors before the fresh authority reads.
		void (async () => {
			await client.resetQueries({ queryKey: prefix }, { cancelRefetch: true })
			if (!isCurrent()) return
			// retry's previous render may still have hidden=true.
			await Promise.all([
				list.refetch(),
				models.refetch(),
				providers.refetch(),
				context.refetch(),
			])
		})().catch((error) => {
			if (isCurrent()) revoke(error)
		})
	}
	async function retry(): Promise<void> {
		try {
			if (hidden) {
				await props.revalidate()
				return
			}
			// A manual refresh must recheck every authority shown on the page.
			// In particular, a previously successful context read cannot remain
			// trusted after config.read is revoked or configuration becomes unavailable.
			await Promise.all([
				list.refetch(),
				models.refetch(),
				providers.refetch(),
				context.refetch(),
			])
		} catch (error) {
			revoke(error)
		}
	}
	return {
		prefix,
		list,
		models,
		providers,
		context,
		mutation,
		notice,
		readError,
		panel: hidden || list.error ? null : panel,
		selected: hidden || list.error ? null : selected,
		action,
		duplicating,
		rows: hidden || list.error ? [] : (list.data ?? []),
		hidden,
		disabled,
		writeUnconfirmed,
		modelWriteUnconfirmed: modelBinding.status !== 'ready',
		manualRecovery: binding.manualRecovery,
		modelManualRecovery: modelBinding.manualRecovery,
		subject: binding.subject,
		userId: binding.userId,
		readOptions: binding.readOptions,
		writeOptions: (
			signal: AbortSignal,
			domain: AdminWriteDomain = 'routes'
		): AdminDomainRequestOptions =>
			(domain === 'models' ? modelBinding : binding).writeOptions(signal),
		queue,
		open,
		close,
		retry,
		revoke,
	}
}
