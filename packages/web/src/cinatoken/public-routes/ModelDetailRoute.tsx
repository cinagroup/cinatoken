/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi } from '@tanstack/react-router'
import { ModelDetailPage } from '../public/ModelDetailPage'

const route = getRouteApi('/models/$vendor/$slug')

export function ModelDetailRoute() {
	const params = route.useParams()
	return <ModelDetailPage vendor={params.vendor} slug={params.slug} />
}
