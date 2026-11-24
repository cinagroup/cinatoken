/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ComponentProps } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { UserDetailWalletCredit } from './UserDetailWalletCredit'
import { adminUserDetailMessages } from './messages'
import {
	walletCreditFixtureInput as input,
	walletCreditFixtureReceipt as receipt,
	walletCreditFixtureUserId as userId,
} from './wallet-credit-fixtures'

type Props = ComponentProps<typeof UserDetailWalletCredit>
function props(): Props {
	return {
		userId,
		currency: 'CNY',
		timezone: 'UTC',
		writer: {
			status: 'ready',
			pending: null,
			busy: false,
			receipt: null,
			error: null,
			observation: null,
			allowed: true,
			canStart: true,
			submit: async () => {},
			reconcile: async () => {},
			retrySameOrder: async () => {},
		},
	}
}
async function render(
	value: Props,
	locale: keyof typeof adminUserDetailMessages = 'en'
) {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		resources: {
			[locale]: {
				translation: {
					cinatoken: { adminUserDetail: adminUserDetailMessages[locale] },
				},
			},
		},
	})
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(UserDetailWalletCredit, value)
		)
	)
}
test('four languages expose the order form, signed confirmation and separate verifiable receipt', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const value = props()
		value.writer.receipt = receipt
		const html = await render(value, locale)
		for (const key of [
			'creditTitle',
			'creditReference',
			'creditConfirm',
			'creditVerified',
			'creditReceiptHint',
		] as const)
			assert.ok(html.includes(adminUserDetailMessages[locale][key]))
		assert.ok(html.includes(receipt.auditId))
		assert.match(html, /25[.,]000001/u)
		assert.ok(html.includes('CNY'))
		assert.ok(!html.includes('cinatoken.adminUserDetail.'))
	}
})
test('unknown orders display only frozen values and provide no editable resubmission', async () => {
	const value = props()
	value.writer = {
		...value.writer,
		status: 'pending',
		canStart: false,
		pending: { version: 1, generation: crypto.randomUUID(), userId, input },
	}
	const html = await render(value)
	assert.ok(html.includes(input.external_ref))
	assert.match(html, /<fieldset disabled=""/u)
	assert.ok(html.includes(adminUserDetailMessages.en.creditCheck))
	assert.ok(!html.includes(adminUserDetailMessages.en.creditRetryConfirm))
	value.writer.observation = 'not_found'
	const missing = await render(value)
	assert.ok(missing.includes(adminUserDetailMessages.en.creditNotFound))
	assert.ok(missing.includes(adminUserDetailMessages.en.creditRetryConfirm))
})
test('missing currency, unavailable persistence and read-only access disable the credit form', async () => {
	for (const change of ['currency', 'storage', 'access'] as const) {
		const value = props()
		if (change === 'currency') value.currency = null
		if (change === 'storage') value.writer.status = 'unavailable'
		if (change === 'access') value.writer.canStart = false
		const html = await render(value)
		assert.match(html, /<fieldset disabled=""/u)
		if (change === 'storage')
			assert.ok(html.includes(adminUserDetailMessages.en.creditStorage))
	}
})
