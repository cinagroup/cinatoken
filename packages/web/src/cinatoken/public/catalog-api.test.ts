import assert from 'node:assert/strict'
import test from 'node:test'
import { createPublicCatalogApi, PublicCatalogError } from './catalog-api'
import { catalogModelsSchema, catalogPricingSchema } from './catalog-contracts'

const tier = {
	upto: null,
	label: null,
	input_price: 2,
	output_price: 8,
	cache_read_price: 0,
	cache_write_price: 2.5,
	image_input_price: 1,
	image_input_cache_price: 0.2,
	image_output_price: 4,
}
const model = {
	id: 'vendor/model',
	slug: '~dmVuZG9yL21vZGVs',
	display_name: null,
	vendor: 'Vendor% Labs',
	context_window: null,
	max_tokens: 0,
	pricing_profile: { tiers: [tier], audio_billing_mode: 'token' },
	tags: [],
	route_groups: ['default'],
	protocols: ['openai'],
	protocols_by_group: { default: ['openai'] },
	recommended_protocol: 'openai',
	description: null,
	input_modalities: ['text', 'image'],
	output_modalities: null,
	released_at: null,
	endpoint_slugs: ['vendor/region'],
	regions: ['US'],
	data_policy_summary: {
		verified_route_count: 1,
		zdr_available: true,
		latest_verified_at: null,
	},
}
const envelope = {
	object: 'list',
	data: [model],
	billing_currency: 'CNY',
	generated_at: '2026-09-27T02:00:00.000Z',
}
const stats = {
	object: 'list',
	data: [
		{
			id: model.id,
			slug: model.slug,
			display_name: 'Model',
			vendor: model.vendor,
			request_count: 20,
			success_rate: 95,
			avg_latency_ms: null,
			output_tokens: 0,
			total_tokens: 300,
		},
	],
	range: '7d',
	window_start: '2026-09-21T00:00:00.000Z',
	window_end: envelope.generated_at,
	minimum_sample_size: 20,
	generated_at: envelope.generated_at,
}
const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
	Response.json(value, { status, headers })

function streamedResponse(
	chunks: readonly Uint8Array[],
	options: {
		close?: boolean
		status?: number
		headers?: HeadersInit
		cancel?: () => void | Promise<void>
	} = {}
) {
	const state = { pulls: 0, cancels: 0 }
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const chunk = chunks[state.pulls++]
				if (chunk !== undefined) controller.enqueue(chunk)
				else if (options.close !== false) controller.close()
			},
			cancel() {
				state.cancels++
				return options.cancel?.()
			},
		},
		{ highWaterMark: 0 }
	)
	const headers = new Headers(options.headers)
	if (!headers.has('content-type'))
		headers.set('content-type', 'application/json')
	return {
		body,
		state,
		response: new Response(body, { status: options.status ?? 200, headers }),
	}
}

test('anonymous catalog uses fixed BFF paths, no Cookie/identity headers and preserves billing currency/cache prices', async () => {
	let sentPath = ''
	let sentInit: RequestInit | undefined
	const api = createPublicCatalogApi(async (input, init) => {
		sentPath = String(input)
		sentInit = init
		return json(envelope)
	})
	const value = await api.models({
		routeGroups: ['Default', 'default', 'Premium'],
	})
	assert.equal(
		sentPath,
		'/api/public/catalog/models?route_groups=default%2Cpremium'
	)
	assert.equal(sentInit?.credentials, 'omit')
	assert.equal(sentInit?.redirect, 'error')
	assert.deepEqual(
		[...new Headers(sentInit?.headers)],
		[['accept', 'application/json']]
	)
	assert.equal(value.billing_currency, 'CNY')
	assert.equal(value.data[0]?.pricing_profile?.tiers[0]?.cache_read_price, 0)
	assert.equal(value.data[0]?.pricing_profile?.audio_billing_mode, 'token')
	assert.equal(value.data[0]?.context_window, null)
	assert.equal(value.data[0]?.display_name, null)
})

