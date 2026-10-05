/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useSyncExternalStore } from 'react'
import type { AccessKeyAccessRecovery } from '../access-keys/access-key-recovery'
import type { AdminSharedKeyWriteRecovery } from './shared-key-recovery'

export function useSharedKeyAccess(
	store: AccessKeyAccessRecovery,
	identity: string
) {
	const snapshot = useCallback(
		() => store.getSnapshot(identity),
		[store, identity]
	)
	return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}
export function useSharedKeyPending(
	store: AdminSharedKeyWriteRecovery,
	identity: string
) {
	const snapshot = useCallback(() => store.status(identity), [store, identity])
	return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}
