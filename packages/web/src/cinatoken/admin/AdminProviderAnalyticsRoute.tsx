/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { AdminProviderAnalytics } from './analytics/providers/AdminProviderAnalytics'
import { cinatokenAdminApi } from './api'
import { useCinaTokenConsole } from './console-context'

export function AdminProviderAnalyticsRoute() {
	const console = useCinaTokenConsole()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	return (
		<AdminProviderAnalytics
			key={console.scopeKey}
			api={cinatokenAdminApi}
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
