/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	emptyUserCreateDraft,
	normalizeUserCreate,
	UserInputError,
} from './users-input'

test('create validates external pair, money precision and JSON before sending', () => {
	const valid = {
		...emptyUserCreateDraft,
		email: ' Person@example.test ',
		externalSystem: 'erp',
		externalUserId: '42',
		budgetMax: '10.123456',
		budgetPeriod: 'daily' as const,
		metadata: '{"plan_id":"team"}',
	}
	assert.deepEqual(normalizeUserCreate(valid), {
		email: 'Person@example.test',
		external_system: 'erp',
		external_user_id: '42',
		budget_max: 10.123456,
		budget_period: 'daily',
		metadata: { plan_id: 'team' },
	})
	for (const draft of [
		{ ...valid, externalUserId: '' },
		{ ...valid, email: 'not-an-email' },
		{ ...valid, budgetMax: '10.1234567' },
		{ ...valid, budgetBase: '-1' },
		{ ...valid, metadata: '[]' },
	])
		assert.throws(() => normalizeUserCreate(draft), UserInputError)
})

test('initial wallet values preserve explicit zero and use defaults only for empty fields', () => {
	const draft = {
		...emptyUserCreateDraft,
		email: 'person@example.test',
		walletGranted: '5.123456',
		walletSpent: '0',
	}
	const result = normalizeUserCreate(draft)
	assert.equal(result.wallet_granted, 5.123456)
	assert.equal(result.wallet_spent, 0)
	const legacy = normalizeUserCreate({
		...draft,
		walletGranted: '',
		walletSpent: '',
	})
	assert.equal(Object.hasOwn(legacy, 'wallet_granted'), false)
	assert.equal(Object.hasOwn(legacy, 'wallet_spent'), false)
	for (const invalid of ['-1', '1.0000001', 'NaN'])
		assert.throws(() =>
			normalizeUserCreate({ ...draft, walletGranted: invalid })
		)
})
