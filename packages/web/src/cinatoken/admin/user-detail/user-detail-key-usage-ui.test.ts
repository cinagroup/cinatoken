/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { adminGatewayKeyMessages } from '../gateway-keys/messages'
import { UserDetailKeysTable } from './UserDetailKeysTable'
import { adminUserDetailMessages } from './messages'
import {
	userDetailKeySchema,
	type UserDetailKey,
} from './user-detail-contracts'
import { formatUserDetailTime } from './user-detail-format'

const wire = {
	id: 'recorded-key',
	key: 'sk-private-must-not-display',
	user_id: 'user-1',
	workspace_id: 'personal:user-1',
	name: 'Key usage',
	status: 'active',
	metadata: null,
	last_used_at: '2026-10-23T16:00:00.000Z',
	created_at: '2026-10-20T16:00:00.000Z',
	updated_at: '2026-10-20T16:00:00.000Z',
}
const rows = [
	userDetailKeySchema.parse(wire),
	userDetailKeySchema.parse({ ...wire, id: 'unused-key', last_used_at: null }),
	userDetailKeySchema.parse({
		...wire,
		id: 'legacy-key',
		last_used_at: undefined,
	}),
]
async function render(
	locale: keyof typeof adminGatewayKeyMessages,
	keys: UserDetailKey[],
	timezone: string | null
) {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		interpolation: { escapeValue: false },
		resources: {
			[locale]: {
				translation: {
					cinatoken: {
						adminGatewayKeys: adminGatewayKeyMessages[locale],
						adminUserDetail: adminUserDetailMessages[locale],
					},
				},
			},
		},
	})
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(UserDetailKeysTable, {
				keys,
				timezone,
				canWrite: false,
				busy: false,
				onEdit: () => {},
				onStatus: async () => {},
				onDelete: async () => {},
			})
		)
	)
}
function rowHtml(html: string, id: string): string {
	const found = html
		.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)
		?.find((value) => value.includes(id))
	assert.ok(found)
	return found
}

test('user key table labels creation separately and preserves all three usage states in four languages', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(locale, rows, 'Asia/Singapore')
		const created = formatUserDetailTime(
				wire.created_at,
				locale,
				'Asia/Singapore'
			),
			used = formatUserDetailTime(wire.last_used_at, locale, 'Asia/Singapore')
		for (const row of rows) {
			const part = rowHtml(html, row.id)
			assert.ok(part.includes(adminGatewayKeyMessages[locale].created))
			assert.ok(part.includes(adminGatewayKeyMessages[locale].lastUsed))
			assert.equal(part.split(created).length - 1, 1)
		}
		assert.ok(rowHtml(html, 'recorded-key').includes(used))
		assert.ok(
			rowHtml(html, 'unused-key').includes(
				adminGatewayKeyMessages[locale].noUsageRecorded
			)
		)
		assert.ok(
			rowHtml(html, 'legacy-key').includes(
				adminGatewayKeyMessages[locale].lastUsedUnavailable
			)
		)
		assert.equal(rowHtml(html, 'unused-key').includes(used), false)
		assert.equal(rowHtml(html, 'legacy-key').includes(used), false)
		assert.equal(html.includes('sk-private-must-not-display'), false)
		assert.equal(html.includes('cinatoken.'), false)
	}
})

test('user key usage follows business DST while creation stays its own instant', async () => {
	const keys = [
		userDetailKeySchema.parse({
			...wire,
			last_used_at: '2026-03-08T07:00:00.000Z',
			created_at: '2026-03-08T06:59:00.000Z',
		}),
	]
	const before = JSON.stringify(keys),
		html = await render('en', keys, 'America/New_York')
	assert.ok(html.includes('03/08/2026, 01:59:00 America/New_York'))
	assert.ok(html.includes('03/08/2026, 03:00:00 America/New_York'))
	assert.equal(JSON.stringify(keys), before)
})

test('unverified timezone uses explicit UTC without inventing a last usage time', async () => {
	const html = await render('zh', rows, null)
	assert.ok(html.includes('2026/10/23 16:00:00 UTC'))
	assert.ok(
		rowHtml(html, 'unused-key').includes(
			adminGatewayKeyMessages.zh.noUsageRecorded
		)
	)
	assert.equal(
		rowHtml(html, 'unused-key').split('2026/10/20 16:00:00 UTC').length - 1,
		1
	)
	assert.equal(html.includes('Asia/Singapore'), false)
})
