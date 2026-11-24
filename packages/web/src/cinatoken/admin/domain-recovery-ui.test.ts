/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, Fragment, type ComponentProps } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { AdminDomainRecoveryDialog } from './AdminDomainRecoveryDialog'
import { adminDomainMessages } from './domain-messages'
import { routeMessages } from './routes/messages'
import type { AdminDomainRecoveryController } from './use-domain-write-recovery'

function controller(
	overrides: Partial<AdminDomainRecoveryController> = {}
): AdminDomainRecoveryController {
	return {
		status: 'pending',
		open: false,
		pending: false,
		error: false,
		allowed: true,
		busy: false,
		show: () => undefined,
		close: () => undefined,
		review: async () => undefined,
		...overrides,
	}
}

async function render(
	props:
		| ComponentProps<typeof AdminDomainRecoveryDialog>
		| ComponentProps<typeof AdminDomainRecoveryDialog>[],
	locale: keyof typeof adminDomainMessages = 'en'
): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		resources: {
			[locale]: {
				translation: {
					cinatoken: { adminDomain: adminDomainMessages[locale] },
				},
			},
		},
	})
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(
				Fragment,
				null,
				...(Array.isArray(props) ? props : [props]).map((item, index) =>
					createElement(AdminDomainRecoveryDialog, { ...item, key: index })
				)
			)
		)
	)
}

function reviewDisabled(html: string): boolean {
	const attributes = html.match(/<button\b([^>]*)>/u)?.[1]
	assert.ok(attributes, 'The review action must be present')
	return /\sdisabled(?:=|\s|$)/u.test(attributes)
}

test('independent route and model recovery actions remain visibly and accessibly distinguishable in every locale', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const routes = {
			recovery: controller(),
			label: routeMessages[locale].routeRecovery,
		}
		const models = {
			recovery: controller({ status: 'unavailable' }),
			label: routeMessages[locale].modelRecovery,
		}
		const html = await render([routes, models], locale)
		assert.equal((html.match(/role="region"/gu) ?? []).length, 2)
		for (const item of [routes, models]) {
			assert.ok(html.includes(`aria-label="${item.label}"`))
			assert.ok(html.includes(`>${item.label}</h2>`))
		}
		const settled = await render(
			[{ ...routes, recovery: controller({ status: 'ready' }) }, models],
			locale
		)
		assert.equal((settled.match(/role="region"/gu) ?? []).length, 1)
		assert.equal(settled.includes(routes.label), false)
		assert.ok(settled.includes(`aria-label="${models.label}"`))
	}
})

for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
	test(`an open editor explains the recovery block in ${locale} without implying an in-flight write`, async () => {
		const html = await render(
			{ recovery: controller(), busy: true, busyReason: 'editor' },
			locale
		)
		assert.ok(html.includes(adminDomainMessages[locale].editorOpen))
		assert.equal(html.includes(adminDomainMessages[locale].writing), false)
		assert.equal(reviewDisabled(html), true)
	})
}

test('editor ownership never overrides active writes or unavailable storage and releases only its own block', async () => {
	for (const recovery of [
		controller({ busy: true }),
		controller({ status: 'unavailable' }),
	]) {
		const html = await render({ recovery, busy: true, busyReason: 'editor' })
		const key =
			recovery.status === 'unavailable' ? 'storageUnavailable' : 'writing'
		assert.ok(html.includes(adminDomainMessages.en[key]))
		assert.equal(html.includes(adminDomainMessages.en.editorOpen), false)
		assert.equal(reviewDisabled(html), true)
	}
	const idle = await render({ recovery: controller(), busyReason: 'editor' })
	assert.ok(idle.includes(adminDomainMessages.en.unknown))
	assert.equal(reviewDisabled(idle), false)
	assert.equal(
		await render({
			recovery: controller({ status: 'ready' }),
			busyReason: 'editor',
		}),
		''
	)
})
