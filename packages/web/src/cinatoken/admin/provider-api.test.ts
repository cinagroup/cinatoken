import type { z } from 'zod'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError } from '../api'
import {
	adminDomainFixtureAuth,
	adminDomainFixtureAck,
	bindAdminDomainFixtureApi,
} from './domain-api-test-fixture'
import { AdminDomainWriteError } from './domain-write-recovery'
import {
	createProvidersApi,
	type ProviderAdminTransport,
	type ProviderRequestOptions,
} from './provider-api'
import {
	providerMaskedKeySchema,
	PROVIDER_OPERATION_PERMISSIONS,
	type ProviderJsonObject,
} from './provider-contracts'
import { ProviderInputError } from './provider-input'

const row = {
	id: 'provider/one',
	name: 'Provider One',
	vendor_key: 'other',
	icon_key: 'other',
	endpoints: JSON.stringify({
		openai: { base: 'https://upstream.example/v1/' },
	}),
	api_key: 'sk-…abcd',
	status: 'active',
	description: null,
	shared_channel_type: null,
	created_at: '2026-09-27T00:00:00.000Z',
	has_pending_key: false,
	routes_count: 2,
	active_routes_count: 1,
}
type Reply = { body: unknown; status?: number }
type Call = { path: string; init: RequestInit; options: ProviderRequestOptions }
function fixture(
	reply: Reply | ((call: Call) => Reply | Promise<Reply>) = {
		body: { success: true, data: [row], count: 1 },
	}
) {
	const calls: Call[] = []
	const transport: ProviderAdminTransport = {
		async send<T>(
			path: string,
			schema: z.ZodType<T>,
			init: RequestInit,
			options: ProviderRequestOptions,
			reader?: (response: Response) => Promise<unknown>
		): Promise<T> {
			const auth = adminDomainFixtureAuth(path)
			if (auth !== undefined) return schema.parse(auth)
			const call = { path, init, options }
			calls.push(call)
			const result = typeof reply === 'function' ? await reply(call) : reply
			if (result.status && result.status >= 400)
				throw new CinaTokenApiError(
					'Unsafe server echo PRIVATE-CREDENTIAL',
					result.status,
					'http'
				)
			let body = adminDomainFixtureAck(path, init, result.body)
			if (reader && path.includes('/dashscope/')) {
				const ack = (body as { acknowledgement: unknown }).acknowledgement
				// Reject non-JSON fixture values before Response serialization can replace NaN with null.
				if (
					typeof result.body === 'object' &&
					result.body !== null &&
					'output' in result.body &&
					Number.isNaN(result.body.output)
				)
					throw new CinaTokenApiError('Invalid JSON', 200, 'invalid-response')
				body = await reader(
					Response.json(result.body, {
						headers: { 'X-CinaToken-Acknowledgement': JSON.stringify(ack) },
					})
				)
			}
			const parsed = schema.safeParse(body)
			if (!parsed.success)
				throw new CinaTokenApiError(
					'Invalid provider response',
					200,
					'invalid-response'
				)
			return parsed.data
		},
		invalidResponse(message): never {
			throw new CinaTokenApiError(message, 0, 'invalid-response')
		},
		sanitizeError(error) {
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'Provider request failed',
					error.status,
					error.code,
					error.serverCode
				)
			if (error instanceof DOMException && error.name === 'AbortError')
				return new CinaTokenApiError(
					'Provider request cancelled',
					0,
					'cancelled'
				)
			return new Error('Provider request failed')
		},
	}
	return {
		api: bindAdminDomainFixtureApi(createProvidersApi(transport), {
			createProvider: 1,
			updateProvider: 2,
			cloneProvider: 2,
			deleteProvider: 1,
			importProviders: 1,
			manageProviderDashScope: 3,
		}),
		calls,
	}
}
const invalid = (error: unknown) =>
	(error instanceof CinaTokenApiError && error.code === 'invalid-response') ||
	(error instanceof AdminDomainWriteError && error.code === 'unknown')
function body(call: Call): Record<string, unknown> {
	return JSON.parse(String(call.init.body)) as Record<string, unknown>
}

