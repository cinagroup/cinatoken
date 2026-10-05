/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { PublicProvidersPage } from '../public/PublicProvidersPage'

const route = getRouteApi('/providers')

export function ProvidersRoute() {
	const search = route.useSearch()
	const navigate = useNavigate({ from: '/providers' })
	return (
		<PublicProvidersPage
			search={search}
			onSearchChange={(next) =>
				void navigate({ search: () => next, replace: true })
			}
		/>
	)
}
