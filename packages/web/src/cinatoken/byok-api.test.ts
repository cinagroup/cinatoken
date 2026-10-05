import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	normalizeByokKeyCreate,
	normalizeByokKeyPatch,
	normalizeByokKeyReorder,
	publicByokKey,
} from '../../../core/src/db/byok-keys-types'
import { CinaTokenApiError, createCinaTokenApi } from './api'
import {
	BYOK_MAX_CREDENTIAL_BYTES,
	createByokKeyInputSchema,
	patchByokKeyInputSchema,
	reorderByokKeysInputSchema,
	type ByokKey,
} from './byok-contracts'

const id = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'
const options = { expectedWorkspaceId: 'personal:alice' }
const row: ByokKey = {
	id,
	workspace_id: options.expectedWorkspaceId,
	provider: 'openai',
	name: 'Production',
	label: '...cret',
	disabled: false,
	is_fallback: false,
	always_use_for_provider: false,
	always_use_for_matching_models: true,
	sort_order: 0,
	allowed_models: null,
	allowed_user_ids: null,
	allowed_api_key_hashes: null,
	created_at: '2026-09-03T00:00:00.000Z',
}

function transport(
	handler: (path: string, init: RequestInit) => Response | Promise<Response>
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) =>
		handler(String(input), init ?? {})) as typeof fetch
}

function result(body: unknown, status = 200): Response {
	return Response.json(body, { status })
}

function code(expected: CinaTokenApiError['code'], status?: number) {
	return (error: unknown) =>
		error instanceof CinaTokenApiError &&
		error.code === expected &&
		(status === undefined || error.status === status)
}

test('BYOK browser methods use exact verbs, Cookie scope and masked outputs including creation', async () => {
	const calls: string[] = []
	const secret = 'upstream-secret'
	const api = createCinaTokenApi(
		transport((path, init) => {
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			assert.equal(
				new Headers(init.headers).get('X-CinaToken-Workspace'),
				'personal%3Aalice'
			)
			assert.equal(new Headers(init.headers).has('New-Api-User'), false)
			calls.push(`${init.method ?? 'GET'} ${path}`)
			if (path.includes('?'))
				return result({
					success: true,
					data: [row],
					total: 1,
					workspaceId: row.workspace_id,
				})
			if (init.method === 'DELETE')
				return result({ success: true, deleted: true })
			if (init.method === 'POST' || init.method === 'PATCH') {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>
				assert.equal(body.key, secret)
				assert.equal(
					new Headers(init.headers).get('Content-Type'),
					'application/json'
				)
			}
			return result(
				{ success: true, data: row },
				init.method === 'POST' ? 201 : 200
			)
		})
	)
	assert.deepEqual(await api.byokKeys(options), {
		data: [row],
		total: 1,
		workspaceId: row.workspace_id,
	})
	assert.deepEqual(await api.byokKey(id.toUpperCase(), options), row)
	const created = await api.createByokKey(
		{ provider: 'openai', key: secret },
		options
	)
	const updated = await api.updateByokKey(id, { key: secret }, options)
	assert.equal(JSON.stringify(created).includes(secret), false)
	assert.equal(JSON.stringify(updated).includes(secret), false)
	assert.equal('key' in created, false)
	await api.deleteByokKey(id, options)
	assert.deepEqual(calls, [
		'GET /api/user/byok?offset=0&limit=50',
		`GET /api/user/byok/${id}`,
		'POST /api/user/byok',
		`PATCH /api/user/byok/${id}`,
		`DELETE /api/user/byok/${id}`,
	])
})

test('server public projection is accepted without importing runtime credentials', async () => {
	const publicRow = publicByokKey({
		...row,
		updated_at: '',
		created_by_management_key_id: null,
	})
	const api = createCinaTokenApi(
		transport(() => result({ success: true, data: publicRow }))
	)
	assert.deepEqual(await api.byokKey(id, options), row)
})

test('provider filtering and nonzero pagination preserve the server total', async () => {
	const api = createCinaTokenApi(
		transport((path) => {
			assert.equal(path, '/api/user/byok?offset=20&limit=10&provider=openai')
			return result({
				success: true,
				data: [row],
				total: 21,
				workspaceId: row.workspace_id,
			})
		})
	)
	assert.equal(
		(
			await api.byokKeys({
				...options,
				offset: 20,
				limit: 10,
				provider: ' openai ',
			})
		).total,
		21
	)
})

