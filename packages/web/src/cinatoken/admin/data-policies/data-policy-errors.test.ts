/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	dataPolicyAccessDenied,
	dataPolicyCanResumeEditor,
	dataPolicyErrorKey,
	dataPolicyWriteUncertain,
	dataPolicyWriteHintKey,
} from './data-policy-errors'
import { DataPolicyFormError } from './data-policy-form'

test('only unknown HTTP write outcomes need authority reconciliation', () => {
	for (const status of [0, 404, 409, 500, 503])
		assert.equal(dataPolicyWriteUncertain({ status }), true)
	for (const status of [400, 401, 403, 413])
		assert.equal(dataPolicyWriteUncertain({ status }), false)
	assert.equal(
		dataPolicyWriteUncertain(new DataPolicyFormError('retention')),
		false
	)
})

test('permission errors demand explicit verification and never expose server text', () => {
	assert.equal(dataPolicyAccessDenied({ status: 403 }), true)
	assert.equal(
		dataPolicyErrorKey({ status: 403, message: 'private credential' }),
		'cinatoken.adminDataPolicies.accessDenied'
	)
})

test('only actual uncoded field rejections qualify for explicit draft repair', () => {
	for (const status of [400, 413, 422])
		assert.equal(
			dataPolicyCanResumeEditor(new AdminDomainWriteError('rejected', status)),
			true
		)
	for (const error of [
		{ code: 'rejected', status: 400 },
		new AdminDomainWriteError('unknown', 400),
		new AdminDomainWriteError('storage'),
		new AdminDomainWriteError('subject', 400),
		new AdminDomainWriteError(
			'rejected',
			400,
			'invalid_data_policy_precondition'
		),
		new AdminDomainWriteError(
			'rejected',
			400,
			'invalid_console_subject_precondition'
		),
		new DataPolicyFormError('evidence'),
	])
		assert.equal(dataPolicyCanResumeEditor(error), false)
})

test('policy version conflicts and preconditions require a new explicit read', () => {
	for (const status of [401, 403, 404, 405, 409, 412, 428, 500, 0])
		assert.equal(
			dataPolicyCanResumeEditor(new AdminDomainWriteError('rejected', status)),
			false
		)
	for (const [status, code, key] of [
		[400, 'invalid_data_policy_precondition', 'precondition'],
		[428, 'data_policy_precondition_required', 'precondition'],
		[409, 'route_data_policy_write_conflict', 'conflict'],
	] as const) {
		const error = new AdminDomainWriteError('rejected', status, code)
		assert.equal(dataPolicyCanResumeEditor(error), false)
		assert.equal(
			dataPolicyErrorKey(error),
			'cinatoken.adminDataPolicies.' + key
		)
		assert.equal(dataPolicyWriteUncertain(error), false)
	}
})

test('feedback distinguishes rejection, unknown result, storage failure and subject changes', () => {
	assert.equal(
		dataPolicyWriteHintKey(new AdminDomainWriteError('rejected', 409)),
		'cinatoken.adminDataPolicies.writeRejected'
	)
	assert.equal(
		dataPolicyWriteHintKey(new AdminDomainWriteError('unknown', 502)),
		'cinatoken.adminDataPolicies.writeUnknown'
	)
	for (const error of [
		new AdminDomainWriteError('storage'),
		new AdminDomainWriteError('subject'),
		new AdminDomainWriteError('rejected', 403),
		{ status: 400 },
	])
		assert.equal(dataPolicyWriteHintKey(error), null)
	assert.equal(
		dataPolicyErrorKey(new AdminDomainWriteError('storage')),
		'cinatoken.adminDomain.storageUnavailable'
	)
	assert.equal(
		dataPolicyErrorKey(new AdminDomainWriteError('subject', 400)),
		'cinatoken.adminDataPolicies.accessDenied'
	)
	assert.equal(
		dataPolicyErrorKey(new AdminDomainWriteError('rejected', 422)),
		'cinatoken.adminDataPolicies.invalidInput'
	)
})