test('catalog strips unapproved nested secrets instead of returning them to a UI', () => {
	const value = catalogModelsSchema.parse({
		...envelope,
		credentials: 'secret',
		data: [
			{
				...model,
				internal_cost: 0.1,
				provider_key: 'secret',
				data_policy_summary: {
					...model.data_policy_summary,
					evidence_url: 'private',
				},
				pricing_profile: {
					tiers: [{ ...tier, route_multiplier: 0.5 }],
					private: 'secret',
				},
			},
		],
	})
	assert.equal(JSON.stringify(value).includes('secret'), false)
	assert.equal(JSON.stringify(value).includes('route_multiplier'), false)
	assert.equal(JSON.stringify(value).includes('evidence_url'), false)
})

test('all published price modes/maps/minimums survive; legacy image data does not invent a billing mode', () => {
	const image = {
		tiers: [],
		image_billing_mode: 'per_image',
		image: {
			default: 0,
			by_quality: { high: 0.2 },
			by_size: { '1024x1024': 0.3 },
			by_quality_size: { 'high:1024x1024': 0.5 },
			input: { default: 0.1, by_quality: { high: 0.05 } },
			uncertain_result_policy: 'zero',
		},
	}
	assert.deepEqual(catalogPricingSchema.parse(image), image)
	for (const audio of [
		{
			tiers: [],
			audio_billing_mode: 'per_second',
			audio: { price_per_second: 0.005, minimum_seconds: 1.5 },
		},
		{
			tiers: [],
			audio_billing_mode: 'per_character',
			audio: { price_per_character: 0.00001, minimum_characters: 20 },
		},
	])
		assert.deepEqual(catalogPricingSchema.parse(audio), audio)
	const legacy = catalogPricingSchema.parse({
		tiers: [tier],
		image: { default: 1 },
	})
	assert.equal(legacy.image_billing_mode, undefined)
	assert.equal(
		catalogPricingSchema.safeParse({
			tiers: [tier],
			audio_billing_mode: 'tokens',
		}).success,
		false
	)
})

test('Core-compatible finite negative token/cache prices and unsorted finite tier bounds stay usable', async () => {
	const profile = {
		tiers: [
			{
				...tier,
				upto: 100,
				input_price: -1,
				output_price: -2,
				cache_read_price: -0.5,
				cache_write_price: -0.1,
			},
			{ ...tier, upto: 10 },
			tier,
		],
	}
	const value = await createPublicCatalogApi(async () =>
		json({ ...envelope, data: [{ ...model, pricing_profile: profile }] })
	).models()
	assert.deepEqual(value.data[0]?.pricing_profile, profile)
	assert.equal(
		catalogPricingSchema.safeParse({
			tiers: [{ ...tier, image_input_price: -1 }],
		}).success,
		false
	)
	assert.equal(
		catalogPricingSchema.safeParse({ tiers: [tier, tier] }).success,
		false
	)
})

test('valid empty catalog is distinct from missing fields, malformed rows and duplicate identities', async () => {
	const value = await createPublicCatalogApi(async () =>
		json({ ...envelope, data: [] })
	).models()
	assert.deepEqual(value.data, [])
	for (const invalid of [
		{ data: [] },
		{ ...envelope, billing_currency: undefined },
		{ ...envelope, data: [{ ...model, pricing_profile: { tiers: [] } }] },
		{ ...envelope, data: [model, model] },
	]) {
		await assert.rejects(
			() => createPublicCatalogApi(async () => json(invalid)).models(),
			(error) =>
				error instanceof PublicCatalogError && error.code === 'invalid-response'
		)
	}
})

