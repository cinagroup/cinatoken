/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { BenchmarksPage } from '../public/BenchmarksPage'
import { validateBenchmarkSearch } from '../public/catalog-view-model'

const route = getRouteApi('/benchmarks')

export function BenchmarksRoute() {
	const search = route.useSearch()
	const navigate = useNavigate({ from: '/benchmarks' })
	return (
		<BenchmarksPage
			search={validateBenchmarkSearch(search)}
			onSearchChange={(next) =>
				void navigate({ search: () => next, replace: true })
			}
		/>
	)
}
