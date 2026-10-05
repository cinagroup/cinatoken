import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AdminDomainWriteError } from '../domain-write-recovery'
import type { ProvidersApi } from '../provider-api'
import type { AdminProvider, ProviderImportResult } from '../provider-contracts'
import {
	useDomainWriteRecovery,
	reserveDomainAutomaticRecheck,
	type AdminDomainSessionProps,
} from '../use-domain-write-recovery'
import {
	providerAccessDenied,
	providerInvalidResponse,
} from './provider-errors'
import {
	endpointDrafts,
	providerFormInput,
	type ProviderEditorMode,
	type ProviderFormValues,
} from './provider-form'
import { observeProviderFailures } from './provider-query-scope'

export type ProviderModal =
	| { kind: 'editor'; mode: ProviderEditorMode; row?: AdminProvider }
	| { kind: 'detail'; row: AdminProvider }
	| { kind: 'import' }
	| { kind: 'change'; row: AdminProvider; action: 'delete' | 'status' }
type Task = {
	run: (signal: AbortSignal) => Promise<void>
	refresh?: boolean
	close?: boolean
	write?: boolean
}
export type ProviderManagerProps = AdminDomainSessionProps & {
	api: ProvidersApi
	scopeKey: string
	canWrite: boolean
	revalidate: () => Promise<void>
}

export function useProvidersManager(props: ProviderManagerProps) {
	const client = useQueryClient()
	const revalidate = props.revalidate
	const prefix = useMemo(
		() =>
			[
				'cinatoken',
				'admin',
				props.scopeKey,
				'providers',
				props.canWrite,
			] as const,
		[props.scopeKey, props.canWrite]
	)
	const [modal, setModal] = useState<ProviderModal | null>(null)
	const [revoked, setRevoked] = useState(false)
	const [notice, setNotice] = useState(false)
	const [importResult, setImportResult] = useState<ProviderImportResult | null>(
		null
	)
	const active = useRef(true)
	const task = useRef<Task | null>(null)
	const controller = useRef<AbortController | null>(null)
	const revalidating = useRef(false)
	const binding = useDomainWriteRecovery({
		...props,
		domain: 'providers',
		enabled: props.canWrite,
		verify: props.api.verifyAdminDomainSubject,
		observe: (options) => props.api.providerList(options),
		onRecovered: () => {
			setRevoked(false)
			setModal(null)
			setImportResult(null)
			setNotice(false)
			mutation.reset()
			void query.refetch()
		},
		onFailure: (error) => revoke(error),
		isWriting: () => task.current !== null,
	})
	const writeUnconfirmed = binding.status !== 'ready'
	const query = useQuery({
		queryKey: [...prefix, 'list'],
		queryFn: ({ signal }) =>
			props.api.providerList(binding.readOptions(signal)),
		enabled: props.canWrite && !revoked,
		retry: false,
	})
	const revoke = useCallback(
		(error: unknown) => {
			if (
				!providerAccessDenied(error) &&
				!providerInvalidResponse(error) &&
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
			setImportResult(null)
			controller.current?.abort()
			void client.cancelQueries({ queryKey: prefix })
			client.removeQueries({ queryKey: prefix })
			if (
				providerAccessDenied(error) &&
				!revalidating.current &&
				reserveDomainAutomaticRecheck(props.reconciliationKey, 'providers')
			) {
				revalidating.current = true
				void revalidate().catch(() => undefined)
			}
		},
		[client, prefix, revalidate, props.reconciliationKey]
	)
	useEffect(
		() => observeProviderFailures(client.getQueryCache(), prefix, revoke),
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
			controller.current = new AbortController()
			try {
				await pending.run(controller.current.signal)
				if (!active.current || controller.current.signal.aborted) return
				if (pending.write) binding.settleKnown('confirmed-2xx')
				if (pending.close) setModal(null)
				if (pending.refresh) {
					setNotice(true)
					await client.invalidateQueries({ queryKey: prefix })
				}
			} catch (error) {
				if (active.current) {
					if (pending.write) {
						setModal(null)
						setImportResult(null)
						if (
							error instanceof AdminDomainWriteError &&
							error.code === 'rejected'
						)
							binding.settleKnown('definitive-rejection')
					}
					revoke(error)
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
		providerAccessDenied(query.error) ||
		providerInvalidResponse(query.error)
	const disabled =
		hidden ||
		query.isFetching ||
		Boolean(query.error) ||
		mutation.isPending ||
		writeUnconfirmed
	function queue(next: Task): void {
		if (disabled || task.current) return
		task.current = next
		binding.resetDispatch()
		void mutation.mutateAsync().catch(() => undefined)
	}
	function open(next: ProviderModal): void {
		if (disabled) return
		mutation.reset()
		setImportResult(null)
		setNotice(false)
		setModal(next)
	}
	function close(): void {
		if (!mutation.isPending) {
			setModal(null)
			setImportResult(null)
			mutation.reset()
		}
	}
	function save(values: ProviderFormValues): void {
		const input = providerFormInput(values)
		const current = modal
		queue({
			close: true,
			refresh: true,
			write: true,
			run: async (signal) => {
				try {
					if (
						current?.kind === 'editor' &&
						current.mode === 'edit' &&
						current.row
					)
						await props.api.updateProvider(
							current.row.id,
							input,
							binding.writeOptions(signal)
						)
					else if (
						current?.kind === 'editor' &&
						current.mode === 'clone' &&
						current.row
					)
						await props.api.cloneProvider(
							current.row.id,
							{
								name: values.name,
								id: values.id.trim() || undefined,
								api_key: input.api_key,
								description: input.description,
								shared_channel_type: input.shared_channel_type,
								endpoints: input.endpoints,
							},
							binding.writeOptions(signal)
						)
					else
						await props.api.createProvider(
							{
								...input,
								name: values.name,
								id: values.id.trim() || undefined,
							},
							binding.writeOptions(signal)
						)
				} finally {
					input.api_key = ''
					values.api_key = ''
					values.endpoints = endpointDrafts(null)
					delete input.endpoints
				}
			},
		})
	}
	function confirm(): void {
		if (modal?.kind !== 'change') return
		const change = modal
		queue({
			close: true,
			refresh: true,
			write: true,
			run: async (signal) => {
				if (change.action === 'delete')
					await props.api.deleteProvider(
						change.row.id,
						binding.writeOptions(signal)
					)
				else
					await props.api.updateProvider(
						change.row.id,
						{ status: change.row.status === 'active' ? 'disabled' : 'active' },
						binding.writeOptions(signal)
					)
			},
		})
	}
	function importProviders(ids: string[]): void {
		queue({
			refresh: true,
			write: true,
			run: async (signal) => {
				const result = await props.api.importProviders(
					ids,
					binding.writeOptions(signal)
				)
				if (active.current) setImportResult(result)
			},
		})
	}
	async function retry(): Promise<void> {
		if (hidden) {
			await props.revalidate()
			return
		}
		await query.refetch()
	}
	return {
		prefix,
		query,
		mutation,
		modal: hidden ? null : modal,
		rows: hidden || query.error ? [] : (query.data ?? []),
		hidden,
		disabled,
		notice,
		writeUnconfirmed,
		manualRecovery: binding.manualRecovery,
		subject: binding.subject,
		userId: binding.userId,
		readOptions: binding.readOptions,
		writeOptions: binding.writeOptions,
		importResult,
		queue,
		open,
		close,
		save,
		confirm,
		importProviders,
		retry,
		revoke,
	}
}
