import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../api'
import { deferred } from '../test-fixtures'
import {
	adminDomainFixtureAuth,
	adminDomainFixtureAck,
	bindAdminDomainFixtureApi,
} from './domain-api-test-fixture'
import { AdminDomainWriteError } from './domain-write-recovery'
import { createModelsApi } from './model-api'
import { ModelInputError } from './model-input'

const row = {
	id: 'vendor/model',
	display_name: 'Model',
	vendor: 'deepseek',
	context_window: 65_536,
	max_tokens: 8192,
	pricing_profile: '{"tiers":[{"upto":null,"input_price":1,"output_price":2}]}',
	input_modalities: '["text","image"]',
	output_modalities: '["text"]',
	released_at: '2026-01-01',
	description: null,
	metadata: null,
	route_policy: null,
	created_at: '2026-09-27T00:00:00.000Z',
	routes_count: 2,
	active_routes_count: 1,
	tags: ['vision'],
}
type Call = { path: string; init: RequestInit }
function fixture(reply: (call: Call) => Promise<Response>) {
	const calls: Call[] = []
	const request: typeof fetch = async (input, init) => {
		const call = { path: String(input), init: init ?? {} }
		const auth = adminDomainFixtureAuth(call.path)
		if (auth !== undefined) return Response.json(auth)
		calls.push(call)
		const response = await reply(call)
		if ((call.init.method ?? 'GET') === 'GET' || !response.ok) return response
		try {
			return Response.json(
				adminDomainFixtureAck(
					call.path,
					call.init,
					await response.clone().json()
				),
				{ status: response.status, headers: response.headers }
			)
		} catch {
			return response
		}
	}
	const transport = createCinaTokenCookieTransport(request)
	const api = createModelsApi({
		send(path, schema, init, options) {
			return transport.send(path, schema, init, options)
		},
		invalidResponse() {
			throw new CinaTokenApiError(
				'Model response is invalid',
				200,
				'invalid-response'
			)
		},
		sanitizeError(error) {
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'Model operation could not be confirmed',
					error.status,
					error.code
				)
			if (error instanceof DOMException && error.name === 'AbortError')
				return new CinaTokenApiError(
					'Model operation was cancelled',
					0,
					'cancelled'
				)
			return new Error('Model operation could not be confirmed')
		},
	})
	return {
		api: bindAdminDomainFixtureApi(api, {
			createModel: 1,
			updateModel: 2,
			deleteModel: 1,
			importModels: 1,
		}),
		calls,
	}
}
function invalid(error: unknown): boolean {
	return (
		(error instanceof CinaTokenApiError && error.code === 'invalid-response') ||
		(error instanceof AdminDomainWriteError && error.code === 'unknown')
	)
}

test('route policy PATCH requires the original exact baseline before dispatch and preserves NULL/whitespace without normalizing expected bytes', async () => {
	const { api, calls } = fixture(async () => Response.json({ success: true }))
	await assert.rejects(
		api.updateModel(row.id, { route_policy: null }),
		ModelInputError
	)
	assert.equal(calls.length, 0)
	for (const expected_route_policy of [
		null,
		' { "strategy": "weighted_random" } ',
	]) {
		await api.updateModel(row.id, { route_policy: null, expected_route_policy })
		assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), {
			route_policy: null,
			expected_route_policy,
		})
	}
})

test('list uses real same-origin Cookie transport, discards private columns, and preserves multimodal LLM classification', async () => {
	const { api, calls } = fixture(async () =>
		Response.json({
			success: true,
			data: [{ ...row, api_key: 'PRIVATE', provider_id: 'not-a-model-field' }],
			count: 1,
			billing_currency: 'CNY',
		})
	)
	const accountOptions = {
		expectedWorkspaceId: 'wrong-workspace',
		expectedOwnerUserId: 'wrong-owner',
		timeoutMs: 500,
	}
	const rows = await api.modelList(accountOptions)
	assert.equal(
		rows[0].kind,
		'llm',
		'image input alone does not imply image generation'
	)
	assert.equal(rows[0].pricing.state, 'available')
	assert.deepEqual(rows[0].inputModalities, ['image', 'text'])
	assert.equal(JSON.stringify(rows).includes('PRIVATE'), false)
	assert.equal((await api.modelListContext()).billingCurrency, 'CNY')
	assert.equal(calls[0].path, '/api/admin/models')
	assert.equal(calls[0].init.credentials, 'same-origin')
	assert.equal(calls[0].init.cache, 'no-store')
	const headers = new Headers(calls[0].init.headers)
	for (const name of ['Authorization', 'New-Api-User', 'X-CinaToken-Workspace'])
		assert.equal(headers.get(name), null)
	assert.equal(headers.get('Accept'), 'application/json')
})

