/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { ModelSyncOutcome, ModelSyncReview } from './ModelSyncDialog'
import { ModelSyncDiff } from './ModelSyncDiff'
import { adminModelsMessages } from './messages'
import { modelSyncSelectionKey } from './model-sync-domain'
import { modelSyncFixture } from './model-sync-fixtures'

async function render(element: ReactElement, locale = 'en'): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		interpolation: { escapeValue: false },
		resources: Object.fromEntries(
			Object.entries(adminModelsMessages).map(([language, messages]) => [
				language,
				{ translation: { cinatoken: { adminModels: messages } } },
			])
		),
	})
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element))
}

test('sync review shows grouped differences, no default choices and a disabled apply button in every locale', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(
			createElement(ModelSyncReview, {
				report: modelSyncFixture,
				disabled: false,
				onApply: () => assert.fail('Rendering cannot apply'),
			}),
			locale
		)
		assert.ok(html.includes('OpenAI'))
		assert.ok(html.includes('Alibaba'))
		assert.ok(html.includes('tiers[0].input_price'))
		assert.ok(html.includes('schedule.windows[0].name'))
		assert.ok(html.includes(adminModelsMessages[locale].syncStatus_removed!))
		assert.ok(html.includes(adminModelsMessages[locale].syncApply!))
		assert.equal((html.match(/aria-checked="true"/gu) ?? []).length, 0)
		const apply = (
			html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gu) ?? []
		).find((button) => button.includes(adminModelsMessages[locale].syncApply!))
		assert.ok(apply)
		assert.match(apply, /\bdisabled(?:=|\s|>)/u)
		assert.ok(html.includes('&lt;script&gt;safe text&lt;/script&gt;'))
		assert.equal(html.includes('<script>safe text</script>'), false)
		assert.equal(html.includes('cinatoken.adminModels.'), false)
	}
})

test('disabled diff retains selected pricing as one explicit replacement and shows current and official values', async () => {
	const html = await render(
		createElement(ModelSyncDiff, {
			groups: modelSyncFixture.groups,
			selection: [modelSyncSelectionKey('openai/text', 'pricing_profile')],
			disabled: true,
			onToggle: () => assert.fail('Rendering cannot select'),
		})
	)
	assert.equal((html.match(/aria-checked="true"/gu) ?? []).length, 1)
	assert.ok(html.includes('Current value'))
	assert.ok(html.includes('Official value'))
	assert.ok(html.includes('replaces the entire pricing profile'))
	assert.ok(html.includes('disabled'))
})

test('known partial outcome shows model identities and safe recovery guidance without raw server errors', async () => {
	const html = await render(
		createElement(ModelSyncOutcome, {
			result: {
				updated: 1,
				skipped: 1,
				failed: [
					{
						model_id: 'alibaba/speech',
						message: 'private token sk-do-not-display',
					},
				],
			},
		})
	)
	assert.ok(html.includes('Updated 1 · Skipped 1 · Failed 1'))
	assert.ok(html.includes('alibaba/speech'))
	assert.ok(html.includes('will not be replayed'))
	assert.equal(html.includes('sk-do-not-display'), false)
	assert.ok(html.includes('role="alert"'))
	const success = await render(
		createElement(ModelSyncOutcome, {
			result: { updated: 0, skipped: 3, failed: [] },
		})
	)
	assert.ok(success.includes('role="status"'))
	assert.ok(success.includes('Skipped 3'))
})
