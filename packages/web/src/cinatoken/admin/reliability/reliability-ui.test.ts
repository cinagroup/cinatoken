/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import type { AnalyticsProviderDirectory } from '../analytics/providers/analytics-provider-directory'
import { ReliabilityDirectoryStatus } from './ReliabilityDirectoryStatus'
import { ReliabilityInsights } from './ReliabilityInsights'
import {
	ReliabilityProviderAccount,
	ReliabilityProviderKind,
} from './ReliabilityProviderIdentity'
import { ReliabilityRecentErrors } from './ReliabilityRecentErrors'
import { ReliabilityTables } from './ReliabilityTables'
import { adminReliabilityMessages } from './messages'
import {
	providerReliabilitySchema,
	modelProviderReliabilitySchema,
} from './reliability-contracts'

const range = { startUtc: '2026-10-01 00:00:00', endUtc: '2026-10-02 00:00:00' }
const row = providerReliabilitySchema.parse({
	provider_id: 'provider-1',
	provider_name: 'Snapshot account',
	request_count: 10,
	success_count: 7,
	error_count: 2,
	success_rate: 70,
	avg_latency_ms: 25,
	avg_upstream_response_ms: null,
	avg_attempts: 2.5,
	failover_rate: 150,
	failover_request_count: 2,
	failover_request_rate: 20,
	charged_cost: 1,
	metered_cost: 2,
	standard_cost: 3,
})
const model = modelProviderReliabilitySchema.parse({
	...row,
	model_id: 'model-1',
})
const directory: AnalyticsProviderDirectory = {
	status: 'ready',
	providers: new Map([
		[
			'provider-1',
			{
				id: 'provider-1',
				name: 'Current account',
				kind: 'kind-a',
				kind_labels: { en: 'Current type', zh: '当前类型' },
			},
		],
	]),
}
type Locale = 'en' | 'zh' | 'ja' | 'ko'
async function render(node: ReactNode, locale: Locale = 'en'): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		resources: {
			[locale]: {
				translation: {
					cinatoken: { adminReliability: adminReliabilityMessages[locale] },
				},
			},
		},
	})
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, node))
}
function escaped(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#x27;')
}

test('six reliability summary cards expose exact outcomes and negative difference in all four languages', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const m = adminReliabilityMessages[locale]
		const html = await render(
			createElement(ReliabilityInsights, {
				rows: [row],
				currency: 'USD',
				locale,
			}),
			locale
		)
		assert.equal((html.match(/<dt\b/g) ?? []).length, 6)
		for (const key of [
			'insightsTitle',
			'requests',
			'successRate',
			'errors',
			'chargedCost',
			'meteredCost',
			'costDifference',
			'definitions',
			'summaryScope',
			'outcomeNote',
			'failoverNote',
		] as const)
			assert.ok(html.includes(escaped(m[key])), `${locale}/${key}`)
		assert.ok(
			html.includes(
				escaped(
					m.outcomes
						.replace('{{success}}', '7')
						.replace('{{errors}}', '2')
						.replace('{{other}}', '1')
				)
			)
		)
		assert.ok(
			html.includes(
				new Intl.NumberFormat(locale, {
					style: 'currency',
					currency: 'USD',
					minimumFractionDigits: 2,
					maximumFractionDigits: 4,
				}).format(-1)
			)
		)
		assert.ok(
			html.includes(
				(0.7).toLocaleString(locale, {
					style: 'percent',
					minimumFractionDigits: 1,
					maximumFractionDigits: 1,
				})
			)
		)
		assert.equal(html.includes('cinatoken.adminReliability.'), false)
		assert.equal(html.includes('{{'), false)
	}
})

test('empty range has no success sample and unknown currency hides only money', async () => {
	const hidden = await render(
		createElement(ReliabilityInsights, {
			rows: [row],
			currency: null,
			locale: 'en',
		})
	)
	assert.ok(hidden.includes('70.0%'))
	assert.ok(hidden.includes(adminReliabilityMessages.en.amountUnavailable))
	assert.doesNotMatch(hidden, /\$|NaN|Infinity/)
	const empty = await render(
		createElement(ReliabilityInsights, {
			rows: [],
			currency: 'USD',
			locale: 'en',
		})
	)
	assert.ok(empty.includes(adminReliabilityMessages.en.noSamples))
	assert.equal(empty.includes('0.0%'), false)
})