test('legacy missing/invalid pricing does not hide other models, and rerank/image/audio nullable limits are supported', async () => {
	const values = [
		row,
		{ ...row, id: 'missing', pricing_profile: null },
		{ ...row, id: 'invalid', pricing_profile: '{invalid' },
		{ ...row, id: 'rerank', output_modalities: '["rerank"]', max_tokens: null },
		{
			...row,
			id: 'image',
			output_modalities: '["image"]',
			context_window: null,
			max_tokens: null,
		},
		{
			...row,
			id: 'speech',
			output_modalities: '["speech"]',
			context_window: null,
			max_tokens: null,
		},
	]
	const { api } = fixture(async () =>
		Response.json({
			success: true,
			data: values,
			count: values.length,
			billing_currency: 'USD',
		})
	)
	const models = await api.modelList()
	assert.deepEqual(
		models.map((item) => item.kind),
		['llm', 'llm', 'llm', 'rerank', 'image', 'audio']
	)
	assert.equal(models[1].pricing.state, 'missing')
	assert.equal(models[2].pricing.state, 'invalid')
	assert.equal(models[4].max_tokens, null)
})

test('list rejects inconsistent counts, duplicate identities and impossible active route counts', async () => {
	for (const body of [
		{ success: true, data: [row], count: 0, billing_currency: 'USD' },
		{ success: true, data: [row, row], count: 2, billing_currency: 'USD' },
		{
			success: true,
			data: [{ ...row, active_routes_count: 3 }],
			count: 1,
			billing_currency: 'USD',
		},
	]) {
		const { api } = fixture(async () => Response.json(body))
		await assert.rejects(api.modelList(), invalid)
	}
})

test('detail encodes the exact model id and rejects a different returned model', async () => {
	const { api, calls } = fixture(async () =>
		Response.json({ success: true, data: row, billing_currency: 'EUR' })
	)
	assert.equal((await api.model(row.id)).id, row.id)
	assert.equal((await api.modelContext(row.id)).billingCurrency, 'EUR')
	assert.equal(calls[0].path, '/api/admin/models/vendor%2Fmodel')
	await assert.rejects(api.model('other'), invalid)
})

test('empty model context keeps the authoritative current currency while missing metadata fails closed', async () => {
	const empty = fixture(async () =>
		Response.json({
			success: true,
			data: [],
			count: 0,
			billing_currency: 'CNY',
		})
	)
	assert.deepEqual(await empty.api.modelListContext(), {
		rows: [],
		billingCurrency: 'CNY',
	})
	const missing = fixture(async () =>
		Response.json({ success: true, data: [], count: 0 })
	)
	await assert.rejects(missing.api.modelListContext(), invalid)
	const mismatched = fixture(async () =>
		Response.json({ success: true, data: row, billing_currency: 'usd' })
	)
	await assert.rejects(mismatched.api.modelContext(row.id), invalid)
})

test('catalog preserves server CNY branch and summaries without inventing full pricing or supplier linkage', async () => {
	const catalog = {
		id: 'image',
		display_name: 'Image',
		vendor: 'openai',
		kind: 'image',
		context_window: null,
		max_tokens: null,
		description: null,
		i18n: { en: 'Image', zh: '图像' },
		tier_count: 0,
		pricing_label: '¥0.35/image',
		pricing_preview: 'Per image CNY',
		pricing_profile: 'not included',
	}
	const { api, calls } = fixture(async () =>
		Response.json({
			success: true,
			data: [catalog],
			count: 1,
			billing_currency: 'CNY',
		})
	)
	const result = await api.modelCatalog()
	assert.equal(result.billingCurrency, 'CNY')
	assert.equal(result.items[0].pricing_label, '¥0.35/image')
	assert.equal('pricing_profile' in result.items[0], false)
	assert.equal(calls[0].path, '/api/admin/models/import/catalog')
	const missing = fixture(async () =>
		Response.json({ success: true, data: [], count: 0 })
	)
	await assert.rejects(missing.api.modelCatalog(), invalid)
})

test('create validates requested identity; PATCH and cascade DELETE return void and perform no supplier operations', async () => {
	const { api, calls } = fixture(async (call) =>
		call.init.method === 'POST'
			? Response.json({ success: true, data: { id: row.id } })
			: Response.json({ success: true })
	)
	assert.deepEqual(
		await api.createModel({ id: row.id, pricing_profile: row.pricing_profile }),
		{ id: row.id }
	)
	assert.equal(
		await api.updateModel(row.id, { metadata: null, tags: [] }),
		undefined
	)
	assert.equal(await api.deleteModel(row.id), undefined)
	assert.deepEqual(
		calls.map((call) => call.init.method),
		['POST', 'PATCH', 'DELETE']
	)
	assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
		metadata: null,
		tags: [],
	})
	assert.equal(
		calls.some(
			(call) =>
				call.path.includes('/providers') || call.path.includes('/routes')
		),
		false
	)
	const wrong = fixture(async () =>
		Response.json({ success: true, data: { id: 'wrong' } })
	)
	await assert.rejects(
		wrong.api.createModel({ id: row.id, pricing_profile: row.pricing_profile }),
		invalid
	)
})

