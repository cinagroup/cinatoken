/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { adminProviderSchema } from '../provider-contracts'
import { ProviderQuotaPanel } from './ProviderQuotaPanel'
import { ProviderSyncReview } from './ProviderSyncDialog'
import { providerMessages } from './messages'
import {
	providerSyncReportSchema,
	providerSyncItemsSchema,
	providerQuotaSchema,
} from './provider-compatibility'
import { providerFormDefaults, providerFormInput } from './provider-form'
import { formatProviderQuotaNumber } from './provider-quota-format'

const row = {
	id: 'provider-1',
	name: 'Account alias',
	kind: 'DeepSeek',
	vendor_key: 'deepseek',
	icon_key: 'deepseek',
	endpoints: '{"openai":{"base":"https://example.invalid"}}',
	api_key: '***',
	status: 'active',
	description: null,
	created_at: '2026-10-01T00:00:00Z',
	has_pending_key: false,
	routes_count: 2,
	active_routes_count: 1,
	quota_supported: true,
}
const choices = [
	{
		kind: 'DeepSeek',
		label_en: 'DeepSeek',
		label_zh: '深度求索',
		vendor_key: 'deepseek',
		icon_key: 'deepseek',
	},
]
const field = {
	key: 'endpoints.openai',
	protocol: 'openai',
	status: 'changed',
	default_apply: true,
	rows: [
		{
			slot: 'base',
			status: 'changed',
			current: 'https://user:PRIVATE@example.invalid/v1?api_key=PRIVATE',
			official: 'https://api.deepseek.com/v1',
		},
	],
}
const report = {
	groups: [
		{
			...choices[0],
			providers: [
				{
					provider_id: 'provider-1',
					provider_name: 'Account alias',
					status: 'active',
					routes_count: 2,
					active_routes_count: 1,
					fields: [field],
				},
			],
		},
	],
	kind_choices: choices,
	orphans: [],
	providers_with_diff: 1,
}

test('provider types, labels and quota support survive list projection without retaining raw secrets', () => {
	const parsed = adminProviderSchema.parse({
		...row,
		kind_labels: { en: 'DeepSeek', zh: '深度求索' },
		quota_supported: true,
		raw_key: 'PRIVATE',
	})
	assert.equal(parsed.kind, 'DeepSeek')
	assert.equal(parsed.quota_supported, true)
	assert.equal(JSON.stringify(parsed).includes('PRIVATE'), false)
	const draft = providerFormDefaults('clone', parsed)
	draft.api_key = 'new-secret'
	assert.equal(providerFormInput(draft).kind, 'DeepSeek')
	const edit = providerFormDefaults('edit', parsed)
	assert.equal(Object.hasOwn(providerFormInput(edit), 'kind'), false)
	edit.kind = '__custom__'
	assert.equal(providerFormInput(edit).kind, '__custom__')
})
test('provider reports redact endpoint credentials before caching and retain precise protocol replacements', () => {
	const parsed = providerSyncReportSchema.parse({
		...report,
		private_key: 'PRIVATE',
	})
	assert.equal(JSON.stringify(parsed).includes('PRIVATE'), false)
	const changed = parsed.groups[0]!.providers[0]!.fields[0]!
	assert.ok('rows' in changed)
	assert.equal(changed.rows[0]!.current, '[redacted]')
	assert.equal(changed.rows[0]!.official, 'https://api.deepseek.com/v1')
})

