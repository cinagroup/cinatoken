/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { userDetailSchema } from './user-detail-contracts'
import {
	buildFactorPatch,
	buildUserDetailPatches,
	createKeyMetadata,
	draftFromUser,
	routeMatchesUser,
	userDetailPath,
	userDetailRequestLogsUrl,
	userRouteIdentity,
} from './user-detail-domain'

const id = 'f2b74bc0-32f3-4613-aea7-96f723d08e12'
const user = userDetailSchema.parse({
	id,
	email: 'person@example.test',
	external_system: 'erp',
	external_user_id: 'abc/42',
	budget_max: null,
	budget_base: 0,
	budget_spent: 18.25,
	budget_period: 'monthly',
	budget_reset_at: '2026-10-01T00:00:00.000Z',
	status: 'active',
	metadata: { tier: 'pro' },
	charged_cost_factors: { 'vendor/model': 0.8 },
	created_at: '2026-09-28T00:00:00.000Z',
	updated_at: '2026-09-28T01:00:00.000Z',
	private_column: 'must-not-enter-state',
})

test('request history deep link uses immutable user ID across email changes', () => {
	assert.equal(
		userDetailRequestLogsUrl(id),
		`/admin/request-logs?user_id=${id}`
	)
	assert.throws(() => userDetailRequestLogsUrl('ext:erp/abc'))
})

test('UUID and encoded ext route IDs resolve the same user; malformed IDs fail closed', () => {
	assert.equal(userRouteIdentity(id)?.kind, 'uuid')
	const ext = 'ext:erp/abc%2F42'
	assert.deepEqual(userRouteIdentity(ext), {
		kind: 'external',
		system: 'erp',
		user: 'abc/42',
	})
	assert.equal(routeMatchesUser(ext, user), true)
	assert.equal(userDetailPath(ext), '/api/admin/users/ext%3Aerp%2Fabc%252F42')
	for (const bad of [
		'ext:erp/',
		'ext:/abc',
		'ext:erp/%GG',
		'../users',
		'ext:erp/a%0Ab',
	])
		assert.equal(userRouteIdentity(bad), null)
	assert.equal(JSON.stringify(user).includes('must-not-enter-state'), false)
})

test('profile-only patch never sends a budget field or resets spending', () => {
	const draft = draftFromUser(user)
	draft.email = 'new@example.test'
	draft.metadata = '{"tier":"plus"}'
	const patches = buildUserDetailPatches(user, draft)
	assert.deepEqual(patches.profile, {
		email: 'new@example.test',
		metadata_replace: '{"tier":"plus"}',
		reason: 'gwui:user-profile',
	})
	assert.equal(patches.budget, null)
	assert.equal(JSON.stringify(patches.profile).includes('budget_spent'), false)
})

test('budget patch preserves explicit null, zero, and reset intent', () => {
	const draft = draftFromUser(user)
	draft.budgetMax = '0'
	draft.budgetBase = '25'
	let patches = buildUserDetailPatches(user, draft)
	assert.deepEqual(patches.budget, {
		budget_max: 0,
		budget_base: 25,
		reset_budget: false,
		reason: 'gwui:user-plan',
	})
	draft.budgetMax = ''
	draft.budgetBase = '0'
	draft.resetBudget = true
	patches = buildUserDetailPatches(user, draft)
	assert.deepEqual(patches.budget, {
		reset_budget: true,
		reason: 'gwui:user-plan',
	})
	draft.resetBudget = false
	draft.budgetSpent = '0'
	patches = buildUserDetailPatches(user, draft)
	assert.deepEqual(patches.budget, {
		budget_spent: 0,
		reset_budget: false,
		reason: 'gwui:user-plan',
	})
})

test('invalid datetime and factors are rejected; factors do not alter budget', () => {
	const draft = draftFromUser(user)
	draft.budgetResetAt = '2026-10-02T12:30'
	assert.deepEqual(buildUserDetailPatches(user, draft).budget, {
		budget_reset_at: '2026-10-02T12:30:00Z',
		reset_budget: false,
		reason: 'gwui:user-plan',
	})
	draft.budgetResetAt = '2026-02-30T12:00:00'
	assert.throws(() => buildUserDetailPatches(user, draft))
	assert.deepEqual(
		buildFactorPatch(user.charged_cost_factors, [
			{ modelId: 'vendor/model', factor: '0.75' },
		]),
		{
			charged_cost_factors: { 'vendor/model': 0.75 },
			reason: 'gwui:charged-cost-factors',
		}
	)
	assert.throws(() => buildFactorPatch(null, [{ modelId: 'x', factor: '-1' }]))
	assert.throws(() =>
		buildFactorPatch(null, [
			{ modelId: 'x', factor: '1' },
			{ modelId: 'x', factor: '2' },
		])
	)
	assert.equal(createKeyMetadata('{"tag":"safe"}'), '{"tag":"safe"}')
	assert.throws(() => createKeyMetadata('[]'))
})
