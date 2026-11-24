/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
	adminConfigAccessRecovery,
	configAccessIdentityKey,
} from './config-access-recovery'
import type { AdminConfigApi } from './config-api'
import type {
	AdminConfigOverview,
	AdminConfigRevision,
	StreamTimeoutConfiguration,
} from './config-contracts'
import { configAccessLost } from './config-errors'
import { configFactorModeIdentity } from './config-factor-mode'
import { configFullErrorKey } from './config-full-errors'
import {
	normalizeStreamTimeout,
	type StreamTimeoutField,
} from './config-stream-timeout'
import {
	reconcileStreamTimeout,
	streamTimeoutRecovery,
	type StreamTimeoutMarker,
} from './config-stream-timeout-recovery'

export type StreamTimeoutProps = {
	api: AdminConfigApi
	scopeKey: string
	reconciliationKey: string
	field: StreamTimeoutField
	configuration: StreamTimeoutConfiguration | undefined
	canWrite: boolean
	disabled: boolean
	revalidate: () => Promise<void>
}
export function useStreamTimeout(props: StreamTimeoutProps) {
	const client = useQueryClient()
	const store = streamTimeoutRecovery(props.api)
	const access = adminConfigAccessRecovery(props.api)
	const identity = configFactorModeIdentity(props.reconciliationKey)
	const accessKey = configAccessIdentityKey(props.reconciliationKey)
	const status = useSyncExternalStore(
		store.subscribe,
		() => store.status(accessKey, props.field),
		() => store.status(accessKey, props.field)
	)
	const denied = useSyncExternalStore(
		access.subscribe,
		() => access.getSnapshot(accessKey),
		() => access.getSnapshot(accessKey)
	)
	const [message, setMessage] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [readFailed, setReadFailed] = useState(false)
	const active = useRef(true)
	const busy = useRef(false)
	const controller = useRef<AbortController | null>(null)
	const queryKey = [
		'cinatoken',
		'admin',
		props.scopeKey,
		'config-overview',
	] as const
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
			controller.current?.abort()
		}
	}, [])
	useEffect(() => {
		if (denied || !props.canWrite) controller.current?.abort()
	}, [denied, props.canWrite])
	function cache(
		field: StreamTimeoutConfiguration | undefined,
		permissions: Partial<
			Pick<AdminConfigOverview, 'canWrite' | 'canReveal'>
		> = {}
	) {
		client.setQueryData<AdminConfigOverview>(queryKey, (prior) =>
			prior ? { ...prior, ...permissions, [props.field]: field } : prior
		)
	}
	function fail(error: unknown) {
		if (configAccessLost(error)) {
			const first = access.block(accessKey)
			void client.cancelQueries({ queryKey })
			client.removeQueries({ queryKey })
			if (first) void props.revalidate().catch(() => undefined)
		}
		if (active.current) setError(configFullErrorKey(error))
	}
	const mutation = useMutation({
		mutationKey: [...queryKey, 'stream-timeout', props.field],
		retry: false,
		gcTime: 0,
		mutationFn: async (
			action:
				| { kind: 'save'; value: string; expectedRevision: AdminConfigRevision }
				| { kind: 'read' }
		) => {
			if (!identity || busy.current || denied || props.disabled) return
			if (
				action.kind === 'save' &&
				(!props.canWrite || !props.configuration || status !== 'ready')
			)
				return
			busy.current = true
			const abort = new AbortController()
			controller.current = abort
			let marker: StreamTimeoutMarker | null = null
			setMessage(null)
			setError(null)
			try {
				await client.cancelQueries({ queryKey })
				abort.signal.throwIfAborted()
				if (action.kind === 'save') {
					const value = normalizeStreamTimeout(props.field, action.value)
					const expectedRevision = action.expectedRevision
					const saved = await props.api.updateStreamTimeout(
						props.field,
						value,
						expectedRevision,
						{
							...identity,
							signal: abort.signal,
							onDispatch: () => {
								marker = store.mark(
									accessKey,
									props.field,
									value,
									expectedRevision
								)
							},
						}
					)
					if (!active.current || abort.signal.aborted) return
					if (marker) store.settle(accessKey, marker)
					cache(saved)
					setReadFailed(false)
					setMessage('cinatoken.adminConfigFull.streamSaved')
					return saved
				} else {
					const observedMarker = store.marker(accessKey, props.field)
					const observed = await props.api.readStreamTimeout(props.field, {
						...identity,
						signal: abort.signal,
					})
					if (!active.current || abort.signal.aborted) return
					setReadFailed(false)
					const current = observed.field
					cache(current, {
						canWrite: observed.canWrite,
						canReveal: observed.canReveal,
					})
					if (observedMarker) {
						const decision = reconcileStreamTimeout(observedMarker, current)
						if (decision !== 'unknown') store.settle(accessKey, observedMarker)
						let key = 'streamPending'
						if (decision === 'matches') key = 'streamMatches'
						if (decision === 'differs') key = 'streamDiffers'
						setMessage('cinatoken.adminConfigFull.' + key)
					} else setMessage('cinatoken.adminConfigFull.refreshed')
				}
			} catch (error) {
				if (!active.current || abort.signal.aborted) return
				if (action.kind === 'read') setReadFailed(true)
				// Only this initial dispatch's definite rejection can clear its own generation.
				if (
					marker &&
					typeof error === 'object' &&
					error !== null &&
					'status' in error &&
					[400, 401, 403, 412, 413, 422, 428].includes(Number(error.status))
				) {
					try {
						store.settle(accessKey, marker)
					} catch (cleanupError) {
						fail(cleanupError)
						return
					}
				}
				fail(error)
			} finally {
				busy.current = false
				if (controller.current === abort) controller.current = null
			}
		},
	})
	return {
		status,
		message,
		error,
		pending: mutation.isPending,
		canEdit:
			!!identity &&
			!readFailed &&
			props.canWrite &&
			!props.disabled &&
			!denied &&
			status === 'ready' &&
			!mutation.isPending,
		save: (value: string, expectedRevision: AdminConfigRevision) =>
			mutation.mutateAsync({ kind: 'save', value, expectedRevision }),
		read: () => mutation.mutate({ kind: 'read' }),
	}
}
