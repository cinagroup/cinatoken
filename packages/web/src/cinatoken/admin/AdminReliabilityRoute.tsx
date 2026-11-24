/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { cinatokenAdminApi } from './api'
import { useCinaTokenConsole } from './console-context'
import { AdminReliability } from './reliability/AdminReliability'

export function AdminReliabilityRoute() {
	const console = useCinaTokenConsole()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	return (
		<AdminReliability
			key={console.scopeKey}
			api={cinatokenAdminApi}
			directoryApi={cinatokenAdminApi}
			logsApi={cinatokenAdminApi}
			subject={console.identity.subject}
			scopeKey={console.scopeKey}
			reconciliationKey={JSON.stringify([
				console.identity.userId,
				console.identity.subject,
				console.identity.epoch,
			])}
			revalidate={console.revalidate}
		/>
	)
}