test('partial import validates every outcome, records actual currency, never overwrites existing rows, and strips failure text', async () => {
	const { api, calls } = fixture(async () =>
		Response.json({
			success: true,
			data: {
				created: 1,
				updated: 0,
				billing_currency_used: 'CNY',
				skipped_existing: ['existing'],
				failed: [
					{ id: 'invalid', message: 'PRIVATE SQL data' },
					{ id: 'unknown', message: 'PRIVATE' },
				],
			},
		})
	)
	const result = await api.importModels([
		'created',
		'existing',
		'invalid',
		'unknown',
		'created',
	])
	assert.equal(result.created, 1)
	assert.equal(result.updated, 0)
	assert.equal(result.billing_currency_used, 'CNY')
	assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
	assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
		ids: ['created', 'existing', 'invalid', 'unknown'],
	})
	assert.equal(calls[0].path, '/api/admin/models/import')
	for (const data of [
		{ ...result, created: 2 },
		{ ...result, updated: 1 },
		{
			...result,
			failed: [
				{ id: 'existing', message: 'duplicate' },
				{ id: 'unknown', message: 'unknown' },
			],
		},
		{
			...result,
			failed: [
				{ id: 'not-selected', message: 'wrong' },
				{ id: 'unknown', message: 'unknown' },
			],
		},
	]) {
		const invalidResult = fixture(async () =>
			Response.json({ success: true, data })
		)
		await assert.rejects(
			invalidResult.api.importModels([
				'created',
				'existing',
				'invalid',
				'unknown',
			]),
			invalid
		)
	}
})

test('authorization, conflict and transient failures retain their status, sanitize errors and never replay a write', async () => {
	for (const status of [401, 403, 409, 429, 503]) {
		const { api, calls } = fixture(async () =>
			Response.json({ success: false, message: 'PRIVATE SQL data' }, { status })
		)
		await assert.rejects(
			api.updateModel(row.id, { display_name: 'Updated' }),
			(error: unknown) => {
				assert.ok(
					error instanceof CinaTokenApiError ||
						error instanceof AdminDomainWriteError
				)
				assert.equal(error.status, status)
				assert.equal(
					error.code,
					status < 500 && status !== 429 ? 'rejected' : 'unknown'
				)
				assert.equal(error.message.includes('PRIVATE'), false)
				return true
			}
		)
		assert.equal(calls.length, 1)
	}
})

test('business rejection and malformed successful JSON never become a successful write', async () => {
	for (const reply of [
		Response.json({ success: false, message: 'PRIVATE' }),
		new Response('PRIVATE'),
		Response.json({ success: true, data: { id: null } }),
	]) {
		const { api } = fixture(async () => reply)
		await assert.rejects(
			api.createModel({ id: row.id, pricing_profile: row.pricing_profile }),
			(error: unknown) => {
				assert.ok(
					error instanceof CinaTokenApiError ||
						error instanceof AdminDomainWriteError
				)
				assert.equal(error.message.includes('PRIVATE'), false)
				assert.ok(
					error.code === 'business' ||
						error.code === 'invalid-response' ||
						error.code === 'unknown'
				)
				return true
			}
		)
	}
})

test(
	'cancellation refuses late successful data even when fetch ignores AbortSignal',
	{ timeout: 2000 },
	async () => {
		const started = deferred<void>()
		const response = deferred<Response>()
		const { api, calls } = fixture(async () => {
			started.resolve()
			return response.promise
		})
		const controller = new AbortController()
		const pending = api.modelList({ signal: controller.signal })
		await started.promise
		controller.abort()
		response.resolve(
			Response.json({
				success: true,
				data: [row],
				count: 1,
				billing_currency: 'USD',
			})
		)
		await assert.rejects(
			pending,
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'cancelled'
		)
		assert.equal(calls.length, 1)
		const before = new AbortController()
		before.abort()
		await assert.rejects(api.modelList({ signal: before.signal }))
		assert.equal(calls.length, 1)
	}
)

test(
	'timeout refuses an unconfirmed write without retrying or exposing response details',
	{ timeout: 2000 },
	async () => {
		const { api, calls } = fixture(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20))
			return Response.json({ success: true })
		})
		await assert.rejects(
			api.deleteModel(row.id, { timeoutMs: 10 }),
			(error: unknown) =>
				error instanceof AdminDomainWriteError && error.code === 'unknown'
		)
		assert.equal(calls.length, 1)
	}
)
