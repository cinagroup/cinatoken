/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi } from '@tanstack/react-router'
import { cinatokenAdminApi } from '../api'
import { useCinaTokenConsole } from '../console-context'
import { ChainOperationsScreen } from './ChainOperationsScreen'
import { validateChainOperationsSearch } from './chain-operations-search'

const route = getRouteApi('/admin/withdrawals')
export function AdminWithdrawalsRoute() {
	const console = useCinaTokenConsole()
	const search = validateChainOperationsSearch(route.useSearch(), 'withdrawals')
	const navigate = route.useNavigate()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	return (
		<ChainOperationsScreen
			kind='withdrawals'
			api={cinatokenAdminApi}
			search={search}
			onSearchChange={(next) => {
				void navigate({ search: next, replace: true })
			}}
			session={{
				scopeKey: console.scopeKey,
				subject: console.identity.subject,
				reconciliationKey: JSON.stringify([
					console.identity.userId,
					console.identity.subject,
					console.identity.epoch,
				]),
				enabled: console.isVerified,
				revalidate: console.revalidate,
			}}
		/>
	)
}
