/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { adminModelAnalyticsMessages } from '../models/messages'
import type {
	AnalyticsProviderDirectory,
	AnalyticsProviderEntry,
} from './analytics-provider-directory'
import { analyticsDirectoryMessages } from './directory-messages'
import { adminProviderAnalyticsMessages } from './messages'
import {
	filterProviderDimensions,
	providerDimension,
	providerKindFilterBlocked,
	type ProviderDimension,
	type ProviderDimensionLabels,
} from './provider-dimensions'

const labels: ProviderDimensionLabels = {
	unclassified: 'Unclassified',
	custom: 'Custom',
	unknown: 'Unknown type',
	unavailable: 'Type unavailable',
	rest: 'Gateway REST tools',
	mcp: 'Gateway MCP',
}
function directory(
	entries: readonly AnalyticsProviderEntry[] = []
): AnalyticsProviderDirectory {
	return {
		status: 'ready',
		providers: new Map(entries.map((entry) => [entry.id, entry])),
	}
}
function classify(
	entry: AnalyticsProviderEntry,
	locale = 'en'
): ProviderDimension {
	return providerDimension(entry.id, directory([entry]), locale, labels)
}

test('REST and MCP virtual IDs remain identifiable independently of directory state', () => {
	for (const state of [
		{ status: 'loading' },
		{ status: 'unavailable' },
		directory([
			{ id: 'octafuse-tools', name: 'Misleading name', kind: 'different' },
			{ id: 'octafuse-mcp', name: 'Misleading name', kind: 'different' },
		]),
	] satisfies AnalyticsProviderDirectory[]) {
		assert.deepEqual(providerDimension('octafuse-tools', state, 'en', labels), {
			key: 'virtual:rest',
			kind: 'gateway-tools',
			label: labels.rest,
			status: 'virtual',
		})
		assert.deepEqual(providerDimension('octafuse-mcp', state, 'en', labels), {
			key: 'virtual:mcp',
			kind: 'gateway-mcp',
			label: labels.mcp,
			status: 'virtual',
		})
	}
	assert.equal(
		providerDimension('octafuse-tools-extra', directory(), 'en', labels).status,
		'missing'
	)
	assert.equal(
		classify({ id: 'account', name: 'Gateway tools', kind: 'gateway-tools' })
			.key,
		'kind:gateway-tools'
	)
})

test('unavailable directories do not imply missing accounts; a complete empty directory does', () => {
	for (const status of ['loading', 'unavailable'] as const)
		assert.deepEqual(
			providerDimension('old-account', { status }, 'en', labels),
			{
				key: 'unavailable',
				kind: null,
				label: labels.unavailable,
				status: 'unavailable',
			}
		)
	assert.deepEqual(
		providerDimension('old-account', directory(), 'en', labels),
		{ key: 'missing', kind: null, label: labels.unknown, status: 'missing' }
	)
})

test('missing or blank kinds are unclassified without guessing from account names', () => {
	for (const kind of [undefined, '', ' \t ']) {
		assert.deepEqual(
			classify({
				id: 'account',
				name: 'OpenAI',
				kind,
				kind_labels: { en: 'OpenAI', zh: 'OpenAI' },
			}),
			{ key: 'kind:', kind: '', label: labels.unclassified, status: 'current' }
		)
	}
	assert.deepEqual(
		classify({
			id: 'account',
			name: 'OpenAI',
			kind: ' __custom__ ',
			kind_labels: { en: 'Pretend system type', zh: '伪装类型' },
		}),
		{
			key: 'kind:__custom__',
			kind: '__custom__',
			label: labels.custom,
			status: 'current',
		}
	)
})

test('kind keys preserve case and identity after trimming independently of translated labels', () => {
	const first = classify({
		id: 'one',
		name: 'same',
		kind: ' Azure ',
		kind_labels: { en: 'Shared label', zh: '相同名称' },
	})
	const second = classify({
		id: 'two',
		name: 'same',
		kind: 'azure',
		kind_labels: { en: 'Shared label', zh: '相同名称' },
	})
	assert.equal(first.kind, 'Azure')
	assert.equal(first.key, 'kind:Azure')
	assert.equal(first.label, second.label)
	assert.notEqual(first.key, second.key)
	assert.equal(
		classify({ id: 'one', name: 'OpenAI', kind: '__CUSTOM__' }).label,
		'__CUSTOM__'
	)
})

test('Chinese locales prefer trimmed zh labels and other locales prefer en with other-language and kind fallbacks', () => {
	const entry = {
		id: 'one',
		name: 'Name',
		kind: ' Vendor Kind ',
		kind_labels: { en: ' English ', zh: ' 中文 ' },
	}
	for (const locale of ['zh', 'zh-CN', 'ZH-hant'])
		assert.equal(classify(entry, locale).label, '中文')
	for (const locale of ['en', 'ja', 'ko'])
		assert.equal(classify(entry, locale).label, 'English')
	assert.equal(
		classify({ ...entry, kind_labels: { en: ' English ', zh: ' \t ' } }, 'zh')
			.label,
		'English'
	)
	assert.equal(
		classify({ ...entry, kind_labels: { en: ' ', zh: ' 中文 ' } }, 'ko').label,
		'中文'
	)
	assert.equal(
		classify({ ...entry, kind_labels: { en: ' ', zh: '\t' } }).label,
		'Vendor Kind'
	)
	assert.equal(
		classify({ ...entry, kind_labels: undefined }).label,
		'Vendor Kind'
	)
})

