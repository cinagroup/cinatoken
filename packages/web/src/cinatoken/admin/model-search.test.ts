/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateModelSearch } from './model-search'

test('Models URL filters survive direct navigation while malformed and private fields are ignored', () => {
	assert.deepEqual(
		validateModelSearch({
			q: '  diffusion ',
			vendor: 'vendor-one',
			kind: 'image',
			availability: 'callable',
			apiKey: 'never-a-search-filter',
		}),
		{
			q: '  diffusion ',
			vendor: 'vendor-one',
			kind: 'image',
			availability: 'callable',
		}
	)
	assert.deepEqual(
		validateModelSearch({
			q: ['invalid'],
			vendor: 'x'.repeat(201),
			kind: 'unknown',
			availability: 'verified',
		}),
		{ q: '', vendor: 'all', kind: 'all', availability: 'all' }
	)
	assert.deepEqual(validateModelSearch(null), {
		q: '',
		vendor: 'all',
		kind: 'all',
		availability: 'all',
	})
})

test('a complete model edit deep link retains the exact identity and independent filters', () => {
	assert.deepEqual(
		validateModelSearch({
			q: 'audio',
			vendor: 'all',
			kind: 'audio',
			availability: 'unrouted',
			edit: 'vendor/model/日本語',
		}),
		{
			q: 'audio',
			vendor: 'all',
			kind: 'audio',
			availability: 'unrouted',
			edit: 'vendor/model/日本語',
		}
	)
	for (const edit of [['a', 'b'], '', ' a', '..', 'a\n']) {
		const parsed = validateModelSearch({ q: 'kept', edit })
		assert.equal(parsed.edit, undefined)
		assert.equal(parsed.invalidEdit, true)
		assert.equal(parsed.q, 'kept')
	}
	assert.equal(validateModelSearch({ invalidEdit: 'true' }).invalidEdit, true)
})
