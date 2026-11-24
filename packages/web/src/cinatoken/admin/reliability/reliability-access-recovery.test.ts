/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	ReliabilityAccessRecovery,
	reliabilityAccessIdentityKey,
} from './reliability-access-recovery'

test('403 locks each read domain once across Console epoch changes until explicit retry', () => {
	const access = new ReliabilityAccessRecovery()
	const first = reliabilityAccessIdentityKey(
		JSON.stringify(['user-1', 'subject-1', 1])
	)
	const rechecked = reliabilityAccessIdentityKey(
		JSON.stringify(['user-1', 'subject-1', 2])
	)
	assert.equal(first, rechecked)
	assert.equal(access.block(first, 'display'), true)
	assert.equal(access.block(rechecked, 'display'), false)
	assert.equal(access.getSnapshot(rechecked, 'display'), true)
	assert.equal(access.getSnapshot(rechecked, 'analytics'), false)
	assert.equal(access.block(first, 'analytics'), true)
	access.settle(first, 'display')
	assert.equal(access.getSnapshot(first, 'display'), false)
	assert.equal(access.getSnapshot(first, 'analytics'), true)
})

test('log denial is independent, remains blocked through epoch refresh and only explicit retry settles it', () => {
	const access = new ReliabilityAccessRecovery()
	const key = reliabilityAccessIdentityKey(JSON.stringify(['u', 'subject', 1]))
	const next = reliabilityAccessIdentityKey(JSON.stringify(['u', 'subject', 2]))
	assert.equal(access.block(key, 'logs'), true)
	assert.equal(access.block(next, 'logs'), false)
	assert.equal(access.getSnapshot(next, 'analytics'), false)
	assert.equal(access.getSnapshot(next, 'display'), false)
	access.block(key, 'analytics')
	access.settle(key, 'analytics')
	assert.equal(access.getSnapshot(next, 'logs'), true)
	access.settle(key, 'logs')
	assert.equal(access.getSnapshot(next, 'logs'), false)
	assert.equal(
		access.getSnapshot(
			reliabilityAccessIdentityKey(JSON.stringify(['u', 'different', 1])),
			'logs'
		),
		false
	)
})