test('unverified nonvirtual filters remain blocked while all and the two known virtual filters stay usable', () => {
	for (const status of ['loading', 'unavailable'] as const) {
		for (const key of ['', 'virtual:rest', 'virtual:mcp'])
			assert.equal(providerKindFilterBlocked(key, { status }), false)
		for (const key of [
			'kind:',
			'kind:__custom__',
			'kind:OpenAI',
			'missing',
			'unavailable',
			'virtual:unknown',
		])
			assert.equal(providerKindFilterBlocked(key, { status }), true)
	}
	for (const key of ['', 'kind:', 'missing', 'kind:OpenAI'])
		assert.equal(providerKindFilterBlocked(key, directory()), false)
})

test('provider filtering intersects exact type keys with trimmed case-insensitive ID, name or available label search', () => {
	const ready = directory([
		{
			id: 'account-a',
			name: 'A',
			kind: 'type-a',
			kind_labels: { en: 'Cloud platform', zh: '云平台' },
		},
		{
			id: 'account-b',
			name: 'B',
			kind: 'type-b',
			kind_labels: { en: 'Other platform', zh: '另一平台' },
		},
	])
	const rows = [
		{ provider_id: 'account-a', provider_name: 'Alpha', requests: 1 },
		{ provider_id: 'account-b', provider_name: null, requests: 2 },
		{
			provider_id: 'octafuse-tools',
			provider_name: 'REST gateway',
			requests: 3,
		},
	]
	const dimensions = new Map(
		rows.map((row) => [
			row.provider_id,
			providerDimension(row.provider_id, ready, 'en', labels),
		])
	)
	assert.deepEqual(filterProviderDimensions(rows, ' ALPHA ', '', dimensions), [
		rows[0],
	])
	assert.deepEqual(
		filterProviderDimensions(rows, ' ACCOUNT-B ', '', dimensions),
		[rows[1]]
	)
	assert.deepEqual(
		filterProviderDimensions(rows, ' cloud ', 'kind:type-a', dimensions),
		[rows[0]]
	)
	assert.deepEqual(
		filterProviderDimensions(rows, ' cloud ', 'kind:type-b', dimensions),
		[]
	)
	assert.deepEqual(
		filterProviderDimensions(rows, ' tools ', 'virtual:rest', dimensions),
		[rows[2]]
	)
	assert.deepEqual(
		filterProviderDimensions(rows, '', 'kind:TYPE-A', dimensions),
		[]
	)
	assert.deepEqual(filterProviderDimensions(rows, 'type-a', '', dimensions), [])
})

test('unknown and unavailable placeholder labels are not searchable provider types and absent dimensions retain ID search', () => {
	const rows = [
		{ provider_id: 'old-account', provider_name: null },
		{ provider_id: 'live-account', provider_name: 'Actual name' },
	]
	const dimensions = new Map([
		[
			'old-account',
			providerDimension('old-account', directory(), 'en', labels),
		],
		[
			'live-account',
			providerDimension(
				'live-account',
				{ status: 'unavailable' },
				'en',
				labels
			),
		],
	])
	assert.deepEqual(
		filterProviderDimensions(rows, 'unknown', '', dimensions),
		[]
	)
	assert.deepEqual(
		filterProviderDimensions(rows, 'unavailable', '', dimensions),
		[]
	)
	assert.deepEqual(filterProviderDimensions(rows, '', 'missing', dimensions), [
		rows[0],
	])
	assert.deepEqual(filterProviderDimensions(rows, 'actual', '', dimensions), [
		rows[1],
	])
	assert.deepEqual(
		filterProviderDimensions(rows, 'old-account', '', new Map()),
		[rows[0]]
	)
	assert.deepEqual(filterProviderDimensions(rows, '', 'missing', new Map()), [])
})

test('classification and filtering leave readonly inputs unchanged and preserve original row order and references', () => {
	const entry = Object.freeze({
		id: 'one',
		name: 'Name',
		kind: ' Kind ',
		kind_labels: Object.freeze({ en: ' Label ', zh: ' 名称 ' }),
	})
	const ready = directory([entry])
	const before = structuredClone(entry)
	const dimension = providerDimension(entry.id, ready, 'en', labels)
	assert.deepEqual(entry, before)
	const rows = Object.freeze([
		Object.freeze({ provider_id: 'one', provider_name: 'First' }),
		Object.freeze({ provider_id: 'two', provider_name: 'Second' }),
	])
	const dimensions = new Map([[entry.id, Object.freeze(dimension)]])
	const filtered = filterProviderDimensions(rows, ' ', '', dimensions)
	assert.deepEqual(filtered, rows)
	assert.notEqual(filtered, rows)
	assert.equal(filtered[0], rows[0])
	assert.equal(filtered[1], rows[1])
	assert.equal(dimensions.size, 1)
	assert.equal(dimension.kind, 'Kind')
})

test('all four locales expose all directory keys through both analytics message namespaces', () => {
	const keys = [
		'provider_kind',
		'directoryTitle',
		'directoryLoading',
		'directoryUnavailable',
		'directoryReady',
		'directoryRetry',
		'directoryAllKinds',
		'directoryClearKind',
		'directorySelectedUnavailable',
		'directoryFilterBlocked',
		'directoryHint',
		'directoryMissing',
		'directoryVirtual',
		'kindUnclassified',
		'kindCustom',
		'kindUnknown',
		'kindUnavailable',
		'kindRest',
		'kindMcp',
	] as const
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const messages = analyticsDirectoryMessages[locale]
		assert.deepEqual(Object.keys(messages).sort(), [...keys].sort())
		for (const key of keys) {
			assert.ok(messages[key].trim().length > 0, `${locale}/${key}`)
			assert.equal(adminModelAnalyticsMessages[locale][key], messages[key])
			assert.equal(adminProviderAnalyticsMessages[locale][key], messages[key])
			assert.doesNotMatch(messages[key], /cinatoken\.admin|\{\{/)
		}
	}
})
