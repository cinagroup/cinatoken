/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { CinaTokenApiError } from '../../api'
import {
	adminEarningReviewInputSchema,
	type AdminEarningReviewInput,
	type AdminEarningReviewResult,
} from './review-contracts'
import type { AdminSharedKeysApi } from './shared-key-api'
import {
	AdminSharedKeyInputError,
	adminSharedKeyWriteUnknown,
} from './shared-key-errors'
import type { AdminSharedKeyMarker } from './shared-key-marker'
import { adminSharedKeyRecovery } from './shared-key-recovery'
import { useSharedKeyPending } from './use-shared-key-access'

export type EarningReviewProps = {
	api: AdminSharedKeysApi
	scopeKey: string
	reconciliationKey: string
	revalidate: () => Promise<void>
	onReadLost: () => void
	canReadLogs: boolean
	consoleSubject: string
}
export function useEarningReview(props: EarningReviewProps) {
	const stores = adminSharedKeyRecovery(props.api)
	const identity = props.reconciliationKey
	const pending = useSharedKeyPending(stores.reviewWrite, identity)
	const active = useRef(true)
	const busy = useRef(false)
	const controller = useRef<AbortController | null>(null)
	const action = useRef<(() => Promise<void>) | null>(null)
	const [result, setResult] = useState<AdminEarningReviewResult | null>(null)
	const [error, setError] = useState<string | null>(null)
	const mutation = useMutation({
		mutationKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'shared-keys',
			'earning-review',
		],
		mutationFn: async () => {
			if (!action.current) throw new AdminSharedKeyInputError()
			await action.current()
			return { confirmed: true }
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
		input: AdminEarningReviewInput,
		apply: boolean
	): Promise<void> {
		if (busy.current || (apply && pending !== 'ready')) return
		const checked = adminEarningReviewInputSchema.safeParse(input)
		if (
			!checked.success ||
			(apply &&
				(!result ||
					result.data.range.since !== checked.data.since ||
					result.data.range.limit !== checked.data.limit))
		) {
			setError('invalidInput')
			return
		}
		let marker: AdminSharedKeyMarker | null = null
		if (apply)
			try {
				marker = stores.reviewWrite.markPending(identity, {
					kind: 'review',
					since: checked.data.since,
					limit: checked.data.limit,
					operation: 'apply-review',
				})
			} catch {
				setError('storageUnavailable')
				return
			}
		busy.current = true
		setError(null)
		const abort = new AbortController()
		controller.current = abort
		action.current = async () => {
			const next = await props.api.reviewAdminEarnings(checked.data, apply, {
				signal: abort.signal,
				expectedConsoleSubject: props.consoleSubject,
			})
			if (!active.current || abort.signal.aborted) return
			if (apply && marker)
				try {
					stores.reviewWrite.settleKnown(
						identity,
						next.success ? 'confirmed-2xx' : 'definitive-rejection',
						marker
					)
				} catch {
					if (active.current) setError('confirmedLocked')
				}
			if (active.current) setResult(next)
		}
		try {
			await mutation.mutateAsync()
		} catch (failure) {
			if (
				apply &&
				marker &&
				active.current &&
				!abort.signal.aborted &&
				!adminSharedKeyWriteUnknown(failure)
			)
				try {
					stores.reviewWrite.settleKnown(
						identity,
						'definitive-rejection',
						marker
					)
				} catch {
					if (active.current) setError('storageUnavailable')
				}
			if (active.current) {
				setResult(null)
				setError(
					apply && adminSharedKeyWriteUnknown(failure)
						? 'unknownWrite'
						: 'reviewFailed'
				)
				if (failure instanceof CinaTokenApiError && failure.status === 401)
					props.onReadLost()
				else if (
					failure instanceof CinaTokenApiError &&
					failure.status === 403 &&
					stores.reviewAccess.block(identity)
				)
					void props.revalidate().catch(() => undefined)
			}
		} finally {
			busy.current = false
			action.current = null
			controller.current = null
			mutation.reset()
		}
	}
	return {
		result,
		error,
		pending,
		busy: mutation.isPending,
		run,
		clear: () => {
			if (!busy.current) {
				setResult(null)
				setError(null)
			}
		},
	}
}