test('empty pages beyond the end remain valid but cannot conceal another workspace', async () => {
	let workspaceId = row.workspace_id
	const api = createCinaTokenApi(
		transport(() => result({ success: true, data: [], total: 0, workspaceId }))
	)
	assert.deepEqual((await api.byokKeys({ ...options, offset: 500 })).data, [])
	workspaceId = 'org:other'
	await assert.rejects(api.byokKeys(options), code('workspace-mismatch'))
})

test('pagination metadata, provider identity and individual rows all fail closed', async () => {
	for (const body of [
		{ success: true, data: [], total: 0 },
		{ success: true, data: [], total: -1, workspaceId: row.workspace_id },
		{
			success: true,
			data: [row, row],
			total: 2,
			workspaceId: row.workspace_id,
		},
		{ success: true, data: [row], total: 0, workspaceId: row.workspace_id },
		{
			success: true,
			data: [{ ...row, provider: 'anthropic' }],
			total: 1,
			workspaceId: row.workspace_id,
		},
	]) {
		const api = createCinaTokenApi(transport(() => result(body)))
		await assert.rejects(
			api.byokKeys({ ...options, provider: 'openai' }),
			code('invalid-response')
		)
	}
	const api = createCinaTokenApi(
		transport(() =>
			result({
				success: true,
				data: [{ ...row, workspace_id: 'org:other' }],
				total: 1,
				workspaceId: row.workspace_id,
			})
		)
	)
	await assert.rejects(api.byokKeys(options), code('workspace-mismatch'))
})

test('invalid pagination and unsupported providers are rejected before network requests', async () => {
	let requests = 0
	const api = createCinaTokenApi(
		transport(() => {
			requests++
			return result({})
		})
	)
	for (const input of [
		{ offset: -1 },
		{ offset: 1_000_001 },
		{ offset: 0.5 },
		{ limit: 0 },
		{ limit: 101 },
		{ limit: Number.POSITIVE_INFINITY },
		{ provider: 'OpenAI' },
		{ provider: 'open--ai' },
		{ provider: '../openai' },
	])
		await assert.rejects(api.byokKeys({ ...options, ...input }))
	assert.equal(requests, 0)
})

test('identity or workspace substitution is rejected in detail, create and PATCH', async () => {
	const api = createCinaTokenApi(
		transport(() =>
			result({ success: true, data: { ...row, workspace_id: 'org:other' } })
		)
	)
	await assert.rejects(api.byokKey(id, options), code('workspace-mismatch'))
	await assert.rejects(
		api.createByokKey({ provider: 'openai', key: 'secret' }, options),
		code('workspace-mismatch')
	)
	await assert.rejects(
		api.updateByokKey(id, { disabled: true }, options),
		code('workspace-mismatch')
	)
	const wrongId = createCinaTokenApi(
		transport(() => result({ success: true, data: { ...row, id: otherId } }))
	)
	await assert.rejects(wrongId.byokKey(id, options), code('invalid-response'))
	await assert.rejects(
		wrongId.updateByokKey(id, { disabled: true }, options),
		code('invalid-response')
	)
})

test('an unexpected plaintext field or unmasked label is never returned to a query', async () => {
	for (const data of [
		{ ...row, key: 'provider-secret' },
		{ ...row, api_key: 'provider-secret' },
		{ ...row, api_key_encrypted: 'encrypted-secret' },
		{ ...row, label: 'provider-secret' },
	]) {
		const api = createCinaTokenApi(
			transport(() => result({ success: true, data }))
		)
		await assert.rejects(api.byokKey(id, options), code('invalid-response'))
		await assert.rejects(
			api.createByokKey(
				{ provider: 'openai', key: 'provider-secret' },
				options
			),
			code('invalid-response')
		)
	}
	const api = createCinaTokenApi(
		transport(() =>
			result({ success: true, data: row, key: 'provider-secret' })
		)
	)
	await assert.rejects(
		api.createByokKey({ provider: 'openai', key: 'provider-secret' }, options),
		code('invalid-response')
	)
})

