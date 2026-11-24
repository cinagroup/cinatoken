/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { GatewayKeyLastUsed } from './GatewayKeyLastUsed'
import { GatewayKeyProfile } from './GatewayKeyProfile'
import { GatewayKeysTable } from './GatewayKeysTable'
import {
	gatewayKeyDetailSchema,
	gatewayKeyRowSchema,
} from './gateway-key-contracts'
import { adminGatewayKeyMessages } from './messages'

const wire = {
	id: 'usage-key',
	key: 'sk-…',
	user_id: 'usage-user',
	workspace_id: 'personal:usage-user',
	name: 'Usage key',
	user_email: null,
	budget_max: 25,
	budget_base: 25,
	budget_spent: 4.5,
	budget_period: 'monthly',
	budget_reset_at: null,
	status: 'active',
	created_at: '2026-09-01T00:00:00.000Z',
	updated_at: '2026-10-01T00:00:00.000Z',
	metadata_preview: null,
	metadata_raw: null,
	metadata_unavailable: false,
	profile_revision: 'sha256:' + 'a'.repeat(64),
}
type Locale = keyof typeof adminGatewayKeyMessages
const locales: Locale[] = ['en', 'zh', 'ja', 'ko']
async function render(
	element: ReactElement,
	locale: Locale = 'en'
): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		interpolation: { escapeValue: false },
		resources: {
			[locale]: {
				translation: {
					cinatoken: { adminGatewayKeys: adminGatewayKeyMessages[locale] },
				},
			},
		},
	})
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element))
}
function escape(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#x27;')
}
function localized(value: string, locale: Locale, timezone: string): string {
	return (
		new Intl.DateTimeFormat(locale, {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		}).format(new Date(value)) + ` ${timezone}`
	)
}
function table(
	value: string | null | undefined,
	timezone: string | null
): ReactElement {
	return createElement(GatewayKeysTable, {
		rows: [gatewayKeyRowSchema.parse({ ...wire, last_used_at: value })],
		capabilities: {
			user_detail: true,
			request_logs: true,
			budget_audit: true,
			effective_guardrails: false,
			can_write: false,
		},
		currency: null,
		timezone,
		canWrite: false,
		onEdit: () => undefined,
		onStatus: () => undefined,
		onTombstone: () => undefined,
	})
}

test('last-used distinguishes an omitted field from no recorded usage in all four languages', async () => {
	for (const locale of locales) {
		for (const value of [undefined, null]) {
			const html = await render(
				createElement(GatewayKeyLastUsed, {
					value,
					timezone: 'Asia/Singapore',
				}),
				locale
			)
			const expected =
				value === null
					? adminGatewayKeyMessages[locale].noUsageRecorded
					: adminGatewayKeyMessages[locale].lastUsedUnavailable
			assert.equal(html, '<span>' + escape(expected) + '</span>')
			assert.equal(html.includes('cinatoken.'), false)
		}
	}
})

test('valid last-used time uses the component locale and crosses the business calendar day', async () => {
	const value = '2026-10-23T16:00:00.000Z'
	for (const locale of locales) {
		const html = await render(
			createElement(GatewayKeyLastUsed, { value, timezone: 'Asia/Singapore' }),
			locale
		)
		assert.equal(
			html,
			'<span>' + escape(localized(value, locale, 'Asia/Singapore')) + '</span>'
		)
	}
	assert.equal(
		await render(
			createElement(GatewayKeyLastUsed, { value, timezone: 'Asia/Singapore' })
		),
		'<span>10/24/2026, 00:00:00 Asia/Singapore</span>'
	)
})

test('last-used follows spring and autumn DST rather than a fixed offset', async () => {
	for (const [value, expected] of [
		['2026-03-08T06:59:00.000Z', '03/08/2026, 01:59:00'],
		['2026-03-08T07:00:00.000Z', '03/08/2026, 03:00:00'],
		['2026-11-01T05:59:00.000Z', '11/01/2026, 01:59:00'],
		['2026-11-01T06:00:00.000Z', '11/01/2026, 01:00:00'],
	]) {
		assert.equal(
			await render(
				createElement(GatewayKeyLastUsed, {
					value,
					timezone: 'America/New_York',
				})
			),
			'<span>' + expected + ' America/New_York</span>'
		)
	}
})

test('unverified timezone is explicitly UTC and an epoch timestamp is still a real observation', async () => {
	assert.equal(
		await render(
			createElement(GatewayKeyLastUsed, {
				value: '1970-01-01T00:00:00.000Z',
				timezone: null,
			})
		),
		'<span>01/01/1970, 00:00:00 UTC</span>'
	)
})

test('list time groups label created and last-used separately without replacing missing usage with creation', async () => {
	for (const locale of locales) {
		for (const value of [undefined, null, '2026-10-23T16:00:00.000Z']) {
			const html = await render(table(value, 'Asia/Singapore'), locale)
			const messages = adminGatewayKeyMessages[locale]
			assert.ok(html.includes('>' + escape(messages.timestamps) + '</th>'))
			assert.ok(html.includes('>' + escape(messages.created) + '</dt>'))
			assert.ok(html.includes('>' + escape(messages.lastUsed) + '</dt>'))
			const created = escape(
				localized(wire.created_at, locale, 'Asia/Singapore')
			)
			assert.equal(html.split(created).length - 1, 1)
			let expected = messages.lastUsedUnavailable
			if (value === null) expected = messages.noUsageRecorded
			else if (value !== undefined)
				expected = localized(value, locale, 'Asia/Singapore')
			assert.ok(html.includes(escape(expected)))
			assert.equal(html.includes('cinatoken.adminGatewayKeys.'), false)
		}
	}
})

test('read-only profiles include all three last-used states even when currency is unavailable', async () => {
	for (const locale of locales) {
		for (const value of [undefined, null, '2026-10-23T16:00:00.000Z']) {
			const detail = gatewayKeyDetailSchema.parse({
				...wire,
				last_used_at: value,
			})
			const before = JSON.stringify(detail)
			const html = await render(
				createElement(GatewayKeyProfile, {
					detail,
					currency: null,
					timezone: 'Asia/Singapore',
				}),
				locale
			)
			const messages = adminGatewayKeyMessages[locale]
			assert.ok(html.includes('<dt>' + escape(messages.lastUsed) + '</dt>'))
			assert.ok(html.includes(escape(messages.currencyUnavailable)))
			let expected = messages.lastUsedUnavailable
			if (value === null) expected = messages.noUsageRecorded
			else if (value !== undefined)
				expected = localized(value, locale, 'Asia/Singapore')
			assert.ok(html.includes('<dd><span>' + escape(expected) + '</span></dd>'))
			assert.equal(
				html.split(escape(localized(wire.created_at, locale, 'Asia/Singapore')))
					.length - 1,
				1
			)
			assert.equal(JSON.stringify(detail), before)
		}
	}
})
