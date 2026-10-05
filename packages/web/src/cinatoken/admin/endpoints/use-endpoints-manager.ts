/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AdminDomainWriteError } from '../domain-write-recovery'
import type { EndpointsApi, EndpointListQuery } from '../endpoint-api'
import type {
	AdminEndpoint,
	EndpointBootstrapResult,
	EndpointStatus,
} from '../endpoint-contracts'
import type {
	CreateEndpointInput,
	UpdateEndpointInput,
} from '../endpoint-input'
import type { EndpointFilters } from '../endpoint-search'
import {
	useDomainWriteRecovery,
	reserveDomainAutomaticRecheck,
	type AdminDomainSessionProps,
} from '../use-domain-write-recovery'
import {
	endpointAccessDenied,
	endpointInvalidResponse,
} from './endpoint-errors'
import { observeEndpointFailures } from './endpoint-query-scope'

export type EndpointModal =
	| { kind: 'editor'; row?: AdminEndpoint }
	| { kind: 'detail'; id: string }
	| {
			kind: 'confirm'
			row: AdminEndpoint
			action: 'delete' | 'publish' | 'draft' | 'disable'
	  }
	| { kind: 'bootstrap' }

type Task = {
	run: (signal: AbortSignal) => Promise<void>
	close?: boolean
	refresh?: boolean
}

export type EndpointManagerProps = AdminDomainSessionProps & {
	api: EndpointsApi
	scopeKey: string
	/** Stable user ID + subject + portal epoch. Do not include console accessVersion. */
	reconciliationKey: string
	canWrite: boolean
	revalidate: () => Promise<void>
}

