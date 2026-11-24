/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ComponentProps } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { adminRequestLogMessages } from '../request-logs/messages'
import { requestChargeFixture } from '../request-logs/request-charge-fixtures'
import { UserDetailRecent } from './UserDetailRecent'
import { adminUserDetailMessages } from './messages'
import { userDetailLogsResponseSchema } from './user-detail-contracts'

type Locale = 'en' | 'zh' | 'ja' | 'ko'
type Props = ComponentProps<typeof UserDetailRecent>
const userId = 'f2b74bc0-32f3-4613-aea7-96f723d08e12'
function page(raw: Record<string, unknown> = {}) {
	return userDetailLogsResponseSchema.parse({
		success: true,
		data: [
			{
				...requestChargeFixture,
				user_id: userId,
				model_name: 'RECENT-CHARGE-MODEL',
				...raw,
			},
		],
		total: 1,
		page: 1,
		page_size: 5,
	})
}
function props(raw: Record<string, unknown> = {}): Props {
	return {
		userId,
		logs: page(raw).data,
		audits: null,
		logsDenied: false,
		auditsDenied: false,
		logsFailed: false,
		auditsFailed: false,
		currency: 'USD',
		timezone: 'UTC',
	}
}
async function render(value: Props, locale: Locale = 'en'): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		interpolation: { escapeValue: false },
		resources: {
			[locale]: {
				translation: {
					cinatoken: {
						adminUserDetail: adminUserDetailMessages[locale],
						adminRequestLogs: adminRequestLogMessages[locale],
					},
				},
			},
		},
	})
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(UserDetailRecent, value)
		)
	)
}
function allocation(html: string): string {
	const sections = [
		...html.matchAll(
			/<section\b[^>]*\baria-label="[^"]+"[^>]*>[\s\S]*?<\/section>/gu
		),
	]
	assert.equal(
		sections.length,
		1,
		'Exactly one allocation belongs to the one recent request'
	)
	return sections[0][0]
}
function currencyAmount(
	value: number,
	currency: 'USD' | 'CNY',
	locale: Locale
): string {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency,
		minimumFractionDigits: 2,
		maximumFractionDigits: 6,
	}).format(value)
}
function shares(card: string): string[] {
	return [...card.matchAll(/<dd\b[^>]*>([^<]*)<\/dd>/gu)].map(
		(match) => match[1]
	)
}

test('the existing user recent-log DTO preserves SQL wallet decimals and legacy null/missing values while rejecting malformed money', () => {
	const current = page({ private_field: 'PRIVATE' }).data[0]
	assert.equal(current.charged_cost, 0.3)
	assert.equal(current.charged_wallet_cost, 0.1)
	assert.equal(Object.hasOwn(current, 'private_field'), false)
	for (const charged_wallet_cost of [null, undefined])
		assert.equal(
			page({ charged_wallet_cost }).data[0].charged_wallet_cost,
			charged_wallet_cost
		)
	for (const charged_wallet_cost of [
		NaN,
		Infinity,
		'NaN',
		'1e-6',
		'0.0000001',
		{},
	])
		assert.throws(() => page({ charged_wallet_cost }))
})

test('recent requests show translated recorded-allocation semantics using the confirmed USD or CNY in all four locales', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		for (const currency of ['USD', 'CNY'] as const) {
			const html = await render({ ...props(), currency }, locale)
			const card = allocation(html)
			const labels = adminRequestLogMessages[locale].chargeSplit
			for (const text of [
				labels.title,
				labels.period,
				labels.wallet,
				labels.hint,
			])
				assert.ok(card.includes(text))
			assert.deepEqual(shares(card), [
				currencyAmount(0.2, currency, locale),
				currencyAmount(0.1, currency, locale),
			])
			assert.ok(html.includes(currencyAmount(0.3, currency, locale)))
			assert.ok(html.includes(adminUserDetailMessages[locale].recentRequests))
			assert.ok(html.includes(`/admin/request-logs?user_id=${userId}`))
			assert.equal(html.includes('cinatoken.'), false)
		}
	}
})

