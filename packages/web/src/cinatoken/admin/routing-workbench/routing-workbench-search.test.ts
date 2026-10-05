/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateModelSearch } from '../model-search'
import { validateRouteFilters } from '../routes/route-domain'
import {
	consumeRoutingModelEdit,
	readRoutingWorkbenchSearch,
	serializeRoutingWorkbenchSearch,
	validateRoutingWorkbenchSearch,
} from './routing-workbench-search'

test('legacy bridge preserves duplicate input for Web validators instead of choosing a value', () => {
	const raw = readRoutingWorkbenchSearch('?model=a&model=b&provider_id=p')
	assert.deepEqual(raw.model, ['a', 'b'])
	const filters = validateRoutingWorkbenchSearch(raw, 'routes')
	assert.equal('invalid' in filters && filters.invalid, true)
	assert.equal('provider_id' in filters && filters.provider_id, 'p')
	assert.equal(
		validateModelSearch(readRoutingWorkbenchSearch('?edit=a&edit=b'))
			.invalidEdit,
		true
	)
})

test('old provider/group links become canonical and conflicts remain explicitly invalid', () => {
	const value = validateRouteFilters(
		readRoutingWorkbenchSearch(
			'?provider=p&group=speech&kind=audio&workspace=overview'
		)
	)
	const serialized = serializeRoutingWorkbenchSearch(value, 'routes')
	const params = new URLSearchParams(serialized)
	assert.equal(params.get('provider_id'), 'p')
	assert.equal(params.get('route_group'), 'speech')
	assert.equal(params.has('provider'), false)
	assert.equal(params.has('group'), false)
	assert.deepEqual(
		validateRouteFilters(readRoutingWorkbenchSearch(serialized)),
		value
	)
	const conflict = validateRouteFilters(
		readRoutingWorkbenchSearch('?provider=p&provider_id=q')
	)
	assert.equal(conflict.invalid, true)
	assert.equal(
		validateRouteFilters(
			readRoutingWorkbenchSearch(
				serializeRoutingWorkbenchSearch(conflict, 'routes')
			)
		).invalid,
		true
	)
})

test('valid literal all IDs and query text survive serialization while defaults are omitted', () => {
	for (const feature of [
		'providers',
		'models',
		'endpoints',
		'routes',
	] as const) {
		const value = validateRoutingWorkbenchSearch(
			{ q: 'all', model: 'all', provider_id: 'all' },
			feature
		)
		const encoded = serializeRoutingWorkbenchSearch(value, feature)
		assert.equal(new URLSearchParams(encoded).get('q'), 'all')
		assert.deepEqual(
			validateRoutingWorkbenchSearch(
				readRoutingWorkbenchSearch(encoded),
				feature
			),
			value
		)
		assert.equal(
			serializeRoutingWorkbenchSearch(
				validateRoutingWorkbenchSearch({}, feature),
				feature
			),
			''
		)
	}
})

test('consuming a Models edit link preserves filters, unrelated parameters and their duplicates', () => {
	const consumed = consumeRoutingModelEdit(
		'?edit=model%2Fa&invalidEdit=true&kind=audio&q=voice&extra=one&extra=two'
	)
	const params = new URLSearchParams(consumed)
	assert.equal(params.has('edit'), false)
	assert.equal(params.has('invalidEdit'), false)
	assert.equal(params.get('kind'), 'audio')
	assert.equal(params.get('q'), 'voice')
	assert.deepEqual(params.getAll('extra'), ['one', 'two'])
})