test('model path encodes real vendor percent bytes and validates response identity', async () => {
	let path = ''
	const api = createPublicCatalogApi(async (input) => {
		path = String(input)
		return json({ ...envelope, object: 'model', data: model })
	})
	await api.model(model.vendor, model.slug)
	assert.equal(
		path,
		'/api/public/catalog/model/Vendor%25%20Labs/~dmVuZG9yL21vZGVs'
	)
	await assert.rejects(
		() => api.model('Other', model.slug),
		(error) =>
			error instanceof PublicCatalogError && error.code === 'invalid-response'
	)
	await assert.rejects(() => api.model(model.vendor, '../model'), TypeError)
})

test('invalid path/query input never triggers a request', async () => {
	let requests = 0
	const api = createPublicCatalogApi(async () => {
		requests++
		return json(envelope)
	})
	for (const vendor of ['', '..', 'a/b', 'a\\b', 'a\n', 'a'.repeat(81)])
		await assert.rejects(() => api.model(vendor, model.slug), TypeError)
	assert.throws(() => api.models({ routeGroups: ['a,b'] }), TypeError)
	assert.throws(
		() =>
			api.models({ routeGroups: Array.from({ length: 33 }, () => 'default') }),
		TypeError
	)
	assert.equal(requests, 0)
})

test('stats preserve real total/output tokens and enforce requested window/privacy threshold even for an empty list', async () => {
	const value = await createPublicCatalogApi(async () => json(stats)).stats(
		'7d'
	)
	assert.equal(value.data[0]?.total_tokens, 300)
	assert.equal(value.data[0]?.avg_latency_ms, null)
	for (const invalid of [
		{ ...stats, data: [], range: '30d' },
		{ ...stats, minimum_sample_size: 1 },
		{ ...stats, data: [{ ...stats.data[0], request_count: 19 }] },
		{ ...stats, data: [{ ...stats.data[0], success_rate: 101 }] },
		{ ...stats, window_start: '2026-10-01T00:00:00Z' },
	])
		await assert.rejects(
			() => createPublicCatalogApi(async () => json(invalid)).stats('7d'),
			(error) =>
				error instanceof PublicCatalogError && error.code === 'invalid-response'
		)
})

for (const status of [401, 403, 404, 429, 503]) {
	test(`catalog HTTP ${status} remains independent of account identity and does not expose upstream errors`, async () => {
		const api = createPublicCatalogApi(async () =>
			json({ message: 'provider secret/internal host' }, status, {
				'Retry-After': '60',
			})
		)
		await assert.rejects(
			() => api.models(),
			(error) =>
				error instanceof PublicCatalogError &&
				error.status === status &&
				error.code === 'http' &&
				error.retryAfter === '60' &&
				!error.message.includes('secret')
		)
	})
}

test('invalid JSON and invalid Retry-After do not become usable catalog data', async () => {
	await assert.rejects(
		() =>
			createPublicCatalogApi(
				async () => new Response('<html>private</html>')
			).providers(),
		(error) =>
			error instanceof PublicCatalogError && error.code === 'invalid-response'
	)
	await assert.rejects(
		() =>
			createPublicCatalogApi(async () =>
				json({}, 429, { 'retry-after': 'private-host.example' })
			).models(),
		(error) => error instanceof PublicCatalogError && error.retryAfter === null
	)
})

test('cancelled reads and late responses cannot deliver data; timeout and network failure remain distinct', async () => {
	const controller = new AbortController()
	controller.abort()
	let called = false
	await assert.rejects(
		() =>
			createPublicCatalogApi(async () => {
				called = true
				return json(envelope)
			}).models({}, { signal: controller.signal }),
		(error) => error instanceof PublicCatalogError && error.code === 'cancelled'
	)
	assert.equal(called, false)
	const late = new AbortController()
	await assert.rejects(
		() =>
			createPublicCatalogApi(async () => {
				late.abort()
				return json(envelope)
			}).models({}, { signal: late.signal }),
		(error) => error instanceof PublicCatalogError && error.code === 'cancelled'
	)
	const hanging: typeof fetch = (_input, init) =>
		new Promise((_resolve, reject) =>
			init?.signal?.addEventListener(
				'abort',
				() => reject(new Error('abort')),
				{ once: true }
			)
		)
	await assert.rejects(
		() => createPublicCatalogApi(hanging).models({}, { timeoutMs: 5 }),
		(error) => error instanceof PublicCatalogError && error.code === 'timeout'
	)
	await assert.rejects(
		() =>
			createPublicCatalogApi(async () => {
				throw new Error('private upstream host')
			}).models(),
		(error) =>
			error instanceof PublicCatalogError &&
			error.code === 'network' &&
			!error.message.includes('private')
	)
})

