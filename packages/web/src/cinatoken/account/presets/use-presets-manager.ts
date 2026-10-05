import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { accountQueryKey, CinaTokenApiError } from '../../api'
import type { PresetsApi, PresetRequestOptions } from '../../preset-api'
import type {
	PresetMetadataInput,
	PresetVersion,
	RequestPreset,
	SavePresetVersionInput,
} from '../../preset-contracts'
import { useCinaTokenSession } from '../../session-context'
import {
	isAccountContextMismatch,
	isUserMismatch,
	requiresSessionRevalidation,
} from '../account-access'
import { presetAccessFailure } from './preset-errors'

export type PresetChange = {
	row: RequestPreset
	kind: 'archive' | 'restore' | 'public' | 'private' | 'designate'
	version?: number
}
export type PresetScope = {
	userId: string
	workspaceId: string
	scopeVersion: number
}
type Task =
	| { kind: 'save'; input: SavePresetVersionInput }
	| { kind: 'metadata'; id: string; input: PresetMetadataInput }
	| { kind: 'change'; change: PresetChange }

export function presetContextErrorKey(errors: readonly unknown[]): string {
	return errors.some(isUserMismatch)
		? 'cinatoken.account.sessionChanged'
		: 'cinatoken.presets.scopeHint'
}

export function usePresetsManager(api: PresetsApi, scope: PresetScope) {
	const session = useCinaTokenSession()
	const client = useQueryClient()
	const key = useMemo(
		() =>
			accountQueryKey(
				scope.userId,
				scope.workspaceId,
				'presets',
				scope.scopeVersion
			),
		[scope]
	)
	const options: PresetRequestOptions = useMemo(
		() => ({
			expectedUserId: scope.userId,
			expectedWorkspaceId: scope.workspaceId,
			expectedOwnerUserId: scope.userId,
		}),
		[scope]
	)
	const query = useQuery({
		queryKey: [...key, 'list', options],
		queryFn: ({ signal }) => api.presetCollection({ ...options, signal }),
		retry: false,
		staleTime: 15_000,
	})
	const active = useRef(false)
	const pending = useRef<Task | null>(null)
	const controllers = useRef(new Set<AbortController>())
	const [accessError, setAccessError] = useState<unknown>(null)
	const [editor, setEditor] = useState<{
		row?: RequestPreset
		version?: PresetVersion
	} | null>(null)
	const [metadata, setMetadata] = useState<RequestPreset | null>(null)
	const [history, setHistory] = useState<RequestPreset | null>(null)
	const [change, setChange] = useState<PresetChange | null>(null)
	const [notice, setNotice] = useState<{
		key: string
		version?: number
	} | null>(null)
	function closeSensitive() {
		setEditor(null)
		setMetadata(null)
		setHistory(null)
		setChange(null)
		setNotice(null)
	}
	useEffect(() => {
		active.current = true
		const requests = controllers.current
		return () => {
			active.current = false
			pending.current = null
			for (const controller of requests) controller.abort()
			requests.clear()
		}
	}, [])
	useEffect(
		() =>
			client.getQueryCache().subscribe((event) => {
				if (
					event.type !== 'updated' ||
					event.action.type !== 'error' ||
					!key.every((part, index) => part === event.query.queryKey[index]) ||
					!presetAccessFailure(event.query.state.error)
				)
					return
				setAccessError(event.query.state.error)
				closeSensitive()
				pending.current = null
				for (const controller of controllers.current) controller.abort()
			}),
		[client, key]
	)
	const refresh = () => client.invalidateQueries({ queryKey: key })
	const blocked = Boolean(accessError) || presetAccessFailure(query.error)
	const mutation = useMutation({
		mutationKey: [...key, 'change'],
		gcTime: 0,
		retry: false,
		// Private prompts/configuration stay in component memory, never mutation variables/data.
		mutationFn: async (): Promise<void> => {
			const task = pending.current
			pending.current = null
			if (!task) return
			const controller = new AbortController()
			controllers.current.add(controller)
			try {
				const request = { ...options, signal: controller.signal }
				let version: number | undefined
				if (task.kind === 'save')
					version = (await api.savePresetVersion(task.input, request))
						.designatedVersion
				else if (task.kind === 'metadata')
					await api.updatePresetMetadata(task.id, task.input, request)
				else {
					const action = task.change
					if (action.kind === 'archive')
						await api.archivePreset(action.row.id, request)
					else if (action.kind === 'designate')
						await api.designatePresetVersion(
							action.row.id,
							action.version!,
							request
						)
					else if (action.kind === 'restore')
						await api.updatePresetMetadata(
							action.row.id,
							{ status: 'active' },
							request
						)
					else
						await api.updatePresetMetadata(
							action.row.id,
							{ visibility: action.kind },
							request
						)
				}
				if (!active.current || controller.signal.aborted) return
				closeSensitive()
				setNotice({
					key:
						'cinatoken.presets.' + (task.kind === 'save' ? 'saved' : 'updated'),
					version,
				})
			} finally {
				controllers.current.delete(controller)
			}
		},
		onSuccess: () => {
			if (active.current) void refresh()
		},
		onError: (error) => {
			if (!active.current) return
			// A resource 403 (a slug owned by another user) is distinct from losing account access.
			if (
				error instanceof CinaTokenApiError &&
				(error.status === 401 ||
					error.code === 'invalid-response' ||
					isAccountContextMismatch(error))
			) {
				setAccessError(error)
				closeSensitive()
			}
			void refresh()
		},
	})
	function canOpen() {
		return (
			!blocked && !query.isError && !query.isFetching && !mutation.isPending
		)
	}
	function openEditor(row?: RequestPreset, version?: PresetVersion) {
		if (!canOpen() || row?.status === 'archived') return
		mutation.reset()
		setNotice(null)
		setHistory(null)
		setEditor({ row, version })
	}
	function run(task: Task) {
		if (blocked || query.isError || mutation.isPending || pending.current)
			return
		pending.current = task
		setNotice(null)
		mutation.mutate()
	}
	return {
		query,
		key,
		options,
		mutation,
		blocked,
		contextErrorKey: presetContextErrorKey([
			accessError,
			query.error,
			mutation.error,
		]),
		editor,
		metadata,
		history,
		change,
		notice,
		openEditor,
		closeEditor: () => setEditor(null),
		closeMetadata: () => setMetadata(null),
		closeHistory: () => setHistory(null),
		closeChange: () => setChange(null),
		openHistory: (row: RequestPreset) => {
			if (canOpen()) {
				mutation.reset()
				setHistory(row)
			}
		},
		openMetadata: (row: RequestPreset) => {
			if (canOpen()) {
				mutation.reset()
				setMetadata(row)
			}
		},
		openChange: (value: PresetChange) => {
			if (canOpen()) {
				mutation.reset()
				setHistory(null)
				setChange(value)
			}
		},
		save: (input: SavePresetVersionInput) => run({ kind: 'save', input }),
		saveMetadata: (input: PresetMetadataInput) => {
			if (metadata) run({ kind: 'metadata', id: metadata.id, input })
		},
		confirm: () => {
			if (change) run({ kind: 'change', change })
		},
		retry: () => {
			const revalidate = [accessError, query.error, mutation.error].some(
				requiresSessionRevalidation
			)
			closeSensitive()
			mutation.reset()
			setAccessError(null)
			if (revalidate) void session.revalidateScope()
			else void refresh()
		},
	}
}
