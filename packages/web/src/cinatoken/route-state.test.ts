/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	lazyRouteComponent,
	Outlet,
	RouterProvider,
} from '@tanstack/react-router'
import { attachRouterServerSsrUtils } from '@tanstack/react-router/ssr/server'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { createPublicCatalogApi } from './public/catalog-api'
import { PublicApplication } from './public/ssr/public-application'
import { createPublicI18n } from './public/ssr/public-i18n'
import { PUBLIC_LOCALES } from './public/ssr/public-location'
import {
	createPublicRequestApp,
	preparePublicRequest,
} from './public/ssr/public-request-app'
import { createPublicRouter } from './public/ssr/public-router'
import { retryFailedRoute } from './route-recovery'
import { RouteErrorComponent, RoutePendingComponent } from './route-state'
import { router as applicationRouter } from './router'
import { shellMessages } from './shell-messages'

function TestShell() {
	return createElement(
		'div',
		null,
		createElement('header', null, 'Retained navigation'),
		createElement('main', null, createElement(Outlet))
	)
}

for (const locale of PUBLIC_LOCALES) {
	test(`route pending and safe loader errors keep their shell and ${locale} text`, async () => {
		const instance = createPublicI18n(locale)
		const pending = renderToStaticMarkup(
			createElement(
				I18nextProvider,
				{ i18n: instance },
				createElement(RoutePendingComponent)
			)
		)
		assert.match(pending, /role="status"/)
		assert.match(pending, /aria-busy="true"/)
		assert.ok(pending.includes(shellMessages[locale].loadingPage))
		const failure = new Error('SECRET_PRIVATE_EXCEPTION_MESSAGE')
		failure.stack = 'SECRET_PRIVATE_EXCEPTION_STACK'
		const root = createRootRoute({ component: TestShell })
		const child = createRoute({
			getParentRoute: () => root,
			path: '/failed',
			loader: () => {
				throw failure
			},
			component: () => createElement('p', null, 'Loaded route'),
		})
		const router = createRouter({
			routeTree: root.addChildren([child]),
			history: createMemoryHistory({ initialEntries: ['/failed'] }),
			isServer: true,
			defaultErrorComponent: RouteErrorComponent,
			defaultPendingComponent: RoutePendingComponent,
		})
		try {
			await router.load()
			assert.equal(router.state.matches.at(-1)?.status, 'error')
			const html = renderToStaticMarkup(
				createElement(
					I18nextProvider,
					{ i18n: instance },
					createElement(RouterProvider, { router })
				)
			)
			assert.match(html, /<header>Retained navigation<\/header>/)
			assert.match(html, /<main><section/)
			assert.match(html, /role="alert"/)
			assert.ok(html.includes(shellMessages[locale].pageUnavailable))
			assert.ok(html.includes(shellMessages[locale].retry))
			assert.ok(html.includes(shellMessages[locale].backHome))
			assert.equal(html.includes('SECRET_'), false)
			assert.equal(html.includes('Show Error'), false)
			assert.equal(html.includes('Something went wrong'), false)
		} finally {
			router.history.destroy()
		}
	})
}

test('retry reruns an actual failed loader and waits before resetting the render boundary', async () => {
	let reads = 0
	let resets = 0
	let release: (() => void) | undefined
	const resumed = new Promise<void>((resolve) => {
		release = resolve
	})
	const root = createRootRoute({ component: TestShell })
	const child = createRoute({
		getParentRoute: () => root,
		path: '/account/keys',
		loader: async () => {
			reads++
			if (reads === 1) throw new Error('temporary-read-failure')
			await resumed
			return 'server-confirmed-result'
		},
		component: () => createElement('p', null, 'Loaded route'),
	})
	const router = createRouter({
		routeTree: root.addChildren([child]),
		history: createMemoryHistory({ initialEntries: ['/account/keys?keep=1'] }),
		isServer: true,
	})
	try {
		await router.load()
		assert.equal(reads, 1)
		assert.equal(router.state.matches.at(-1)?.status, 'error')
		const retry = retryFailedRoute(router, () => {
			resets++
		})
		await new Promise<void>((resolve) => queueMicrotask(resolve))
		assert.equal(resets, 0)
		release!()
		await retry
		assert.equal(reads, 2)
		assert.equal(resets, 1)
		assert.equal(router.state.matches.at(-1)?.status, 'success')
		assert.equal(
			router.state.matches.at(-1)?.loaderData,
			'server-confirmed-result'
		)
		assert.equal(router.state.location.href, '/account/keys?keep=1')
	} finally {
		router.history.destroy()
	}
})