test('table columns align and distinguish request share, event rate and unknown legacy measures', async () => {
	const legacy = {
		...row,
		provider_id: 'old',
		failover_request_count: undefined,
		failover_request_rate: undefined,
	}
	const html = await render(
		createElement(ReliabilityTables, {
			providers: [row, legacy],
			modelProviders: [model],
			currency: 'USD',
			locale: 'en',
			directory,
			range,
			logsAllowed: true,
		})
	)
	const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/g)].map(
		(match) => match[0]
	)
	assert.equal(tables.length, 2)
	for (const table of tables) {
		const head = table.match(/<thead\b[\s\S]*?<\/thead>/)?.[0] ?? ''
		assert.equal((head.match(/<th\b/g) ?? []).length, 13)
		const body = table.match(/<tbody\b[\s\S]*?<\/tbody>/)?.[0] ?? ''
		for (const row of body.matchAll(/<tr\b[\s\S]*?<\/tr>/g))
			assert.equal((row[0].match(/<t[dh]\b/g) ?? []).length, 13)
	}
	assert.ok(html.includes('20.0%'))
	assert.ok(html.includes('2 of 10 requests'))
	assert.ok(html.includes('>150</td>'))
	assert.equal(html.includes('150.0%'), false)
	assert.ok(html.includes(adminReliabilityMessages.en.failoverUnknown))
	assert.ok(html.includes('Current account'))
	assert.ok(html.includes('provider_id=provider-1'))
	assert.ok(html.includes('start_date=2026-10-01+00%3A00%3A00'))
	assert.ok(html.includes('end_date=2026-10-02+00%3A00%3A00'))
	const denied = await render(
		createElement(ReliabilityTables, {
			providers: [row],
			modelProviders: [model],
			currency: 'USD',
			locale: 'en',
			range,
			logsAllowed: false,
		})
	)
	assert.equal(denied.includes('<a '), false)
	assert.ok(denied.includes('20.0%'))
})

test('recent errors carry the selected range, all provider identity columns and only verified log links', async () => {
	const rows = [
		{
			id: 'request-1',
			model_id: 'model-1',
			provider_id: 'provider-1',
			provider_name: 'Snapshot account',
			status: 'error' as const,
			created_at: '2026-10-01T05:00:00.000Z',
		},
	]
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(
			createElement(ReliabilityRecentErrors, {
				rows,
				timezone: 'UTC',
				locale,
				directory,
				range,
				logsAllowed: true,
			}),
			locale
		)
		assert.ok(
			html.includes(escaped(adminReliabilityMessages[locale].recentIndependent))
		)
		assert.ok(html.includes('start_date=2026-10-01+00%3A00%3A00'))
		assert.ok(html.includes('end_date=2026-10-02+00%3A00%3A00'))
		assert.equal((html.match(/<th\b/g) ?? []).length, 5)
		assert.equal((html.match(/<td\b/g) ?? []).length, 5)
		assert.equal(html.includes('cinatoken.adminReliability.'), false)
	}
	const hidden = await render(
		createElement(ReliabilityRecentErrors, {
			rows,
			timezone: null,
			locale: 'en',
			range,
		})
	)
	assert.equal(hidden.includes('<a '), false)
	assert.ok(hidden.includes('model-1'))
})

test('directory failure never labels providers deleted and virtual tools remain identifiable in all languages', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const m = adminReliabilityMessages[locale]
		for (const status of ['loading', 'unavailable'] as const) {
			const state: AnalyticsProviderDirectory = { status }
			const html = await render(
				createElement(ReliabilityProviderKind, {
					id: 'gone',
					directory: state,
					locale,
				}),
				locale
			)
			assert.ok(html.includes(escaped(m.kindUnavailable)))
			assert.equal(html.includes(escaped(m.directoryMissing)), false)
		}
		const missing = await render(
			createElement(ReliabilityProviderKind, { id: 'gone', directory, locale }),
			locale
		)
		assert.ok(missing.includes(escaped(m.directoryMissing)))
		for (const [id, label] of [
			['octafuse-tools', m.kindRest],
			['octafuse-mcp', m.kindMcp],
		]) {
			const html = await render(
				createElement(ReliabilityProviderKind, {
					id,
					directory: { status: 'unavailable' },
					locale,
				}),
				locale
			)
			assert.ok(html.includes(escaped(label)))
			assert.ok(html.includes(escaped(m.directoryVirtual)))
		}
		const status = await render(
			createElement(ReliabilityDirectoryStatus, {
				directory: { status: 'unavailable' },
				retry: () => undefined,
				loading: false,
				canRetry: true,
			}),
			locale
		)
		assert.ok(status.includes(escaped(m.directoryUnavailable)))
		assert.ok(status.includes(escaped(m.directoryHint)))
		assert.ok(status.includes(escaped(m.directoryRetry)))
		assert.equal(status.includes('cinatoken.adminReliability.'), false)
	}
	const current = await render(
		createElement(ReliabilityProviderAccount, {
			id: 'provider-1',
			name: 'Snapshot account',
			directory,
		})
	)
	assert.ok(current.includes('Current account'))
	const unavailable = await render(
		createElement(ReliabilityProviderAccount, {
			id: 'provider-1',
			name: 'Snapshot account',
			directory: { status: 'unavailable' },
		})
	)
	assert.ok(unavailable.includes('Snapshot account'))
})
