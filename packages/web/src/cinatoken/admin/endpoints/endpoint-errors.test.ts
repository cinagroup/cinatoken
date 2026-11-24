/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	endpointCanResumeEditor,
	endpointErrorKey,
	endpointWriteHintKey,
} from './endpoint-errors'

const prefix = 'cinatoken.adminEndpoints.'

test('only actual field rejections permit draft repair; status-shaped errors never authorize it', () => {
	for (const creating of [false, true]) {
		for (const status of [400, 413, 422])
			assert.equal(
				endpointCanResumeEditor(
					new AdminDomainWriteError('rejected', status),
					creating
				),
				true
			)
		for (const error of [
			{ code: 'rejected', status: 400 },
			new AdminDomainWriteError('unknown', 400),
			new AdminDomainWriteError('storage', 400),
			new AdminDomainWriteError('subject', 400),
			new AdminDomainWriteError(
				'rejected',
				400,
				'invalid_console_subject_precondition'
			),
			new AdminDomainWriteError('rejected', 400, 'invalid_admin_resource_id'),
			new Error('Rejected'),
			null,
		])
			assert.equal(endpointCanResumeEditor(error, creating), false)
	}
})

test('duplicate new endpoint can be corrected, while stale endpoint/publication and precondition failures require fresh review', () => {
	assert.equal(
		endpointCanResumeEditor(new AdminDomainWriteError('rejected', 409), true),
		true
	)
	assert.equal(
		endpointCanResumeEditor(new AdminDomainWriteError('rejected', 409), false),
		false
	)
	for (const status of [401, 403, 404, 405, 412, 428, 500, 0])
		for (const creating of [false, true])
			assert.equal(
				endpointCanResumeEditor(
					new AdminDomainWriteError('rejected', status),
					creating
				),
				false
			)
})

test('write guidance distinguishes rejection, unknown outcome, access and unavailable recovery storage', () => {
	assert.equal(
		endpointWriteHintKey(new AdminDomainWriteError('rejected', 409)),
		prefix + 'writeRejected'
	)
	assert.equal(
		endpointWriteHintKey(new AdminDomainWriteError('unknown', 502)),
		prefix + 'writeUnknown'
	)
	for (const error of [
		new AdminDomainWriteError('storage'),
		new AdminDomainWriteError('subject', 401),
		new AdminDomainWriteError('rejected', 403),
		{ status: 409 },
	])
		assert.equal(endpointWriteHintKey(error), null)
	assert.equal(
		endpointErrorKey(new AdminDomainWriteError('storage')),
		'cinatoken.adminDomain.storageUnavailable'
	)
	assert.equal(
		endpointErrorKey(new AdminDomainWriteError('subject')),
		prefix + 'accessDenied'
	)
	assert.equal(
		endpointErrorKey(new AdminDomainWriteError('rejected', 422)),
		prefix + 'invalidInput'
	)
})
