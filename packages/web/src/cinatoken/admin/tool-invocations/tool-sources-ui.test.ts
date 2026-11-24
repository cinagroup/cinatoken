/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, Fragment } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { RequestLogProviderSetFilter } from '../request-logs/RequestLogProviderSetFilter'
import { adminRequestLogMessages } from '../request-logs/messages'
import { validateRequestLogRouteSearch } from '../request-logs/request-log-domain'
import { ToolInvocationSourceFilters } from './ToolInvocationSourceFilters'
import { adminToolInvocationMessages } from './messages'
import { validateToolInvocationSearch } from './tool-invocation-domain'

test('four languages explain combined sources, provider sets and intersection semantics', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const i18n = createInstance()
		await i18n.init({
			lng: locale,
			fallbackLng: false,
			resources: {
				[locale]: {
					translation: {
						cinatoken: {
							adminToolInvocations: adminToolInvocationMessages[locale],
							adminRequestLogs: adminRequestLogMessages[locale],
						},
					},
				},
			},
		})
		const html = renderToStaticMarkup(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(
					Fragment,
					null,
					createElement(ToolInvocationSourceFilters, {
						search: validateToolInvocationSearch({ source: 'all' }),
						onSearch: () => assert.fail(),
					}),
					createElement(RequestLogProviderSetFilter, {
						search: validateRequestLogRouteSearch({
							provider_ids: 'octafuse-tools,octafuse-mcp',
						}),
						onSearch: () => assert.fail(),
					})
				)
			)
		)
		assert.ok(
			html.includes(adminToolInvocationMessages[locale].invocations.sourceAll)
		)
		assert.ok(
			html.includes(
				adminToolInvocationMessages[locale].invocations.sourceAllHint
			)
		)
		assert.ok(html.includes(adminRequestLogMessages[locale].providerIdsHint))
		assert.ok(html.includes(adminRequestLogMessages[locale].applyProviderIds))
		assert.ok(html.includes(adminRequestLogMessages[locale].clearProviderIds))
		assert.equal(html.includes('cinatoken.admin'), false)
	}
})
