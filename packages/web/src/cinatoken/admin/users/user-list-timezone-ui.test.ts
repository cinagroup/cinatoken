/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { formatUserDetailTime } from '../user-detail/user-detail-format'
import { AdminListTimezone } from './AdminListTimezone'
import { UserList } from './UserList'
import { adminUsersMessages } from './messages'
import { adminUserListRowSchema } from './users-contracts'

const row = adminUserListRowSchema.parse({
	id: 'user-qa',
	email: 'timezone@example.invalid',
	external_system: null,
	external_user_id: null,
	budget_max: 25,
	budget_base: 25,
	budget_spent: 4.5,
	budget_period: 'monthly',
	budget_reset_at: '2026-10-23T16:00:00.000Z',
	status: 'active',
	metadata: null,
	charged_cost_factors: null,
	created_at: '2026-10-23T16:00:00.000Z',
	updated_at: '2026-10-23T16:00:00.000Z',
	active_keys_count: 0,
	keys_count: 0,
})
async function render(
	locale: keyof typeof adminUsersMessages,
	element: ReactNode
) {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		resources: {
			[locale]: {
				translation: { cinatoken: { adminUsers: adminUsersMessages[locale] } },
			},
		},
	})
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element))
}

test('user desktop and mobile budgets retain period and local reset time without currency in four languages', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(
			locale,
			createElement(UserList, {
				rows: [row],
				currency: null,
				timezone: 'Asia/Singapore',
				locale,
			})
		)
		assert.ok(html.includes(adminUsersMessages[locale].amountUnavailable))
		assert.ok(html.includes(adminUsersMessages[locale].periodMonthly))
		const time = formatUserDetailTime(row.created_at, locale, 'Asia/Singapore')
		assert.equal(html.split(time).length - 1, 4)
		assert.equal(html.includes('4.50'), false)
		assert.equal(html.includes(' UTC'), false)
	}
})

test('timezone labels distinguish verified UTC legacy server fallback and unavailable configuration', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		for (const [source, key] of [
			['configured', 'timezoneConfigured'],
			['legacy', 'timezoneLegacy'],
			['missing', 'timezoneFallback'],
			['invalid', 'timezoneFallback'],
		] as const) {
			const html = await render(
				locale,
				createElement(AdminListTimezone, {
					display: {
						timezone: 'UTC',
						timezoneSource: source,
						currency: null,
						currencySource: null,
					},
				})
			)
			assert.ok(
				html.includes(
					adminUsersMessages[locale][key].replace('{{timezone}}', 'UTC')
				)
			)
		}
		assert.ok(
			(
				await render(
					locale,
					createElement(AdminListTimezone, { display: null })
				)
			).includes(adminUsersMessages[locale].timezoneUnavailable)
		)
	}
})

test('business timezone crosses calendar day and follows both sides of New York daylight saving', () => {
	assert.equal(
		formatUserDetailTime('2026-10-23T16:00:00.000Z', 'en', 'Asia/Singapore'),
		'10/24/2026, 00:00:00 Asia/Singapore'
	)
	assert.equal(
		formatUserDetailTime('2026-03-08T06:59:00.000Z', 'en', 'America/New_York'),
		'03/08/2026, 01:59:00 America/New_York'
	)
	assert.equal(
		formatUserDetailTime('2026-03-08T07:00:00.000Z', 'en', 'America/New_York'),
		'03/08/2026, 03:00:00 America/New_York'
	)
	assert.equal(
		formatUserDetailTime('2026-11-01T05:59:00.000Z', 'en', 'America/New_York'),
		'11/01/2026, 01:59:00 America/New_York'
	)
	assert.equal(
		formatUserDetailTime('2026-11-01T06:00:00.000Z', 'en', 'America/New_York'),
		'11/01/2026, 01:00:00 America/New_York'
	)
	assert.equal(
		formatUserDetailTime(row.created_at, 'en', null),
		'10/23/2026, 16:00:00 UTC'
	)
})
