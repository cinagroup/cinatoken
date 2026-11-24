/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactElement, type ComponentProps } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { RequestLogDetail } from './RequestLogDetail'
import { RequestLogIngressFilter } from './RequestLogIngressFilter'
import { RequestLogPrefixFilter } from './RequestLogPrefixFilter'
import { RequestLogTable } from './RequestLogTable'
import { RequestLogsContent } from './RequestLogsContent'
import { adminRequestLogMessages } from './messages'
import { requestLogsResponseSchema } from './request-log-contracts'
import {
	validateRequestLogRouteSearch,
	validateRequestLogSearch,
} from './request-log-domain'

const page = requestLogsResponseSchema.parse({
	success: true,
	data: [
		{
			id: 'log-1',
			input_tokens: 1,
			output_tokens: 2,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			metered_cost: 0,
			charged_cost: 0,
			status: 'success',
			created_at: '2026-10-18T00:00:00.000Z',
		},
	],
	total: 1,
	page: 1,
	page_size: 50,
})
async function render(
	element: ReactElement,
	locale: 'en' | 'zh' | 'ja' | 'ko' = 'en'
) {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		resources: {
			[locale]: {
				translation: {
					cinatoken: { adminRequestLogs: adminRequestLogMessages[locale] },
				},
			},
		},
	})
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element))
}
const disabledButtons = (html: string) =>
	(html.match(/<button\b[^>]*\sdisabled(?:="")?(?=\s|>)/gu) ?? []).length

test('host filter is translated, associated and bounded; applied or invalid input cannot submit another query', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(
			createElement(RequestLogIngressFilter, {
				search: validateRequestLogSearch({ ingress_host: 'Gateway.Test:8443' }),
				onSearch: () => assert.fail('Rendering cannot navigate'),
			}),
			locale
		)
		assert.ok(html.includes(adminRequestLogMessages[locale].ingressHost))
		assert.ok(html.includes(adminRequestLogMessages[locale].applyIngressHost))
		assert.ok(html.includes(adminRequestLogMessages[locale].ingressHostHint))
		assert.match(html, /for="request-log-ingress-host"/u)
		assert.match(html, /id="request-log-ingress-host"/u)
		assert.match(html, /maxlength="255"/iu)
		assert.match(html, /aria-describedby="request-log-ingress-host-hint"/u)
		assert.equal(disabledButtons(html), 1)
		assert.equal(html.includes('cinatoken.adminRequestLogs.'), false)
	}
	const invalid = await render(
		createElement(RequestLogIngressFilter, {
			search: { ...validateRequestLogSearch({}), ingress_host: ' ' },
			onSearch: () => assert.fail('Invalid input cannot navigate'),
		})
	)
	assert.match(invalid, /aria-invalid="true"/u)
	assert.ok(invalid.includes(adminRequestLogMessages.en.invalidIngressHost))
	assert.equal(disabledButtons(invalid), 1)
	const clear = await render(
		createElement(RequestLogIngressFilter, {
			search: { ...validateRequestLogSearch({}), invalidFilter: true },
			onSearch: () => {},
		})
	)
	assert.equal(disabledButtons(clear), 0)
})

