/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import {
	adminProviderSchema,
	providerCatalogItemSchema,
	providerCatalogResponseSchema,
} from '../provider-contracts'
import { ProviderCatalogOutboundLink } from './ProviderCatalogOutboundLink'
import { ProviderImportCatalogItem } from './ProviderImportDialog'
import { providerCatalogLinkMessages } from './catalog-link-messages'
import { providerMessages } from './messages'
import {
	providerCatalogLinksSchema,
	providerCatalogOutboundRel,
	resolveProviderCatalogOutbound,
} from './provider-catalog-links'

const catalogRow = {
	id: '0',
	name: 'Example Provider',
	vendor_key: 'other',
	icon_key: 'other',
	vendor_label: 'Other',
	protocols: ['openai'],
	endpoints: null,
	description: 'A provider template',
}
const links = {
	platform: 'https://provider.example/',
	api_keys: 'https://provider.example/console?tab=app#/api-key',
	referral: 'https://provider.example/invite/example?ref=public-code',
}

test('catalog and saved-provider contracts preserve only known safe optional links', () => {
	const catalog = providerCatalogItemSchema.parse({
		...catalogRow,
		links: { ...links, private_key: 'PRIVATE-CREDENTIAL' },
	})
	assert.deepEqual(catalog.links, links)
	assert.equal(JSON.stringify(catalog).includes('PRIVATE-CREDENTIAL'), false)
	const provider = adminProviderSchema.parse({
		id: 'provider-1',
		name: 'Example Provider',
		vendor_key: 'other',
		icon_key: 'other',
		endpoints: null,
		api_key: '***',
		status: 'active',
		description: null,
		created_at: '2026-10-28T00:00:00Z',
		has_pending_key: false,
		routes_count: 0,
		active_routes_count: 0,
		catalog_links: { ...links, private_key: 'PRIVATE-CREDENTIAL' },
	})
	assert.deepEqual(provider.catalog_links, links)
	assert.equal(JSON.stringify(provider).includes('PRIVATE-CREDENTIAL'), false)
	assert.equal(providerCatalogItemSchema.parse(catalogRow).links, undefined)
})

test('malformed optional links do not prevent importing otherwise valid templates', () => {
	const malformed = [null, false, 123, 'https://provider.example/', [], {}]
	const parsed = providerCatalogResponseSchema.parse({
		success: true,
		count: malformed.length,
		data: malformed.map((value, index) => ({
			...catalogRow,
			id: String(index),
			links: value,
		})),
	})
	assert.equal(parsed.data.length, malformed.length)
	assert.ok(parsed.data.every((row) => row.links === undefined))
})

test('unsafe higher-priority links are discarded and never copied into read DTOs', () => {
	for (const unsafe of [
		'javascript:alert(1)',
		'data:text/html,PRIVATE-CREDENTIAL',
		'http://provider.example/',
		'//provider.example/',
		'https:provider.example/',
		'https://user:PRIVATE-CREDENTIAL@provider.example/',
		'https://provider.example/?api_key=PRIVATE-CREDENTIAL',
		'https://provider.example/?access%5Ftoken=PRIVATE-CREDENTIAL',
		'https://provider.example/#access_token=PRIVATE-CREDENTIAL',
		'https://provider.example/#/console?token=PRIVATE-CREDENTIAL',
		'https://provider.example/#access_token%3DPRIVATE-CREDENTIAL',
		'https://provider.example/#/console%3Ftoken%3DPRIVATE-CREDENTIAL',
		'https://provider.example/\nPRIVATE-CREDENTIAL',
		'https://provider.example/\u202ePRIVATE-CREDENTIAL',
		'https://provider.example/\\PRIVATE-CREDENTIAL',
		'https://provider.example/' + 'x'.repeat(4096),
		42,
		{},
	]) {
		const safe = providerCatalogLinksSchema.parse({
			referral: unsafe,
			api_keys: links.api_keys,
		})
		assert.deepEqual(safe, { api_keys: links.api_keys })
		assert.deepEqual(resolveProviderCatalogOutbound(safe), {
			href: links.api_keys,
			kind: 'api_keys',
		})
		assert.equal(JSON.stringify(safe).includes('PRIVATE-CREDENTIAL'), false)
	}
})

test('outbound preference, query/hash routes and referral attribution match the legacy catalog', () => {
	assert.deepEqual(resolveProviderCatalogOutbound(links), {
		href: links.referral,
		kind: 'referral',
	})
	assert.deepEqual(
		resolveProviderCatalogOutbound({
			api_keys: links.api_keys,
			platform: links.platform,
		}),
		{ href: links.api_keys, kind: 'api_keys' }
	)
	assert.deepEqual(
		resolveProviderCatalogOutbound({ platform: '  ' + links.platform + '  ' }),
		{
			href: links.platform,
			kind: 'platform',
		}
	)
	assert.equal(
		resolveProviderCatalogOutbound({ referral: 'javascript:alert(1)' }),
		null
	)
	assert.equal(
		providerCatalogOutboundRel('referral'),
		'sponsored noopener noreferrer'
	)
	assert.equal(providerCatalogOutboundRel('api_keys'), 'noopener noreferrer')
	assert.equal(providerCatalogOutboundRel('platform'), 'noopener noreferrer')
})

async function render(
	locale: keyof typeof providerCatalogLinkMessages,
	element: ReactElement
): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		interpolation: { escapeValue: false },
		resources: {
			[locale]: {
				translation: {
					cinatoken: {
						adminProviders: {
							...providerMessages[locale],
							...providerCatalogLinkMessages[locale],
						},
					},
				},
			},
		},
	})
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element))
}

for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
	test(`catalog links expose translated actions and new-tab labels in ${locale}`, async () => {
		for (const [kind, key] of [
			['referral', 'catalogOpenReferral'],
			['api_keys', 'catalogOpenApiKeys'],
			['platform', 'catalogOpenPlatform'],
		] as const) {
			const html = await render(
				locale,
				createElement(ProviderCatalogOutboundLink, {
					providerName: 'Example <Provider>',
					links: { [kind]: links[kind] },
				})
			)
			assert.ok(html.includes(providerCatalogLinkMessages[locale][key]))
			assert.match(html, /aria-label="[^"]*Example &lt;Provider&gt;/u)
			assert.match(html, /target="_blank"/u)
			assert.match(html, /referrerPolicy="no-referrer"/u)
			assert.ok(html.includes(`rel="${providerCatalogOutboundRel(kind)}"`))
			assert.doesNotMatch(html, /cinatoken\.adminProviders|<Provider>/u)
		}
	})
}

test('missing or unsafe links render no interactive fallback', async () => {
	for (const value of [undefined, null, { platform: 'javascript:alert(1)' }])
		assert.equal(
			await render(
				'en',
				createElement(ProviderCatalogOutboundLink, {
					links: value,
					providerName: 'Example Provider',
				})
			),
			''
		)
})

test('import link is outside the checkbox label so opening it cannot select the template', async () => {
	const html = await render(
		'en',
		createElement(ProviderImportCatalogItem, {
			row: providerCatalogItemSchema.parse({ ...catalogRow, links }),
			selected: true,
			disabled: false,
			onSelected: () => undefined,
		})
	)
	const label = html.match(/<label\b[^>]*>([\s\S]*?)<\/label>/u)?.[1]
	assert.ok(label)
	assert.match(label, /type="checkbox"[^>]*checked=""/u)
	assert.match(label, /Example Provider/u)
	assert.doesNotMatch(label, /<a\b/u)
	assert.match(html, /<\/label><a\b/u)
	assert.ok(html.includes(links.referral))
})