test(
	'fetch and body sources that ignore AbortSignal still time out or cancel promptly',
	{ timeout: 1_000 },
	async () => {
		let deliver: (response: Response) => void = () => {
			throw new Error('Fetch not started')
		}
		const api = createPublicCatalogApi(
			() =>
				new Promise<Response>((resolve) => {
					deliver = resolve
				})
		)
		await assert.rejects(
			() => api.models({}, { timeoutMs: 5 }),
			(error) => error instanceof PublicCatalogError && error.code === 'timeout'
		)
		let lateBodyCancelled = false
		deliver(
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						lateBodyCancelled = true
					},
				}),
				{ headers: { 'content-type': 'application/json' } }
			)
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(lateBodyCancelled, true)
		const hangingBody = streamedResponse(
			[new TextEncoder().encode('{"object":"list","data":[')],
			{ close: false }
		)
		await assert.rejects(
			() =>
				createPublicCatalogApi(async () => hangingBody.response).models(
					{},
					{ timeoutMs: 5 }
				),
			(error) => error instanceof PublicCatalogError && error.code === 'timeout'
		)
		assert.equal(hangingBody.state.cancels, 1)
		assert.equal(hangingBody.body.locked, false)
		const controller = new AbortController()
		const pending = createPublicCatalogApi(
			() => new Promise<Response>(() => undefined)
		).models({}, { signal: controller.signal })
		controller.abort()
		await assert.rejects(
			() => pending,
			(error) =>
				error instanceof PublicCatalogError && error.code === 'cancelled'
		)
	}
)

test('a caller abort cancels the actual pending body reader and a manual retry recovers', async () => {
	let reading: () => void = () => undefined
	const started = new Promise<void>((resolve) => {
		reading = resolve
	})
	const state = { cancels: 0 }
	const body = new ReadableStream<Uint8Array>(
		{
			pull() {
				reading()
			},
			cancel() {
				state.cancels++
			},
		},
		{ highWaterMark: 0 }
	)
	let requests = 0
	const api = createPublicCatalogApi(async () => {
		requests++
		return requests === 1
			? new Response(body, { headers: { 'content-type': 'application/json' } })
			: json(envelope)
	})
	const controller = new AbortController()
	const pending = api.models({}, { signal: controller.signal })
	await started
	controller.abort('Private cancellation details')
	await assert.rejects(
		() => pending,
		(error) =>
			error instanceof PublicCatalogError &&
			error.code === 'cancelled' &&
			!error.message.includes('Private')
	)
	assert.equal(state.cancels, 1)
	assert.equal(body.locked, false)
	assert.equal(requests, 1)
	assert.equal((await api.models()).billing_currency, 'CNY')
	assert.equal(requests, 2)
})

test(
	'a source that never settles cancellation cannot delay timeout or keep the reader lock',
	{ timeout: 1_000 },
	async () => {
		const fixture = streamedResponse([], {
			close: false,
			cancel: () => new Promise<void>(() => undefined),
		})
		await assert.rejects(
			() =>
				createPublicCatalogApi(async () => fixture.response).models(
					{},
					{ timeoutMs: 5 }
				),
			(error) => error instanceof PublicCatalogError && error.code === 'timeout'
		)
		assert.equal(fixture.state.cancels, 1)
		assert.equal(fixture.body.locked, false)
	}
)

