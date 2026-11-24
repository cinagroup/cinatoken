/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ComponentProps } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import {
	auditCompatibilityRows,
	auditFixtureUserId,
} from '../audit-logs/audit-log-fixtures'
import { adminAuditLogMessages } from '../audit-logs/messages'
import { UserDetailRecent } from './UserDetailRecent'
import { adminUserDetailMessages } from './messages'
import { userDetailAuditsResponseSchema } from './user-detail-contracts'

type Props = ComponentProps<typeof UserDetailRecent>
function props(): Props {
	const page = userDetailAuditsResponseSchema.parse({
		success: true,
		data: auditCompatibilityRows,
		total: 5,
		page: 1,
		page_size: 5,
	})
	return {
		userId: auditFixtureUserId,
		logs: [],
		audits: page.data,
		logsDenied: false,
		auditsDenied: false,
		logsFailed: false,
		auditsFailed: false,
		currency: 'USD',
		timezone: 'Asia/Singapore',
	}
}
async function render(
	value: Props,
	locale: keyof typeof adminAuditLogMessages = 'en'
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
						adminUserDetail: adminUserDetailMessages[locale],
						adminAuditLogs: adminAuditLogMessages[locale],
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
test('recent user audits retain full wallet, period, actor and change information in all four locales', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(props(), locale)
		assert.ok(html.includes(adminAuditLogMessages[locale].table.wallet))
		assert.ok(
			html.includes(adminAuditLogMessages[locale].labels.viewChangeDetail)
		)
		assert.ok(html.includes('wallet_credit'))
		assert.ok(html.includes('admin_wallet'))
		assert.ok(html.includes('charged_cost_factors'))
		assert.ok(html.includes('15.250000'))
		assert.ok(html.includes('2.749999'))
		assert.ok(html.includes('monthly'))
		assert.ok(html.includes('weekly'))
		assert.equal(html.includes('sk-private-fixture-canary'), false)
		assert.equal(html.includes('cinatoken.adminAuditLogs.'), false)
	}
})
test('recent audit denial, error and reload remove shared details rather than retaining prior wallet values', async () => {
	for (const overrides of [
		{ auditsDenied: true },
		{ auditsFailed: true },
		{ audits: null },
	]) {
		const html = await render({ ...props(), ...overrides })
		assert.equal(html.includes('15.250000'), false)
		assert.equal(html.includes('wallet_credit'), false)
	}
})
