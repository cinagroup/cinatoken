/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { createAdminGatewayKeysApi } from './gateway-key-api'
import { gatewayKeyRowSchema } from './gateway-key-contracts'
import {
	gatewayKeyCreateInput,
	gatewayKeyEditInput,
	parseGatewayKeyMetadata,
	type GatewayKeyCreateForm,
	type GatewayKeyEditForm,
} from './gateway-key-input'
import {
	validateGatewayKeySearch,
	validateGatewayKeyRouteSearch,
	gatewayKeysListPath,
} from './gateway-key-search'

const revision = 'sha256:' + 'a'.repeat(64)
const secret = 'sk-' + 'S'.repeat(32)
const wireRow = {
	id: 'key-1',
	key: 'sk-…',
	user_id: 'user-1',
	workspace_id: 'personal:user-1',
	name: 'Team key',
	user_email: 'person@example.test',
	budget_max: 10,
	budget_base: 10,
	budget_spent: 3,
	budget_period: 'monthly',
	budget_reset_at: '2026-10-01 00:00:00',
	status: 'active',
	created_at: '2026-09-28 00:00:00.123456',
	updated_at: '2026-09-28T01:00:00.000Z',
	metadata_preview: '{"field_count":2}',
	metadata_unavailable: false,
	profile_revision: revision,
}
const row = gatewayKeyRowSchema.parse(wireRow)
const search = validateGatewayKeySearch({})
const capabilities = {
	user_detail: true,
	request_logs: true,
	budget_audit: true,
	effective_guardrails: true,
	can_write: true,
}
const detail = { ...wireRow, metadata_raw: '{"team":"a","password":"PRIVATE"}' }
const created = {
	id: row.id,
	key_id: row.id,
	key: secret,
	user_id: row.user_id,
	workspace_id: row.workspace_id,
	name: 'Team key',
	status: 'active',
	profile_revision: revision,
	owner: {
		email: 'person@example.test',
		external_system: 'erp',
		external_user_id: '42',
	},
}
const draft: GatewayKeyCreateForm = {
	mode: 'existing',
	userId: row.user_id,
	email: '',
	externalSystem: '',
	externalUserId: '',
	name: 'Team key',
	metadata: '{"team":"a"}',
	reason: 'Operator request',
}
type Call = { path: string; init: RequestInit }
function fixture(reply: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = []
	const request: typeof fetch = async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		calls.push(call)
		return reply(call)
	}
	const cookie = createCinaTokenCookieTransport(request)
	const api = createAdminGatewayKeysApi({
		send: (path, schema, init, options) =>
			cookie.send(path, schema, init, options),
		invalidResponse() {
			throw new CinaTokenApiError(
				'Invalid Gateway key response',
				200,
				'invalid-response'
			)
		},
		sanitizeError(error) {
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'Gateway key operation failed',
					error.status,
					error.code
				)
			return new Error('Gateway key operation failed')
		},
	})
	return { api, calls }
}
function list(data: unknown[] = [wireRow], extras: object = {}): Response {
	return Response.json({
		success: true,
		data,
		total: data.length,
		page: 1,
		page_size: 20,
		capabilities,
		...extras,
	})
}
const invalid = (error: unknown) =>
	error instanceof CinaTokenApiError && error.code === 'invalid-response'

test('URL filters reach the first request exactly; explicit invalid filters never widen to a global read', () => {
	const checked = validateGatewayKeySearch({
		page: '2',
		email: ' person ',
		user_id: ' user-1 ',
		sort: 'budget_reset_at',
		order: 'asc',
	})
	assert.equal(
		gatewayKeysListPath(checked),
		'/api/admin/keys?page=2&page_size=20&sort=budget_reset_at&order=asc&email=person&user_id=user-1'
	)
	for (const input of [
		{ user_id: 'a\nb' },
		{ user_id: 'a'.repeat(601) },
		{ email: 'a'.repeat(321) },
		{ email: ['a', 'b'] },
	]) {
		assert.throws(() => validateGatewayKeySearch(input))
		assert.equal(validateGatewayKeyRouteSearch(input).invalidFilter, true)
	}
	assert.equal(validateGatewayKeyRouteSearch({}).invalidFilter, undefined)
})

