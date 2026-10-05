/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	adminGuardrailWriteRejected,
	adminGuardrailWriteUncertain,
} from './guardrails-errors'

test('known rejections are definitive; uncertain writes require explicit recovery', () => {
	for (const code of [404, 409]) {
		const error = { status: code }
		assert.equal(adminGuardrailWriteUncertain(error), false)
		assert.equal(adminGuardrailWriteRejected(error), true)
	}
	for (const error of [{ status: 503 }, { status: 0 }, { status: 401 }]) {
		assert.equal(adminGuardrailWriteRejected(error), false)
	}
	for (const status of [400, 401, 403, 404, 409, 413, 422]) {
		const error = new AdminDomainWriteError('rejected', status)
		assert.equal(adminGuardrailWriteRejected(error), true)
		assert.equal(adminGuardrailWriteUncertain(error), false)
	}
	assert.equal(
		adminGuardrailWriteUncertain(new AdminDomainWriteError('unknown', 200)),
		true
	)
	assert.equal(
		adminGuardrailWriteUncertain(new AdminDomainWriteError('storage')),
		true
	)
	assert.equal(
		adminGuardrailWriteUncertain(new AdminDomainWriteError('subject', 401)),
		false
	)
})
