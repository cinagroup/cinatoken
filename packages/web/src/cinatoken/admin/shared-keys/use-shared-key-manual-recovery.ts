/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AdminSharedKeysApi } from './shared-key-api'
import {
	acknowledgeSharedKeyRecovery,
	inspectSharedKeyRecovery,
	readSharedKeyRecoveryAudit,
	SharedKeyManualRecoveryError,
	type SharedKeyRecoveryEvidence,
	type SharedKeyRecoveryStage,
} from './shared-key-manual-recovery'
import type { AdminSharedKeyMarker } from './shared-key-marker'
import type { AdminSharedKeyWriteRecovery } from './shared-key-recovery'

export type SharedKeyManualRecoveryProps = {
	api: AdminSharedKeysApi
	store: AdminSharedKeyWriteRecovery
	marker: AdminSharedKeyMarker
	identity: string
	consoleSubject: string
	onAccessLost: (stage: SharedKeyRecoveryStage, status: number) => void
	onRecovered: () => void
	onClose: () => void
}
export function useSharedKeyManualRecovery(
	props: SharedKeyManualRecoveryProps
) {
	const active = useRef(true)
	const controller = useRef<AbortController | null>(null)
	const action = useRef<(() => Promise<void>) | null>(null)
	const [evidence, setEvidence] = useState<SharedKeyRecoveryEvidence | null>(
		null
	)
	const [error, setError] = useState<string | null>(null)
	const [acknowledged, setAcknowledged] = useState(false)
	const [cursors, setCursors] = useState<(string | null)[]>([null])
	const mutation = useMutation({
		mutationKey: [
			'cinatoken',
			'admin',
			'shared-key-manual',
			props.identity,
			props.marker.generation,
		],
		mutationFn: async () => {
			if (action.current) await action.current()
			return { completed: true }
		},
		retry: false,
		gcTime: 0,
	})
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
			controller.current?.abort()
			action.current = null
		}
	}, [])
	async function run(
		task: (signal: AbortSignal) => Promise<void>
	): Promise<void> {
		if (controller.current) return
		const abort = new AbortController()
		controller.current = abort
		setError(null)
		setAcknowledged(false)
		action.current = () => task(abort.signal)
		try {
			await mutation.mutateAsync()
		} catch (failure) {
			if (!active.current || abort.signal.aborted) return
			setEvidence(null)
			setError(
				failure instanceof SharedKeyManualRecoveryError &&
					failure.stage === 'storage'
					? 'storageUnavailable'
					: 'recoveryFailed'
			)
			if (
				failure instanceof SharedKeyManualRecoveryError &&
				[401, 403].includes(failure.status)
			)
				props.onAccessLost(failure.stage, failure.status)
		} finally {
			controller.current = null
			action.current = null
			mutation.reset()
		}
	}
	function options(signal: AbortSignal) {
		return { signal, expectedConsoleSubject: props.consoleSubject }
	}
	return {
		evidence,
		error,
		acknowledged,
		setAcknowledged,
		busy: mutation.isPending,
		cursors,
		inspect: () =>
			run(async (signal) => {
				setEvidence(null)
				setCursors([null])
				const next = await inspectSharedKeyRecovery(
					props.api,
					props.marker,
					options(signal)
				)
				if (active.current && !signal.aborted) setEvidence(next)
			}),
		pageAudit: (cursor: string | null, back = false) =>
			run(async (signal) => {
				if (!evidence || evidence.kind !== 'governance') return
				const next = await readSharedKeyRecoveryAudit(
					props.api,
					evidence.marker,
					cursor,
					options(signal)
				)
				if (active.current && !signal.aborted) {
					setEvidence({ ...evidence, audit: next })
					setCursors((values) =>
						back ? values.slice(0, -1) : [...values, cursor]
					)
				}
			}),
		acknowledge: () =>
			run(async (signal) => {
				if (!evidence) return
				await acknowledgeSharedKeyRecovery(
					props.api,
					props.store,
					props.identity,
					evidence,
					acknowledged,
					options(signal)
				)
				if (active.current && !signal.aborted) {
					setEvidence(null)
					props.onRecovered()
				}
			}),
	}
}
