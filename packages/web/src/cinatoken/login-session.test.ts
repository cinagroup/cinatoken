import assert from 'node:assert/strict'
import test from 'node:test'
import { confirmsRestoredLogin } from './login-session'
import type { SessionSnapshot } from './session'
import { testUser } from './test-fixtures'

const restored: SessionSnapshot = {
	status: 'unavailable',
	user: testUser,
	workspaceContext: null,
	error: 'session_unavailable',
	isRefreshing: false,
	isLoggingOut: false,
	isSwitchingWorkspace: false,
	scopeVersion: 1,
}

test('Console login can finish with verified identity when the unrelated workspace is unavailable', () => {
	assert.equal(confirmsRestoredLogin(restored, testUser, 'admin'), true)
	assert.equal(confirmsRestoredLogin(restored, testUser, 'portal'), false)
	assert.equal(
		confirmsRestoredLogin(
			{ ...restored, status: 'authenticated' },
			testUser,
			'portal'
		),
		true
	)
})
test('Console login cannot finish after an identity change, identity loss or unfinished session operation', () => {
	for (const user of [
		null,
		{ ...testUser, userId: 'another-user' },
		{ ...testUser, subject: 'another-subject' },
	])
		assert.equal(
			confirmsRestoredLogin({ ...restored, user }, testUser, 'admin'),
			false
		)
	for (const status of ['loading', 'unauthenticated'] as const)
		assert.equal(
			confirmsRestoredLogin({ ...restored, status }, testUser, 'admin'),
			false
		)
	for (const pending of [
		'isRefreshing',
		'isLoggingOut',
		'isSwitchingWorkspace',
	] as const)
		assert.equal(
			confirmsRestoredLogin(
				{ ...restored, [pending]: true },
				testUser,
				'admin'
			),
			false
		)
})
