/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useNavigate, useSearch } from '@tanstack/react-router'
import { cinatokenAdminApi } from './api'
import { useCinaTokenConsole } from './console-context'
import { AdminMcp } from './mcp/AdminMcp'
import type { McpSearch } from './mcp/mcp-domain'

export function AdminMcpRoute() {
	const console = useCinaTokenConsole()
	const search = useSearch({ from: '/admin/mcp' })
	const navigate = useNavigate()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	const identity = console.identity
	const reconciliationKey = JSON.stringify([
		identity.userId,
		identity.subject,
		identity.epoch,
	])
	function onSearch(next: McpSearch): void {
		void navigate({ to: '/admin/mcp', search: next, replace: true })
	}
	return (
		<AdminMcp
			key={JSON.stringify([
				console.scopeKey,
				reconciliationKey,
				search.server ?? '',
			])}
			api={cinatokenAdminApi}
			session={{
				scopeKey: console.scopeKey,
				reconciliationKey,
				subject: identity.subject,
				userId: identity.userId,
				enabled: true,
				revalidate: console.revalidate,
			}}
			search={search}
			onSearch={onSearch}
		/>
	)
}
