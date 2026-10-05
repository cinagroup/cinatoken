/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { RankingsPage } from '../public/RankingsPage'

const route = getRouteApi('/rankings')

export function RankingsRoute() {
	const search = route.useSearch()
	const navigate = useNavigate({ from: '/rankings' })
	return (
		<RankingsPage
			search={search}
			onSearchChange={(next) =>
				void navigate({ search: () => next, replace: true })
			}
		/>
	)
}
