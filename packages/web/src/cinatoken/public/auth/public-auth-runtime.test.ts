/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCinaTokenApi, CinaTokenApiError } from '../../api'
import { verifyPublicLogin } from './public-auth-runtime'

const me = {
	userId: 'user-fixture',
	subject: 'identity-fixture',
	email: 'fixture@example.invalid',
	isAdmin: true,
	capabilities: ['admin.console'],
	organizations: [],
}
const verified = {
	authenticated: true,
	verification: 'verified',
	principalType: 'console',
	subject: me.subject,
}
function fixture(
	check: unknown = verified,
	meBody: unknown = { success: true, data: me },
	meStatus = 200
) {
	const requests: Array<{ path: string; init: RequestInit | undefined }> = []
	const api = createCinaTokenApi(async (input, init) => {
		const path = new URL(
			input instanceof Request ? input.url : String(input),
			'https://fixture.invalid'
		).pathname
		requests.push({ path, init })
		return path === '/api/user/me'
			? Response.json(meBody, { status: meStatus })
			: Response.json(check)
	})
	return { api, requests }
}

test('portal completion uses the real strict Cookie SDK and never needs an Admin check or workspace read', async () => {
	const f = fixture()
	const controller = new AbortController()
	await verifyPublicLogin(
		f.api,
		{ intent: 'portal', callbackPath: '/account' },
		controller.signal
	)
	assert.deepEqual(
		f.requests.map((r) => r.path),
		['/api/user/me']
	)
	assert.equal(f.requests[0].init?.credentials, 'same-origin')
	assert.equal(
		new Headers(f.requests[0].init?.headers).get('authorization'),
		null
	)
	assert.equal(f.requests[0].init?.method ?? 'GET', 'GET')
})

test('Admin completion requires an independently verified console with the same exact identity', async () => {
	const f = fixture()
	await verifyPublicLogin(
		f.api,
		{ intent: 'admin', callbackPath: '/dashboard' },
		new AbortController().signal
	)
	assert.deepEqual(
		f.requests.map((r) => r.path),
		['/api/user/me', '/api/auth/check']
	)
	assert.ok(
		f.requests.every(
			(r) =>
				r.init?.credentials === 'same-origin' &&
				new Headers(r.init?.headers).get('authorization') === null
		)
	)
})

for (const [name, check, error] of [
	[
		'unauthenticated',
		{ authenticated: false, verification: 'none' },
		'admin_forbidden',
	],
	[
		'degraded',
		{ authenticated: true, verification: 'degraded', principalType: 'console' },
		'session_unavailable',
	],
	[
		'rejected',
		{
			authenticated: true,
			verification: 'rejected',
			principalType: 'console',
			subject: me.subject,
		},
		'session_unavailable',
	],
	['non-console', { ...verified, principalType: 'portal' }, 'admin_forbidden'],
	[
		'different subject',
		{ ...verified, subject: 'another-user' },
		'admin_forbidden',
	],
	[
		'missing subject',
		{ authenticated: true, verification: 'verified', principalType: 'console' },
		'admin_forbidden',
	],
] as const) {
	test(`Admin ${name} result never authorizes completion`, async () => {
		const f = fixture(check)
		await assert.rejects(
			verifyPublicLogin(
				f.api,
				{ intent: 'admin' },
				new AbortController().signal
			),
			(e) => e instanceof Error && e.message === error
		)
	})
}

for (const status of [401, 403, 500, 503]) {
	test(`a fake completion cannot bypass real me HTTP ${status}`, async () => {
		const f = fixture(
			verified,
			{ success: false, message: 'private server diagnostics' },
			status
		)
		await assert.rejects(
			verifyPublicLogin(
				f.api,
				{ intent: 'admin' },
				new AbortController().signal
			),
			(e) => e instanceof CinaTokenApiError && e.status === status
		)
		assert.deepEqual(
			f.requests.map((r) => r.path),
			['/api/user/me']
		)
	})
}

test('malformed HTTP200 me data and malformed Admin verification remain failures', async () => {
	const invalidMe = fixture(verified, {
		success: true,
		data: { subject: 'forged' },
	})
	await assert.rejects(
		verifyPublicLogin(
			invalidMe.api,
			{ intent: 'admin' },
			new AbortController().signal
		),
		(e) => e instanceof CinaTokenApiError && e.code === 'invalid-response'
	)
	assert.equal(invalidMe.requests.length, 1)
	const invalidCheck = fixture({
		authenticated: true,
		verification: 'synthetic',
	})
	await assert.rejects(
		verifyPublicLogin(
			invalidCheck.api,
			{ intent: 'admin' },
			new AbortController().signal
		),
		(e) => e instanceof CinaTokenApiError && e.code === 'invalid-response'
	)
})

test('already cancelled verification performs no Cookie request', async () => {
	const f = fixture()
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(
		verifyPublicLogin(f.api, { intent: 'admin' }, controller.signal)
	)
	assert.deepEqual(f.requests, [])
})

test('late me resolution after cancellation cannot proceed to the Admin check', async () => {
	let release!: () => void
	const response = new Promise<Response>((resolve) => {
		release = () => resolve(Response.json({ success: true, data: me }))
	})
	const paths: string[] = []
	const api = createCinaTokenApi(async (input) => {
		paths.push(String(input))
		return response
	})
	const controller = new AbortController()
	const pending = verifyPublicLogin(api, { intent: 'admin' }, controller.signal)
	controller.abort()
	release()
	await assert.rejects(pending)
	assert.deepEqual(paths, ['/api/user/me'])
})
