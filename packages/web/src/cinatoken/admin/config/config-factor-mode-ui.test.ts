/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ComponentProps } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { FactorModeCard } from './FactorModeCard'
import { configFullMessages } from './messages'

async function render(
	changes: Partial<ComponentProps<typeof FactorModeCard>> = {},
	locale: 'en' | 'zh' | 'ja' | 'ko' = 'en'
) {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		resources: {
			[locale]: {
				translation: {
					cinatoken: { adminConfigFull: configFullMessages[locale] },
				},
			},
		},
	})
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(FactorModeCard, {
				field: { value: 'multiply', source: 'configured', revision: 'legacy' },
				draft: null,
				canWrite: true,
				canEdit: true,
				locked: false,
				onChange: () => assert.fail('Rendering cannot change mode'),
				onSave: () => assert.fail('Rendering cannot write'),
				onDiscard: () => assert.fail('Rendering cannot discard'),
				...changes,
			})
		)
	)
}

test('factor mode card explains both formulas with translated accessible controls, dirty/save/discard states in all four locales', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render({}, locale)
		assert.ok(html.includes(configFullMessages[locale].factorMode!))
		assert.ok(html.includes(configFullMessages[locale].factorMultiplyHint!))
		assert.ok(html.includes(configFullMessages[locale].factorMinHint!))
		assert.ok(html.includes('for="admin-config-factor-mode"'))
		assert.ok(html.includes('id="admin-config-factor-mode"'))
		assert.equal((html.match(/<option /gu) ?? []).length, 2)
		assert.equal(
			(html.match(/<button\b[^>]*\sdisabled(?:="")?(?=\s|>)/gu) ?? []).length,
			2
		)
		assert.equal(html.includes('cinatoken.adminConfigFull.'), false)
	}
	const dirty = await render({ draft: 'min' })
	assert.ok(dirty.includes(configFullMessages.en.factorModeDirty!))
	assert.ok(dirty.includes('value="min" selected=""'))
	assert.equal(
		(dirty.match(/<button\b[^>]*\sdisabled(?:="")?(?=\s|>)/gu) ?? []).length,
		0
	)
})

test('legacy missing snapshot, read-only and pending states never expose an editable mode or a save path', async () => {
	for (const props of [
		{ field: undefined },
		{ canWrite: false },
		{ locked: true },
	]) {
		const html = await render(props)
		assert.equal(html.includes('<select'), false)
		assert.equal(html.includes('<button'), false)
	}
	assert.ok(
		(await render({ field: undefined })).includes(
			configFullMessages.en.factorModeUnavailable!
		)
	)
	const locked = await render({ locked: true })
	assert.ok(locked.includes('role="alert"'))
	assert.ok(locked.includes(configFullMessages.en.unconfirmed!))
	const disabled = await render({ canEdit: false, draft: 'min' })
	assert.ok(/<select\b[^>]*\sdisabled(?:="")?(?=\s|>)/u.test(disabled))
	assert.equal(
		(disabled.match(/<button\b[^>]*\sdisabled(?:="")?(?=\s|>)/gu) ?? []).length,
		2
	)
})
