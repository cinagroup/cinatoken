/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { ModelCatalogPage } from '../public/ModelCatalogPage'

const route = getRouteApi('/models')

export function ModelCatalogRoute() {
	const search = route.useSearch()
	const navigate = useNavigate({ from: '/models' })
	return (
		<ModelCatalogPage
			search={search}
			onSearchChange={(next) =>
				void navigate({ search: () => next, replace: true })
			}
		/>
	)
}
