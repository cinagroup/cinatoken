/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	defaultParseSearch,
	defaultStringifySearch,
	lazyRouteComponent,
	notFound,
	type RouterHistory,
} from '@tanstack/react-router'
import { validateChatSearch } from '../../chat/chat-search'
import { RouteErrorComponent, RoutePendingComponent } from '../../route-state'
import {
	validateCompareSearch,
	validateModelCatalogSearch,
	validateProvidersSearch,
	validateStatsSearch,
} from '../catalog-search'
import { validateBenchmarkSearch } from '../catalog-view-model'
import type { PublicLocale } from './public-location'
import { classifyPublicRoute } from './public-route'
import { preservePublicSearch } from './public-search-middleware'
import { PublicNotFoundPage, PublicShell } from './public-shell'

export function createPublicRouter(input: {
	locale: PublicLocale
	href: string
	isServer: boolean
	history?: RouterHistory
}) {
	const initialPath = new URL(input.href, 'https://public.invalid').pathname
	const invalidInitial =
		classifyPublicRoute(initialPath, input.locale).kind === 'not-found'
	const history =
		input.history ?? createMemoryHistory({ initialEntries: [input.href] })
	const currentSearch = () => defaultParseSearch(history.location.search)
	const publicChatSearch = (value: unknown) =>
		validateChatSearch({
			model:
				typeof value === 'object' &&
				value !== null &&
				!Array.isArray(value) &&
				'model' in value
					? value.model
					: undefined,
		})
	const root = createRootRoute({
		component: PublicShell,
		notFoundComponent: PublicNotFoundPage,
		beforeLoad: ({ location }) => {
			if (
				invalidInitial &&
				location.publicHref.split(/[?#]/)[0] === initialPath
			)
				throw notFound()
		},
	})
	const home = createRoute({
		getParentRoute: () => root,
		path: '/',
		component: lazyRouteComponent(() => import('../../home-page'), 'HomePage'),
	})
	const models = createRoute({
		getParentRoute: () => root,
		path: '/models',
		validateSearch: validateModelCatalogSearch,
		search: {
			middlewares: [
				preservePublicSearch(validateModelCatalogSearch, currentSearch),
			],
		},
		component: lazyRouteComponent(
			() => import('../../public-routes/ModelCatalogRoute'),
			'ModelCatalogRoute'
		),
	})
	const model = createRoute({
		getParentRoute: () => root,
		path: '/models/$vendor/$slug',
		component: lazyRouteComponent(
			() => import('../../public-routes/ModelDetailRoute'),
			'ModelDetailRoute'
		),
	})
	const providers = createRoute({
		getParentRoute: () => root,
		path: '/providers',
		validateSearch: validateProvidersSearch,
		search: {
			middlewares: [
				preservePublicSearch(validateProvidersSearch, currentSearch),
			],
		},
		component: lazyRouteComponent(
			() => import('../../public-routes/ProvidersRoute'),
			'ProvidersRoute'
		),
	})
	const compare = createRoute({
		getParentRoute: () => root,
		path: '/compare',
		validateSearch: validateCompareSearch,
		search: {
			middlewares: [preservePublicSearch(validateCompareSearch, currentSearch)],
		},
		component: lazyRouteComponent(
			() => import('../../public-routes/CompareRoute'),
			'CompareRoute'
		),
	})
	const chat = createRoute({
		getParentRoute: () => root,
		path: '/chat',
		validateSearch: publicChatSearch,
		search: {
			middlewares: [preservePublicSearch(publicChatSearch, currentSearch)],
		},
		component: lazyRouteComponent(
			() => import('../../chat/PublicChatRoute'),
			'PublicChatRoute'
		),
	})
	const rankings = createRoute({
		getParentRoute: () => root,
		path: '/rankings',
		validateSearch: validateStatsSearch,
		search: {
			middlewares: [preservePublicSearch(validateStatsSearch, currentSearch)],
		},
		component: lazyRouteComponent(
			() => import('../../public-routes/RankingsRoute'),
			'RankingsRoute'
		),
	})
	const benchmarks = createRoute({
		getParentRoute: () => root,
		path: '/benchmarks',
		validateSearch: validateBenchmarkSearch,
		search: {
			middlewares: [
				preservePublicSearch(validateBenchmarkSearch, currentSearch),
			],
		},
		component: lazyRouteComponent(
			() => import('../../public-routes/BenchmarksRoute'),
			'BenchmarksRoute'
		),
	})
	return createRouter({
		routeTree: root.addChildren([
			home,
			models,
			model,
			providers,
			compare,
			chat,
			rankings,
			benchmarks,
		]),
		history,
		stringifySearch: (search) => {
			const current = currentSearch()
			const kind = classifyPublicRoute(
				history.location.pathname,
				input.locale
			).kind
			const validators = {
				models: validateModelCatalogSearch,
				providers: validateProvidersSearch,
				compare: validateCompareSearch,
				chat: publicChatSearch,
				rankings: validateStatsSearch,
				benchmarks: validateBenchmarkSearch,
			}
			if (kind in validators) {
				const validate = validators[kind as keyof typeof validators]
				if (
					JSON.stringify(validate(current)) === JSON.stringify(validate(search))
				)
					return history.location.search
			}
			return defaultStringifySearch(search)
		},
		// Explicit rewrite keeps locale roots at /en instead of TanStack's /en/ basepath root.
		rewrite: {
			input: ({ url }) => {
				const prefix = `/${input.locale}`
				if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
					url.pathname = url.pathname.slice(prefix.length) || '/'
				return url
			},
			output: ({ url }) => {
				const prefix = `/${input.locale}`
				let bareInitial = initialPath
				if (initialPath === prefix || initialPath.startsWith(`${prefix}/`))
					bareInitial = initialPath.slice(prefix.length) || '/'
				if (url.pathname.replace(/\/$/, '') === bareInitial.replace(/\/$/, ''))
					url.pathname = initialPath
				else
					url.pathname = `${prefix}${url.pathname === '/' ? '' : url.pathname}`
				return url
			},
		},
		isServer: input.isServer,
		defaultPreload: 'intent',
		defaultErrorComponent: RouteErrorComponent,
		defaultPendingComponent: RoutePendingComponent,
		defaultPendingMs: 150,
		scrollRestoration: !input.isServer,
	})
}

export type PublicRouter = ReturnType<typeof createPublicRouter>
