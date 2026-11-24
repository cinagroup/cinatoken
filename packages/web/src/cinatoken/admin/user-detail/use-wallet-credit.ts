/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { CinaTokenApiError } from '../../api'
import { adminDomainIdentity } from '../domain-write-recovery'
import { userAccessDenied } from '../users/users-errors'
import type { AdminUserDetailApi } from './user-detail-api'
import {
	WalletCreditClientError,
	walletCreditInputSchema,
	type WalletCreditInput,
	type WalletCreditReceipt,
} from './wallet-credit-contracts'
import {
	walletCreditRecovery,
	type WalletCreditMarker,
} from './wallet-credit-recovery'

function definitiveRejection(error: unknown): boolean {
	return (
		error instanceof CinaTokenApiError &&
		error.code === 'http' &&
		[400, 401, 403, 404, 405, 409, 412, 413, 422, 428].includes(error.status)
	)
}
export function useWalletCredit(props: {
	api: AdminUserDetailApi
	identity: string
	userId: string
	allowed: boolean
	canStart: boolean
	status: 'ready' | 'pending' | 'unavailable'
	onBusy: (busy: boolean) => void
	onDenied: () => void
	onSaved: () => Promise<void>
}) {
	const store = walletCreditRecovery(),
		identity = adminDomainIdentity(props.identity)
	const controller = useRef<AbortController | null>(null),
		live = useRef(true)
	const [receipt, setReceipt] = useState<WalletCreditReceipt | null>(null)
	const [error, setError] = useState<unknown>(null)
	const [observation, setObservation] = useState<
		'not_found' | 'legacy_unverified' | null
	>(null)
	const [busy, setBusy] = useState(false)
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
			controller.current?.abort()
		}
	}, [props.identity, props.userId])
	useEffect(() => {
		if (!props.allowed) controller.current?.abort()
	}, [props.allowed])
	const mutation = useMutation({
		mutationKey: [
			'cinatoken',
			'admin',
			props.identity,
			props.userId,
			'wallet-credit',
		],
		mutationFn: async (operation: {
			input?: WalletCreditInput
			retry?: boolean
		}) => {
			if (
				!props.allowed ||
				!identity ||
				controller.current ||
				props.status === 'unavailable'
			)
				throw new WalletCreditClientError('unavailable')
			if (operation.input && !operation.retry && !props.canStart)
				throw new WalletCreditClientError('unavailable')
			let marker = store.marker(props.identity, props.userId)
			if ((!operation.input || operation.retry) && !marker)
				throw new WalletCreditClientError('storage')
			const request = new AbortController()
			controller.current = request
			setBusy(true)
			props.onBusy(true)
			setError(null)
			setReceipt(null)
			setObservation(null)
			const options = {
				signal: request.signal,
				expectedConsoleSubject: identity.subject,
				expectedUserId: identity.userId,
			}
			try {
				let confirmed: WalletCreditReceipt | null = null
				if (operation.input) {
					confirmed = await props.api.creditUserWallet(
						props.userId,
						operation.input,
						{
							...options,
							onDispatch: () => {
								if (operation.retry) {
									if (
										!marker ||
										store.marker(props.identity, props.userId)?.generation !==
											marker.generation
									)
										throw new WalletCreditClientError('storage')
								} else
									marker = store.mark(
										props.identity,
										props.userId,
										operation.input!
									)
							},
						}
					)
				} else {
					const result = await props.api.userWalletCreditReceipt(
						props.userId,
						marker!.input.external_ref,
						options
					)
					if (result.status === 'recorded') confirmed = result.receipt
					else if (live.current && !request.signal.aborted)
						setObservation(result.status)
				}
				if (!live.current || request.signal.aborted) return
				if (confirmed) {
					if (marker) store.confirm(props.identity, marker, confirmed)
					setReceipt(confirmed)
					await props.onSaved()
				}
			} catch (failure) {
				let reported = failure
				// A rejection of a later retry cannot disprove the original uncertain dispatch.
				if (
					marker &&
					operation.input &&
					!operation.retry &&
					definitiveRejection(failure)
				) {
					try {
						store.reject(props.identity, marker)
					} catch (storageError) {
						reported = storageError
					}
				}
				if (live.current && !request.signal.aborted) {
					setError(reported)
					if (userAccessDenied(failure)) props.onDenied()
				}
			} finally {
				controller.current = null
				if (live.current) {
					setBusy(false)
					props.onBusy(false)
				}
			}
		},
		retry: false,
		gcTime: 0,
	})
	const pending =
		props.status === 'pending'
			? store.marker(props.identity, props.userId)
			: null
	async function submit(input: WalletCreditInput) {
		const snapshot = Object.freeze(walletCreditInputSchema.parse(input))
		await mutation.mutateAsync({ input: snapshot }).catch(setError)
	}
	async function reconcile() {
		await mutation.mutateAsync({}).catch(setError)
	}
	async function retrySameOrder() {
		const marker: WalletCreditMarker | null = store.marker(
			props.identity,
			props.userId
		)
		if (!marker || observation !== 'not_found') return
		await mutation
			.mutateAsync({ input: marker.input, retry: true })
			.catch(setError)
	}
	return {
		status: props.status,
		pending,
		busy,
		receipt,
		error,
		observation,
		allowed: props.allowed,
		canStart: props.canStart,
		submit,
		reconcile,
		retrySameOrder,
	}
}
