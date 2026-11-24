/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { ToolInvocationDetail } from '../tool-invocations/ToolInvocationDetail'
import { ToolInvocationTable } from '../tool-invocations/ToolInvocationTable'
import { adminToolInvocationMessages } from '../tool-invocations/messages'
import { toolInvocationSchema } from '../tool-invocations/tool-invocation-contracts'
import { RequestChargeSplit } from './RequestChargeSplit'
import { RequestLogDetail } from './RequestLogDetail'
import { adminRequestLogMessages } from './messages'
import { requestChargeFixture } from './request-charge-fixtures'
import { requestChargeSplit } from './request-charge-split'
import { requestLogSchema } from './request-log-contracts'
import { requestLogDetailResponseSchema } from './request-log-detail-contracts'

test('charge allocation preserves zero, micro-units and exact period/wallet shares without floating tails', () => {
	for (const [charged_cost, charged_wallet_cost, period, wallet] of [
		[0.3, 0.1, 0.2, 0.1],
		[0.3, 0, 0.3, 0],
		[0.3, 0.3, 0, 0.3],
		[0.000002, 0.000001, 0.000001, 0.000001],
		[0, -0, 0, 0],
		[0.1 + 0.2, 0.1, 0.2, 0.1],
		[9_000_000_000, 0, 9_000_000_000, 0],
		[9_000_000_000, 9_000_000_000, 0, 9_000_000_000],
	])
		assert.deepEqual(
			requestChargeSplit({ charged_cost, charged_wallet_cost }),
			{
				status: 'known',
				period,
				wallet,
			}
		)
})

test('missing fields never imply a zero wallet share and inconsistent or unsafe allocations remain unavailable', () => {
	for (const charged_wallet_cost of [null, undefined])
		assert.deepEqual(
			requestChargeSplit({ charged_cost: 0.3, charged_wallet_cost }),
			{ status: 'missing' }
		)
	for (const [charged_cost, charged_wallet_cost] of [
		[9_000_000_000, 0.000001],
		[0.3, 0.4],
		[-0.3, 0],
		[0.3, -0.1],
		[NaN, 0],
		[0.3, Infinity],
		[0.0000004, 0],
		[1e-16, 0],
		[0.3, 1e-16],
		[Number.MIN_VALUE, 0],
		[0.3, Number.MIN_VALUE],
		[0.3, 0.0000004],
		[Number.MAX_SAFE_INTEGER, 0],
	])
		assert.deepEqual(
			requestChargeSplit({ charged_cost, charged_wallet_cost }),
			{ status: 'inconsistent' }
		)
})

test('SQL decimals and legacy wallet fields survive only the request and tool safe contracts', () => {
	const parsed = requestLogSchema.parse({
		...requestChargeFixture,
		private_field: 'PRIVATE',
	})
	assert.equal(parsed.charged_wallet_cost, 0.1)
	assert.equal(Object.hasOwn(parsed, 'private_field'), false)
	assert.equal(
		toolInvocationSchema.parse(requestChargeFixture).charged_wallet_cost,
		0.1
	)
	for (const charged_wallet_cost of [null, undefined]) {
		assert.equal(
			requestLogSchema.parse({ ...requestChargeFixture, charged_wallet_cost })
				.charged_wallet_cost,
			charged_wallet_cost
		)
		assert.equal(
			toolInvocationSchema.parse({
				...requestChargeFixture,
				charged_wallet_cost,
			}).charged_wallet_cost,
			charged_wallet_cost
		)
	}
	for (const charged_wallet_cost of [
		NaN,
		Infinity,
		'NaN',
		'1e-6',
		'sk-private',
		{},
		'0.0000001',
	])
		assert.equal(
			requestLogSchema.safeParse({
				...requestChargeFixture,
				charged_wallet_cost,
			}).success,
			false
		)
	const detail = { ...parsed, request_body: 'PRIVATE' }
	assert.equal(
		requestLogDetailResponseSchema.parse({ success: true, data: detail }).data
			.charged_wallet_cost,
		0.1
	)
	assert.equal(
		requestLogDetailResponseSchema.safeParse({
			success: true,
			data: { ...detail, charged_wallet_cost: '0.100000' },
		}).success,
		false
	)
})

