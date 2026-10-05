/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError } from '../../api'
import { createCinaTokenAdminApi } from '../api'

const secret = 'sk-admin-' + 'a'.repeat(64)
const rotated = 'sk-admin-' + 'b'.repeat(64)
const publicRow = {
	id: 'integration/one',
	name: 'Accounting integration',
	description: null,
	key: 'sk-admin-aaa••••••••',
	key_prefix: 'sk-admin-aaa',
	permissions: ['routes.read'],
	status: 'active',
	last_used_at: null,
	created_at: '2026-09-29 03:45:10',
	updated_at: '2026-09-29T03:45:10.000Z',
	revoked_at: null,
}
type Call = { path: string; init: RequestInit }
function fixture(reply: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = []
	const api = createCinaTokenAdminApi(async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		calls.push(call)
		return reply(call)
	})
	return { api, calls }
}
function invalid(error: unknown): boolean {
	return (
		error instanceof CinaTokenApiError &&
		error.code === 'invalid-response' &&
		!error.message.includes(secret)
	)
}

test('list retains only public fields, normalizes UTC dates, and uses private same-origin transport', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: [{ ...publicRow, secretKey: secret, internal_owner: 'PRIVATE' }],
			secret,
		})
	)
	const rows = await api.listAccessKeys()
	assert.equal(rows[0]?.created_at, '2026-09-29T03:45:10.000Z')
	assert.equal(JSON.stringify(rows).includes(secret), false)
	assert.equal(JSON.stringify(rows).includes('PRIVATE'), false)
	assert.equal(calls.length, 1)
	assert.equal(calls[0]?.path, '/api/admin/access-keys')
	assert.equal(calls[0]?.init.credentials, 'same-origin')
	assert.equal(calls[0]?.init.cache, 'no-store')
	assert.equal(new Headers(calls[0]?.init.headers).has('Authorization'), false)
})

test('list rejects plaintext, long prefixes, invalid UTC dates, malformed identity, unknown permissions and duplicate rows', async () => {
	const badRows = [
		{ ...publicRow, key: secret },
		{ ...publicRow, key_prefix: secret, key: secret + '••••••••' },
		{ ...publicRow, key_prefix: 'arbitrary', key: 'arbitrary••••••••' },
		{ ...publicRow, created_at: '2026-02-30T01:02:03Z' },
		{ ...publicRow, created_at: '2026-09-29T03:45:10+02:00' },
		{ ...publicRow, last_used_at: 'not-a-date' },
		{ ...publicRow, id: 'bad\nidentity' },
		{ ...publicRow, permissions: ['secret.admin'] },
		{ ...publicRow, permissions: ['routes.read', 'routes.read'] },
	]
	for (const row of badRows) {
		const { api } = fixture(() => Response.json({ success: true, data: [row] }))
		await assert.rejects(api.listAccessKeys(), invalid)
	}
	const { api } = fixture(() =>
		Response.json({ success: true, data: [publicRow, publicRow] })
	)
	await assert.rejects(api.listAccessKeys(), invalid)
})

test('secret reads require an explicit separate request and exact requested identity', async () => {
	const { api, calls } = fixture((call) =>
		Response.json({
			success: true,
			data: call.path.endsWith('/secret')
				? { id: publicRow.id, key: secret }
				: [publicRow],
		})
	)
	await api.listAccessKeys()
	assert.equal(calls.length, 1)
	assert.equal(await api.revealAccessKey(publicRow.id), secret)
	assert.equal(
		calls[1]?.path,
		'/api/admin/access-keys/integration%2Fone/secret'
	)
	const mismatch = fixture(() =>
		Response.json({ success: true, data: { id: 'other', key: secret } })
	)
	await assert.rejects(mismatch.api.revealAccessKey(publicRow.id), invalid)
})

test('only the imported legacy master may have an old short public prefix or explicitly read an old secret', async () => {
	for (const legacySecret of ['old', 'Old-Master-Secret-Imported-In-2024']) {
		const prefix = legacySecret.slice(
			0,
			Math.min(12, Math.max(0, legacySecret.length - 4))
		)
		const legacy = {
			...publicRow,
			id: 'legacy-master',
			key_prefix: prefix,
			key: prefix + '••••••••',
			status: 'revoked',
		}
		const { api, calls } = fixture((call) =>
			Response.json({
				success: true,
				data: call.path.endsWith('/secret')
					? { id: legacy.id, key: legacySecret }
					: [legacy, publicRow],
			})
		)
		const rows = await api.listAccessKeys()
		assert.equal(rows.length, 2)
		assert.equal(rows[0]?.key, legacy.key)
		assert.equal(calls.length, 1)
		assert.equal(await api.revealAccessKey('legacy-master'), legacySecret)
		const nonLegacy = fixture(() =>
			Response.json({
				success: true,
				data: [{ ...legacy, id: 'ordinary-key' }],
			})
		)
		await assert.rejects(nonLegacy.api.listAccessKeys(), invalid)
		const wrongIdentity = fixture(() =>
			Response.json({
				success: true,
				data: { id: publicRow.id, key: legacySecret },
			})
		)
		await assert.rejects(
			wrongIdentity.api.revealAccessKey(publicRow.id),
			invalid
		)
	}
	const invalidLegacy = fixture(() =>
		Response.json({
			success: true,
			data: { id: 'legacy-master', key: 'a'.repeat(4097) },
		})
	)
	await assert.rejects(
		invalidLegacy.api.revealAccessKey('legacy-master'),
		invalid
	)
})