test('unknown currency hides all total/share amounts without treating the recorded allocation as free', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render({ ...props(), currency: null }, locale)
		assert.deepEqual(shares(allocation(html)), ['—', '—'])
		assert.equal(/[$¥￥]/u.test(html), false)
		assert.equal(html.includes('0.20'), false)
		assert.equal(html.includes('0.10'), false)
		assert.equal(html.includes('0.00'), false)
		assert.ok(html.includes(adminRequestLogMessages[locale].chargeSplit.hint))
	}
})

test('recent requests preserve zero, all-wallet, micro-unit and floating-representation allocations', async () => {
	for (const [charged_cost, charged_wallet_cost, period, wallet] of [
		[0, -0, 0, 0],
		[0.3, 0, 0.3, 0],
		[0.3, 0.3, 0, 0.3],
		[0.000002, 0.000001, 0.000001, 0.000001],
		[0.1 + 0.2, 0.1, 0.2, 0.1],
	]) {
		const html = await render(props({ charged_cost, charged_wallet_cost }))
		assert.deepEqual(shares(allocation(html)), [
			currencyAmount(period, 'USD', 'en'),
			currencyAmount(wallet, 'USD', 'en'),
		])
		assert.ok(html.includes(currencyAmount(charged_cost, 'USD', 'en')))
		assert.equal(html.includes('0.199999'), false)
	}
})

test('legacy or inconsistent allocations never fabricate a zero wallet, negative period or unsafe total', async () => {
	for (const charged_wallet_cost of [undefined, null]) {
		const card = allocation(await render(props({ charged_wallet_cost })))
		assert.deepEqual(shares(card), ['—', '—'])
		assert.ok(card.includes(adminRequestLogMessages.en.chargeSplit.missing))
		assert.equal(card.includes('$0.00'), false)
	}
	for (const [charged_cost, charged_wallet_cost] of [
		[0.3, 0.4],
		[0.3, -0.1],
		[-0.3, 0],
		[0.3, 0.0000004],
		[0.3, Number.MIN_VALUE],
		[Number.MIN_VALUE, 0],
		[1e-16, 0],
		[Number.MAX_SAFE_INTEGER, 0],
	]) {
		const html = await render(props({ charged_cost, charged_wallet_cost }))
		const card = allocation(html)
		assert.deepEqual(shares(card), ['—', '—'])
		assert.ok(
			card.includes(adminRequestLogMessages.en.chargeSplit.inconsistent)
		)
		assert.equal(card.includes('$0.00'), false)
		if (charged_cost !== 0.3) assert.equal(html.includes('$0.00'), false)
		assert.equal(html.includes('9,007,199,254,740,991'), false)
	}
})

test('logs permission denial or failure hides stale recent rows and allocation, while audit denial alone does not hide authorized logs', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		for (const flags of [{ logsDenied: true }, { logsFailed: true }]) {
			const html = await render({ ...props(), ...flags }, locale)
			assert.ok(
				html.includes(
					adminUserDetailMessages[locale][
						flags.logsDenied ? 'logsDenied' : 'logsFailed'
					]
				)
			)
			assert.equal(html.includes('RECENT-CHARGE-MODEL'), false)
			assert.equal(
				html.includes(adminRequestLogMessages[locale].chargeSplit.title),
				false
			)
			assert.equal(html.includes(currencyAmount(0.3, 'USD', locale)), false)
			assert.equal(html.includes(currencyAmount(0.1, 'USD', locale)), false)
		}
		const allowed = await render({ ...props(), auditsDenied: true }, locale)
		assert.ok(allowed.includes('RECENT-CHARGE-MODEL'))
		assert.deepEqual(shares(allocation(allowed)), [
			currencyAmount(0.2, 'USD', locale),
			currencyAmount(0.1, 'USD', locale),
		])
	}
})
