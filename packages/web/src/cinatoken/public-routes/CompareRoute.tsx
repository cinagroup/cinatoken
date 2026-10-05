/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { ModelComparePage } from '../public/ModelComparePage'

const route = getRouteApi('/compare')

export function CompareRoute() {
	const search = route.useSearch()
	const navigate = useNavigate({ from: '/compare' })
	return (
		<ModelComparePage
			search={search}
			onSearchChange={(next) =>
				void navigate({ search: () => next, replace: true })
			}
		/>
	)
}
