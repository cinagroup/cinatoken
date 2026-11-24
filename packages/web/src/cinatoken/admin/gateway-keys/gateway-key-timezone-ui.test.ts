/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { GatewayKeyEditor } from './GatewayKeyEditor'
import { GatewayKeyProfile } from './GatewayKeyProfile'
import { GatewayKeysTable } from './GatewayKeysTable'
import {
	gatewayKeyDetailSchema,
	gatewayKeyRowSchema,
	type GatewayKeysCapabilities,
} from './gateway-key-contracts'
import { adminGatewayKeyMessages } from './messages'

const wire = {
	id: 'timezone-key',
	key: 'sk-…',
	user_id: 'timezone-user',
	workspace_id: 'personal:timezone-user',
	name: 'Business clock key',
	user_email: 'timezone@example.test',
	budget_max: 987.25,
	budget_base: 987.25,
	budget_spent: 123.5,
	budget_period: 'monthly',
	budget_reset_at: '2026-10-23T16:00:00.000Z',
	created_at: '2026-10-23T15:59:00.000Z',
	updated_at: '2026-10-23T16:01:00.000Z',
	status: 'active',
	rate_limit: null,
	metadata_preview: null,
	metadata_raw: null,
	metadata_unavailable: false,
	profile_revision: 'sha256:' + 'a'.repeat(64),
}
const capabilities: GatewayKeysCapabilities = {
	user_detail: true,
	request_logs: true,
	budget_audit: true,
	effective_guardrails: false,
	can_write: false,
}
type Locale = keyof typeof adminGatewayKeyMessages
type Currency = 'USD' | 'CNY' | null
const locales: Locale[] = ['en', 'zh', 'ja', 'ko']
function table(
	timezone: string | null,
	currency: Currency = 'USD',
	value = wire
): ReactElement {
	return createElement(GatewayKeysTable, {
		rows: [gatewayKeyRowSchema.parse(value)],
		capabilities,
		currency,
		timezone,
		canWrite: false,
		onEdit: () => undefined,
		onStatus: () => undefined,
		onTombstone: () => undefined,
	})
}
function profile(
	timezone: string | null,
	currency: Currency = 'USD',
	value = wire
): ReactElement {
	return createElement(GatewayKeyProfile, {
		detail: gatewayKeyDetailSchema.parse(value),
		currency,
		timezone,
	})
}
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
function expectedTime(value: string, timezone: string, locale: Locale): string {
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
function escaped(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#x27;')
}

test('Gateway key list and profile show the same business-day boundary in all four languages', async () => {
	for (const locale of locales) {
		const list = await render(table('Asia/Singapore'), locale)
		const detail = await render(profile('Asia/Singapore'), locale)
		for (const value of [wire.created_at, wire.budget_reset_at]) {
			const expected = escaped(expectedTime(value, 'Asia/Singapore', locale))
			assert.ok(list.includes(expected), `${locale}: list ${expected}`)
			assert.ok(detail.includes(expected), `${locale}: detail ${expected}`)
		}
		assert.ok(
			detail.includes(
				escaped(expectedTime(wire.updated_at, 'Asia/Singapore', locale))
			)
		)
		assert.equal(list.includes('cinatoken.adminGatewayKeys.'), false)
		assert.equal(detail.includes('cinatoken.adminGatewayKeys.'), false)
		assert.equal(list.includes(' UTC'), false)
	}
	const html = await render(profile('Asia/Singapore'))
	assert.ok(html.includes('10/23/2026, 23:59:00 Asia/Singapore'))
	assert.ok(html.includes('10/24/2026, 00:00:00 Asia/Singapore'))
})

test('Gateway key timestamps follow the spring DST gap instead of a fixed offset', async () => {
	const value = {
		...wire,
		created_at: '2026-03-08T06:59:00.000Z',
		budget_reset_at: '2026-03-08T07:01:00.000Z',
		updated_at: '2026-03-08T07:02:00.000Z',
	}
	for (const element of [
		table('America/New_York', 'USD', value),
		profile('America/New_York', 'USD', value),
	]) {
		const html = await render(element)
		assert.ok(html.includes('03/08/2026, 01:59:00 America/New_York'))
		assert.ok(html.includes('03/08/2026, 03:01:00 America/New_York'))
		assert.equal(html.includes('03/08/2026, 02:'), false)
	}
})

test('Gateway key timestamps retain both UTC instants across the repeated autumn wall-clock hour', async () => {
	const value = {
		...wire,
		created_at: '2026-11-01T05:30:00.000Z',
		budget_reset_at: '2026-11-01T06:30:00.000Z',
	}
	const original = JSON.stringify(value)
	for (const element of [
		table('America/New_York', 'USD', value),
		profile('America/New_York', 'USD', value),
	]) {
		const html = await render(element)
		assert.equal(
			html.split('11/01/2026, 01:30:00 America/New_York').length - 1,
			2
		)
	}
	assert.equal(JSON.stringify(value), original)
})

test('unknown timezone explicitly falls back to UTC while a verified currency stays usable', async () => {
	for (const locale of locales) {
		for (const element of [table(null, 'CNY'), profile(null, 'CNY')]) {
			const html = await render(element, locale)
			assert.ok(
				html.includes(escaped(expectedTime(wire.created_at, 'UTC', locale)))
			)
			assert.ok(
				html.includes(
					escaped(expectedTime(wire.budget_reset_at, 'UTC', locale))
				)
			)
			assert.ok(html.includes('987.25'))
			assert.equal(html.includes('Asia/Singapore'), false)
		}
	}
})

test('missing currency hides amounts but retains verified business times, periods and permitted read links', async () => {
	for (const locale of locales) {
		const list = await render(table('Asia/Singapore', null), locale)
		const detail = await render(profile('Asia/Singapore', null), locale)
		for (const html of [list, detail]) {
			assert.ok(
				html.includes(
					escaped(expectedTime(wire.budget_reset_at, 'Asia/Singapore', locale))
				)
			)
			assert.ok(html.includes(escaped(adminGatewayKeyMessages[locale].monthly)))
			assert.equal(html.includes('987.25'), false)
			assert.equal(html.includes('123.50'), false)
		}
		assert.ok(list.includes('href="/admin/users/timezone-user"'))
		assert.ok(
			list.includes('href="/admin/request-logs?api_key_id=timezone-key"')
		)
		assert.ok(list.includes('href="/admin/audit-logs?api_key_id=timezone-key"'))
		assert.ok(
			detail.includes(
				escaped(adminGatewayKeyMessages[locale].currencyUnavailable)
			)
		)
	}
})

test('Gateway key editor forwards the verified timezone to its existing profile without altering the UTC record', async () => {
	const detail = gatewayKeyDetailSchema.parse(wire)
	const original = JSON.stringify(detail)
	const element = createElement(GatewayKeyEditor, {
		detail,
		row: gatewayKeyRowSchema.parse(wire),
		capabilities,
		previewApi: {
			previewGuardrail: async () => {
				throw new Error('Preview must not run during render')
			},
		},
		previewReadOptions: () => ({}),
		scopeKey: 'timezone-fixture',
		currency: 'USD',
		timezone: 'Asia/Singapore',
		guardrailBlocked: false,
		onGuardrailDenied: () => undefined,
		busy: false,
		canWrite: false,
		error: null,
		onClose: () => undefined,
		onSave: async () => undefined,
	})
	const html = await render(element)
	assert.ok(html.includes('10/24/2026, 00:00:00 Asia/Singapore'))
	assert.ok(html.includes('10/24/2026, 00:01:00 Asia/Singapore'))
	assert.equal(JSON.stringify(detail), original)
})
