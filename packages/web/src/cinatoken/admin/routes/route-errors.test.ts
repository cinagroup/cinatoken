/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError } from '../../api'
import { RouteInputError, routeUnknownWrite } from './route-errors'

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
