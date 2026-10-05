/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	AdminConfigAccessRecovery,
	adminConfigAccessRecovery,
	configAccessIdentityKey,
} from './config-access-recovery'

test('one denied identity triggers one Console recheck across remounts until explicit successful read', () => {
	const api = {}
	const firstMount = adminConfigAccessRecovery(api)
	const firstKey = configAccessIdentityKey(
		JSON.stringify(['user:alice', 'cinaauth:alice', 1])
	)
	const afterPortalRevalidation = configAccessIdentityKey(
		JSON.stringify(['user:alice', 'cinaauth:alice', 2])
	)
	assert.equal(firstKey, afterPortalRevalidation)
	assert.notEqual(
		firstKey,
		configAccessIdentityKey(JSON.stringify(['user:bob', 'cinaauth:bob', 2]))
	)
	let checks = 0
	if (firstMount.block(firstKey)) checks++
	const secondMount = adminConfigAccessRecovery(api)
	assert.equal(secondMount, firstMount)
	assert.equal(secondMount.getSnapshot(afterPortalRevalidation), true)
	if (secondMount.block(afterPortalRevalidation)) checks++
	assert.equal(checks, 1)
	assert.equal(secondMount.getSnapshot('other-user:subject:epoch'), false)
	assert.equal(adminConfigAccessRecovery({}).getSnapshot(firstKey), false)
	secondMount.settle(firstKey)
	assert.equal(firstMount.getSnapshot(afterPortalRevalidation), false)
	assert.equal(firstMount.block(afterPortalRevalidation), true)
})

test('revoked identity memory is bounded and contains no configuration value', () => {
	const store = new AdminConfigAccessRecovery()
	let updates = 0
	const unsubscribe = store.subscribe(() => updates++)
	for (let index = 0; index <= store.maxScopes; index++)
		assert.equal(store.block(`identity:${index}`), true)
	assert.equal(store.getSnapshot('identity:0'), false)
	assert.equal(store.getSnapshot(`identity:${store.maxScopes}`), true)
	assert.equal(JSON.stringify(store).includes('BUSINESS_TIMEZONE'), false)
	store.settle(`identity:${store.maxScopes}`)
	assert.equal(updates, store.maxScopes + 2)
	unsubscribe()
})
