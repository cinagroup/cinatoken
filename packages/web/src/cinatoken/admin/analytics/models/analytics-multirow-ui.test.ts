/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { ProviderAnalyticsTable } from '../providers/ProviderAnalyticsTable'
import { adminProviderAnalyticsMessages } from '../providers/messages'
import { AnalyticsDrilldownControls } from './AnalyticsDrilldownControls'
import { ModelAnalyticsTable } from './ModelAnalyticsTable'
import type { AnalyticsDetailState } from './analytics-drilldowns'
import { adminModelAnalyticsMessages } from './messages'
import {
	modelAnalyticsRowSchema,
	modelProviderRowSchema,
	type ModelAnalyticsRow,
	type ModelProviderRow,
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
async function render(
	node: ReactNode,
	locale: 'en' | 'zh' | 'ja' | 'ko' = 'en'
): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		resources: {
			[locale]: {
				translation: {
					cinatoken: {
						adminModelAnalytics: adminModelAnalyticsMessages[locale],
						adminProviderAnalytics: adminProviderAnalyticsMessages[locale],
					},
				},
			},
		},
	})
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, node))
}

test('model rows with the same name keep independently expanded success, error and loading details', async () => {
	const models = ['group-a', 'group-b', 'group-c'].map((route_group) => ({
		...model,
		route_group,
	}))
	const details = new Map<string, AnalyticsDetailState<ModelProviderRow>>([
		[
			JSON.stringify([model.model_id, 'group-a']),
			{
				rows: [{ ...provider, provider_name: 'Only A supplier' }],
				loading: false,
				error: false,
				retry: () => assert.fail('SSR must not retry'),
			},
		],
		[
			JSON.stringify([model.model_id, 'group-b']),
			{
				rows: [{ ...provider, provider_name: 'Stale failed supplier' }],
				loading: false,
				error: true,
				retry: () => assert.fail('SSR must not retry'),
			},
		],
		[
			JSON.stringify([model.model_id, 'group-c']),
			{
				rows: undefined,
				loading: true,
				error: false,
				retry: () => assert.fail('SSR must not retry'),
			},
		],
	])
	for (const [view, columns] of [
		['overview', 7],
		['cost', 10],
		['performance', 10],
		['all', 19],
	] as const) {
		const html = await render(
			createElement(ModelAnalyticsTable, {
				...base,
				rows: models,
				details,
				view,
				sortKey: 'model_id',
			})
		)
		assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 3)
		assert.equal(
			(html.match(new RegExp('colSpan="' + columns + '"', 'g')) ?? []).length,
			3
		)
		assert.ok(html.includes('Only A supplier'))
		assert.equal(html.includes('Stale failed supplier'), false)
		assert.ok(html.includes(adminModelAnalyticsMessages.en.detailFailed))
		assert.ok(html.includes(adminModelAnalyticsMessages.en.loadingProviders))
		for (const group of ['group-a', 'group-b', 'group-c'])
			assert.ok(
				html.includes(
					'aria-label="Toggle provider details for sample-model in ' +
						group +
						'"'
				)
			)
	}
})

test('provider rows with duplicate display names render their own model results and identify toggles by provider ID', async () => {
	const providers = ['id-a', 'id-b', 'id-c'].map((provider_id) => ({
		...provider,
		provider_id,
		provider_name: 'Same supplier',
	}))
	const details = new Map<string, AnalyticsDetailState<ModelAnalyticsRow>>([
		[
			'id-a',
			{
				rows: [{ ...model, model_id: 'Only A model' }],
				loading: false,
				error: false,
				retry: () => assert.fail('SSR must not retry'),
			},
		],
		[
			'id-b',
			{
				rows: [],
				loading: false,
				error: false,
				retry: () => assert.fail('SSR must not retry'),
			},
		],
	])
	const html = await render(
		createElement(ProviderAnalyticsTable, {
			...base,
			rows: providers,
			tag: '',
			details,
			view: 'overview',
			sortKey: 'provider_name',
		})
	)
	assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 2)
	assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 1)
	assert.equal((html.match(/Only A model/g) ?? []).length, 2) // Visible model and its request-log link label.
	assert.ok(html.includes(adminProviderAnalyticsMessages.en.noModels))
	for (const id of ['id-a', 'id-b', 'id-c'])
		assert.ok(
			html.includes(
				'aria-label="Toggle model details for Same supplier (' + id + ')"'
			)
		)
})

test('four languages expose an expanded count and disable collapse-all only when no detail is expanded', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		for (const count of [0, 2]) {
			const html = await render(
				createElement(AnalyticsDrilldownControls, {
					count,
					onCollapse: () => assert.fail('SSR must not collapse'),
				}),
				locale
			)
			assert.ok(
				html.includes(
					adminModelAnalyticsMessages[locale].drilldownExpanded.replace(
						'{{count}}',
						String(count)
					)
				)
			)
			assert.ok(
				html.includes(adminModelAnalyticsMessages[locale].collapseDetails)
			)
			assert.equal(html.includes('disabled=""'), count === 0)
			assert.equal(html.includes('cinatoken.admin'), false)
		}
	}
})