test('list projects only public columns and validated summary, canonicalizes UTC and uses same-origin no-store', async () => {
	const { api, calls } = fixture(() =>
		list([
			{
				...wireRow,
				metadata: '{"password":"PRIVATE"}',
				metadata_raw: 'PRIVATE',
				legacy_secret: secret,
			},
		])
	)
	const value = await api.gatewayKeyList(search)
	assert.deepEqual(value.data[0]?.metadata_preview, { field_count: 2 })
	assert.equal(value.data[0]?.created_at, '2026-09-28T00:00:00.123Z')
	assert.equal(value.data[0]?.budget_reset_at, '2026-10-01T00:00:00.000Z')
	assert.equal(JSON.stringify(value).includes('PRIVATE'), false)
	assert.equal(JSON.stringify(value).includes(secret), false)
	assert.equal(calls[0]?.path, gatewayKeysListPath(search))
	assert.equal(calls[0]?.init.cache, 'no-store')
	assert.equal(calls[0]?.init.credentials, 'same-origin')
	for (const header of [
		'Authorization',
		'X-CinaToken-Workspace',
		'New-Api-User',
	])
		assert.equal(new Headers(calls[0]?.init.headers).get(header), null)
})

test('malformed, unbounded or secret-bearing metadata summaries fail closed before Query receives a row', async () => {
	for (const metadata_preview of [
		'{',
		'{"field_count":-1}',
		'{"field_count":"2"}',
		'{"field_count":1001}',
		'{"field_count":2,"password":"PRIVATE"}',
		'[]',
	]) {
		const { api } = fixture(() => list([{ ...wireRow, metadata_preview }]))
		await assert.rejects(api.gatewayKeyList(search), invalid)
	}
})

test('legacy short values or full ordinary-read secrets and unsafe public rows fail closed', async () => {
	assert.equal(
		gatewayKeyRowSchema.parse({ ...wireRow, key: 'sk-ABCDE…WXYZ' }).key,
		'sk-…'
	)
	for (const change of [
		{ key: 'short-private' },
		{ key: secret },
		{ id: 'sk-legacy-secret' },
		{ id: '../key' },
		{ id: 'key\u0085' },
		{ user_id: 'different/owner' },
		{ workspace_id: 'workspace?secret' },
		{ name: 'a\nb' },
		{ created_at: '2026-02-30T00:00:00Z' },
		{ created_at: '2026-09-28T00:00:00+08:00' },
		{ budget_spent: -1 },
		{ profile_revision: 'unsafe' },
	]) {
		const { api } = fixture(() => list([{ ...wireRow, ...change }]))
		await assert.rejects(api.gatewayKeyList(search), invalid)
	}
})

test('list rejects duplicate IDs, false totals, wrong pages, wrong owners and missing capabilities', async () => {
	for (const response of [
		list([wireRow, wireRow]),
		list([wireRow], { total: 0 }),
		list([wireRow], { page: 2 }),
		list([wireRow], { capabilities: undefined }),
	]) {
		const { api } = fixture(() => response)
		await assert.rejects(api.gatewayKeyList(search), invalid)
	}
	const { api } = fixture(() => list())
	await assert.rejects(
		api.gatewayKeyList({ ...search, user_id: 'other-user' }),
		invalid
	)
})

test('explicit edit fetch keeps raw metadata local and verifies ID and ownership', async () => {
	const { api, calls } = fixture(() =>
		Response.json({ success: true, data: detail })
	)
	const value = await api.gatewayKeyEditDetail(row)
	assert.equal(value.metadata_raw, detail.metadata_raw)
	assert.equal('metadata_preview' in value, false)
	assert.equal(calls[0]?.path, '/api/admin/keys/key-1')
	assert.equal(calls[0]?.init.method ?? 'GET', 'GET')
	for (const change of [
		{ id: 'other-key' },
		{ user_id: 'other-user' },
		{ workspace_id: 'personal:other-user' },
	]) {
		const wrong = fixture(() =>
			Response.json({ success: true, data: { ...detail, ...change } })
		)
		await assert.rejects(wrong.api.gatewayKeyEditDetail(row), invalid)
	}
})

