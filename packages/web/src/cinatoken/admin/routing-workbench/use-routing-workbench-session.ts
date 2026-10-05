/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCinaTokenConsole } from '../console-context'
import type { RoutingWorkbenchSession } from './AdminRoutingWorkbench'

export function useRoutingWorkbenchSession(): RoutingWorkbenchSession | null {
	const console = useCinaTokenConsole()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	return {
		scopeKey: console.scopeKey,
		reconciliationKey: JSON.stringify([
			console.identity.userId,
			console.identity.subject,
			console.identity.epoch,
		]),
		subject: console.identity.subject,
		userId: console.identity.userId,
		canWrite: console.canWrite,
		revalidate: console.revalidate,
	}
}
