import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AdminDomainWriteError } from '../domain-write-recovery'
import type { ModelsApi } from '../model-api'
import type { ModelImportResult } from '../model-contracts'
import type { CreateModelInput, UpdateModelInput } from '../model-input'
import {
	useDomainWriteRecovery,
	reserveDomainAutomaticRecheck,
	type AdminDomainSessionProps,
} from '../use-domain-write-recovery'
import {
	modelAccessDenied,
	modelInvalidResponse,
	modelWriteNeedsReconciliation,
} from './model-errors'
import {
	confirmedModelCurrency,
	observeModelFailures,
} from './model-query-scope'

export type ModelModal =
	| { kind: 'create' | 'import' }
	| { kind: 'edit' | 'detail' | 'delete'; id: string }
export type ModelManagerProps = AdminDomainSessionProps & {
	api: ModelsApi
	scopeKey: string
	/** Stable userId + subject + portal epoch; exclude the console accessVersion. */
	reconciliationKey: string
	canWrite: boolean
	/** Caller-local block; it cannot revoke an already dispatched Models write. */
	writeBlocked?: boolean
	revalidate: () => Promise<void>
}
type Task = { run: (signal: AbortSignal) => Promise<void>; close: boolean }
export function useModelsManager(props: ModelManagerProps) {
	const client = useQueryClient()
	const prefix = useMemo(
		() =>
			['cinatoken', 'admin', props.scopeKey, 'models', props.canWrite] as const,
		[props.scopeKey, props.canWrite]
	)
	const revalidate = props.revalidate
	const [modal, setModal] = useState<ModelModal | null>(null)
	const [revoked, setRevoked] = useState(false)
	const [blockedError, setBlockedError] = useState<unknown>(null)
	const [notice, setNotice] = useState(false)
	const [importResult, setImportResult] = useState<ModelImportResult | null>(
		null
	)
	const active = useRef(true)
	const task = useRef<Task | null>(null)
	const controller = useRef<AbortController | null>(null)
	const revalidating = useRef(false)
	const binding = useDomainWriteRecovery({
		...props,
		domain: 'models',
		enabled: props.canWrite,
		verify: props.api.verifyAdminDomainSubject,
		observe: (options) => props.api.modelListContext(options),
		onRecovered: () => {
			setRevoked(false)
			setBlockedError(null)
			setModal(null)
			setImportResult(null)
			setNotice(false)
			mutation.reset()
			void query.refetch()
		},
		onFailure: (error) => revoke(error),
		isWriting: () => task.current !== null,
	})
	const writeUnknown = binding.status !== 'ready'
	const query = useQuery({
		queryKey: [...prefix, 'list'],
		queryFn: ({ signal }) =>
			props.api.modelListContext(binding.readOptions(signal)),
		enabled: props.canWrite && !revoked,
		retry: false,
	})
	const revoke = useCallback(
		(error: unknown) => {
			if (
				!modelAccessDenied(error) &&
				!modelInvalidResponse(error) &&
				!(
					typeof error === 'object' &&
					error !== null &&
					'status' in error &&
					Number(error.status) >= 500
				)
			)
				return
			setRevoked(true)
			setBlockedError(error)
			setModal(null)
			setImportResult(null)
			controller.current?.abort()
			void client.cancelQueries({ queryKey: prefix })
			client.removeQueries({ queryKey: prefix })
			if (
				modelAccessDenied(error) &&
				!revalidating.current &&
				reserveDomainAutomaticRecheck(props.reconciliationKey, 'models')
			) {
				revalidating.current = true
				void revalidate().catch(() => undefined)
			}
		},
		[client, prefix, revalidate, props.reconciliationKey]
	)
	useEffect(
		() => observeModelFailures(client.getQueryCache(), prefix, revoke),
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
		mutationKey: [...prefix, 'write'],
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
				binding.settleKnown('confirmed-2xx')
				if (pending.close) setModal(null)
				setNotice(true)
				await client.invalidateQueries({ queryKey: [...prefix, 'list'] })
			} catch (error) {
				if (active.current) {
					revoke(error)
					if (modelWriteNeedsReconciliation(error)) {
						setModal(null)
						setImportResult(null)
					} else if (
						error instanceof AdminDomainWriteError &&
						error.code === 'rejected'
					)
						binding.settleKnown('definitive-rejection')
				}
				throw error
			} finally {
				task.current = null
				if (controller.current === abort) controller.current = null
			}
		},
	})
	const hidden =
		revoked ||
		!props.canWrite ||
		modelAccessDenied(query.error) ||
		modelInvalidResponse(query.error)
	const disabled =
		Boolean(props.writeBlocked) ||
		hidden ||
		query.isFetching ||
		Boolean(query.error) ||
		mutation.isPending ||
		writeUnknown
	function queue(next: Task): void {
		if (disabled || task.current || binding.status !== 'ready') return
		task.current = next
		binding.resetDispatch()
		void mutation.mutateAsync().catch(() => undefined)
	}
	function open(next: ModelModal): void {
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
	function save(input: CreateModelInput | UpdateModelInput, id?: string): void {
		queue({
			close: true,
			run: async (signal) => {
				if (id)
					await props.api.updateModel(
						id,
						input as UpdateModelInput,
						binding.writeOptions(signal)
					)
				else
					await props.api.createModel(
						input as CreateModelInput,
						binding.writeOptions(signal)
					)
			},
		})
	}
	function remove(id: string): void {
		queue({
			close: true,
			run: async (signal) =>
				props.api.deleteModel(id, binding.writeOptions(signal)),
		})
	}
	function importModels(ids: string[]): void {
		queue({
			close: false,
			run: async (signal) => {
				const result = await props.api.importModels(
					ids,
					binding.writeOptions(signal)
				)
				if (active.current && !signal.aborted) setImportResult(result)
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
		rows: hidden || query.error ? [] : (query.data?.rows ?? []),
		billingCurrency: confirmedModelCurrency(query.data, query.error, hidden),
		hidden,
		disabled,
		notice,
		writeUnknown,
		manualRecovery: binding.manualRecovery,
		subject: binding.subject,
		userId: binding.userId,
		readOptions: binding.readOptions,
		blockedError,
		importResult,
		open,
		close,
		save,
		remove,
		importModels,
		retry,
	}
}