test('provider list projects only masked DTO fields and has no account/workspace request scope', async () => {
	const { api, calls } = fixture({
		body: {
			success: true,
			data: [
				{
					...row,
					encrypted_api_key: 'PRIVATE-CREDENTIAL',
					private_key: 'PRIVATE-CREDENTIAL',
				},
			],
			count: 1,
		},
	})
	const signal = new AbortController().signal
	const accountOptions = {
		signal,
		timeoutMs: 2222,
		expectedWorkspaceId: 'wrong-workspace',
		expectedOwnerUserId: 'wrong-owner',
	}
	const result = await api.providerList(accountOptions)
	assert.equal(result[0].api_key, row.api_key)
	assert.equal(result[0].endpointsState, 'available')
	assert.equal(JSON.stringify(result).includes('PRIVATE-CREDENTIAL'), false)
	assert.deepEqual(calls[0].options, { signal, timeoutMs: 2222 })
	assert.equal(
		new Headers(calls[0].init.headers).has('X-CinaToken-Workspace'),
		false
	)
	assert.equal(calls[0].path, '/api/admin/providers')
})
test('unsafe or corrupt endpoints disable only that field while other rows and CRUD remain available', async () => {
	const rows = [
		row,
		{
			...row,
			id: 'unsafe',
			endpoints:
				'{"openai":{"base":"https://user:PRIVATE-CREDENTIAL@upstream.example/v1?key=PRIVATE-CREDENTIAL"}}',
		},
		{ ...row, id: 'corrupt', endpoints: 'PRIVATE-CREDENTIAL-not-json' },
	]
	const { api, calls } = fixture((call) => ({
		body:
			call.init.method === 'PATCH'
				? { success: true }
				: { success: true, data: rows, count: 3 },
	}))
	const result = await api.providerList()
	assert.equal(result.length, 3)
	assert.equal(result[1].endpoints, null)
	assert.equal(result[1].endpointsState, 'redacted')
	assert.equal(result[2].endpoints, null)
	assert.equal(result[2].endpointsState, 'invalid')
	assert.equal(JSON.stringify(result).includes('PRIVATE-CREDENTIAL'), false)
	await api.updateProvider('unsafe', { status: 'disabled' })
	assert.deepEqual(body(calls.at(-1)!), { status: 'disabled' })
})
test('ignored endpoint fields are not retained as raw JSON in a masked DTO', async () => {
	const { api } = fixture({
		body: {
			success: true,
			data: [
				{
					...row,
					endpoints:
						'{"openai":{"base":"https://upstream.example/v1","api_key":"PRIVATE-CREDENTIAL"}}',
				},
			],
			count: 1,
		},
	})
	const result = await api.providerList()
	assert.equal(result[0].endpointsState, 'available')
	assert.equal(JSON.stringify(result).includes('PRIVATE-CREDENTIAL'), false)
})
test('full plaintext or service-account JSON cannot enter the normal masked provider list', async () => {
	for (const apiKey of [
		'sk-private-credential',
		'{"private_key":"PRIVATE-CREDENTIAL"}',
		'env:lowercase',
		'sa:PRIVATE-CREDENTIAL',
	]) {
		await assert.rejects(
			fixture({
				body: { success: true, data: [{ ...row, api_key: apiKey }], count: 1 },
			}).api.providerList(),
			invalid
		)
	}
	for (const apiKey of [
		'(empty)',
		'***',
		'sk-…abcd',
		'env:DEEPSEEK_API_KEY',
		'sa:service@project.iam.gserviceaccount.com',
	])
		assert.equal(providerMaskedKeySchema.safeParse(apiKey).success, true)
})
test('count, duplicate identity, status and impossible route counts are checked', async () => {
	for (const response of [
		{ success: true, data: [row], count: 2 },
		{ success: true, data: [row, row], count: 2 },
		{ success: true, data: [{ ...row, status: 'unknown' }], count: 1 },
		{ success: true, data: [{ ...row, active_routes_count: 3 }], count: 1 },
	])
		await assert.rejects(
			fixture({ body: response }).api.providerList(),
			invalid
		)
	assert.deepEqual(
		await fixture({
			body: { success: true, data: [], count: 0 },
		}).api.providerList(),
		[]
	)
})
test('detail validates returned identity and URL-encodes IDs without a new ownership model', async () => {
	const { api, calls } = fixture({ body: { success: true, data: row } })
	assert.equal((await api.provider(row.id)).id, row.id)
	assert.equal(calls[0].path, '/api/admin/providers/provider%2Fone')
	await assert.rejects(
		fixture({
			body: { success: true, data: { ...row, id: 'other' } },
		}).api.provider(row.id),
		invalid
	)
})
test('create uses exact supported fields and returns only the new identity', async () => {
	const { api, calls } = fixture({
		body: {
			success: true,
			message: 'Unsafe PRIVATE-CREDENTIAL',
			data: { id: 'custom', api_key: 'PRIVATE-CREDENTIAL' },
		},
	})
	assert.deepEqual(
		await api.createProvider({
			id: 'custom',
			name: '  New provider  ',
			api_key: ' PRIVATE-CREDENTIAL ',
			endpoints: {
				gemini: { base: 'https://upstream.example/v1', auth: 'bearer' },
			},
			status: 'disabled',
			shared_channel_type: null,
		}),
		{ id: 'custom' }
	)
	assert.equal(calls[0].init.method, 'POST')
	assert.equal(body(calls[0]).name, 'New provider')
	assert.equal(body(calls[0]).api_key, 'PRIVATE-CREDENTIAL')
	assert.deepEqual(body(calls[0]).endpoints, {
		gemini: { base: 'https://upstream.example/v1', auth: 'bearer' },
	})
	await assert.rejects(
		fixture({
			body: { success: true, data: { id: 'other' } },
		}).api.createProvider({ id: 'custom', name: 'New', api_key: 'fixture' }),
		invalid
	)
})
test('shared-channel create may omit provider key while ordinary create fails before a request', async () => {
	const { api, calls } = fixture({
		body: { success: true, data: { id: 'new' } },
	})
	await api.createProvider({ name: 'Shared', shared_channel_type: 'deepseek' })
	const count = calls.length
	await assert.rejects(
		api.createProvider({ name: 'No key' }),
		ProviderInputError
	)
	assert.equal(calls.length, count)
})
test('PATCH distinguishes omitted, undefined and explicit null endpoints and blank key means unchanged', async () => {
	const { api, calls } = fixture({ body: { success: true } })
	await api.updateProvider('redacted', { status: 'disabled', api_key: '   ' })
	assert.deepEqual(body(calls.at(-1)!), { status: 'disabled' })
	await api.updateProvider('redacted', {
		name: 'Renamed',
		endpoints: undefined,
	})
	assert.deepEqual(body(calls.at(-1)!), { name: 'Renamed' })
	await api.updateProvider('redacted', { endpoints: null })
	assert.deepEqual(body(calls.at(-1)!), { endpoints: null })
})
test('explicitly entered credential URL keeps Core write semantics but is never reflected into cached DTO', async () => {
	const { api, calls } = fixture({ body: { success: true } })
	await api.updateProvider('redacted', {
		endpoints: {
			openai: {
				base: 'https://upstream.example/v1?api_key=PRIVATE-CREDENTIAL',
			},
		},
	})
	assert.match(JSON.stringify(body(calls[0])), /PRIVATE-CREDENTIAL/u)
})
test('clone is disabled, preserves safe configuration, and requires a new credential instead of copying mask', async () => {
	const { api, calls } = fixture((call) => ({
		body:
			call.init.method === 'POST'
				? { success: true, data: { id: 'clone' } }
				: { success: true, data: row },
	}))
	assert.deepEqual(
		await api.cloneProvider(row.id, {
			id: 'clone',
			name: 'Copy',
			api_key: 'NEW-CREDENTIAL',
		}),
		{ id: 'clone' }
	)
	const created = body(calls.at(-1)!)
	assert.equal(created.status, 'disabled')
	assert.equal(created.api_key, 'NEW-CREDENTIAL')
	assert.deepEqual(created.endpoints, {
		openai: { base: 'https://upstream.example/v1' },
	})
	await assert.rejects(
		api.cloneProvider(row.id, { name: 'Copy without key' }),
		ProviderInputError
	)
	assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1)
})
test('clone cannot silently clear redacted endpoints; explicit replacement or clearing is required', async () => {
	const { api, calls } = fixture((call) => ({
		body:
			call.init.method === 'POST'
				? { success: true, data: { id: 'clone' } }
				: {
						success: true,
						data: {
							...row,
							endpoints:
								'{"openai":{"base":"https://upstream.example?key=PRIVATE-CREDENTIAL"}}',
						},
					},
	}))
	await assert.rejects(
		api.cloneProvider(row.id, { name: 'Copy', api_key: 'NEW-CREDENTIAL' }),
		ProviderInputError
	)
	assert.equal(calls.filter((call) => call.init.method === 'POST').length, 0)
	await api.cloneProvider(row.id, {
		name: 'Repair copy',
		api_key: 'NEW-CREDENTIAL',
		endpoints: null,
	})
	assert.equal(body(calls.at(-1)!).endpoints, null)
})
test('catalog returns real index keys, four protocols and no secret columns', async () => {
	const item = {
		id: '12',
		name: 'Template',
		vendor_key: 'aliyun',
		icon_key: 'bailian',
		vendor_label: 'Alibaba',
		protocols: ['openai', 'anthropic', 'gemini', 'dashscope'],
		endpoints: row.endpoints,
		description: null,
		api_key: 'PRIVATE-CREDENTIAL',
	}
	const { api, calls } = fixture({
		body: { success: true, data: [item], count: 1 },
	})
	const result = await api.providerCatalog()
	assert.equal(calls[0].path, '/api/admin/providers/import/catalog')
	assert.equal(result[0].id, '12')
	assert.equal(JSON.stringify(result).includes('PRIVATE-CREDENTIAL'), false)
})
test('partial import preserves all counts, managed-template skips and failure IDs with safe error text', async () => {
	const { api, calls } = fixture({
		body: {
			success: true,
			data: {
				created: 1,
				updated: 0,
				skipped_existing: ['2'],
				failed: [
					{
						id: '3',
						message: 'PRIVATE-CREDENTIAL database echo',
						raw: 'PRIVATE-CREDENTIAL',
					},
				],
			},
		},
	})
	const result = await api.importProviders(['1', '2', '3', '1'])
	assert.deepEqual(body(calls[0]), { ids: ['1', '2', '3'] })
	assert.deepEqual(result, {
		created: 1,
		updated: 0,
		skipped_existing: ['2'],
		failed: [{ id: '3', message: 'Provider import failed' }],
	})
})
test('invalid import outcomes reject unknown IDs, duplicates, count mismatch and nonzero updated', async () => {
	for (const data of [
		{ created: 0, updated: 0, skipped_existing: ['unknown'], failed: [] },
		{ created: 0, updated: 0, skipped_existing: ['1', '1'], failed: [] },
		{ created: 0, updated: 0, skipped_existing: [], failed: [] },
		{ created: 1, updated: 1, skipped_existing: [], failed: [] },
	])
		await assert.rejects(
			fixture({ body: { success: true, data } }).api.importProviders(['1']),
			invalid
		)
})
test('reveal is an explicit separate path and never enriches the normal list response', async () => {
	const { api, calls } = fixture((call) => ({
		body: call.path.endsWith('/api-key')
			? {
					success: true,
					data: { api_key: 'PRIVATE-CREDENTIAL', extra: 'discard' },
				}
			: { success: true, data: [row], count: 1 },
	}))
	assert.equal(await api.revealProviderKey(row.id), 'PRIVATE-CREDENTIAL')
	assert.equal(calls[0].path, '/api/admin/providers/provider%2Fone/api-key')
	assert.equal((await api.providerList())[0].api_key, row.api_key)
	assert.equal((await api.revealProviderKey(row.id)).length > 0, true)
})
test('DashScope keeps official JSON unchanged on send and preserves all legal response diagnostics', async () => {
	const input: ProviderJsonObject = {
		model: 'minimax/speech-02',
		input: {
			action: 'list_voice',
			extra_future_field: { token: 'resource-token' },
		},
	}
	const response = {
		request_id: 'request-1',
		output: {
			voices: [
				{ voice_id: 'voice-1', secret: 'voice-label', token: 'resource-token' },
			],
		},
		message: 'Diagnostic retained',
		unknown_future_field: [null, true, 0],
	}
	const { api, calls } = fixture({ body: response })
	const result = await api.manageProviderDashScope(row.id, 'voices', input)
	assert.deepEqual(body(calls[0]), input)
	assert.equal(
		calls[0].path,
		'/api/admin/providers/provider%2Fone/dashscope/voices'
	)
	assert.equal(calls[0].init.method, 'POST')
	assert.deepEqual(result, { body: response, redactedPaths: [] })
})
test('DashScope explicitly marks only credential fields or known secret echoes without dropping legitimate keys', async () => {
	const response = {
		message: 'Echo PRIVATE-CREDENTIAL',
		output: {
			api_key: 'PRIVATE-CREDENTIAL',
			private_key: 'private material',
			secret: 'keep',
			token: 'keep',
			voices: [{ authorization: 'Bearer PRIVATE-CREDENTIAL' }],
		},
	}
	const { api, calls } = fixture({ body: response })
	const result = await api.manageProviderDashScope(
		row.id,
		'hotwords',
		{ input: { action: 'list_vocabulary' } },
		{ knownSecrets: ['PRIVATE-CREDENTIAL'] }
	)
	assert.deepEqual(result.body, {
		message: 'Echo [REDACTED]',
		output: {
			api_key: '[REDACTED]',
			private_key: '[REDACTED]',
			secret: 'keep',
			token: 'keep',
			voices: [{ authorization: '[REDACTED]' }],
		},
	})
	assert.deepEqual(result.redactedPaths, [
		'/message',
		'/output/api_key',
		'/output/private_key',
		'/output/voices/0/authorization',
	])
	assert.equal('knownSecrets' in calls[0].options, false)
})
test('malformed native JSON fails safely and illegal request JSON never reaches the transport', async () => {
	for (const response of [[], null, { output: Number.NaN }])
		await assert.rejects(
			fixture({ body: response }).api.manageProviderDashScope(
				row.id,
				'hotwords',
				{}
			),
			invalid
		)
	const { api, calls } = fixture()
	await assert.rejects(
		api.manageProviderDashScope(row.id, 'hotwords', {
			value: Number.POSITIVE_INFINITY,
		}),
		ProviderInputError
	)
	assert.equal(calls.length, 0)
})
test('401/403/409/5xx errors retain their status and never retry or retain credential echo', async () => {
	for (const status of [401, 403, 409, 500, 503]) {
		const { api, calls } = fixture({ body: {}, status })
		await assert.rejects(
			api.deleteProvider(row.id),
			(error: unknown) =>
				(error instanceof CinaTokenApiError ||
					error instanceof AdminDomainWriteError) &&
				error.status === status &&
				!error.message.includes('PRIVATE-CREDENTIAL')
		)
		assert.equal(calls.length, 1)
	}
})
test('abort is forwarded and remains authoritative before send and after an ignoring transport settles', async () => {
	const controller = new AbortController()
	controller.abort()
	const blocked = fixture()
	await assert.rejects(
		blocked.api.providerList({ signal: controller.signal }),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
	assert.equal(blocked.calls.length, 0)
	const late = new AbortController()
	const response = fixture(async () => {
		late.abort()
		return { body: { success: true, data: [row], count: 1 } }
	})
	await assert.rejects(
		response.api.providerList({ signal: late.signal }),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
	assert.equal(response.calls[0].options.signal, late.signal)
})
test('permission contract keeps reveal separate from list/read and writes', () => {
	assert.deepEqual(PROVIDER_OPERATION_PERMISSIONS, {
		read: 'providers.read',
		write: 'providers.write',
		reveal: 'providers.secrets.read',
		dashscope: 'providers.write',
	})
})
