/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	emptyDataPolicyFilters,
	validateDataPolicySearch,
} from './data-policy-search'

test('accepts a typed status and strips control characters from search', () => {
	assert.deepEqual(
		validateDataPolicySearch({ q: '  Model\nA\u0000 ', status: 'expired' }),
		{
			q: 'ModelA',
			status: 'expired',
		}
	)
})

test('rejects malformed direct-link search parameters', () => {
	for (const value of [null, [], 'text', 10])
		assert.deepEqual(validateDataPolicySearch(value), emptyDataPolicyFilters)
	assert.deepEqual(
		validateDataPolicySearch({ q: {}, status: 'administrator' }),
		emptyDataPolicyFilters
	)
})

test('bounds long query strings', () => {
	assert.equal(validateDataPolicySearch({ q: 'x'.repeat(250) }).q.length, 200)
})