test('write inputs preserve credential bytes and match server name and allowlist normalization', () => {
	const input = {
		provider: ' openai ',
		key: '  secret  ',
		name: '😀'.repeat(255),
		allowed_models: [' model-a ', 'model-a'],
		allowed_user_ids: [],
		allowed_api_key_hashes: ['a'.repeat(64), 'a'.repeat(64)],
	}
	const normalized = createByokKeyInputSchema.parse(input)
	const server = normalizeByokKeyCreate(input, row.workspace_id)
	assert.equal(normalized.key, server.apiKey)
	assert.equal(normalized.name, server.name)
	assert.deepEqual(normalized.allowed_models, server.allowedModels)
	assert.deepEqual(normalized.allowed_user_ids, server.allowedUserIds)
	assert.deepEqual(
		normalized.allowed_api_key_hashes,
		server.allowedApiKeyHashes
	)
	assert.equal(
		createByokKeyInputSchema.parse({ provider: 'openai', key: 's', name: '  ' })
			.name,
		null
	)
})

test('credential limits count UTF-8 bytes rather than characters', () => {
	const base = {
		provider: 'openai',
		key: '界'.repeat(Math.floor(BYOK_MAX_CREDENTIAL_BYTES / 3)),
	}
	assert.equal(createByokKeyInputSchema.safeParse(base).success, true)
	assert.equal(
		createByokKeyInputSchema.safeParse({ ...base, key: `${base.key}界` })
			.success,
		false
	)
	assert.equal(
		createByokKeyInputSchema.safeParse({ ...base, key: ' '.repeat(20) })
			.success,
		false
	)
})

test('JSON escaping cannot bypass the aggregate request byte limit', async () => {
	let requests = 0
	const api = createCinaTokenApi(
		transport(() => {
			requests++
			return result({})
		})
	)
	const key = `x${'\u0000'.repeat(32 * 1024)}`
	assert.equal(
		createByokKeyInputSchema.safeParse({ provider: 'openai', key }).success,
		true
	)
	await assert.rejects(
		api.createByokKey({ provider: 'openai', key }, options),
		TypeError
	)
	await assert.rejects(api.updateByokKey(id, { key }, options), TypeError)
	assert.equal(requests, 0)
})

test('unsupported money, expiry and writable identity fields cannot cross the BYOK contract', async () => {
	let requests = 0
	const api = createCinaTokenApi(
		transport(() => {
			requests++
			return result({})
		})
	)
	for (const extra of [
		{ limit: 10 },
		{ expires_at: null },
		{ account_type: 'personal' },
		{ label: 'secret' },
		{ sort_order: 2 },
	])
		await assert.rejects(
			api.createByokKey(
				{ provider: 'openai', key: 'secret', ...extra },
				options
			)
		)
	for (const extra of [
		{ provider: 'anthropic' },
		{ workspace_id: 'org:other' },
		{ limit: 10 },
	])
		await assert.rejects(
			api.updateByokKey(id, { name: 'test', ...extra }, options)
		)
	await assert.rejects(
		api.createByokKey(
			{ provider: 'openai', key: 'secret', workspace_id: 'org:other' },
			options
		),
		code('workspace-mismatch')
	)
	await assert.rejects(api.updateByokKey(id, {}, options))
	assert.equal(requests, 0)
})

test('allowlists retain null versus empty semantics and enforce account key hash format', () => {
	assert.deepEqual(patchByokKeyInputSchema.parse({ allowed_models: [] }), {
		allowed_models: [],
	})
	assert.deepEqual(patchByokKeyInputSchema.parse({ allowed_models: null }), {
		allowed_models: null,
	})
	for (const input of [
		{ allowed_api_key_hashes: [] },
		{ allowed_api_key_hashes: [`sha256:${'a'.repeat(64)}`] },
		{ allowed_api_key_hashes: ['A'.repeat(64)] },
		{ allowed_models: ['bad\nmodel'] },
		{
			allowed_user_ids: Array.from(
				{ length: 101 },
				(_, index) => `user:${index}`
			),
		},
	])
		assert.equal(patchByokKeyInputSchema.safeParse(input).success, false)
	assert.deepEqual(
		normalizeByokKeyPatch({ allowed_models: [] }).allowedModels,
		[]
	)
})

test('shared-capacity policies match backend prioritized/fallback rules', () => {
	for (const policy of [
		{ is_fallback: true, always_use_for_provider: true },
		{ is_fallback: true, always_use_for_matching_models: true },
		{ always_use_for_provider: true, always_use_for_matching_models: true },
	]) {
		assert.equal(
			createByokKeyInputSchema.safeParse({
				provider: 'openai',
				key: 'secret',
				...policy,
			}).success,
			false
		)
		assert.equal(patchByokKeyInputSchema.safeParse(policy).success, false)
		assert.throws(() => normalizeByokKeyPatch(policy), TypeError)
	}
})

