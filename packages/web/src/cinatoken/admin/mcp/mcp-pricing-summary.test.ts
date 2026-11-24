/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { McpCatalog } from './McpCatalog'
import { McpPricingDetails } from './McpPricingFields'
import { McpPricingSummary } from './McpPricingSummary'
import {
	mcpCatalogItemSchema,
	mcpPricingSchema,
	mcpServerSchema,
	type McpPricingRule,
} from './mcp-contracts'
import { validateMcpSearch } from './mcp-domain'
import { adminMcpMessages } from './messages'
import { mcpPricingSummaryMessages } from './pricing-summary-messages'

type Locale = keyof typeof adminMcpMessages
const locales: Locale[] = ['en', 'zh', 'ja', 'ko']
const legacy = mcpPricingSchema.parse({
	v: 1,
	prices: { standard: 0, charged: 0.03, metered: 0.02 },
})
const factors = mcpPricingSchema.parse({
	v: 2,
	standard: 0.02,
	chargedFactor: 3,
	meteredFactor: 0,
})
async function render(node: ReactNode, locale: Locale = 'en'): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		interpolation: { escapeValue: false },
		resources: {
			[locale]: {
				translation: { cinatoken: { adminMcp: adminMcpMessages[locale] } },
			},
		},
	})
	const html = renderToStaticMarkup(
		createElement(I18nextProvider, { i18n }, node)
	)
	assert.doesNotMatch(html, /cinatoken\.adminMcp|\{\{/u)
	return html
}
function summary(
	rule: McpPricingRule | null,
	currency: 'USD' | 'CNY' | null = 'USD'
) {
	return createElement(McpPricingSummary, { rule, currency })
}
function values(html: string): string[] {
	return [...html.matchAll(/<dd\b[^>]*>(.*?)<\/dd>/gsu)].map((match) =>
		match[1].replace(/<[^>]*>/gu, '')
	)
}

test('MCP price summary preserves independent v1 amounts and provides labeled request prices', async () => {
	const html = await render(summary(legacy))
	assert.deepEqual(values(html), ['0 USD', '0.03 USD', '0.02 USD'])
	assert.match(html, /aria-label="Resolved per-request prices"/u)
	assert.match(html, />Prices per request</u)
	for (const label of ['Standard price', 'Charged price', 'Metered price']) {
		assert.ok(html.includes(`>${label}</dt>`))
	}
	assert.doesNotMatch(html, /multiplier|priceBelowMetered/u)
})

test('MCP detail adds resolved v2 prices while retaining factors and the compact summary omits factors', async () => {
	const compact = await render(summary(factors))
	const detail = await render(
		createElement(McpPricingDetails, { rule: factors, currency: 'USD' })
	)
	assert.deepEqual(values(compact), ['0.02 USD', '0.06 USD', '0 USD'])
	assert.deepEqual(values(detail), [...values(compact), '3 ×', '0 ×'])
	assert.match(detail, />Charged multiplier<|>Metered multiplier</u)
	assert.doesNotMatch(compact, /multiplier/u)
})

test('MCP prices use Core ledger rounding and retain factor precision without mutating the rule', async () => {
	const rule = mcpPricingSchema.parse({
		v: 2,
		standard: 0.1234567,
		chargedFactor: 0.123456789,
		meteredFactor: 0.000000001,
	})
	const before = JSON.stringify(rule)
	Object.freeze(rule)
	const html = await render(
		createElement(McpPricingDetails, { rule, currency: 'CNY' })
	)
	assert.deepEqual(values(html), [
		'0.123457 CNY',
		'0.015242 CNY',
		'0 CNY',
		'0.123456789 ×',
		'0.000000001 ×',
	])
	assert.equal(JSON.stringify(rule), before)
})

test('MCP zero remains visible and micro-cost warnings compare resolved ledger prices', async () => {
	const rule = mcpPricingSchema.parse({
		v: 1,
		prices: { standard: 0, charged: 0, metered: 0.000001 },
	})
	const html = await render(summary(rule))
	assert.deepEqual(values(html), ['0 USD', '0 USD', '0.000001 USD'])
	assert.ok(html.includes(mcpPricingSummaryMessages.en.priceBelowMetered))
	for (const equal of [
		mcpPricingSchema.parse({ v: 2, standard: 0 }),
		mcpPricingSchema.parse({ v: 2, standard: 0.02 }),
		mcpPricingSchema.parse({
			v: 2,
			standard: 0.000001,
			chargedFactor: 0.2,
			meteredFactor: 0.3,
		}),
	]) {
		const equalHtml = await render(summary(equal))
		assert.equal(values(equalHtml).length, 3)
		assert.ok(
			!equalHtml.includes(mcpPricingSummaryMessages.en.priceBelowMetered)
		)
	}
})

test('MCP invalid rules and unavailable currency have distinct four-language states without amounts', async () => {
	for (const locale of locales) {
		const invalid = await render(summary(null), locale)
		const unknown = await render(summary(legacy, null), locale)
		assert.ok(invalid.includes(adminMcpMessages[locale].invalidPricing))
		assert.ok(unknown.includes(adminMcpMessages[locale].currencyUnknown))
		assert.equal(values(invalid).length, 0)
		assert.equal(values(unknown).length, 0)
		assert.doesNotMatch(invalid + unknown, /0\.03|\bUSD\b|\bCNY\b/u)
		const both = await render(summary(null, null), locale)
		assert.ok(both.includes(adminMcpMessages[locale].invalidPricing))
	}
})

test('MCP price resolution overflow fails closed rather than rendering Infinity or a clamped amount', async () => {
	const rule: McpPricingRule = {
		v: 2,
		unit: 'request',
		config: {},
		standard: 1e200,
		chargedFactor: 1e200,
		meteredFactor: 1,
	}
	assert.equal(mcpPricingSchema.safeParse(rule).success, false)
	const html = await render(summary(rule))
	assert.ok(html.includes(adminMcpMessages.en.invalidPricing))
	assert.equal(values(html).length, 0)
	assert.doesNotMatch(html, /Infinity|NaN|1e\+200/u)
})

test('MCP price summaries translate every label, unit and below-metered notice in four locales', async () => {
	const rule = mcpPricingSchema.parse({
		v: 1,
		prices: { standard: 1234.000001, charged: 0.01, metered: 0.02 },
	})
	for (const locale of locales) {
		for (const currency of ['USD', 'CNY'] as const) {
			const html = await render(summary(rule, currency), locale)
			const messages = mcpPricingSummaryMessages[locale]
			for (const value of Object.values(messages))
				assert.ok(html.includes(value))
			for (const key of ['standard', 'charged', 'metered'] as const) {
				assert.ok(html.includes(adminMcpMessages[locale][key]))
			}
			const expected = new Intl.NumberFormat(locale, {
				maximumFractionDigits: 6,
			}).format(1234.000001)
			assert.equal(values(html)[0], `${expected} ${currency}`)
			assert.doesNotMatch(html, /<input|<button/u)
		}
	}
})

test('MCP detail retains both factor labels in all supported locales', async () => {
	for (const locale of locales) {
		const html = await render(
			createElement(McpPricingDetails, { rule: factors, currency: 'USD' }),
			locale
		)
		assert.equal(values(html).length, 5)
		assert.ok(html.includes(adminMcpMessages[locale].chargedFactor))
		assert.ok(html.includes(adminMcpMessages[locale].meteredFactor))
	}
})

test('MCP tool price summaries preserve inheritance, overrides, invalid and legacy unknown origins', async () => {
	const server = mcpServerSchema.parse({
		id: 'server-price',
		slug: 'price',
		name: 'Price server',
		description: null,
		status: 'active',
		urlMasked: 'https://mcp.invalid',
		authHeaderNames: [],
		pricing: legacy,
		timeoutMs: 30000,
		maxResponseBytes: 1048576,
		lastSyncedAt: null,
		lastSyncError: null,
	})
	const item = mcpCatalogItemSchema.parse({
		id: 'item-price',
		serverId: server.id,
		kind: 'tool',
		upstreamKey: 'read',
		exposedName: 'price__read',
		definition: {},
		pendingDefinition: null,
		reviewState: 'none',
		status: 'enabled',
		pricing: null,
	})
	const noop = () => undefined
	for (const state of ['inherit', 'override', 'invalid', undefined] as const) {
		const html = await render(
			createElement(McpCatalog, {
				detail: {
					server,
					items: [
						{
							...item,
							pricingState: state,
							pricing: state === 'override' ? factors : null,
						},
					],
				},
				search: validateMcpSearch({}),
				currency: 'USD',
				busy: false,
				onSearch: noop,
				onStatus: noop,
				onAccept: noop,
				onPricing: noop,
			})
		)
		const pricingHtml =
			html.match(
				/<section aria-label="Resolved per-request prices"[^>]*>.*?<\/section>/su
			)?.[0] ?? ''
		if (state === 'inherit') {
			assert.deepEqual(values(pricingHtml), ['0 USD', '0.03 USD', '0.02 USD'])
		} else if (state === 'override') {
			assert.deepEqual(values(pricingHtml), [
				'0.02 USD',
				'0.06 USD',
				'0 USD',
				'3 ×',
				'0 ×',
			])
		} else {
			assert.equal(values(pricingHtml).length, 0)
			const key = state === 'invalid' ? 'invalidPricing' : 'pricingUnknown'
			assert.ok(html.includes(adminMcpMessages.en[key]))
		}
	}
})
