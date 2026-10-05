/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import { QueryClient } from '@tanstack/react-query'
import type { i18n } from 'i18next'
import type { PublicCatalogApi } from '../catalog-api'
import type { catalogDetailSchema } from '../catalog-contracts'
import { validateStatsSearch } from '../catalog-search'
import {
	failureStatus,
	publicBootstrapSchema,
	publicSnapshotSchema,
	safePublicError,
	type PublicBootstrap,
	type PublicSnapshot,
} from './public-bootstrap'
import { createPublicI18n } from './public-i18n'
import {
	createPublicLocation,
	type PublicLocale,
	type PublicLocation,
} from './public-location'
import {
	publicModelQueryOptions,
	publicModelsQueryOptions,
	publicProvidersQueryOptions,
	publicQueryDefaults,
	publicStatsQueryOptions,
} from './public-query-options'
import {
	publicSnapshotQueryKey,
	restorePublicQueries,
} from './public-query-state'
import { classifyPublicRoute, type PublicRoute } from './public-route'
import { createPublicRouter, type PublicRouter } from './public-router'

export type PublicRequestInput = {
	url: URL | string
	locale: PublicLocale
	api: PublicCatalogApi
	/** Passed by a trusted adapter; this never comes from arbitrary Host headers. */
	publicOrigin: string
	signal?: AbortSignal
}

export type PreparedPublicRequest = {
	app: PublicRequestApp
	status: 200 | 404 | 503
	route: PublicRoute
	bootstrap: PublicBootstrap
	modelDetail?: z.infer<typeof catalogDetailSchema>
}

export type PublicRequestApp = {
	input: PublicRequestInput
	url: URL
	route: PublicRoute
	location: PublicLocation
	queryClient: QueryClient
	i18n: i18n
	router: PublicRouter
	signal: AbortSignal
	prepared?: Promise<PreparedPublicRequest>
	dispose: () => void
}

export function createPublicRequestApp(
	input: PublicRequestInput
): PublicRequestApp {
	const url = new URL(input.url)
	const origin = new URL(input.publicOrigin)
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		origin.protocol !== 'https:' ||
		origin.username ||
		origin.password ||
		origin.pathname !== '/' ||
		origin.search ||
		origin.hash
	)
		throw new TypeError('Invalid public request origin')
	const controller = new AbortController()
	const signal = input.signal
		? AbortSignal.any([controller.signal, input.signal])
		: controller.signal
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { ...publicQueryDefaults, gcTime: Infinity },
			mutations: { retry: false, gcTime: 0 },
		},
	})
	const router = createPublicRouter({
		locale: input.locale,
		href: url.pathname + url.search,
		isServer: true,
	})
	let disposed = false
	return {
		input,
		url,
		route: classifyPublicRoute(url.pathname, input.locale),
		location: createPublicLocation(input.locale),
		queryClient,
		router,
		i18n: createPublicI18n(input.locale),
		signal,
		dispose: () => {
			if (disposed) return
			disposed = true
			controller.abort()
			void queryClient.cancelQueries().catch(() => undefined)
			queryClient.clear()
			router.history.destroy()
		},
	}
}

async function captureSnapshot(
	app: PublicRequestApp,
	scope: Record<string, string>,
	read: () => Promise<unknown>
): Promise<PublicSnapshot> {
	try {
		const data = await read()
		app.signal.throwIfAborted()
		return publicSnapshotSchema.parse({
			...scope,
			result: { status: 'success', data, observedAt: Date.now() },
		})
	} catch (error) {
		app.signal.throwIfAborted()
		return publicSnapshotSchema.parse({
			...scope,
			result: {
				status: 'error',
				error: safePublicError(error),
				observedAt: Date.now(),
			},
		})
	}
}

async function prepare(app: PublicRequestApp): Promise<PreparedPublicRequest> {
	app.signal.throwIfAborted()
	await app.router.load()
	app.signal.throwIfAborted()
	if (!app.router.state.matches.length)
		throw new Error('Public route did not produce renderable matches')
	let record: PublicSnapshot | undefined
	const route = app.route
	if (
		route.kind === 'models' ||
		route.kind === 'compare' ||
		route.kind === 'chat'
	) {
		const chat = route.kind === 'chat'
		record = await captureSnapshot(
			app,
			{ kind: chat ? 'chat-models' : 'models' },
			() =>
				app.queryClient.fetchQuery({
					...publicModelsQueryOptions(app.input.api, app.signal, chat),
					gcTime: Infinity,
				})
		)
	} else if (route.kind === 'providers') {
		record = await captureSnapshot(app, { kind: 'providers' }, () =>
			app.queryClient.fetchQuery({
				...publicProvidersQueryOptions(app.input.api, app.signal),
				gcTime: Infinity,
			})
		)
	} else if (route.kind === 'model') {
		record = await captureSnapshot(
			app,
			{ kind: 'model', vendor: route.vendor, slug: route.slug },
			() =>
				app.queryClient.fetchQuery({
					...publicModelQueryOptions(
						app.input.api,
						route.vendor,
						route.slug,
						app.signal
					),
					gcTime: Infinity,
				})
		)
	} else if (route.kind === 'rankings' || route.kind === 'benchmarks') {
		const range = validateStatsSearch(
			app.router.state.matches.at(-1)?.search
		).range
		record = await captureSnapshot(app, { kind: 'stats', range }, () =>
			app.queryClient.fetchQuery({
				...publicStatsQueryOptions(app.input.api, range, app.signal),
				gcTime: Infinity,
			})
		)
	}
	let status: 200 | 404 | 503 = route.kind === 'not-found' ? 404 : 200
	if (record?.result.status === 'error')
		status = failureStatus(record.result.error, record.kind === 'model')
	const bootstrap = publicBootstrapSchema.parse({
		version: 1,
		locale: app.input.locale,
		pathname: app.url.pathname,
		search: app.url.search,
		status,
		records: record ? [record] : [],
	})
	if (record) {
		// Restore the exact public projection for both React and metadata, including safe error instances.
		app.queryClient.removeQueries({
			queryKey: publicSnapshotQueryKey(record),
			exact: true,
		})
		restorePublicQueries(app.queryClient, bootstrap.records)
	}
	const prepared: PreparedPublicRequest = { app, status, route, bootstrap }
	const detail = bootstrap.records[0]
	if (detail?.kind === 'model' && detail.result.status === 'success')
		prepared.modelDetail = detail.result.data
	return prepared
}

/** A request has one authoritative read even if rendering and metadata ask concurrently. */
export function preparePublicRequest(
	app: PublicRequestApp
): Promise<PreparedPublicRequest> {
	app.prepared ??= prepare(app)
	return app.prepared
}
