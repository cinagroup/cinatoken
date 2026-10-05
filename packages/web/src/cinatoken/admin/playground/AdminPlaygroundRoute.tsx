/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi } from '@tanstack/react-router'
import { useCinaTokenConsole } from '../console-context'
import { PlaygroundScreen } from './PlaygroundScreen'
import { validatePlaygroundSearch } from './playground-contracts'

/** This wrapper is the only Playground module that depends on TanStack Router. */
const route = getRouteApi('/admin/playground')
export function AdminPlaygroundRoute() {
	const console = useCinaTokenConsole(),
		search = route.useSearch(),
		navigate = route.useNavigate()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	return (
		<PlaygroundScreen
			session={{
				scopeKey: console.scopeKey,
				reconciliationKey: JSON.stringify([
					console.identity.userId,
					console.identity.subject,
					console.identity.epoch,
				]),
				subject: console.identity.subject,
				enabled: console.canWrite,
				revalidate: console.revalidate,
			}}
			search={validatePlaygroundSearch(search)}
			onSearchChange={(next) => void navigate({ search: next, replace: true })}
		/>
	)
}