test('legacy master replacement uses the strict new secret format and preserves exact row identity', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: {
				...publicRow,
				id: 'legacy-master',
				key: rotated,
				key_prefix: rotated.slice(0, 12),
			},
		})
	)
	const replaced = await api.patchAccessKey('legacy-master', {
		secret_key: rotated,
	})
	assert.equal(replaced.id, 'legacy-master')
	assert.equal(replaced.key, 'sk-admin-bbb••••••••')
	await assert.rejects(
		api.patchAccessKey('legacy-master', { secret_key: 'old-master' }),
		invalid
	)
	assert.equal(calls.length, 1)
})

test('ordinary metadata edit omits the secret and does not fetch the secret endpoint', async () => {
	const patch = {
		name: 'Updated name',
		description: 'ERP',
		permissions: ['routes.write'] as const,
	}
	const { api, calls } = fixture(() =>
		Response.json({ success: true, data: { ...publicRow, ...patch } })
	)
	const changed = await api.patchAccessKey(publicRow.id, {
		...patch,
		permissions: [...patch.permissions],
	})
	assert.equal(changed.name, patch.name)
	assert.equal(calls.length, 1)
	assert.equal(calls[0]?.init.method, 'PATCH')
	assert.equal(String(calls[0]?.init.body).includes('secret_key'), false)
	assert.equal(calls[0]?.path.endsWith('/secret'), false)
})

test('create and saved rotation confirm the exact draft but return only masked public data', async () => {
	const draft = {
		name: publicRow.name,
		description: null,
		permissions: ['routes.read'] as const,
		secret_key: secret,
	}
	const { api, calls } = fixture((call) => {
		const body = JSON.parse(String(call.init.body)) as { secret_key: string }
		return Response.json({
			success: true,
			data: {
				...publicRow,
				key: body.secret_key,
				key_prefix: body.secret_key.slice(0, 12),
			},
		})
	})
	const created = await api.createAccessKey({
		...draft,
		permissions: [...draft.permissions],
	})
	const updated = await api.patchAccessKey(publicRow.id, {
		secret_key: rotated,
	})
	assert.equal(JSON.stringify([created, updated]).includes(secret), false)
	assert.equal(JSON.stringify([created, updated]).includes(rotated), false)
	assert.equal(updated.key, 'sk-admin-bbb••••••••')
	assert.equal(calls[0]?.init.method, 'POST')
	assert.equal(calls[1]?.init.method, 'PATCH')
	assert.equal(JSON.parse(String(calls[1]?.init.body)).secret_key, rotated)
})

test('status changes verify the new active/revoked state and malformed success remains unknown', async () => {
	const { api } = fixture(() =>
		Response.json({
			success: true,
			data: {
				...publicRow,
				status: 'revoked',
				revoked_at: '2026-09-29 04:00:00.123456',
			},
		})
	)
	assert.equal(
		(await api.patchAccessKey(publicRow.id, { status: 'revoked' })).revoked_at,
		'2026-09-29T04:00:00.123Z'
	)
	const mismatch = fixture(() =>
		Response.json({ success: true, data: publicRow })
	)
	await assert.rejects(
		mismatch.api.patchAccessKey(publicRow.id, { status: 'revoked' }),
		invalid
	)
	await assert.rejects(
		mismatch.api.patchAccessKey(publicRow.id, { name: 'Changed' }),
		invalid
	)
	const wrongSecret = fixture(() =>
		Response.json({
			success: true,
			data: { ...publicRow, key: rotated, key_prefix: rotated.slice(0, 12) },
		})
	)
	await assert.rejects(
		wrongSecret.api.createAccessKey({
			name: publicRow.name,
			description: null,
			permissions: ['routes.read'],
			secret_key: secret,
		}),
		invalid
	)
})

test('bad paths and invalid write drafts are rejected before dispatch', async () => {
	const { api, calls } = fixture(() => {
		throw new Error('Should not dispatch')
	})
	await assert.rejects(api.revealAccessKey('bad\u0000id'), invalid)
	await assert.rejects(
		api.patchAccessKey(' good ', { status: 'active' }),
		invalid
	)
	await assert.rejects(api.patchAccessKey(publicRow.id, {}), invalid)
	await assert.rejects(
		api.patchAccessKey(publicRow.id, { secret_key: 'invalid' }),
		invalid
	)
	await assert.rejects(
		api.createAccessKey({
			name: ' ',
			description: null,
			permissions: ['routes.read'],
			secret_key: secret,
		}),
		invalid
	)
	assert.equal(calls.length, 0)
})

test('server failures are sanitized and a late aborted secret reply is discarded', async () => {
	const failed = fixture(() =>
		Response.json({ success: false, message: secret }, { status: 403 })
	)
	await assert.rejects(
		failed.api.revealAccessKey(publicRow.id),
		(error: unknown) =>
			error instanceof CinaTokenApiError &&
			error.status === 403 &&
			!error.message.includes(secret)
	)
	const controller = new AbortController()
	let resolveReply: (response: Response) => void = () => {
		throw new Error('Uninitialized reply')
	}
	const delayed = fixture(
		() =>
			new Promise<Response>((resolve) => {
				resolveReply = resolve
			})
	)
	const read = delayed.api.revealAccessKey(publicRow.id, {
		signal: controller.signal,
	})
	controller.abort()
	resolveReply(
		Response.json({ success: true, data: { id: publicRow.id, key: secret } })
	)
	await assert.rejects(
		read,
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
})
