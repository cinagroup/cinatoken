/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { modelSyncReportSchema, modelSyncItemsSchema } from '../model-contracts'
import {
	filterModelSyncGroups,
	modelSyncSelectionKey,
	selectedModelSyncItems,
	selectModelSyncMetadata,
} from './model-sync-domain'
import { modelSyncFixture } from './model-sync-fixtures'

test('grouped diff validates scalar additions and complete pricing replacements including removals', () => {
	const report = modelSyncReportSchema.parse(modelSyncFixture)
	assert.equal(report.groups.length, 2)
	assert.equal(report.models_with_diff, 3)
	const pricing = report.groups[0]!.models[0]!.fields.find(
		(field) => field.key === 'pricing_profile'
	)
	assert.equal(pricing?.default_apply, false)
	assert.ok(
		pricing &&
			'rows' in pricing &&
			pricing.rows.some((row) => row.status === 'removed')
	)
	assert.deepEqual(selectedModelSyncItems(report, []), [])
})

test('diff rejects identity, counts, field and pricing-path ambiguity rather than merging reports', () => {
	const mutations = [
		(value: typeof modelSyncFixture) => {
			value.models_with_diff = 99
		},
		(value: typeof modelSyncFixture) => {
			value.groups[0]!.models[1]!.model_id = 'openai/text'
		},
		(value: typeof modelSyncFixture) => {
			value.groups[1]!.vendor = 'openai'
		},
		(value: typeof modelSyncFixture) => {
			value.groups[0]!.models[0]!.active_routes_count = 3
		},
		(value: typeof modelSyncFixture) => {
			value.groups[0]!.models[0]!.fields.push(
				value.groups[0]!.models[0]!.fields[0]!
			)
		},
		(value: typeof modelSyncFixture) => {
			const field = value.groups[0]!.models[0]!.fields[2]!
			if (field.key === 'pricing_profile') field.rows.push(field.rows[0]!)
		},
	]
	for (const mutate of mutations) {
		const report = structuredClone(modelSyncFixture)
		mutate(report)
		assert.equal(modelSyncReportSchema.safeParse(report).success, false)
	}
	assert.equal(
		modelSyncReportSchema.safeParse({
			...modelSyncFixture,
			billing_currency: 'EUR',
		}).success,
		false
	)
	assert.equal(
		modelSyncReportSchema.safeParse({
			...modelSyncFixture,
			groups: [],
			models_with_diff: 0,
		}).success,
		true
	)
})

test('visible metadata selection excludes prices, preserves hidden choices and only applies explicitly selected fields', () => {
	const groups = filterModelSyncGroups(modelSyncFixture, {
		search: 'TEXT',
		vendor: 'openai',
		kind: 'llm',
	})
	assert.deepEqual(
		groups.flatMap((group) => group.models.map((model) => model.model_id)),
		['openai/text']
	)
	const previous = [modelSyncSelectionKey('alibaba/speech', 'vendor')]
	const selected = selectModelSyncMetadata(groups, previous)
	assert.deepEqual(selectedModelSyncItems(modelSyncFixture, selected), [
		{ model_id: 'openai/text', fields: ['display_name', 'description'] },
		{ model_id: 'alibaba/speech', fields: ['vendor'] },
	])
	assert.deepEqual(previous, [
		modelSyncSelectionKey('alibaba/speech', 'vendor'),
	])
	assert.equal(
		selected.some((key) => key.includes('pricing_profile')),
		false
	)
	assert.deepEqual(
		selectedModelSyncItems(modelSyncFixture, [
			modelSyncSelectionKey('openai/text', 'pricing_profile'),
		]),
		[{ model_id: 'openai/text', fields: ['pricing_profile'] }]
	)
	assert.equal(
		filterModelSyncGroups(modelSyncFixture, {
			search: '',
			vendor: 'other',
			kind: 'all',
		}).length,
		0
	)
})

test('selection rejects unknown, stale, repeated and unsupported fields before dispatch', () => {
	for (const selection of [
		[modelSyncSelectionKey('missing/model', 'description')],
		[modelSyncSelectionKey('openai/image', 'description')],
		['["openai/text","route_policy"]'],
		[
			modelSyncSelectionKey('openai/text', 'display_name'),
			modelSyncSelectionKey('openai/text', 'display_name'),
		],
	])
		assert.throws(() => selectedModelSyncItems(modelSyncFixture, selection))
	for (const items of [
		[],
		[{ model_id: 'x', fields: [] }],
		[{ model_id: 'x', fields: ['metadata'] }],
		[{ model_id: 'x', fields: ['vendor', 'vendor'] }],
		[
			{ model_id: 'x', fields: ['vendor'] },
			{ model_id: 'x', fields: ['description'] },
		],
	]) {
		assert.equal(modelSyncItemsSchema.safeParse(items).success, false)
	}
})

test('prototype member model IDs remain ordinary independent selectable identities', () => {
	const report = structuredClone(modelSyncFixture)
	report.groups[0]!.models[0]!.model_id = 'constructor'
	report.groups[0]!.models[1]!.model_id = '__proto__'
	assert.equal(modelSyncReportSchema.safeParse(report).success, true)
	const selection = [
		modelSyncSelectionKey('constructor', 'display_name'),
		modelSyncSelectionKey('__proto__', 'max_tokens'),
	]
	assert.deepEqual(selectedModelSyncItems(report, selection), [
		{ model_id: 'constructor', fields: ['display_name'] },
		{ model_id: '__proto__', fields: ['max_tokens'] },
	])
	assert.deepEqual(selectedModelSyncItems(report, selection.slice(1)), [
		{ model_id: '__proto__', fields: ['max_tokens'] },
	])
})