test('unavailable metadata cannot be supplied raw; malformed raw cannot become an editable detail', async () => {
	for (const change of [
		{ metadata_unavailable: true },
		{ metadata_raw: '[]' },
		{ metadata_raw: '{"__proto__":{"x":1}}' },
		{ metadata_raw: 'invalid JSON' },
	]) {
		const { api } = fixture(() =>
			Response.json({ success: true, data: { ...detail, ...change } })
		)
		await assert.rejects(api.gatewayKeyEditDetail(row), invalid)
	}
	const { api } = fixture(() =>
		Response.json({
			success: true,
			data: { ...detail, metadata_raw: null, metadata_unavailable: true },
		})
	)
	assert.equal((await api.gatewayKeyEditDetail(row)).metadata_unavailable, true)
})

test('cancelled late detail and secret responses cannot populate local editor state', async () => {
	for (const kind of ['detail', 'create'] as const) {
		const abort = new AbortController()
		let release!: () => void
		const waiting = new Promise<void>((resolve) => {
			release = resolve
		})
		const { api } = fixture(async () => {
			await waiting
			return Response.json({
				success: true,
				data: kind === 'detail' ? detail : created,
			})
		})
		let revealed = false
		const result =
			kind === 'detail'
				? api.gatewayKeyEditDetail(row, { signal: abort.signal })
				: api.createGatewayKey(
						draft,
						() => {
							revealed = true
						},
						{ signal: abort.signal }
					)
		abort.abort()
		release()
		await assert.rejects(result)
		assert.equal(revealed, false)
	}
})

test('existing-user creation confirms personal workspace and returns the full secret only through a validated callback', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: { ...created, extra_secret: 'PRIVATE' },
		})
	)
	let once = ''
	const result = await api.createGatewayKey(draft, (value) => {
		once = value
	})
	assert.equal(once, secret)
	assert.equal('key' in result, false)
	assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
	assert.equal(calls[0]?.init.method, 'POST')
	assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
		user_id: row.user_id,
		name: 'Team key',
		metadata: { team: 'a' },
		reason: 'Operator request',
	})
	for (const change of [
		{ id: 'other-key' },
		{ user_id: 'other-user' },
		{ workspace_id: 'shared:team' },
		{ name: 'Other' },
		{ key: 'sk-bad' },
	]) {
		let revealed = false
		const wrong = fixture(() =>
			Response.json({ success: true, data: { ...created, ...change } })
		)
		await assert.rejects(
			wrong.api.createGatewayKey(draft, () => {
				revealed = true
			}),
			invalid
		)
		assert.equal(revealed, false)
	}
})

test('external creation sends only its identity mode and confirms the resolved pair, including an existing owner email', async () => {
	const external: GatewayKeyCreateForm = {
		...draft,
		mode: 'external',
		userId: 'unused',
		email: 'new@example.test',
		externalSystem: 'erp',
		externalUserId: '42',
	}
	const { api, calls } = fixture(() =>
		Response.json({ success: true, data: created })
	)
	await api.createGatewayKey(external, () => undefined)
	const body = JSON.parse(String(calls[0]?.init.body)) as Record<
		string,
		unknown
	>
	assert.equal(body.user_id, undefined)
	assert.equal(body.email, 'new@example.test')
	assert.equal(body.external_system, 'erp')
	const wrong = fixture(() =>
		Response.json({
			success: true,
			data: {
				...created,
				owner: { ...created.owner, external_user_id: 'other' },
			},
		})
	)
	await assert.rejects(
		wrong.api.createGatewayKey(external, () =>
			assert.fail('mismatched secret')
		),
		invalid
	)
})

test('PATCH carries opaque expected revision and strips raw response data; mismatched success remains unknown', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: { ...detail, name: 'Renamed', metadata: 'PRIVATE' },
		})
	)
	const result = await api.patchGatewayKey(row, {
		expected_revision: revision,
		name: 'Renamed',
		reason: 'Edit',
	})
	assert.equal(calls[0]?.init.method, 'PATCH')
	assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
		expected_revision: revision,
		name: 'Renamed',
		reason: 'Edit',
	})
	assert.equal('metadata_raw' in result, false)
	assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
	for (const change of [
		{ name: 'Other' },
		{ user_id: 'other-user' },
		{ workspace_id: 'other-workspace' },
	]) {
		const wrong = fixture(() =>
			Response.json({
				success: true,
				data: { ...detail, name: 'Renamed', ...change },
			})
		)
		await assert.rejects(
			wrong.api.patchGatewayKey(row, {
				expected_revision: revision,
				name: 'Renamed',
				reason: 'Edit',
			}),
			invalid
		)
	}
})

