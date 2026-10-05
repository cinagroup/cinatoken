/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useNavigate, useSearch } from '@tanstack/react-router'
import { cinatokenAdminApi } from './api'
import { useCinaTokenConsole } from './console-context'
import { AdminToolInvocations } from './tool-invocations/AdminToolInvocations'
import type { ToolInvocationSearch } from './tool-invocations/tool-invocation-domain'

export function AdminToolInvocationsRoute() {
	const console = useCinaTokenConsole()
	const search = useSearch({ from: '/admin/tools/invocations' })
	const navigate = useNavigate()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	const reconciliationKey = JSON.stringify([
		console.identity.userId,
		console.identity.subject,
		console.identity.epoch,
	])
	function onSearch(next: ToolInvocationSearch): void {
		void navigate({
			to: '/admin/tools/invocations',
			search: next,
			replace: true,
		})
	}
	return (
		<AdminToolInvocations
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
