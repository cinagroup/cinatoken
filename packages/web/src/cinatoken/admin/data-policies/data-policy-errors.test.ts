/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	dataPolicyAccessDenied,
	dataPolicyErrorKey,
	dataPolicyWriteUncertain,
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