test('list and expanded detail render host as escaped copyable text, redact secrets and keep absent snapshots unknown', async () => {
	const host = '<img src=x onerror=alert(1)>'
	const log = { ...page.data[0], ingress_host: host }
	const table = await render(
		createElement(RequestLogTable, {
			page: { ...page, data: [log] },
			models: null,
			providers: null,
			currency: null,
			timezone: 'UTC',
			locale: 'en',
			expanded: null,
			onExpand: () => {},
		})
	)
	assert.ok(table.includes(adminRequestLogMessages.en.ingressHost))
	assert.ok(table.includes('&lt;img src=x onerror=alert(1)&gt;'))
	assert.doesNotMatch(table, /<img|<a\b/iu)
	const detail = await render(createElement(RequestLogDetail, { log }))
	assert.ok(detail.includes('&lt;img src=x onerror=alert(1)&gt;'))
	assert.ok(detail.includes(adminRequestLogMessages.en.copy))
	assert.doesNotMatch(detail, /<img/iu)
	const redacted = await render(
		createElement(RequestLogDetail, {
			log: { ...log, ingress_host: 'Bearer private-host-token' },
		})
	)
	assert.equal(redacted.includes('private-host-token'), false)
	for (const ingress_host of [undefined, null]) {
		const legacy = await render(
			createElement(RequestLogTable, {
				page: { ...page, data: [{ ...log, ingress_host }] },
				models: null,
				providers: null,
				currency: null,
				timezone: 'UTC',
				locale: 'en',
				expanded: null,
				onExpand: () => {},
			})
		)
		assert.ok(legacy.includes(adminRequestLogMessages.en.ingressHost))
		assert.equal(legacy.includes(host), false)
		assert.ok(legacy.includes('—'))
	}
})

test('invalid URL host state takes precedence over any previously loaded page', async () => {
	const state: ComponentProps<typeof RequestLogsContent>['state'] = {
		invalidFilter: true,
		page,
		error: null,
		loading: false,
		logsBlocked: false,
		invalidateLogs: () => {},
		display: null,
		displaySettled: true,
		timezone: null,
		currency: null,
		effectiveSearch: { ...validateRequestLogSearch({}), invalidFilter: true },
		models: null,
		providers: null,
		routes: null,
		catalogSettled: true,
		retry: () => {},
	}
	const html = await render(
		createElement(RequestLogsContent, {
			state,
			expanded: null,
			onExpand: () => {},
		})
	)
	assert.match(html, /role="alert"/u)
	assert.ok(html.includes(adminRequestLogMessages.en.invalidFilter))
	assert.doesNotMatch(html, /<table|log-1/u)
})

test('prefix recovery input has associated four-language errors and retains bounded invalid URL values for editing', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		for (const model_id_prefix of [' ', 'x'.repeat(601)]) {
			const html = await render(
				createElement(RequestLogPrefixFilter, {
					search: validateRequestLogRouteSearch({ model_id_prefix }),
					onSearch: () => assert.fail('Rendering cannot navigate'),
				}),
				locale
			)
			assert.match(html, /for="request-log-model-prefix"/u)
			assert.match(html, /id="request-log-model-prefix"/u)
			assert.match(html, /maxlength="600"/iu)
			assert.match(html, /aria-invalid="true"/u)
			assert.match(html, /aria-describedby="request-log-model-prefix-hint"/u)
			assert.ok(html.includes(adminRequestLogMessages[locale].modelIdPrefix))
			assert.ok(
				html.includes(adminRequestLogMessages[locale].invalidModelPrefix)
			)
			assert.equal(html.includes('cinatoken.adminRequestLogs.'), false)
		}
	}
})

test('prefix-only and combined errors show the correct four-language alerts before any stale loaded page', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		for (const ingress_host of ['', ' ']) {
			const search = validateRequestLogRouteSearch({
				model_id_prefix: ' ',
				ingress_host,
			})
			const state: ComponentProps<typeof RequestLogsContent>['state'] = {
				invalidFilter: true,
				page,
				error: null,
				loading: false,
				logsBlocked: false,
				invalidateLogs: () => {},
				display: null,
				displaySettled: true,
				timezone: null,
				currency: null,
				effectiveSearch: search,
				models: null,
				providers: null,
				routes: null,
				catalogSettled: true,
				retry: () => {},
			}
			const html = await render(
				createElement(RequestLogsContent, {
					state,
					search,
					expanded: null,
					onExpand: () => {},
				}),
				locale
			)
			assert.match(html, /role="alert"/u)
			assert.ok(
				html.includes(adminRequestLogMessages[locale].invalidModelPrefixFilter)
			)
			assert.equal(
				html.includes(adminRequestLogMessages[locale].invalidFilter),
				ingress_host === ' '
			)
			assert.doesNotMatch(html, /<table|log-1/u)
		}
	}
})
