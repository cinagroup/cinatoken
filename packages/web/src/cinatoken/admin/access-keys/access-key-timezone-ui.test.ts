/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { AccessKeyLastUsed } from './AccessKeyLastUsed'
import { adminAccessKeyMessages } from './messages'

type Locale = keyof typeof adminAccessKeyMessages
const locales: Locale[] = ['en', 'zh', 'ja', 'ko']

async function render(
	value: string | null,
	timezone: string | null,
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
					cinatoken: { adminAccessKeys: adminAccessKeyMessages[locale] },
				},
			},
		},
	})
	const html = renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(AccessKeyLastUsed, { value, timezone })
		)
	)
	assert.match(html, /^<p\b/u)
	assert.equal(html.includes('cinatoken.'), false)
	return html.replace(/<[^>]+>/gu, '')
}

test('Integration Key last-used keeps the complete localized never paragraph in all four languages', async () => {
	for (const locale of locales) {
		const messages = adminAccessKeyMessages[locale]
		for (const timezone of [null, 'Asia/Singapore'])
			assert.equal(
				await render(null, timezone, locale),
				`${messages.lastUsed}: ${messages.never}`
			)
	}
})

test('Integration Key last-used renders its own locale and the business calendar day', async () => {
	const value = '2026-10-23T16:00:00.000Z'
	for (const locale of locales) {
		const expected = new Intl.DateTimeFormat(locale, {
			timeZone: 'Asia/Singapore',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		}).format(new Date(value))
		assert.equal(
			await render(value, 'Asia/Singapore', locale),
			`${adminAccessKeyMessages[locale].lastUsed}: ${expected} Asia/Singapore`
		)
	}
	assert.equal(
		await render(value, 'Asia/Singapore'),
		'Last used: 10/24/2026, 00:00:00 Asia/Singapore'
	)
})

test('Integration Key last-used explicitly falls back to UTC and retains a real epoch observation', async () => {
	for (const locale of locales) {
		const value = '2026-10-23T16:00:00.000Z'
		assert.equal(
			await render(value, null, locale),
			await render(value, 'UTC', locale)
		)
		assert.match(await render(value, null, locale), / UTC$/u)
	}
	assert.equal(
		await render('1970-01-01T00:00:00.000Z', null),
		'Last used: 01/01/1970, 00:00:00 UTC'
	)
})

test('Integration Key last-used follows spring and autumn DST changes', async () => {
	for (const [value, expected] of [
		['2026-03-08T06:59:00.000Z', '03/08/2026, 01:59:00'],
		['2026-03-08T07:00:00.000Z', '03/08/2026, 03:00:00'],
		['2026-11-01T05:59:00.000Z', '11/01/2026, 01:59:00'],
		['2026-11-01T06:00:00.000Z', '11/01/2026, 01:00:00'],
	])
		assert.equal(
			await render(value, 'America/New_York'),
			`Last used: ${expected} America/New_York`
		)
})
