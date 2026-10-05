/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { cinatokenAdminApi } from './api'
import { AdminConfigFull } from './config/AdminConfigFull'
import { useCinaTokenConsole } from './console-context'

export function AdminConfigFullRoute() {
	const console = useCinaTokenConsole()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	return (
		<AdminConfigFull
			key={console.scopeKey}
			api={cinatokenAdminApi}
			scopeKey={console.scopeKey}
			reconciliationKey={JSON.stringify([
				console.identity.userId,
				console.identity.subject,
				console.identity.epoch,
			])}
			canWrite={console.canWrite}
			revalidate={console.revalidate}
		/>
	)
}
