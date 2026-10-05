import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError } from '../api'
import {
	invalidatesAccountAccess,
	isAccountContextMismatch,
	isUserMismatch,
	isWorkspaceMismatch,
	requiresSessionRevalidation,
} from './account-access'

test('a user conflict closes access and rechecks identity without becoming a workspace conflict', () => {
	const error = new CinaTokenApiError('User changed', 409, 'user-mismatch')
	assert.equal(isUserMismatch(error), true)
	assert.equal(isWorkspaceMismatch(error), false)
	assert.equal(isAccountContextMismatch(error), true)
	assert.equal(invalidatesAccountAccess(error), true)
	assert.equal(requiresSessionRevalidation(error), true)
})

test('a server workspace precondition conflict requires fresh context and closes access', () => {
	const error = new CinaTokenApiError(
		'Workspace changed',
		409,
		'workspace-mismatch'
	)
	assert.equal(isWorkspaceMismatch(error), true)
	assert.equal(isUserMismatch(error), false)
	assert.equal(isAccountContextMismatch(error), true)
	assert.equal(invalidatesAccountAccess(error), true)
	assert.equal(requiresSessionRevalidation(error), true)
})
test('invalid response scope closes sensitive surfaces without a session refresh loop', () => {
	const error = new CinaTokenApiError(
		'Unexpected workspace',
		0,
		'workspace-mismatch'
	)
	assert.equal(invalidatesAccountAccess(error), true)
	assert.equal(requiresSessionRevalidation(error), false)
})
test('resource conflicts and temporary failures cannot imply lost session', () => {
	for (const status of [400, 404, 409, 429, 503]) {
		const error = new CinaTokenApiError('Resource failure', status, 'http')
		assert.equal(requiresSessionRevalidation(error), false)
		assert.equal(invalidatesAccountAccess(error), false)
	}
})
test('401 rechecks identity, while resource 403 only rechecks its permission', () => {
	for (const status of [401, 403]) {
		const error = new CinaTokenApiError('Rejected', status, 'http')
		assert.equal(invalidatesAccountAccess(error), true)
		assert.equal(requiresSessionRevalidation(error), status === 401)
	}
	assert.equal(requiresSessionRevalidation(new Error('network')), false)
})