test('large valid descriptions remain reviewable without disabling all official type choices', () => {
	const large = {
		...report,
		groups: [
			{
				...report.groups[0],
				providers: [
					{
						...report.groups[0]!.providers[0],
						fields: [
							{
								key: 'description',
								status: 'changed',
								current: 'x'.repeat(20000),
								official: 'Updated',
								default_apply: true,
							},
						],
					},
				],
			},
		],
	}
	const parsed = providerSyncReportSchema.parse(large),
		field = parsed.groups[0]!.providers[0]!.fields[0]!
	assert.ok('current' in field)
	assert.equal(field.current?.length, 16385)
	assert.equal(field.current?.endsWith('…'), true)
	assert.equal(parsed.kind_choices.length, 1)
})
test('quota number formatting preserves small positive and negative nonzero values', () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'])
		for (const value of [0.0001, -0.0001, 0.0000000001, -0.0000000001]) {
			const formatted = formatProviderQuotaNumber(value, locale)
			assert.notEqual(formatted, '0')
			assert.notEqual(formatted, '-0')
			assert.match(formatted, /1/u)
		}
	assert.equal(formatProviderQuotaNumber(undefined, 'en'), '—')
	assert.equal(formatProviderQuotaNumber(0, 'en'), '0')
})
test('provider sync review renders prototype-named provider IDs without inherited selections', async () => {
	const i18n = createInstance()
	await i18n.init({
		lng: 'en',
		interpolation: { escapeValue: false },
		resources: {
			en: {
				translation: { cinatoken: { adminProviders: providerMessages.en } },
			},
		},
	})
	for (const id of ['constructor', '__proto__', 'toString']) {
		const parsed = providerSyncReportSchema.parse({
			...report,
			groups: [
				{
					...report.groups[0],
					providers: [{ ...report.groups[0]!.providers[0], provider_id: id }],
				},
			],
			orphans: [
				{
					provider_id: 'old-' + id,
					provider_name: 'Legacy',
					kind: 'Old',
					routes_count: 0,
					suggested_kind: 'DeepSeek',
				},
			],
		})
		const html = renderToStaticMarkup(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(ProviderSyncReview, {
					api: {} as never,
					queryPrefix: [],
					disabled: false,
					pending: false,
					error: null,
					result: null,
					migrated: false,
					onFresh: () => {},
					onApply: () => {},
					onMigrate: () => {},
					onClose: () => {},
					report: parsed,
				})
			)
		)
		assert.ok(html.includes('Account alias'))
		assert.ok(html.includes('Apply selected fields'))
		assert.equal(html.includes('aria-checked="true"'), false)
	}
})
test('provider reports reject false totals, duplicate identities, duplicate fields and mismatched protocol keys', () => {
	for (const changed of [
		{ ...report, providers_with_diff: 0 },
		{ ...report, groups: [...report.groups, ...report.groups] },
		{
			...report,
			orphans: [
				{
					provider_id: 'provider-1',
					provider_name: 'Other',
					kind: 'old',
					routes_count: 0,
					suggested_kind: null,
				},
			],
		},
		{
			...report,
			groups: [
				{
					...report.groups[0],
					providers: [
						{ ...report.groups[0]!.providers[0], fields: [field, field] },
					],
				},
			],
		},
		{
			...report,
			groups: [
				{
					...report.groups[0],
					providers: [
						{
							...report.groups[0]!.providers[0],
							fields: [{ ...field, protocol: 'gemini' }],
						},
					],
				},
			],
		},
	])
		assert.equal(providerSyncReportSchema.safeParse(changed).success, false)
})
test('provider sync payloads contain only selected catalog fields and reject implicit credentials, duplicates and empty batches', () => {
	assert.deepEqual(
		providerSyncItemsSchema.parse([
			{
				provider_id: 'provider-1',
				fields: ['description', 'endpoints.openai'],
			},
		]),
		[{ provider_id: 'provider-1', fields: ['description', 'endpoints.openai'] }]
	)
	for (const input of [
		[],
		[{ provider_id: 'p', fields: [] }],
		[{ provider_id: 'p', fields: ['api_key'] }],
		[{ provider_id: 'p', fields: ['description', 'description'] }],
		[{ provider_id: 'p', fields: ['description'], name: 'changed' }],
		[
			{ provider_id: 'p', fields: ['description'] },
			{ provider_id: 'p', fields: ['description'] },
		],
	])
		assert.equal(providerSyncItemsSchema.safeParse(input).success, false)
})
test('quota preserves original currencies, signed balances, window units and missing counters without fabricated zeros', () => {
	const parsed = providerQuotaSchema.parse({
		adapter: 'deepseek',
		checkedAt: '2026-10-18T10:00:00Z',
		state: 'exhausted',
		balances: [{ currency: 'CNY', total: -1.2, granted: 0 }],
		windows: [
			{ id: 'weekly', unit: 'tokens', remaining: -3, usedPercent: 105 },
		],
		raw_key: 'PRIVATE',
	})
	assert.equal(parsed.balances[0]!.currency, 'CNY')
	assert.equal(parsed.balances[0]!.total, -1.2)
	assert.equal(parsed.balances[0]!.paid, undefined)
	assert.equal(parsed.windows[0]!.used, undefined)
	assert.equal(JSON.stringify(parsed).includes('PRIVATE'), false)
	assert.equal(
		providerQuotaSchema.safeParse({
			...parsed,
			windows: [{ id: 'bad', unit: 'unknown' }],
		}).success,
		false
	)
	assert.equal(
		providerQuotaSchema.safeParse({
			...parsed,
			balances: [{ currency: 'USD', total: Infinity }],
		}).success,
		false
	)
})
test('quota remains an explicit disabled-capable action and explains native units in all four locales', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const i18n = createInstance()
		await i18n.init({
			lng: locale,
			interpolation: { escapeValue: false },
			resources: {
				[locale]: {
					translation: {
						cinatoken: { adminProviders: providerMessages[locale] },
					},
				},
			},
		})
		let queries = 0
		const html = renderToStaticMarkup(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(ProviderQuotaPanel, {
					api: {
						providerQuota: async () => {
							queries++
							throw new Error('No automatic query')
						},
					} as never,
					id: 'p',
					disabled: true,
				})
			)
		)
		assert.ok(html.includes(providerMessages[locale].quotaHint!))
		assert.ok(html.includes(providerMessages[locale].quotaQuery!))
		assert.match(html, /disabled=""/u)
		assert.equal(queries, 0)
	}
})
