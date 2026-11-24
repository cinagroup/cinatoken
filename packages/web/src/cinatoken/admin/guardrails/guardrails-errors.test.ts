/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	adminGuardrailAccessLost,
	adminGuardrailCanResumeBinding,
	adminGuardrailErrorKey,
	adminGuardrailReadFailed,
	adminGuardrailWriteHintKey,
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

test('binding repair requires an actual uncoded definitive field rejection', () => {
	for (const status of [400, 413, 422])
		assert.equal(
			adminGuardrailCanResumeBinding(
				new AdminDomainWriteError('rejected', status)
			),
			true
		)
	for (const status of [401, 403, 404, 405, 409, 412, 428, 500])
		assert.equal(
			adminGuardrailCanResumeBinding(
				new AdminDomainWriteError('rejected', status)
			),
			false
		)
	for (const error of [
		null,
		{ status: 400, code: 'rejected', serverCode: null },
		new AdminDomainWriteError('unknown', 400),
		new AdminDomainWriteError('storage'),
		new AdminDomainWriteError('subject', 400),
		new AdminDomainWriteError('rejected', 400, 'invalid_admin_resource_id'),
	])
		assert.equal(adminGuardrailCanResumeBinding(error), false)
})

test('read failures distinguish a nonfatal missing detail from invalid data and Console loss', () => {
	assert.equal(adminGuardrailReadFailed({ status: 404 }), false)
	assert.equal(adminGuardrailReadFailed({ status: 503 }), true)
	assert.equal(
		adminGuardrailReadFailed({ status: 200, code: 'invalid-response' }),
		true
	)
	assert.equal(
		adminGuardrailAccessLost({ status: 200, code: 'invalid-response' }),
		false
	)
	for (const code of [
		'invalid_console_subject_precondition',
		'console_subject_required',
		'console_subject_mismatch',
	]) {
		const error = new AdminDomainWriteError('rejected', 400, code)
		assert.equal(adminGuardrailReadFailed(error), true)
		assert.equal(adminGuardrailAccessLost(error), true)
		assert.equal(adminGuardrailCanResumeBinding(error), false)
		assert.equal(
			adminGuardrailErrorKey(error),
			'cinatoken.adminGuardrails.accessDenied'
		)
		assert.equal(adminGuardrailWriteHintKey(error), null)
	}
})

test('failure feedback separates field rejection, preconditions, unknown and storage results', () => {
	assert.equal(
		adminGuardrailErrorKey(new AdminDomainWriteError('rejected', 422)),
		'cinatoken.adminGuardrails.invalidInput'
	)
	for (const status of [412, 428])
		assert.equal(
			adminGuardrailErrorKey(new AdminDomainWriteError('rejected', status)),
			'cinatoken.adminGuardrails.precondition'
		)
	assert.equal(
		adminGuardrailErrorKey(
			new AdminDomainWriteError('rejected', 400, 'invalid_admin_resource_id')
		),
		'cinatoken.adminGuardrails.precondition'
	)
	assert.equal(
		adminGuardrailErrorKey(new AdminDomainWriteError('storage')),
		'cinatoken.adminDomain.storageUnavailable'
	)
	assert.equal(
		adminGuardrailWriteHintKey(new AdminDomainWriteError('unknown', 200)),
		'cinatoken.adminGuardrails.writeUnknown'
	)
	assert.equal(
		adminGuardrailWriteHintKey(new AdminDomainWriteError('rejected', 409)),
		'cinatoken.adminGuardrails.writeRejected'
	)
	assert.equal(adminGuardrailWriteHintKey({ status: 409 }), null)
	assert.equal(
		adminGuardrailWriteHintKey(new AdminDomainWriteError('storage')),
		null
	)
})