test('retry reimports a rejected lazy route instead of resetting the same stored import error', async () => {
	let imports = 0
	let resets = 0
	const component = lazyRouteComponent(async () => {
		imports++
		if (imports === 1) throw new Error('temporary-chunk-failure')
		return { default: () => createElement('p', null, 'Lazy route recovered') }
	})
	const root = createRootRoute({ component: TestShell })
	const child = createRoute({
		getParentRoute: () => root,
		path: '/admin/models',
		component,
	})
	const router = createRouter({
		routeTree: root.addChildren([child]),
		history: createMemoryHistory({ initialEntries: ['/admin/models?q=kept'] }),
		isServer: true,
	})
	try {
		await router.load()
		assert.equal(imports, 1)
		assert.throws(
			() => renderToStaticMarkup(createElement(component)),
			/temporary-chunk-failure/
		)
		await retryFailedRoute(router, () => {
			resets++
		})
		assert.equal(imports, 2)
		assert.equal(resets, 1)
		assert.match(
			renderToStaticMarkup(createElement(component)),
			/Lazy route recovered/
		)
		assert.equal(router.state.location.href, '/admin/models?q=kept')
	} finally {
		router.history.destroy()
	}
})

test('both application and public router entrances install the shared route states', () => {
	assert.equal(
		applicationRouter.options.defaultErrorComponent,
		RouteErrorComponent
	)
	assert.equal(
		applicationRouter.options.defaultPendingComponent,
		RoutePendingComponent
	)
	for (const isServer of [true, false]) {
		const router = createPublicRouter({
			locale: 'zh',
			href: '/zh/models',
			isServer,
		})
		try {
			assert.equal(router.options.defaultErrorComponent, RouteErrorComponent)
			assert.equal(
				router.options.defaultPendingComponent,
				RoutePendingComponent
			)
		} finally {
			router.history.destroy()
		}
	}
})

for (const locale of PUBLIC_LOCALES) {
	test(`public route errors keep the real public shell and locale home link: ${locale}`, async () => {
		const app = createPublicRequestApp({
			url: `https://request.invalid/${locale}/models`,
			locale,
			publicOrigin: 'https://canonical.invalid',
			api: createPublicCatalogApi(async () => {
				throw new Error('Catalog must not run in a route error')
			}),
		})
		app.router.routesById['/models']!.options.loader = () => {
			throw new Error('SECRET_LOADER_BODY')
		}
		try {
			await app.router.load()
			const html = renderToStaticMarkup(
				createElement(PublicApplication, { app })
			)
			assert.match(html, /<header/)
			assert.match(html, /<main id="main-content"/)
			assert.match(html, /<footer/)
			assert.ok(html.includes(shellMessages[locale].pageUnavailable))
			assert.ok(html.includes(`href="/${locale}"`))
			assert.equal(html.includes('SECRET_'), false)
		} finally {
			app.dispose()
		}
	})
}

test('public preparation stops an actual router failure before catalog reads or error dehydration', async (t) => {
	let catalogReads = 0
	let dehydrations = 0
	const failure = new Error('SECRET_ROUTER_MESSAGE')
	failure.stack = 'SECRET_ROUTER_STACK'
	const app = createPublicRequestApp({
		url: 'https://request.invalid/zh/models',
		locale: 'zh',
		publicOrigin: 'https://canonical.invalid',
		api: createPublicCatalogApi(async () => {
			catalogReads++
			throw new Error('Catalog must not run after router failure')
		}),
	})
	app.router.routeTree.options.beforeLoad = () => {
		throw failure
	}
	attachRouterServerSsrUtils({ router: app.router, manifest: undefined })
	assert.ok(app.router.serverSsr)
	t.mock.method(app.router.serverSsr, 'dehydrate', async () => {
		dehydrations++
	})
	try {
		await assert.rejects(
			async () => {
				await preparePublicRequest(app)
				await app.router.serverSsr!.dehydrate({ signal: app.signal })
			},
			(error) => error === failure
		)
		assert.equal(dehydrations, 0)
		assert.equal(catalogReads, 0)
		assert.equal(app.router.state.matches[0]?.status, 'error')
	} finally {
		app.router.serverSsr?.cleanup()
		app.dispose()
	}
	assert.equal(app.signal.aborted, true)
	assert.equal(app.queryClient.getQueryCache().getAll().length, 0)
})