test('revision conflict is surfaced once without retry or secret-bearing backend errors', async () => {
	const { api, calls } = fixture(() =>
		Response.json(
			{ success: false, error: 'PRIVATE metadata conflict' },
			{ status: 409 }
		)
	)
	await assert.rejects(
		api.patchGatewayKey(row, {
			expected_revision: revision,
			name: 'Changed',
			reason: 'Edit',
		}),
		(error: unknown) =>
			error instanceof CinaTokenApiError &&
			error.status === 409 &&
			!error.message.includes('PRIVATE')
	)
	assert.equal(calls.length, 1)
})

test('tombstone uses DELETE JSON conditional identity, confirms revoked and retains public row identity', async () => {
	const { api, calls } = fixture(() =>
		Response.json({ success: true, data: { ...detail, status: 'revoked' } })
	)
	const result = await api.tombstoneGatewayKey(row, 'Retire')
	assert.equal(calls[0]?.path, '/api/admin/keys/key-1')
	assert.equal(calls[0]?.init.method, 'DELETE')
	assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
		expected_revision: revision,
		reason: 'Retire',
	})
	assert.equal(result.id, row.id)
	assert.equal('metadata_raw' in result, false)
	const wrong = fixture(() => Response.json({ success: true, data: detail }))
	await assert.rejects(wrong.api.tombstoneGatewayKey(row, 'Retire'), invalid)
})

test('metadata edits preserve unchanged bytes and distinguish explicit merge, replacement, and clear', () => {
	const editable = { ...row, metadata_raw: detail.metadata_raw }
	const form: GatewayKeyEditForm = {
		name: 'Team key',
		status: 'active',
		statusConfirmed: false,
		metadataMode: 'unchanged',
		metadata: '',
		reason: 'Edit',
	}
	const unchanged = gatewayKeyEditInput(editable, form)
	assert.equal('metadata' in unchanged, false)
	assert.equal('metadata_replace' in unchanged, false)
	assert.equal(unchanged.expected_revision, revision)
	assert.deepEqual(
		gatewayKeyEditInput(editable, {
			...form,
			metadataMode: 'merge',
			metadata: '{"team":"b"}',
		}).metadata,
		{ team: 'b' }
	)
	assert.deepEqual(
		gatewayKeyEditInput(editable, {
			...form,
			metadataMode: 'replace',
			metadata: '{"only":true}',
		}).metadata_replace,
		{ only: true }
	)
	assert.equal(
		gatewayKeyEditInput(editable, { ...form, metadataMode: 'replace' })
			.metadata_replace,
		null
	)
	for (const metadataMode of ['merge', 'replace'] as const)
		assert.throws(() =>
			gatewayKeyEditInput(
				{ ...editable, metadata_raw: null, metadata_unavailable: true },
				{ ...form, metadataMode, metadata: '{}' }
			)
		)
	assert.throws(() =>
		gatewayKeyEditInput(editable, { ...form, status: 'revoked' })
	)
	assert.equal(
		gatewayKeyEditInput(editable, {
			...form,
			status: 'revoked',
			statusConfirmed: true,
		}).status,
		'revoked'
	)
})

test('metadata rejects scalar, pollution, depth, nonfinite, excessive fields and UTF-8 over-limit input', () => {
	let nested = '{}'
	for (let depth = 0; depth < 18; depth++) nested = '{"x":' + nested + '}'
	const tooMany = Object.fromEntries(
		Array.from({ length: 1001 }, (_, index) => [String(index), index])
	)
	for (const raw of [
		'[]',
		'"text"',
		'null',
		'{"__proto__":{}}',
		'{"constructor":{}}',
		'{"x":1e999}',
		nested,
		JSON.stringify(tooMany),
		JSON.stringify({ x: '字'.repeat(23_000) }),
	])
		assert.throws(() => parseGatewayKeyMetadata(raw))
	assert.deepEqual(parseGatewayKeyMetadata('{"labels":[1,true,null]}'), {
		labels: [1, true, null],
	})
	assert.equal(parseGatewayKeyMetadata(''), null)
	assert.throws(() =>
		gatewayKeyCreateInput({
			...draft,
			mode: 'external',
			email: 'not-email',
			externalSystem: '',
			externalUserId: '',
		})
	)
})
