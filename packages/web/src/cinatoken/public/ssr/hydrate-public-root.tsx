/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { hydrateRoot, type Root } from 'react-dom/client'
import { QueryClient } from '@tanstack/react-query'
import { createBrowserHistory } from '@tanstack/react-router'
import { hydrate as hydrateRouter } from '@tanstack/react-router/ssr/client'
import { PublicApplication } from './public-application'
import { publicBootstrapSchema, type PublicBootstrap } from './public-bootstrap'
import { createPublicI18n } from './public-i18n'
import { createPublicLocation } from './public-location'
import { publicQueryDefaults } from './public-query-options'
import { restorePublicQueries } from './public-query-state'
import { createPublicRouter } from './public-router'

export async function hydratePublicRoot(
	element: Element,
	input: PublicBootstrap
): Promise<Root> {
	const bootstrap = publicBootstrapSchema.parse(input)
	if (
		window.location.pathname !== bootstrap.pathname ||
		window.location.search !== bootstrap.search
	)
		throw new TypeError('Public hydration location does not match the response')
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: publicQueryDefaults,
			mutations: { retry: false, gcTime: 0 },
		},
	})
	const history = createBrowserHistory()
	const router = createPublicRouter({
		locale: bootstrap.locale,
		href: bootstrap.pathname + bootstrap.search,
		isServer: false,
		history,
	})
	try {
		restorePublicQueries(queryClient, bootstrap.records)
		const app = {
			queryClient,
			router,
			i18n: createPublicI18n(bootstrap.locale),
			location: createPublicLocation(bootstrap.locale),
		}
		try {
			await hydrateRouter(router)
		} finally {
			window.$_TSR?.h()
		}
		return hydrateRoot(element, <PublicApplication app={app} />, {
			identifierPrefix: 'cinatoken-public-',
		})
	} catch (error) {
		queryClient.clear()
		history.destroy()
		throw error
	}
}