async function render(
	element: ReactElement,
	locale: 'en' | 'zh' | 'ja' | 'ko' = 'en'
): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		interpolation: { escapeValue: false },
		resources: {
			[locale]: {
				translation: {
					cinatoken: {
						adminRequestLogs: adminRequestLogMessages[locale],
						adminToolInvocations: adminToolInvocationMessages[locale],
					},
				},
			},
		},
	})
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element))
}

test('four-language charge views expose recorded allocation semantics and hide unknown currency amounts', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const log = { charged_cost: 0.000002, charged_wallet_cost: 0.000001 }
		const html = await render(
			createElement(RequestChargeSplit, { log, currency: 'USD' }),
			locale
		)
		const messages = adminRequestLogMessages[locale].chargeSplit
		for (const value of [
			messages.title,
			messages.total,
			messages.period,
			messages.wallet,
			messages.hint,
		])
			assert.ok(html.includes(value))
		assert.ok(html.includes('0.000001'))
		assert.equal(html.includes('cinatoken.adminRequestLogs.'), false)
		const hidden = await render(
			createElement(RequestChargeSplit, { log, currency: null }),
			locale
		)
		assert.equal(hidden.includes('0.000001'), false)
		assert.equal(hidden.includes('$'), false)
	}
})

test('expanded safe detail displays valid allocation, legacy unknowns and inconsistent shares honestly', async () => {
	const log = requestLogSchema.parse(requestChargeFixture)
	const known = await render(
		createElement(RequestLogDetail, { log, currency: 'USD' })
	)
	assert.ok(known.includes('$0.20'))
	assert.ok(known.includes('$0.10'))
	for (const [charged_wallet_cost, message] of [
		[undefined, adminRequestLogMessages.en.chargeSplit.missing],
		[null, adminRequestLogMessages.en.chargeSplit.missing],
		[0.4, adminRequestLogMessages.en.chargeSplit.inconsistent],
	] as const) {
		const html = await render(
			createElement(RequestChargeSplit, {
				log: { ...log, charged_wallet_cost },
				currency: 'USD',
			})
		)
		assert.ok(html.includes(message))
		assert.equal(html.includes('$0.00'), false)
	}
	for (const charged_cost of [
		1e-16,
		Number.MIN_VALUE,
		0.0000004,
		Number.MAX_SAFE_INTEGER,
	]) {
		const html = await render(
			createElement(RequestChargeSplit, {
				log: { charged_cost, charged_wallet_cost: 0 },
				currency: 'USD',
			})
		)
		assert.equal(html.includes('$0.00'), false)
		assert.ok(
			html.includes(adminRequestLogMessages.en.chargeSplit.inconsistent)
		)
	}
})

test('MCP invocation list and detail receive the shared wallet field and verified currency in all four languages', async () => {
	const log = toolInvocationSchema.parse(requestChargeFixture)
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const table = await render(
			createElement(ToolInvocationTable, {
				page: { data: [log], total: 1, page: 1, page_size: 50 },
				currency: 'CNY',
				timezone: 'UTC',
				locale,
				context: 'charge-test',
			}),
			locale
		)
		const detail = await render(
			createElement(ToolInvocationDetail, { log, currency: 'CNY' }),
			locale
		)
		const period = new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: 'CNY',
			minimumFractionDigits: 2,
			maximumFractionDigits: 6,
		}).format(0.2)
		for (const html of [table, detail]) {
			assert.ok(html.includes(period))
			assert.ok(
				html.includes(adminRequestLogMessages[locale].chargeSplit.wallet)
			)
			assert.equal(html.includes('cinatoken.adminRequestLogs.'), false)
		}
		assert.ok(detail.includes(adminRequestLogMessages[locale].chargeSplit.hint))
	}
})
