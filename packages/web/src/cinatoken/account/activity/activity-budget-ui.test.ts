/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import {
	activityBudgetSchema,
	type ActivityBudget,
} from '../../activity-contracts'
import { ActivityBudgetCard } from './ActivityBudgetCard'
import { activityMessages } from './messages'

const legacy = {
	status: 'finite',
	budgetMax: 10,
	budgetBase: 10,
	budgetSpent: 2,
	budgetReserved: 0.25,
	budgetReservedMicros: 250000,
	budgetRemaining: 7.75,
	budgetPeriod: 'monthly',
	budgetResetAt: null,
}
async function render(
	budget: ActivityBudget,
	locale: keyof typeof activityMessages = 'en'
) {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		resources: {
			[locale]: {
				translation: {
					cinatoken: { account: { activity: activityMessages[locale] } },
				},
			},
		},
	})
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(ActivityBudgetCard, { budget, currency: 'CNY' })
		)
	)
}

test('Activity budget separates permanent credit and account reservations in each supported locale', async () => {
	const budget = activityBudgetSchema.parse({
		...legacy,
		walletGranted: 20,
		walletSpent: 3,
		walletRemaining: 17,
		totalRemaining: 24.75,
	})
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(budget, locale)
		assert.ok(html.includes(activityMessages[locale].permanentBudget))
		assert.ok(html.includes(activityMessages[locale].walletDoesNotReset))
		assert.ok(html.includes(activityMessages[locale].totalBudgetHint))
		assert.match(html, /CNY[^<]*17/u)
		assert.match(html, /CNY[^<]*0[.,]25/u)
		assert.ok(!html.includes(activityMessages[locale].walletUnavailable))
	}
})

test('legacy Activity responses explain missing permanent details without displaying a fabricated zero', async () => {
	const html = await render(activityBudgetSchema.parse(legacy))
	assert.ok(html.includes(activityMessages.en.walletUnavailable))
	assert.ok(!html.includes(activityMessages.en.walletGranted))
	assert.ok(!html.includes(activityMessages.en.walletRemaining))
})
