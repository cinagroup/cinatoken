/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { AuditWalletSummary } from './AuditWalletSummary'
import type { AuditLog } from './audit-log-contracts'
import { formatAuditWalletMoney } from './audit-wallet'
import { adminAuditLogMessages } from './messages'

type Locale = keyof typeof adminAuditLogMessages
const base: AuditLog = {
	id: 'audit-wallet',
	event_type: 'wallet_credit',
	actor_type: 'admin',
	created_at: '2026-10-23T00:00:00.000Z',
}
const snapshot = (granted: number | string, spent: number | string) =>
	JSON.stringify({ wallet_granted: granted, wallet_spent: spent })
async function render(
	log: Partial<AuditLog>,
	locale: Locale = 'en',
	currency: string | null = 'USD'
): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		resources: {
			[locale]: {
				translation: {
					cinatoken: { adminAuditLogs: adminAuditLogMessages[locale] },
				},
			},
		},
	})
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(AuditWalletSummary, {
				log: { ...base, ...log },
				locale,
				currency,
			})
		)
	)
}
function escaped(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#x27;')
}

test('wallet summary has translated granted/spent/balance labels and exact changes in all four locales', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const labels = adminAuditLogMessages[locale].wallet
		const html = await render(
			{
				before_user_snapshot: snapshot(2, 3),
				after_user_snapshot: snapshot('2.000001', 3),
			},
			locale
		)
		assert.equal((html.match(/<dt\b/g) ?? []).length, 3)
		for (const key of [
			'granted',
			'spent',
			'balance',
			'before',
			'after',
		] as const)
			assert.ok(html.includes(escaped(labels[key])), locale + '/' + key)
		for (const micros of [2000000n, 2000001n, 3000000n, -1000000n, -999999n])
			assert.ok(
				html.includes(escaped(formatAuditWalletMoney(micros, 'USD', locale)!)),
				locale + '/' + micros
			)
		assert.equal((html.match(/→/g) ?? []).length, 2)
		assert.equal(html.includes('cinatoken.adminAuditLogs.'), false)
		assert.equal(html.includes('{{'), false)
	}
})
test('unchanged exact wallet values simplify to a single value per row while zero remains recorded', async () => {
	const html = await render({
		before_user_snapshot: snapshot(0, 0),
		after_user_snapshot: snapshot('0.000000', '0.000000'),
	})
	assert.equal(html.includes('→'), false)
	assert.equal((html.match(/\$0\.000000/g) ?? []).length, 3)
	assert.equal(html.includes(adminAuditLogMessages.en.wallet.missing), false)
})
test('one-sided and invalid history stays explicit and is never displayed as zero', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const labels = adminAuditLogMessages[locale].wallet
		const oneSide = await render(
			{ after_user_snapshot: snapshot(1, 0) },
			locale
		)
		assert.ok(oneSide.includes(escaped(labels.missing)))
		assert.equal((oneSide.match(/→/g) ?? []).length, 3)
		const invalid = await render(
			{
				before_user_snapshot: '{"wallet_granted":false,"wallet_spent":0}',
				after_user_snapshot: '{"wallet_spent":0}',
			},
			locale
		)
		assert.ok(invalid.includes(escaped(labels.invalid)))
		assert.ok(invalid.includes(escaped(labels.missing)))
	}
})
test('unknown or invalid currency hides all wallet amounts without obscuring the three field labels', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const)
		for (const currency of [null, 'bad currency']) {
			const html = await render(
				{
					before_user_snapshot: snapshot(123456, 2),
					after_user_snapshot: snapshot(123457, 3),
				},
				locale,
				currency
			)
			assert.ok(
				html.includes(escaped(adminAuditLogMessages[locale].wallet.hidden))
			)
			assert.equal(/123[,.]?45[67]|\$|¥|￥|NaN|Infinity/u.test(html), false)
			assert.equal((html.match(/<dt\b/g) ?? []).length, 3)
		}
})
test('large historical numbers display their exact micro-units without exposing unrelated snapshot content', async () => {
	const html = await render({
		before_user_snapshot:
			'{"wallet_granted":9000000000.000001,"wallet_spent":9000000000,"metadata":"secret-canary"}',
		after_user_snapshot:
			'{"wallet_granted":9000000000.000002,"wallet_spent":9000000000}',
	})
	assert.ok(html.includes('$9,000,000,000.000001'))
	assert.ok(html.includes('$9,000,000,000.000002'))
	assert.ok(html.includes('$0.000001'))
	assert.ok(html.includes('$0.000002'))
	assert.equal(html.includes('secret-canary'), false)
})
