/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { UserDetailBudgetTransition } from './UserDetailBudgetTransition'
import { UserDetailWalletFields } from './UserDetailWalletFields'
import { adminUserDetailMessages } from './messages'
import { userDetailSchema } from './user-detail-contracts'
import { draftFromUser } from './user-detail-domain'

const user = userDetailSchema.parse({
	id: 'f2b74bc0-32f3-4613-aea7-96f723d08e12',
	email: 'qa@example.invalid',
	external_system: null,
	external_user_id: null,
	budget_max: 10,
	budget_base: 10,
	budget_spent: 1,
	budget_period: 'monthly',
	budget_reset_at: '2030-01-01T00:00:00.000Z',
	status: 'active',
	metadata: null,
	charged_cost_factors: null,
	created_at: '2026-10-01T00:00:00.000Z',
	updated_at: '2026-10-01T00:00:00.000Z',
})
async function render(
	locale: keyof typeof adminUserDetailMessages,
	element: ReactNode
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
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element))
}

test('wallet fields keep signed balances and explain non-resetting credit and required corrections in all locales', async () => {
	const withWallet = userDetailSchema.parse({
		...user,
		wallet_granted: 1,
		wallet_spent: 2,
		wallet_balance: -1,
	})
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(
			locale,
			createElement(UserDetailWalletFields, {
				user: withWallet,
				currency: 'CNY',
				draft: draftFromUser(withWallet),
				canWrite: false,
				onChange: () => {},
			})
		)
		for (const key of [
			'walletHint',
			'walletReason',
			'walletGranted',
			'walletSpent',
		] as const)
			assert.ok(html.includes(adminUserDetailMessages[locale][key]))
		assert.match(html, /-[^<]*1[.,]00/u)
		assert.equal((html.match(/disabled=""/gu) ?? []).length, 3)
	}
})

test('legacy user detail explains missing wallet data and exposes no editable counters', async () => {
	const html = await render(
		'zh',
		createElement(UserDetailWalletFields, {
			user,
			currency: 'CNY',
			draft: draftFromUser(user),
			canWrite: true,
			onChange: () => {},
		})
	)
	assert.ok(html.includes(adminUserDetailMessages.zh.walletUnavailable))
	assert.equal(html.includes('<input'), false)
})

test('transition review displays preserved wallet counters alongside period changes', async () => {
	const before = {
		budget_max: 10,
		budget_base: 10,
		budget_spent: 1,
		budget_period: 'monthly' as const,
		budget_reset_at: '2030-01-01T00:00:00.000Z',
		budget_epoch: 1,
		budget_reserved_micros: 0,
		wallet_granted: 20,
		wallet_spent: 3,
		wallet_balance: 17,
	}
	const after = { ...before, budget_max: 19, budget_spent: 0, budget_epoch: 2 }
	const html = await render(
		'zh',
		createElement(UserDetailBudgetTransition, {
			user,
			currency: 'CNY',
			timezone: 'UTC',
			canWrite: true,
			busy: false,
			preview: { before, after, carryover: 9 },
			error: null,
			unknown: false,
			safetyUnavailable: false,
			onPreview: async () => {},
			onApply: async () => {},
			onInvalidate: () => {},
		})
	)
	assert.ok(html.includes(adminUserDetailMessages.zh.walletTransition))
	assert.match(html, /17[.,]00[^<]*→[^<]*17[.,]00/u)
})
