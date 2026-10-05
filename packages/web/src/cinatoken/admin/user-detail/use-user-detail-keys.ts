/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useMutation } from '@tanstack/react-query'
import { CinaTokenApiError } from '../../api'
import type { GatewayKeyPatch } from '../gateway-keys/gateway-key-input'
import {
	gatewayKeyRecovery,
	gatewayKeyWriteUnknown,
} from '../gateway-keys/gateway-key-recovery'
import type { AdminUserDetailApi } from './user-detail-api'
import type { UserDetailKey } from './user-detail-contracts'
import { createKeyMetadata } from './user-detail-domain'
import { keyCreateRecovery } from './user-detail-recovery'

type Outcome = 'saved' | 'rejected' | 'unknown' | 'conflict'
export function useUserDetailKeys(props: {
	api: AdminUserDetailApi
	identity: string
	scopeKey: string
	userId: string
	authorized: boolean
	canStart: boolean
	onError: (error: unknown) => void
	onInputError: (error: unknown) => void
	onSaved: () => Promise<void>
	onStart: () => void
}) {
	const write = gatewayKeyRecovery(props.api).write
	const legacy = keyCreateRecovery(props.api)
	const snapshot = useCallback(
		() => write.status(props.identity),
		[write, props.identity]
	)
	const legacySnapshot = useCallback(
		() => legacy.getSnapshot(props.identity, props.userId),
		[legacy, props.identity, props.userId]
	)
	const status = useSyncExternalStore(write.subscribe, snapshot, snapshot)
	const legacyPending = useSyncExternalStore(
		legacy.subscribe,
		legacySnapshot,
		legacySnapshot
	)
	const active = useRef(true)
	const controller = useRef<AbortController | null>(null)
	const action = useRef<(() => Promise<void>) | null>(null)
	const running = useRef(false)
	const mutation = useMutation({
		mutationKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'user-detail',
			props.userId,
			'key-write',
		],
		mutationFn: async () => {
			if (!action.current) throw new Error('No key operation')
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
	useEffect(() => {
		if (!props.authorized) controller.current?.abort()
	}, [props.authorized])
	const storageUnavailable =
		status === 'unavailable' ||
		legacy.isStorageUnavailable(props.identity, props.userId)
	const canWrite =
		props.authorized &&
		props.canStart &&
		status === 'ready' &&
		!legacyPending &&
		!storageUnavailable &&
		!mutation.isPending
	async function perform(
		operation: (signal: AbortSignal) => Promise<void>
	): Promise<Outcome> {
		if (!canWrite || running.current) return 'rejected'
		try {
			write.markPending(props.identity)
		} catch (error) {
			props.onInputError(error)
			return 'rejected'
		}
		running.current = true
		props.onStart()
		const abort = new AbortController()
		controller.current = abort
		action.current = () => operation(abort.signal)
		try {
			await mutation.mutateAsync()
			try {
				write.settleKnown(props.identity, 'confirmed-2xx')
			} catch (error) {
				if (active.current) props.onError(error)
			}
			if (active.current && !abort.signal.aborted) await props.onSaved()
			return 'saved'
		} catch (error) {
			const unknown = gatewayKeyWriteUnknown(error)
			if (!unknown) {
				try {
					write.settleKnown(props.identity, 'definitive-rejection')
				} catch (settleError) {
					if (active.current) props.onError(settleError)
				}
			}
			if (active.current) props.onError(error)
			if (error instanceof CinaTokenApiError && error.status === 409)
				return 'conflict'
			return unknown ? 'unknown' : 'rejected'
		} finally {
			running.current = false
			action.current = null
			controller.current = null
			mutation.reset()
		}
	}
	async function create(
		name: string,
		metadata: string,
		onSecret: (secret: string) => void
	): Promise<void> {
		let parsed: string | null
		try {
			parsed = createKeyMetadata(metadata)
		} catch (error) {
			props.onInputError(error)
			return
		}
		await perform(async (signal) => {
			legacy.markPending(props.identity, props.userId)
			try {
				await props.api.createUserDetailKey(
					props.userId,
					name.trim() || null,
					parsed,
					(secret) => {
						if (active.current && !signal.aborted) onSecret(secret)
					},
					{ signal }
				)
			} catch (error) {
				if (!gatewayKeyWriteUnknown(error))
					legacy.settleKnownPost(props.identity, props.userId)
				throw error
			}
			legacy.settleKnownPost(props.identity, props.userId)
		})
	}
	return {
		canWrite,
		busy: mutation.isPending,
		unknown: status === 'pending' && !mutation.isPending,
		legacyPending,
		storageUnavailable,
		create,
		status: async (keyId: string, status: 'active' | 'revoked') => {
			await perform(async (signal) => {
				await props.api.patchUserDetailKey(props.userId, keyId, status, {
					signal,
				})
			})
		},
		remove: async (keyId: string) => {
			await perform(async (signal) => {
				await props.api.deleteUserDetailKey(props.userId, keyId, { signal })
			})
		},
		save: (row: UserDetailKey, patch: GatewayKeyPatch) =>
			perform(async (signal) => {
				await props.api.saveUserDetailKeyEdit(row, patch, { signal })
			}),
	}
}
