/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	adminPresetAccessLost,
	adminPresetCanResumeMetadata,
	adminPresetErrorKey,
	adminPresetReadFailed,
	adminPresetWriteHintKey,
} from './preset-errors'

test('only actual uncoded field rejections qualify for metadata repair', () => {
	for (const status of [400, 413, 422])
		assert.equal(
			adminPresetCanResumeMetadata(
				new AdminDomainWriteError('rejected', status)
			),
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
			'invalid_console_subject_precondition'
		),
	])
		assert.equal(adminPresetCanResumeMetadata(error), false)
})

test('state conflicts require fresh reads and Console preconditions revoke old write authority', () => {
	for (const status of [401, 403, 404, 405, 409, 412, 428, 500, 0])
		assert.equal(
			adminPresetCanResumeMetadata(
				new AdminDomainWriteError('rejected', status)
			),
			false
		)
	assert.equal(
		adminPresetErrorKey(new AdminDomainWriteError('rejected', 409)),
		'cinatoken.adminPresets.conflict'
	)
	for (const status of [412, 428])
		assert.equal(
			adminPresetErrorKey(new AdminDomainWriteError('rejected', status)),
			'cinatoken.adminPresets.precondition'
		)
	for (const error of [
		new AdminDomainWriteError('subject', 400),
		new AdminDomainWriteError(
			'rejected',
			400,
			'invalid_console_subject_precondition'
		),
		new AdminDomainWriteError('rejected', 428, 'console_subject_required'),
	]) {
		assert.equal(adminPresetAccessLost(error), true)
		assert.equal(adminPresetReadFailed(error), true)
		assert.equal(adminPresetCanResumeMetadata(error), false)
		assert.equal(
			adminPresetErrorKey(error),
			'cinatoken.adminPresets.accessDenied'
		)
	}
	assert.equal(
		adminPresetReadFailed(new AdminDomainWriteError('rejected', 404)),
		false
	)
})

test('write feedback preserves truthful rejection, unknown, storage and subject categories', () => {
	assert.equal(
		adminPresetWriteHintKey(new AdminDomainWriteError('rejected', 400)),
		'cinatoken.adminPresets.writeRejected'
	)
	assert.equal(
		adminPresetWriteHintKey(new AdminDomainWriteError('unknown', 502)),
		'cinatoken.adminPresets.writeUnknown'
	)
	assert.equal(
		adminPresetErrorKey(new AdminDomainWriteError('storage')),
		'cinatoken.adminDomain.storageUnavailable'
	)
	assert.equal(
		adminPresetErrorKey(new AdminDomainWriteError('rejected', 422)),
		'cinatoken.adminPresets.invalidInput'
	)
	for (const error of [
		new AdminDomainWriteError('subject'),
		new AdminDomainWriteError('rejected', 403),
		new AdminDomainWriteError(
			'rejected',
			400,
			'invalid_console_subject_precondition'
		),
		{ status: 400 },
	])
		assert.equal(adminPresetWriteHintKey(error), null)
})
