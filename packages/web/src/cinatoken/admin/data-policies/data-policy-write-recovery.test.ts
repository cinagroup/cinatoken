/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DataPolicyWriteRecovery } from './data-policy-write-recovery'

test('a write remains locked until both authoritative reads succeed', async () => {
	const recovery = new DataPolicyWriteRecovery()
	recovery.mark('alice|subject|epoch', 'target-1')
	let listRead = false
	let auditRead = false
	assert.equal(
		await recovery.reconcile(
			'alice|subject|epoch',
			async (target) => {
				assert.equal(target, 'target-1')
				return listRead && auditRead
			},
			() => true
		),
		false
	)
	assert.equal(recovery.getSnapshot('alice|subject|epoch'), true)
	listRead = true
	auditRead = true
	assert.equal(
		await recovery.reconcile(
			'alice|subject|epoch',
			async () => listRead && auditRead,
			() => true
		),
		true
	)
	assert.equal(recovery.getSnapshot('alice|subject|epoch'), false)
})

test('late read cannot settle a different or unmounted identity', async () => {
	const recovery = new DataPolicyWriteRecovery()
	recovery.mark('alice', 'a-target')
	let current = false
	assert.equal(
		await recovery.reconcile(
			'alice',
			async () => true,
			() => current
		),
		false
	)
	assert.equal(recovery.getTarget('alice'), 'a-target')
	recovery.mark('bob', 'b-target')
	current = true
	assert.equal(recovery.getTarget('bob'), 'b-target')
	assert.equal(recovery.getTarget('alice'), 'a-target')
})