export function useEndpointsManager(
	props: EndpointManagerProps,
	filters: EndpointFilters
) {
	const client = useQueryClient()
	const revalidate = props.revalidate
	const prefix = useMemo(
		() =>
			[
				'cinatoken',
				'admin',
				props.scopeKey,
				'endpoints',
				props.canWrite,
			] as const,
		[props.scopeKey, props.canWrite]
	)
	const serverFilters = useMemo<EndpointListQuery>(() => {
		const query: EndpointListQuery = {}
		if (filters.model) query.model_id = filters.model
		if (filters.provider) query.provider_id = filters.provider
		if (filters.status !== 'all' && filters.status !== 'expired')
			query.status = filters.status
		return query
	}, [filters.model, filters.provider, filters.status])
	const [modal, setModal] = useState<EndpointModal | null>(null)
	const [revoked, setRevoked] = useState(false)
	const [notice, setNotice] = useState(false)
	const [bootstrapResult, setBootstrapResult] =
		useState<EndpointBootstrapResult | null>(null)
	const active = useRef(true)
	const task = useRef<Task | null>(null)
	const controller = useRef<AbortController | null>(null)
	const revalidating = useRef(false)
	const binding = useDomainWriteRecovery({
		...props,
		domain: 'endpoints',
		enabled: props.canWrite,
		verify: props.api.verifyAdminDomainSubject,
		observe: async (options) => {
			await props.api.endpointList(serverFilters, options)
			await props.api.endpointChoices(options)
		},
		onRecovered: () => {
			setRevoked(false)
			setModal(null)
			setBootstrapResult(null)
			setNotice(false)
			mutation.reset()
			void list.refetch()
			void choices.refetch()
		},
		onFailure: (error) => revoke(error),
		isWriting: () => task.current !== null,
	})
	const writeUnconfirmed = binding.status !== 'ready'
	const list = useQuery({
		queryKey: [...prefix, 'list', serverFilters],
		queryFn: ({ signal }) =>
			props.api.endpointList(serverFilters, binding.readOptions(signal)),
		enabled: props.canWrite && !revoked,
		retry: false,
	})
	const choices = useQuery({
		queryKey: [...prefix, 'choices'],
		queryFn: ({ signal }) =>
			props.api.endpointChoices(binding.readOptions(signal)),
		enabled: props.canWrite && !revoked,
		retry: false,
	})
	const revoke = useCallback(
		(error: unknown) => {
			if (
				!endpointAccessDenied(error) &&
				!endpointInvalidResponse(error) &&
				!(
					typeof error === 'object' &&
					error !== null &&
					'status' in error &&
					Number(error.status) >= 500
				)
			)
				return
			setRevoked(true)
			setModal(null)
			setBootstrapResult(null)
			controller.current?.abort()
			void client.cancelQueries({ queryKey: prefix })
			client.removeQueries({ queryKey: prefix })
			if (
				endpointAccessDenied(error) &&
				!revalidating.current &&
				reserveDomainAutomaticRecheck(props.reconciliationKey, 'endpoints')
			) {
				revalidating.current = true
				void revalidate().catch(() => undefined)
			}
		},
		[client, prefix, revalidate, props.reconciliationKey]
	)
	useEffect(
		() => observeEndpointFailures(client.getQueryCache(), prefix, revoke),
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
			const signal = new AbortController()
			controller.current = signal
			try {
				await pending.run(signal.signal)
				if (!active.current || signal.signal.aborted) return
				binding.settleKnown('confirmed-2xx')
				if (pending.refresh) {
					const refreshed = await Promise.all([
						list.refetch(),
						choices.refetch(),
					])
					if (!active.current || signal.signal.aborted) return
					if (refreshed.some((result) => result.error)) return
					await client.invalidateQueries({ queryKey: [...prefix, 'detail'] })
				}
				if (pending.close) setModal(null)
				setNotice(true)
			} catch (error) {
				if (active.current) {
					revoke(error)
					setModal(null)
					setBootstrapResult(null)
					if (
						error instanceof AdminDomainWriteError &&
						error.code === 'rejected'
					)
						binding.settleKnown('definitive-rejection')
				}
				throw error
			} finally {
				task.current = null
				controller.current = null
			}
		},
	})
	const hidden =
		revoked ||
		!props.canWrite ||
		endpointAccessDenied(list.error) ||
		endpointAccessDenied(choices.error) ||
		endpointInvalidResponse(list.error) ||
		endpointInvalidResponse(choices.error)
	const disabled =
		hidden ||
		list.isFetching ||
		choices.isFetching ||
		Boolean(list.error) ||
		Boolean(choices.error) ||
		mutation.isPending ||
		writeUnconfirmed
	function queue(next: Task): void {
		if (disabled || task.current || binding.status !== 'ready') return
		task.current = next
		binding.resetDispatch()
		void mutation.mutateAsync().catch(() => undefined)
	}
	function open(next: EndpointModal): void {
		if (disabled) return
		mutation.reset()
		setNotice(false)
		setBootstrapResult(null)
		setModal(next)
	}
	function close(): void {
		if (mutation.isPending) return
		setModal(null)
		setBootstrapResult(null)
		mutation.reset()
	}
	function save(input: UpdateEndpointInput, row?: AdminEndpoint): void {
		queue({
			close: true,
			refresh: true,
			run: async (signal) => {
				if (row)
					await props.api.updateEndpoint(
						row.id,
						input,
						binding.writeOptions(signal)
					)
				// endpointFormInput validates every required create field before queueing.
				else
					await props.api.createEndpoint(
						input as CreateEndpointInput,
						binding.writeOptions(signal)
					)
			},
		})
	}
	function changeStatus(row: AdminEndpoint, status: EndpointStatus): void {
		queue({
			close: true,
			refresh: true,
			run: async (signal) => {
				await props.api.updateEndpoint(
					row.id,
					{ status },
					binding.writeOptions(signal)
				)
			},
		})
	}
	function deleteEndpoint(row: AdminEndpoint): void {
		queue({
			close: true,
			refresh: true,
			run: async (signal) => {
				await props.api.deleteEndpoint(row.id, binding.writeOptions(signal))
			},
		})
	}
	function toggleRoute(
		row: AdminEndpoint,
		routeId: string,
		linked: boolean
	): void {
		queue({
			refresh: true,
			run: async (signal) => {
				if (linked)
					await props.api.linkEndpointRoute(
						row.id,
						routeId,
						binding.writeOptions(signal)
					)
				else
					await props.api.unlinkEndpointRoute(
						row.id,
						routeId,
						binding.writeOptions(signal)
					)
			},
		})
	}
	function bootstrap(): void {
		queue({
			refresh: true,
			run: async (signal) => {
				const result = await props.api.bootstrapDeepSeekEndpoints(
					binding.writeOptions(signal)
				)
				if (active.current && !signal.aborted) setBootstrapResult(result)
			},
		})
	}
	async function retry(): Promise<void> {
		if (hidden) {
			await props.revalidate()
			return
		}
		await Promise.all([list.refetch(), choices.refetch()])
	}
	return {
		prefix,
		list,
		choices,
		mutation,
		modal: hidden ? null : modal,
		rows: hidden || list.error ? [] : (list.data ?? []),
		hidden,
		disabled,
		writeUnconfirmed,
		manualRecovery: binding.manualRecovery,
		subject: binding.subject,
		userId: binding.userId,
		readOptions: binding.readOptions,
		writeOptions: binding.writeOptions,
		notice,
		bootstrapResult,
		queue,
		open,
		close,
		save,
		changeStatus,
		deleteEndpoint,
		toggleRoute,
		bootstrap,
		retry,
		revoke,
	}
}