test('caller cancellation keeps priority if it happens during timeout disposal', async () => {
	const controller = new AbortController()
	const fixture = streamedResponse([], {
		close: false,
		cancel: () => controller.abort(),
	})
	await assert.rejects(
		() =>
			createPublicCatalogApi(async () => fixture.response).models(
				{},
				{ signal: controller.signal, timeoutMs: 5 }
			),
		(error) => error instanceof PublicCatalogError && error.code === 'cancelled'
	)
	assert.equal(fixture.state.cancels, 1)
	assert.equal(fixture.body.locked, false)
})

test(
	'a late response from an ignored fetch signal is cancelled without consuming it or changing a retry',
	{ timeout: 1_000 },
	async () => {
		let deliver: (response: Response) => void = () => undefined
		let requests = 0
		const api = createPublicCatalogApi(() => {
			requests++
			return requests === 1
				? new Promise<Response>((resolve) => {
						deliver = resolve
					})
				: Promise.resolve(json(envelope))
		})
		await assert.rejects(
			() => api.models({}, { timeoutMs: 5 }),
			(error) => error instanceof PublicCatalogError && error.code === 'timeout'
		)
		const late = streamedResponse(
			[new TextEncoder().encode(JSON.stringify(envelope))],
			{ close: false }
		)
		deliver(late.response)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(late.state.cancels, 1)
		assert.equal(late.state.pulls, 0)
		assert.equal(late.body.locked, false)
		assert.equal((await api.models()).billing_currency, 'CNY')
		assert.equal(requests, 2)
	}
)

test('the 16 MiB budget accepts the exact boundary and releases a completed stream', async () => {
	const maximum = 16 * 1024 * 1024
	const bytes = new Uint8Array(maximum).fill(32)
	bytes.set(new TextEncoder().encode(JSON.stringify(envelope)))
	const fixture = streamedResponse([bytes], {
		headers: { 'content-length': String(maximum) },
	})
	const value = await createPublicCatalogApi(
		async () => fixture.response
	).models()
	assert.equal(value.billing_currency, 'CNY')
	assert.deepEqual(value.data[0]?.pricing_profile, model.pricing_profile)
	assert.equal(fixture.state.cancels, 0)
	assert.equal(fixture.body.locked, false)
})

test('declared oversized or malformed lengths cancel before a body read', async () => {
	for (const length of [
		String(16 * 1024 * 1024 + 1),
		'9007199254740992',
		'-1',
		'1x',
	]) {
		const fixture = streamedResponse([], {
			close: false,
			headers: { 'content-length': length },
		})
		await assert.rejects(
			() => createPublicCatalogApi(async () => fixture.response).models(),
			(error) =>
				error instanceof PublicCatalogError &&
				error.code === 'invalid-response' &&
				error.status === 200
		)
		assert.equal(fixture.state.cancels, 1)
		assert.equal(fixture.state.pulls, 0)
		assert.equal(fixture.body.locked, false)
	}
})

test('streaming limits count actual cumulative bytes even when Content-Length understates them', async () => {
	const maximum = 16 * 1024 * 1024
	for (const declared of [undefined, '1']) {
		const fixture = streamedResponse(
			[new Uint8Array(maximum).fill(32), new Uint8Array([32])],
			{ close: false, headers: declared ? { 'content-length': declared } : {} }
		)
		let requests = 0
		const api = createPublicCatalogApi(async () =>
			++requests === 1 ? fixture.response : json(envelope)
		)
		await assert.rejects(
			() => api.models(),
			(error) =>
				error instanceof PublicCatalogError &&
				error.code === 'invalid-response' &&
				error.status === 200
		)
		assert.equal(fixture.state.cancels, 1)
		assert.equal(fixture.state.pulls, 2)
		assert.equal(fixture.body.locked, false)
		assert.equal((await api.models()).billing_currency, 'CNY')
		assert.equal(requests, 2)
	}
})

