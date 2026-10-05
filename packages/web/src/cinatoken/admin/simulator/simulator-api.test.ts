/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	createSimulatorAdminApi,
	isOriginalGatewaySecret,
} from './simulator-api'

const secret = 'sk-' + 'K'.repeat(32)
const subject = 'cinaauth:operator team/百分号 %2F'
const key = { id: 'key-1', user_id: 'user-1', workspace_id: 'personal:user-1' }
const identity = {
	authenticated: true,
	verification: 'verified',
	principalType: 'console',
	subject,
}
const verified = { success: true, data: { ...key, verified: true } }
function emptyList(page = 1) {
	return {
		success: true,
		data: [],
		total: 0,
		page,
		page_size: 100,
		capabilities: {
			user_detail: false,
			request_logs: true,
			budget_audit: false,
			effective_guardrails: false,
			can_write: false,
		},
	}
}

test('directory uses legal 100-row paging and exact email query without any secret', async () => {
	const paths: string[] = []
	const api = createSimulatorAdminApi(async (path, init) => {
		paths.push(String(path))
		assert.equal(init?.credentials, 'same-origin')
		assert.equal(init?.redirect, 'error')
		assert.equal(init?.cache, 'no-store')
		return Response.json(emptyList(3))
	})
	const result = await api.listKeys({
		page: 3,
		email: 'operator+test@example.test',
	})
	assert.equal(result.page_size, 100)
	const url = new URL(paths[0], 'https://admin.example.test')
	assert.equal(url.searchParams.get('page_size'), '100')
	assert.equal(url.searchParams.get('page'), '3')
	assert.equal(url.searchParams.get('email'), 'operator+test@example.test')
	assert.equal(url.searchParams.has('key'), false)
})
test('directory rejects inconsistent server page and duplicate immutable IDs', async () => {
	const api = createSimulatorAdminApi(async () => Response.json(emptyList(2)))
	await assert.rejects(api.listKeys({ page: 1, email: '' }))
	let calls = 0
	const invalid = createSimulatorAdminApi(async () => {
		calls++
		return Response.json(emptyList())
	})
	await assert.rejects(invalid.listKeys({ page: 0, email: '' }))
	assert.equal(calls, 0)
	const duplicateRow = {
		...key,
		key: 'sk-…',
		name: null,
		user_email: null,
		budget_max: null,
		budget_base: 0,
		budget_spent: 0,
		budget_period: 'none',
		budget_reset_at: null,
		status: 'active',
		created_at: '2026-10-01T00:00:00.000Z',
		updated_at: '2026-10-01T00:00:00.000Z',
		metadata_preview: null,
		metadata_unavailable: false,
		profile_revision: 'sha256:' + 'a'.repeat(64),
	}
	const duplicate = createSimulatorAdminApi(async () =>
		Response.json({
			...emptyList(),
			total: 2,
			data: [duplicateRow, duplicateRow],
		})
	)
	await assert.rejects(duplicate.listKeys({ page: 1, email: '' }))
})
test('secret verification fresh-checks exact subject and sends one canonical header, with only the immutable ID in URL', async () => {
	const calls: Array<{ path: string; init: RequestInit }> = []
	const api = createSimulatorAdminApi(async (path, init) => {
		calls.push({ path: String(path), init: init ?? {} })
		return Response.json(
			String(path) === '/api/auth/check' ? identity : verified
		)
	})
	assert.deepEqual(await api.verifySecret(key, secret, subject), verified.data)
	assert.equal(calls.length, 2)
	assert.equal(calls[0].path, '/api/auth/check')
	assert.equal(calls[1].path, '/api/admin/keys/key-1/verify-secret')
	assert.equal(calls[1].init.method, 'POST')
	assert.equal(
		new Headers(calls[1].init.headers).get(
			'X-CinaToken-Expected-Console-Subject'
		),
		encodeURIComponent(subject)
	)
	assert.deepEqual(JSON.parse(String(calls[1].init.body)), { secret })
	assert.equal(
		calls.some((call) => call.path.includes(secret)),
		false
	)
})
test('masked, redacted and malformed secrets never produce a request', async () => {
	let calls = 0
	const api = createSimulatorAdminApi(async () => {
		calls++
		return Response.json(verified)
	})
	for (const input of [
		'sk-…',
		'sk-abc…def',
		'sk-...',
		'Bearer ' + secret,
		'hashref:sha256:' + 'a'.repeat(64),
		secret + '\n',
		'sk-' + 'a'.repeat(4094),
	]) {
		assert.equal(isOriginalGatewaySecret(input), false)
		await assert.rejects(api.verifySecret(key, input, subject))
	}
	assert.equal(calls, 0)
	for (const id of [
		secret,
		'hashref:sha256:' + 'a'.repeat(64),
		'sha256:' + 'a'.repeat(64),
	])
		await assert.rejects(api.verifySecret({ ...key, id }, secret, subject))
	assert.equal(calls, 0)
})
test('changed or non-Console subject fails before the secret verification POST', async () => {
	for (const replacement of [
		{ ...identity, subject: 'different' },
		{ ...identity, principalType: 'api_key' },
		{ ...identity, verification: 'degraded' },
	]) {
		const paths: string[] = []
		const api = createSimulatorAdminApi(async (path) => {
			paths.push(String(path))
			return Response.json(replacement)
		})
		await assert.rejects(api.verifySecret(key, secret, subject))
		assert.deepEqual(paths, ['/api/auth/check'])
	}
})
test('matching secret still requires exact returned id, owner, workspace and verified flag', async () => {
	for (const mismatch of [
		{ ...key, id: 'key-2', verified: true },
		{ ...key, user_id: 'user-2', verified: true },
		{ ...key, workspace_id: 'personal:user-2', verified: true },
		{ ...key, verified: false },
	]) {
		const api = createSimulatorAdminApi(async (path) =>
			Response.json(
				String(path) === '/api/auth/check'
					? identity
					: { success: true, data: mismatch }
			)
		)
		await assert.rejects(api.verifySecret(key, secret, subject))
	}
})
test('untrusted error bodies cannot retain an echoed secret in the thrown error', async () => {
	const api = createSimulatorAdminApi(async (path) =>
		String(path) === '/api/auth/check'
			? Response.json(identity)
			: Response.json(
					{ success: false, message: 'echo ' + secret },
					{ status: 422 }
				)
	)
	await assert.rejects(
		api.verifySecret(key, secret, subject),
		(error: unknown) =>
			error instanceof Error &&
			!JSON.stringify(error).includes(secret) &&
			!error.message.includes(secret)
	)
})
test('abort after fresh identity prevents disclosure to the verification endpoint', async () => {
	const controller = new AbortController()
	let calls = 0
	const api = createSimulatorAdminApi(async () => {
		calls++
		controller.abort()
		return Response.json(identity)
	})
	await assert.rejects(
		api.verifySecret(key, secret, subject, { signal: controller.signal })
	)
	assert.equal(calls, 1)
})