test('complete ordering sends disabled entries and verifies exact ordered acknowledgment', async () => {
	const input = {
		provider: 'openai',
		keys: [
			{ id: id.toUpperCase(), is_fallback: false },
			{ id: otherId, is_fallback: true },
		],
	}
	const server = normalizeByokKeyReorder(input, row.workspace_id)
	const normalized = reorderByokKeysInputSchema.parse(input)
	assert.deepEqual(
		normalized.keys.map((key) => key.id),
		server.keys.map((key) => key.id)
	)
	const data = {
		workspace_id: row.workspace_id,
		provider: 'openai',
		keys: normalized.keys.map((key, sort_order) => ({ ...key, sort_order })),
	}
	const api = createCinaTokenApi(
		transport((path, init) => {
			assert.equal(path, '/api/user/byok/reorder')
			assert.equal(init.method, 'POST')
			assert.deepEqual(JSON.parse(String(init.body)), normalized)
			return result({ success: true, data })
		})
	)
	assert.deepEqual(await api.reorderByokKeys(input, options), data)
})

test('ordering rejects missing/duplicate IDs, partial structure and fallback before prioritized entries', async () => {
	let requests = 0
	const api = createCinaTokenApi(
		transport(() => {
			requests++
			return result({})
		})
	)
	for (const keys of [
		[],
		[{ id: 'invalid', is_fallback: false }],
		[
			{ id, is_fallback: false },
			{ id: id.toUpperCase(), is_fallback: true },
		],
		[
			{ id, is_fallback: true },
			{ id: otherId, is_fallback: false },
		],
		[{ id, is_fallback: false, sort_order: 4 }],
		Array.from({ length: 101 }, () => ({ id, is_fallback: false })),
	])
		await assert.rejects(
			api.reorderByokKeys({ provider: 'openai', keys }, options)
		)
	assert.equal(requests, 0)
})

test('mismatched ordering acknowledgments cannot report success', async () => {
	const input = { provider: 'openai', keys: [{ id, is_fallback: false }] }
	const data = {
		workspace_id: row.workspace_id,
		provider: 'openai',
		keys: [{ id, is_fallback: false, sort_order: 0 }],
	}
	for (const changed of [
		{ ...data, provider: 'anthropic' },
		{ ...data, keys: [] },
		{ ...data, keys: [{ id: otherId, is_fallback: false, sort_order: 0 }] },
		{ ...data, keys: [{ id, is_fallback: true, sort_order: 0 }] },
		{ ...data, keys: [{ id, is_fallback: false, sort_order: 1 }] },
	]) {
		const api = createCinaTokenApi(
			transport(() => result({ success: true, data: changed }))
		)
		await assert.rejects(
			api.reorderByokKeys(input, options),
			code('invalid-response')
		)
	}
})

test('workspace conflict and changed provider group remain distinguishable without replay', async () => {
	for (const body of [
		{
			success: false,
			code: 'workspace_mismatch',
			message: 'Workspace changed',
		},
		{
			success: false,
			message:
				'BYOK credentials changed; reload the complete provider list and retry',
		},
	]) {
		let requests = 0
		const api = createCinaTokenApi(
			transport(() => {
				requests++
				return result(body, 409)
			})
		)
		await assert.rejects(
			api.reorderByokKeys(
				{ provider: 'openai', keys: [{ id, is_fallback: false }] },
				options
			),
			code('code' in body ? 'workspace-mismatch' : 'http', 409)
		)
		assert.equal(requests, 1)
	}
})

test('403 permissions, 400 validation, 404 missing and 413 body limits preserve status', async () => {
	for (const status of [400, 401, 403, 404, 413]) {
		const api = createCinaTokenApi(
			transport(() => result({ success: false, message: 'Rejected' }, status))
		)
		await assert.rejects(
			api.createByokKey({ provider: 'openai', key: 'secret' }, options),
			code('http', status)
		)
	}
})

test('cancellation remains authoritative for a BYOK write with a late response', async () => {
	const controller = new AbortController()
	const api = createCinaTokenApi(
		transport(() => {
			controller.abort()
			return result({ success: true, data: row }, 201)
		})
	)
	await assert.rejects(
		api.createByokKey(
			{ provider: 'openai', key: 'secret' },
			{ ...options, signal: controller.signal }
		),
		code('cancelled')
	)
})

test('delete requires server deletion confirmation and never reveals upstream credentials', async () => {
	const api = createCinaTokenApi(transport(() => result({ success: true })))
	await assert.rejects(api.deleteByokKey(id, options), code('invalid-response'))
})
