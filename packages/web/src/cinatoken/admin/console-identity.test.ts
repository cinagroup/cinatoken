import { QueryClient } from '@tanstack/react-query'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createCinaTokenApi } from '../api'
import type { AuthCheck } from '../contracts'
import type { SessionSnapshot } from '../session'
import { deferred, testUser, testWorkspaceContext } from '../test-fixtures'
import {
	consoleIdentityForPortal,
	consoleMatchesPortal,
	consoleScopeKey,
} from './console-identity'
import {
	CinaTokenConsoleSessionController,
	type ConsoleSessionSnapshot,
} from './console-session'

const portal: SessionSnapshot = {
	status: 'authenticated',
	user: testUser,
	workspaceContext: testWorkspaceContext(),
	error: null,
	isRefreshing: false,
	isLoggingOut: false,
	isSwitchingWorkspace: false,
	scopeVersion: 4,
}
const identity = {
	userId: testUser.userId,
	subject: testUser.subject,
	epoch: 4,
}
const verified: ConsoleSessionSnapshot = {
	status: 'verified',
	identity,
	canWrite: true,
	isRefreshing: false,
	accessVersion: 2,
	error: null,
	reason: null,
}

test('portal cache identity never grants console access while loading, changing cookies or logging out', () => {
	for (const patch of [
		{ status: 'loading' as const },
		{ status: 'unauthenticated' as const },
		{ isRefreshing: true },
		{ isLoggingOut: true },
		{ isSwitchingWorkspace: true },
		{ user: null },
	])
		assert.equal(consoleIdentityForPortal({ ...portal, ...patch }), null)
	assert.deepEqual(consoleIdentityForPortal(portal), identity)
})

test('console association does not require a portal workspace or infer authorization from isAdmin/capabilities', () => {
	const session: SessionSnapshot = {
		...portal,
		status: 'unavailable',
		workspaceContext: null,
		error: 'session_unavailable',
		user: { ...testUser, isAdmin: false, capabilities: [] },
	}
	// This association is usable only with the controller's independent verified-subject check.
	assert.deepEqual(consoleIdentityForPortal(session), identity)
	assert.equal(
		consoleMatchesPortal(
			{ ...verified, status: 'forbidden', canWrite: false },
			identity
		),
		false
	)
})

test('rendering rejects the prior user, subject, epoch and any unverified state before effects run', () => {
	assert.equal(consoleMatchesPortal(verified, identity), true)
	for (const changed of [
		null,
		{ ...identity, userId: 'other-user' },
		{ ...identity, subject: 'other-subject' },
		{ ...identity, epoch: 5 },
	])
		assert.equal(consoleMatchesPortal(verified, changed), false)
	for (const status of ['checking', 'degraded', 'forbidden'] as const)
		assert.equal(
			consoleMatchesPortal({ ...verified, status, canWrite: false }, identity),
			false
		)
})

test('scope keys cannot collide across delimiter-containing identities and revoke component state on recheck', () => {
	assert.notEqual(
		consoleScopeKey({ userId: 'a|b', subject: 'c', epoch: 1 }, 2),
		consoleScopeKey({ userId: 'a', subject: 'b|c', epoch: 1 }, 2)
	)
	assert.notEqual(consoleScopeKey(identity, 2), consoleScopeKey(identity, 3))
})

test('focus revalidation blocks the unchanged portal immediately, clears only admin queries, and remounts recovered access', async () => {
	const response = deferred<Response>()
	const started = deferred<void>()
	let calls = 0
	const client = new QueryClient()
	const api = createCinaTokenApi(async () => {
		calls += 1
		if (calls === 2) {
			started.resolve()
			return response.promise
		}
		return Response.json({
			authenticated: true,
			principalType: 'console',
			verification: 'verified',
			subject: identity.subject,
		})
	})
	const session = new CinaTokenConsoleSessionController(api, async () => {
		await client.cancelQueries({ queryKey: ['cinatoken', 'admin'] })
		client.removeQueries({ queryKey: ['cinatoken', 'admin'] })
	})
	try {
		session.setIdentity(identity)
		await session.refresh()
		const association = consoleIdentityForPortal(portal)
		assert.equal(consoleMatchesPortal(session.getSnapshot(), association), true)
		const priorKey = consoleScopeKey(
			identity,
			session.getSnapshot().accessVersion
		)
		client.setQueryData(
			['cinatoken', 'admin', priorKey, 'providers'],
			['private-row']
		)
		client.setQueryData(['cinatoken', 'account', 'activity'], ['account-row'])
		const pending = session.refresh()
		assert.equal(
			consoleMatchesPortal(session.getSnapshot(), association),
			false
		)
		assert.equal(session.getSnapshot().canWrite, false)
		assert.equal(session.getSnapshot().status, 'checking')
		await started.promise
		assert.equal(
			client.getQueriesData({ queryKey: ['cinatoken', 'admin'] }).length,
			0
		)
		assert.deepEqual(
			client.getQueryData(['cinatoken', 'account', 'activity']),
			['account-row']
		)
		response.resolve(
			Response.json({ authenticated: false, verification: 'rejected' })
		)
		await pending
		assert.equal(
			consoleMatchesPortal(session.getSnapshot(), association),
			false
		)
		await session.refresh()
		assert.equal(consoleMatchesPortal(session.getSnapshot(), association), true)
		assert.notEqual(
			consoleScopeKey(identity, session.getSnapshot().accessVersion),
			priorKey
		)
	} finally {
		session.dispose()
		client.clear()
	}
})

test(
	'portal revalidation and console revalidation cannot restore a previous subject after the shared cookie changes',
	{ timeout: 2000 },
	async () => {
		const old = deferred<AuthCheck>()
		const started = deferred<void>()
		let calls = 0
		const session = new CinaTokenConsoleSessionController({
			authCheck: () => {
				calls += 1
				if (calls === 2) {
					started.resolve()
					return old.promise
				}
				return Promise.resolve({
					authenticated: true,
					principalType: 'console',
					verification: 'verified',
					subject: calls === 1 ? identity.subject : 'new-subject',
				})
			},
		})
		session.setIdentity(identity)
		await session.refresh()
		const pending = session.refresh()
		await started.promise
		const refreshingPortal = { ...portal, isRefreshing: true }
		assert.equal(
			consoleMatchesPortal(
				session.getSnapshot(),
				consoleIdentityForPortal(refreshingPortal)
			),
			false
		)
		session.clear()
		const changedPortal: SessionSnapshot = {
			...portal,
			user: { ...testUser, userId: 'new-user', subject: 'new-subject' },
			scopeVersion: portal.scopeVersion + 1,
		}
		const nextIdentity = consoleIdentityForPortal(changedPortal)
		assert.equal(
			consoleMatchesPortal(session.getSnapshot(), nextIdentity),
			false
		)
		session.setIdentity(nextIdentity)
		await Promise.all([pending, session.refresh()])
		const current = session.getSnapshot()
		assert.equal(consoleMatchesPortal(current, nextIdentity), true)
		assert.equal(consoleMatchesPortal(current, identity), false)
		old.resolve({
			authenticated: true,
			principalType: 'console',
			verification: 'verified',
			subject: identity.subject,
		})
		await setImmediate()
		assert.equal(session.getSnapshot(), current)
	}
)
