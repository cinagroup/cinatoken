/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError } from '../../api'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	RouteInputError,
	routeCanResumeEditor,
	routeErrorKey,
	routeUnknownWrite,
	routeWriteHintKey,
} from './route-errors'

test('preflight policy errors release the write lock, while uncertain network/server outcomes retain it', () => {
	assert.equal(
		routeUnknownWrite(new RouteInputError('invalid model policy')),
		false
	)
	assert.equal(
		routeUnknownWrite(new CinaTokenApiError('failed', 400, 'http')),
		false
	)
	assert.equal(
		routeUnknownWrite(new CinaTokenApiError('failed', 409, 'http')),
		true
	)
	assert.equal(
		routeUnknownWrite(new CinaTokenApiError('failed', 503, 'http')),
		true
	)
	assert.equal(
		routeUnknownWrite(new CinaTokenApiError('failed', 0, 'network')),
		true
	)
})

test('only actual field rejections permit inline repair, never status-shaped errors or uncertain writes', () => {
	for (const status of [400, 413, 422])
		assert.equal(
			routeCanResumeEditor(new AdminDomainWriteError('rejected', status)),
			true
		)
	for (const error of [
		{ code: 'rejected', status: 400 },
		new AdminDomainWriteError('unknown', 400),
		new AdminDomainWriteError('storage'),
		new AdminDomainWriteError('subject', 401),
		new AdminDomainWriteError(
			'rejected',
			400,
			'invalid_console_subject_precondition'
		),
		new RouteInputError('Local policy cannot be built'),
	])
		assert.equal(routeCanResumeEditor(error), false)
})

test('route state conflicts and model policy preconditions require a new explicit read', () => {
	for (const status of [401, 403, 404, 405, 409, 412, 428, 500, 0])
		assert.equal(
			routeCanResumeEditor(new AdminDomainWriteError('rejected', status)),
			false
		)
	for (const [status, code, key] of [
		[409, 'model_route_policy_conflict', 'policyConflict'],
		[428, 'model_route_policy_precondition_required', 'policyPrecondition'],
	] as const) {
		const error = new AdminDomainWriteError('rejected', status, code)
		assert.equal(routeCanResumeEditor(error), false)
		assert.equal(routeErrorKey(error), 'cinatoken.adminDomain.' + key)
	}
})

test('route feedback distinguishes known rejection, unknown result, unavailable storage and access failure', () => {
	assert.equal(
		routeWriteHintKey(new AdminDomainWriteError('rejected', 409)),
		'cinatoken.adminRoutes.writeRejected'
	)
	assert.equal(
		routeWriteHintKey(new AdminDomainWriteError('unknown', 502)),
		'cinatoken.adminRoutes.writeUnknown'
	)
	for (const error of [
		new AdminDomainWriteError('storage'),
		new AdminDomainWriteError('subject'),
		new AdminDomainWriteError('rejected', 403),
		{ status: 409 },
	])
		assert.equal(routeWriteHintKey(error), null)
	assert.equal(
		routeErrorKey(new AdminDomainWriteError('storage')),
		'cinatoken.adminDomain.storageUnavailable'
	)
	assert.equal(
		routeErrorKey(new AdminDomainWriteError('subject')),
		'cinatoken.adminRoutes.accessDenied'
	)
	assert.equal(
		routeErrorKey(new AdminDomainWriteError('rejected', 422)),
		'cinatoken.adminRoutes.invalidInput'
	)
})