test('fatal UTF-8 rejects invalid open streams, cancels once and allows a clean manual retry', async () => {
	const fixture = streamedResponse([new Uint8Array([0xc3, 0x28])], {
		close: false,
	})
	let requests = 0
	const api = createPublicCatalogApi(async () =>
		++requests === 1 ? fixture.response : json(envelope)
	)
	await assert.rejects(
		() => api.models(),
		(error) =>
			error instanceof PublicCatalogError && error.code === 'invalid-response'
	)
	assert.equal(fixture.state.cancels, 1)
	assert.equal(fixture.state.pulls, 1)
	assert.equal(fixture.body.locked, false)
	assert.equal((await api.models()).billing_currency, 'CNY')
	assert.equal(requests, 2)
})

test('UTF-8 characters and a BOM split across chunks remain valid without data truncation', async () => {
	const description = '漢字 😀 é'
	const value = { ...envelope, data: [{ ...model, description }] }
	const bytes = new TextEncoder().encode(JSON.stringify(value))
	const split = bytes.indexOf(0xf0) + 1
	const fixture = streamedResponse([
		new Uint8Array([0xef]),
		new Uint8Array([0xbb, 0xbf]),
		bytes.slice(0, split),
		bytes.slice(split, split + 1),
		bytes.slice(split + 1),
	])
	const result = await createPublicCatalogApi(
		async () => fixture.response
	).models()
	assert.equal(result.data[0]?.description, description)
	assert.equal(result.billing_currency, 'CNY')
	assert.equal(fixture.state.cancels, 0)
	assert.equal(fixture.body.locked, false)
})

test('JSON syntax and incomplete UTF-8 failures release already closed streams safely', async () => {
	for (const bytes of [
		new TextEncoder().encode('{]'),
		new Uint8Array([0xc3]),
	]) {
		const fixture = streamedResponse([bytes])
		await assert.rejects(
			() => createPublicCatalogApi(async () => fixture.response).models(),
			(error) =>
				error instanceof PublicCatalogError && error.code === 'invalid-response'
		)
		// EOF has already closed the source; cancelling the reader cannot call source.cancel again.
		assert.equal(fixture.state.cancels, 0)
		assert.equal(fixture.body.locked, false)
	}
})

test('invalid successful status/content type and HTTP errors cancel unused bodies without changing safe errors', async () => {
	const cases: {
		status: number
		headers: HeadersInit
		code: PublicCatalogError['code']
		retry: string | null
	}[] = [
		{ status: 201, headers: {}, code: 'invalid-response', retry: null },
		{
			status: 200,
			headers: { 'content-type': 'text/html' },
			code: 'invalid-response',
			retry: null,
		},
		{
			status: 429,
			headers: { 'retry-after': '60' },
			code: 'http',
			retry: '60',
		},
	]
	for (const entry of cases) {
		const fixture = streamedResponse([], {
			close: false,
			status: entry.status,
			headers: entry.headers,
		})
		await assert.rejects(
			() => createPublicCatalogApi(async () => fixture.response).models(),
			(error) =>
				error instanceof PublicCatalogError &&
				error.code === entry.code &&
				error.status === entry.status &&
				error.retryAfter === entry.retry
		)
		assert.equal(fixture.state.cancels, 1)
		assert.equal(fixture.state.pulls, 0)
		assert.equal(fixture.body.locked, false)
	}
})

test('a rejecting underlying cancellation cannot replace an invalid-response error or retain the lock', async () => {
	const fixture = streamedResponse([new Uint8Array([0xff])], {
		close: false,
		cancel: () =>
			Promise.reject(new Error('Private source cancellation details')),
	})
	await assert.rejects(
		() => createPublicCatalogApi(async () => fixture.response).models(),
		(error) =>
			error instanceof PublicCatalogError &&
			error.code === 'invalid-response' &&
			!error.message.includes('Private')
	)
	assert.equal(fixture.state.cancels, 1)
	assert.equal(fixture.body.locked, false)
})
