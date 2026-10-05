/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useNavigate, useSearch } from '@tanstack/react-router'
import { cinatokenAdminApi } from './api'
import { AdminAuditLogs } from './audit-logs/AdminAuditLogs'
import type { AuditLogSearch } from './audit-logs/audit-log-domain'
import { useCinaTokenConsole } from './console-context'

export function AdminAuditLogsRoute() {
	const console = useCinaTokenConsole()
	const search = useSearch({ from: '/admin/audit-logs' })
	const navigate = useNavigate()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	const reconciliationKey = JSON.stringify([
		console.identity.userId,
		console.identity.subject,
		console.identity.epoch,
	])
	function onSearch(next: AuditLogSearch): void {
		void navigate({ to: '/admin/audit-logs', search: next, replace: true })
	}
	return (
		<AdminAuditLogs
			key={JSON.stringify([console.scopeKey, reconciliationKey])}
			api={cinatokenAdminApi}
			scopeKey={console.scopeKey}
			reconciliationKey={reconciliationKey}
			revalidate={console.revalidate}
			search={search}
			onSearch={onSearch}
		/>
	)
}
