/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { ProviderAnalyticsTable } from '../providers/ProviderAnalyticsTable'
import { adminProviderAnalyticsMessages } from '../providers/messages'
import { ModelAnalyticsTable } from './ModelAnalyticsTable'
import type { AnalyticsView } from './analytics-view'
import { adminModelAnalyticsMessages } from './messages'
import {
	modelAnalyticsRowSchema,
	modelProviderRowSchema,
} from './model-analytics-contracts'

const metric = {
	request_count: 10,
	input_tokens: 12345,
	output_tokens: 5432,
	cache_read_tokens: 20,
	cache_write_tokens: 5,
	cache_hit_rate: 12,
	standard_cost: 7,
	charged_cost: 6,
	metered_cost: 4,
	avg_charged_per_request: 0.6,
	success_count: 8,
	error_count: 1,
	success_rate: 80,
	avg_latency_ms: 300,
	avg_first_reasoning_token_ms: null,
	avg_first_token_ms: 30,
	avg_effective_ttft_ms: 30,
	avg_reasoning_phase_ms: null,
	reasoning_ttft_rate: 0,
	content_ttft_rate: 80,
	avg_upstream_response_ms: 20,
	tokens_per_second: 100,
	stream_tokens_per_second: 45,
	stream_sample_count: 6,
	failover_rate: 150,
	failover_request_count: 2,
	failover_request_rate: 20,
	avg_attempts: 2.5,
}
const model = modelAnalyticsRowSchema.parse({
	...metric,
	model_id: 'sample-model',
	route_group: 'default',
})
const provider = modelProviderRowSchema.parse({
	...metric,
	provider_id: 'provider-a',
	provider_name: 'Provider A',
	distinct_models: 1,
})
const base = {
	range: { startUtc: '2026-10-22 00:00:00', endUtc: '2026-10-23 00:00:00' },
	logsAllowed: true,
	currency: 'USD' as const,
	locale: 'en',
	tokenMode: 'compact' as const,
	sortDirection: 'asc' as const,
	onSort: () => assert.fail('SSR must not dispatch sorting'),
	onToggle: () => assert.fail('SSR must not open details'),
}
async function render(node: ReactNode): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: 'en',
		fallbackLng: false,
		resources: {
			en: {
				translation: {
					cinatoken: {
						adminModelAnalytics: adminModelAnalyticsMessages.en,
						adminProviderAnalytics: adminProviderAnalyticsMessages.en,
					},
				},
			},
		},
	})
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, node))
}
function table(
	scope: 'models' | 'providers',
	view: AnalyticsView,
	options: {
		expanded?: boolean
		loading?: boolean
		error?: boolean
		emptyDetail?: boolean
		currency?: null
	} = {}
) {
	const shared = {
		...base,
		view,
		...(options.currency === null ? { currency: null } : {}),
	}
	if (scope === 'models')
		return createElement(ModelAnalyticsTable, {
			...shared,
			rows: [model],
			sortKey: 'model_id',
			details: new Map(
				options.expanded
					? [
							[
								JSON.stringify([model.model_id, model.route_group]),
								{
									rows: options.emptyDetail ? [] : [provider],
									loading: options.loading ?? false,
									error: options.error ?? false,
									retry: () => assert.fail('SSR must not retry'),
								},
							],
						]
					: []
			),
		})
	return createElement(ProviderAnalyticsTable, {
		...shared,
		tag: '',
		rows: [provider],
		sortKey: 'provider_name',
		details: new Map(
			options.expanded
				? [
						[
							provider.provider_id,
							{
								rows: options.emptyDetail ? [] : [model],
								loading: options.loading ?? false,
								error: options.error ?? false,
								retry: () => assert.fail('SSR must not retry'),
							},
						],
					]
				: []
		),
	})
}
const counts: Record<AnalyticsView, number> = {
	overview: 7,
	cost: 10,
	performance: 10,
	all: 19,
}
function firstRow(html: string): string {
	return (
		html.match(/<tbody[^>]*><tr[^>]*>([\s\S]*?)<\/tr>/)?.[1] ??
		assert.fail('Missing first row')
	)
}
function firstHead(html: string): string {
	return (
		html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/)?.[1] ??
		assert.fail('Missing header')
	)
}

test('each analytics view renders matching visible headers and cells, preserving all legacy metrics only in all', async () => {
	for (const scope of ['models', 'providers'] as const)
		for (const view of ['overview', 'cost', 'performance', 'all'] as const) {
			const html = await render(table(scope, view)),
				count = counts[view]
			assert.equal((firstHead(html).match(/<th\b/g) ?? []).length, count)
			assert.equal((firstRow(html).match(/<td\b/g) ?? []).length, count)
			assert.equal(html.includes('hidden='), false)
			assert.equal(firstRow(html).includes('150.0%'), view === 'all')
			assert.equal(
				firstHead(html).includes(
					adminModelAnalyticsMessages.en.stream_tokens_per_second
				),
				view === 'performance' || view === 'all'
			)
			assert.equal(
				firstRow(html).includes('12.35K'),
				view === 'cost' || view === 'all'
			)
			assert.equal(html.includes('cinatoken.admin'), false)
		}
})

test('expanded success, loading, empty and error rows span exactly the active main view while full detail remains available', async () => {
	for (const scope of ['models', 'providers'] as const)
		for (const view of ['overview', 'cost', 'performance', 'all'] as const) {
			const count = counts[view]
			for (const state of [
				{},
				{ loading: true },
				{ error: true },
				{ emptyDetail: true },
			]) {
				const html = await render(
					table(scope, view, { expanded: true, ...state })
				)
				assert.match(html, new RegExp('colSpan="' + count + '"', 'i'))
				const tableCount = (html.match(/<table\b/g) ?? []).length
				assert.equal(tableCount, Object.keys(state).length ? 1 : 2)
				if (!Object.keys(state).length) {
					const headers = [...html.matchAll(/<thead[^>]*>([\s\S]*?)<\/thead>/g)]
					assert.equal((headers[1][1].match(/<th\b/g) ?? []).length, 17)
					assert.match(html, /provider_id=provider-a/)
					assert.match(html, /model_id=sample-model/)
				}
			}
		}
})

test('cost view keeps unknown-currency amounts hidden and search-empty state distinct from an empty time range', async () => {
	for (const scope of ['models', 'providers'] as const) {
		const html = await render(table(scope, 'cost', { currency: null }))
		assert.equal(
			(
				firstRow(html).match(
					new RegExp('>' + adminModelAnalyticsMessages.en.hidden + '<', 'g')
				) ?? []
			).length,
			4
		)
	}
	const html = await render(
		createElement(ModelAnalyticsTable, {
			...base,
			view: 'overview',
			rows: [],
			details: new Map(),
			sortKey: 'model_id',
			emptyMessage: adminModelAnalyticsMessages.en.viewNoMatches,
		})
	)
	assert.ok(html.includes(adminModelAnalyticsMessages.en.viewNoMatches))
	assert.equal(html.includes(adminModelAnalyticsMessages.en.noData), false)
})
