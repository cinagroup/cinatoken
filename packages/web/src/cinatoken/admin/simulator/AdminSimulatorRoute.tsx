/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi } from '@tanstack/react-router'
import { useCinaTokenConsole } from '../console-context'
import { SimulatorScreen } from './SimulatorScreen'
import { validateSimulatorSearch } from './simulator-search'

const route = getRouteApi('/admin/simulator')

export function AdminSimulatorRoute() {
	const console = useCinaTokenConsole()
	const search = validateSimulatorSearch(route.useSearch())
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	return (
		<SimulatorScreen
			key={console.scopeKey}
			search={search}
			session={{
				scopeKey: console.scopeKey,
				reconciliationKey: JSON.stringify([
					console.identity.userId,
					console.identity.subject,
					console.identity.epoch,
				]),
				subject: console.identity.subject,
				enabled: console.isVerified,
				revalidate: console.revalidate,
			}}
		/>
	)
}
