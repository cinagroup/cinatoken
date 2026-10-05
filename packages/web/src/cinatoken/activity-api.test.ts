import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GenerationRequestLogRow } from '../../../core/src/db/request-logs-types'
import { toPortalGenerationMetadataData } from '../../../core/src/generation-metadata'
import type { ActivityData, ActivityLog } from './activity-contracts'
import { CinaTokenApiError, createCinaTokenApi } from './api'

const options = { expectedWorkspaceId: 'personal:alice' }
const generationId = 'gen-owned_123'
const log: ActivityLog = {
	id: generationId,
	apiKeyId: 'key:one',
	apiKeyName: 'Production',
	modelId: 'openai/test',
	modelName: 'Test model',
	providerName: 'OpenAI',
	protocol: 'openai',
	operation: 'chat.completions',
	status: 'success',
	inputTokens: 10,
	outputTokens: 5,
	totalTokens: 15,
	chargedCost: 0.000001,
	latencyMs: null,
	billingKind: 'llm_tokens',
	inputImageCount: 0,
	outputImageCount: 0,
	audioDurationSeconds: null,
	audioCharacters: null,
	createdAt: '2026-09-27T00:00:00.000Z',
}

function activityData(): ActivityData {
	return {
		workspaceId: options.expectedWorkspaceId,
		billingCurrency: 'CNY',
		range: {
			id: '7d',
			startAt: '2026-09-20T00:00:00.000Z',
			endAt: '2026-09-27T00:00:00.000Z',
		},
		budget: {
			status: 'finite',
			budgetMax: 10,
			budgetBase: 10,
			budgetSpent: 2,
			budgetReserved: 0.25,
			budgetReservedMicros: 250_000,
			budgetRemaining: 7.75,
			budgetPeriod: 'monthly',
			budgetResetAt: null,
		},
		summary: {
			totalRequests: 0,
			successCount: 0,
			errorCount: 0,
			chargedCost: 0,
			meteredCost: 0,
			standardCost: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			avgLatencyMs: null,
		},
		analytics: { limit: 10, models: [], apiKeys: [], providers: [] },
		timeline: { granularity: 'hour', points: [] },
		keys: [],
		logs: [],
		pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
	}
}

function generationData(changes: Partial<GenerationRequestLogRow> = {}) {
	const source: GenerationRequestLogRow = {
		id: generationId,
		request_operation: 'chat',
		status: 'success',
		created_at: log.createdAt,
		latency_ms: 321,
		final_upstream_headers_ms: 100,
		stream_duration_ms: 200,
		model_id: log.modelId,
		provider_name: 'OpenAI',
		input_tokens: 10,
		output_tokens: 5,
		cache_read_tokens: 2,
		reasoning_tokens: 1,
		native_tokens_prompt: 10,
		native_tokens_completion: 5,
		native_tokens_cached: 2,
		native_tokens_reasoning: 1,
		native_tokens_completion_images: null,
		input_image_count: 0,
		output_image_count: 0,
		upstream_message_id: 'chatcmpl-safe',
		session_id: 'session-public',
		workspace_id: options.expectedWorkspaceId,
		request_origin: 'https://cinatoken.com',
		http_referer: 'https://app.example',
		user_agent: 'SDK/1.0',
		response_streamed: true,
		data_region: 'global',
		is_byok: false,
		charged_cost_usd: '0.00042',
		upstream_inference_cost_usd: '0.00021',
		service_tier: 'default',
		finish_reason: 'stop',
		native_finish_reason: 'stop',
		provider_responses: JSON.stringify([
			{ status: 200, provider_name: 'OpenAI', latency: 100 },
		]),
		...changes,
	}
	const projected = toPortalGenerationMetadataData(source)
	assert.ok(projected)
	return projected
}

function transport(
	handler: (path: string, init: RequestInit) => Response | Promise<Response>
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) =>
		handler(String(input), init ?? {})) as typeof fetch
}
function code(expected: CinaTokenApiError['code'], status?: number) {
	return (error: unknown) =>
		error instanceof CinaTokenApiError &&
		error.code === expected &&
		(status === undefined || error.status === status)
}

const columns = [
	'time',
	'request_id',
	'api_key_id',
	'api_key_name',
	'model_id',
	'model_name',
	'provider_name',
	'protocol',
	'operation',
	'status',
	'input_tokens',
	'output_tokens',
	'total_tokens',
	'input_image_count',
	'output_image_count',
	'audio_duration_seconds',
	'audio_characters',
	'charged_cost_cny',
	'latency_ms',
	'billing_kind',
]
function csv(cells: string[][] = [], header: string[] = columns): string {
	return `\uFEFF${[header, ...cells].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\r\n')}\r\n`
}
function csvResponse(
	body = csv(),
	metadata: Record<string, string> = {}
): Response {
	return new Response(body, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition':
				'attachment; filename="cinatoken-activity-2026-09-27.csv"',
			'X-CinaToken-Workspace-Id': encodeURIComponent(
				options.expectedWorkspaceId
			),
			'X-CinaToken-Export-Count': '0',
			'X-CinaToken-Export-Total': '0',
			'X-CinaToken-Export-Truncated': 'false',
			'X-CinaToken-Billing-Currency': 'CNY',
			...metadata,
		},
	})
}

test('Activity list preserves the real billing currency, main units and nullable measurements', async () => {
	const data = activityData()
	data.logs = [log]
	data.pagination.total = 1
	const api = createCinaTokenApi(
		transport((path, init) => {
			assert.equal(path, '/api/user/activity?range=7d&page=1&page_size=20')
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			assert.equal(
				new Headers(init.headers).get('X-CinaToken-Workspace'),
				'personal%3Aalice'
			)
			assert.equal(new Headers(init.headers).has('New-Api-User'), false)
			return Response.json({ success: true, data })
		})
	)
	const received = await api.activity(options)
	assert.deepEqual(received, data)
	assert.equal(received.logs[0].chargedCost, 0.000001)
	assert.equal(received.logs[0].latencyMs, null)
	assert.equal(
		received.budget.budgetReserved,
		received.budget.budgetReservedMicros! / 1_000_000
	)
})

test('all supported filters and pagination are encoded, with blank filters omitted', async () => {
	const api = createCinaTokenApi(
		transport((path) => {
			const query = new URL(`https://fixture.invalid${path}`).searchParams
			assert.deepEqual(Object.fromEntries(query), {
				range: '30d',
				api_key_id: 'key:one',
				model_id: 'openai/a+b',
				provider_name: 'Open AI',
				status: 'cancelled',
				page: '3',
				page_size: '100',
			})
			const data = activityData()
			data.range.id = '30d'
			data.pagination = { page: 3, pageSize: 100, total: 0, totalPages: 1 }
			data.timeline.granularity = 'day'
			return Response.json({ success: true, data })
		})
	)
	await api.activity({
		...options,
		range: '30d',
		api_key_id: ' key:one ',
		model_id: 'openai/a+b',
		provider_name: 'Open AI',
		status: 'cancelled',
		page: 3,
		page_size: 100,
	})
	const blanks = createCinaTokenApi(
		transport((path) => {
			assert.equal(path.includes('api_key_id'), false)
			assert.equal(path.includes('status='), false)
			return Response.json({ success: true, data: activityData() })
		})
	)
	await blanks.activity({ ...options, api_key_id: ' ', status: '' })
})

test('empty Activity pages require matching workspace metadata', async () => {
	for (const workspaceId of [undefined, '', 'organization:other']) {
		const data = { ...activityData(), workspaceId }
		const api = createCinaTokenApi(
			transport(() => Response.json({ success: true, data }))
		)
		await assert.rejects(
			api.activity(options),
			code(
				workspaceId === 'organization:other'
					? 'workspace-mismatch'
					: 'invalid-response'
			)
		)
	}
})

test('filters cannot silently broaden an Activity query after malformed input', async () => {
	let requests = 0
	const api = createCinaTokenApi(
		transport(() => {
			requests++
			return Response.json({})
		})
	)
	for (const fields of [
		{ page: 0 },
		{ page: 100_001 },
		{ page: 1.5 },
		{ page_size: 0 },
		{ page_size: 101 },
		{ api_key_id: 'x'.repeat(129) },
		{ model_id: 'x'.repeat(257) },
		{ provider_name: 'x'.repeat(201) },
		{ model_id: 'bad\nmodel' },
		{ expectedWorkspaceId: '' },
		{ expectedWorkspaceId: ' bad ' },
	])
		await assert.rejects(api.activity({ ...options, ...fields }))
	assert.equal(requests, 0)
})

test('inconsistent page identities and totals are rejected instead of entering caches', async () => {
	const base = activityData()
	for (const data of [
		{ ...base, range: { ...base.range, id: '90d' } },
		{ ...base, pagination: { ...base.pagination, page: 2 } },
		{ ...base, pagination: { ...base.pagination, pageSize: 100 } },
		{ ...base, pagination: { ...base.pagination, totalPages: 0 } },
		{ ...base, logs: [log] },
		{ ...base, logs: [log, log], pagination: { ...base.pagination, total: 2 } },
	]) {
		const api = createCinaTokenApi(
			transport(() => Response.json({ success: true, data }))
		)
		await assert.rejects(api.activity(options), code('invalid-response'))
	}
})

test('unavailable and unlimited budgets retain missing values without inventing zero', async () => {
	for (const status of ['unavailable', 'unlimited'] as const) {
		const data = activityData()
		data.budget.status = status
		data.budget.budgetMax = null
		data.budget.budgetRemaining = null
		if (status === 'unavailable') {
			data.budget.budgetReserved = null
			data.budget.budgetReservedMicros = null
		}
		const api = createCinaTokenApi(
			transport(() => Response.json({ success: true, data }))
		)
		assert.equal((await api.activity(options)).budget.budgetRemaining, null)
	}
	const data = activityData()
	data.budget.budgetReserved = 250_000
	const badUnits = createCinaTokenApi(
		transport(() => Response.json({ success: true, data }))
	)
	await assert.rejects(badUnits.activity(options), code('invalid-response'))
})

test('list schema rejects body, credential and trace fields at every public boundary', async () => {
	const base = activityData()
	for (const data of [
		{ ...base, request_body: 'private-marker' },
		{
			...base,
			logs: [{ ...log, route_trace: 'private-marker' }],
			pagination: { ...base.pagination, total: 1 },
		},
		{
			...base,
			keys: [
				{ id: 'key:one', name: null, status: 'active', key: 'private-marker' },
			],
		},
		{ ...base, summary: { ...base.summary, pricing_audit: 'private-marker' } },
	]) {
		const api = createCinaTokenApi(
			transport(() => Response.json({ success: true, data }))
		)
		await assert.rejects(api.activity(options), code('invalid-response'))
	}
})

test('Generation consumes the actual credential-free core projection with USD costs independent of CNY list units', async () => {
	const data = generationData()
	const api = createCinaTokenApi(
		transport((path, init) => {
			assert.equal(path, `/api/user/activity/${generationId}`)
			assert.equal(
				new Headers(init.headers).get('X-CinaToken-Workspace'),
				'personal%3Aalice'
			)
			return Response.json({ success: true, data })
		})
	)
	assert.deepEqual(await api.activityGeneration(generationId, options), data)
	assert.equal(data.total_cost, 0.00042)
	assert.equal(data.upstream_inference_cost, 0.00021)
	const noUsd = createCinaTokenApi(
		transport(() =>
			Response.json({
				success: true,
				data: generationData({
					charged_cost_usd: null,
					upstream_inference_cost_usd: null,
				}),
			})
		)
	)
	const received = await noUsd.activityGeneration(generationId, options)
	assert.equal(received.total_cost, null)
	assert.equal(received.usage, null)
	assert.equal(received.upstream_inference_cost, null)
})

test('Generation detail validates requested ID, workspace, origin and the nested projection whitelist', async () => {
	const base = generationData()
	for (const data of [
		{ ...base, id: 'gen-other' },
		{ ...base, request_body: 'private-marker' },
		{ ...base, origin: 'https://example.com/path?key=private-marker' },
		{
			...base,
			provider_responses: [{ status: 200, route_trace: 'private-marker' }],
		},
		{
			...base,
			provider_responses: [
				{ status: 200, provider_key_fingerprint: 'private-marker' },
			],
		},
		{ ...base, usage: 9 },
	]) {
		const api = createCinaTokenApi(
			transport(() => Response.json({ success: true, data }))
		)
		await assert.rejects(
			api.activityGeneration(generationId, options),
			code('invalid-response')
		)
	}
	const api = createCinaTokenApi(
		transport(() =>
			Response.json({
				success: true,
				data: { ...base, workspace_id: 'organization:other' },
			})
		)
	)
	await assert.rejects(
		api.activityGeneration(generationId, options),
		code('workspace-mismatch')
	)
	await assert.rejects(api.activityGeneration('../request-1', options))
})

test('CSV exports use filter scope, omit pagination and retain BOM in the returned file', async () => {
	const source = csv()
	const api = createCinaTokenApi(
		transport((path, init) => {
			assert.equal(
				path,
				'/api/user/activity/export.csv?range=7d&model_id=openai%2Ftest'
			)
			assert.equal(new Headers(init.headers).get('Accept'), 'text/csv')
			assert.equal(
				new Headers(init.headers).get('X-CinaToken-Workspace'),
				'personal%3Aalice'
			)
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			return csvResponse(source)
		})
	)
	const exported = await api.exportActivityCsv({
		...options,
		model_id: 'openai/test',
	})
	assert.equal(exported.filename, 'cinatoken-activity-2026-09-27.csv')
	assert.equal(exported.billingCurrency, 'CNY')
	assert.equal(exported.rowCount, 0)
	assert.equal(exported.workspaceId, options.expectedWorkspaceId)
	assert.deepEqual(
		new Uint8Array(await exported.blob.arrayBuffer()).slice(0, 3),
		new Uint8Array([239, 187, 191])
	)
})

test('CSV validates quoted multiline data and reports truncation without modifying file contents', async () => {
	const cells = Array.from({ length: columns.length }, () => '')
	cells[0] = log.createdAt
	cells[1] = generationId
	cells[3] = '\'=HYPERLINK("https://example.com")\r\nsecond, line'
	const source = csv([cells])
	const api = createCinaTokenApi(
		transport(() =>
			csvResponse(source, {
				'X-CinaToken-Export-Count': '1',
				'X-CinaToken-Export-Total': '1500',
				'X-CinaToken-Export-Truncated': 'true',
			})
		)
	)
	const received = await api.exportActivityCsv(options)
	assert.equal(received.rowCount, 1)
	assert.equal(received.total, 1500)
	assert.equal(received.truncated, true)
	assert.equal(
		new TextDecoder('utf-8', { ignoreBOM: true }).decode(
			await received.blob.arrayBuffer()
		),
		source
	)
})

test('CSV empty exports cannot conceal another workspace or omit metadata', async () => {
	for (const header of [
		null,
		'',
		'%broken',
		encodeURIComponent('organization:other'),
	]) {
		const response = csvResponse()
		if (header === null) response.headers.delete('X-CinaToken-Workspace-Id')
		else response.headers.set('X-CinaToken-Workspace-Id', header)
		const api = createCinaTokenApi(transport(() => response))
		await assert.rejects(
			api.exportActivityCsv(options),
			code(
				header === encodeURIComponent('organization:other')
					? 'workspace-mismatch'
					: 'invalid-response'
			)
		)
	}
})

test('CSV column whitelist, row count, formulas, currency and filename are checked before download', async () => {
	const cells = Array.from({ length: columns.length }, () => '')
	cells[3] = '=HYPERLINK("https://example.com")'
	const responses = [
		csvResponse(csv([], [...columns, 'request_body'])),
		csvResponse(csv(), {
			'X-CinaToken-Export-Count': '1',
			'X-CinaToken-Export-Total': '1',
		}),
		csvResponse(csv([cells]), {
			'X-CinaToken-Export-Count': '1',
			'X-CinaToken-Export-Total': '1',
		}),
		csvResponse(csv(), { 'X-CinaToken-Billing-Currency': 'usd' }),
		csvResponse(csv(), { 'X-CinaToken-Billing-Currency': 'USD' }),
		csvResponse(csv(), { 'X-CinaToken-Export-Count': '001' }),
		csvResponse(csv(), { 'X-CinaToken-Export-Truncated': 'true' }),
		csvResponse(csv(), {
			'Content-Disposition': 'attachment; filename="../../private.csv"',
		}),
		csvResponse(csv(), {
			'Content-Disposition':
				'attachment; filename="cinatoken-activity-2026-02-30.csv"',
		}),
		new Response('<html>Login</html>', {
			headers: { 'Content-Type': 'text/html' },
		}),
	]
	for (const response of responses) {
		const api = createCinaTokenApi(transport(() => response))
		await assert.rejects(
			api.exportActivityCsv(options),
			code('invalid-response')
		)
	}
})

test('Activity and CSV auth, access, scope and unavailable failures preserve status without replay', async () => {
	for (const status of [401, 403, 409, 500, 503]) {
		let requests = 0
		const api = createCinaTokenApi(
			transport(() => {
				requests++
				return Response.json(
					{
						success: false,
						code: status === 409 ? 'workspace_mismatch' : undefined,
						message: 'Rejected',
					},
					{ status }
				)
			})
		)
		await assert.rejects(
			api.activity(options),
			code(status === 409 ? 'workspace-mismatch' : 'http', status)
		)
		await assert.rejects(
			api.activityGeneration(generationId, options),
			code(status === 409 ? 'workspace-mismatch' : 'http', status)
		)
		await assert.rejects(
			api.exportActivityCsv(options),
			code(status === 409 ? 'workspace-mismatch' : 'http', status)
		)
		assert.equal(requests, 3)
	}
})

test('late Activity and CSV responses cannot override caller cancellation', async () => {
	for (const kind of ['json', 'csv']) {
		const controller = new AbortController()
		const api = createCinaTokenApi(
			transport(() => {
				controller.abort()
				return kind === 'csv'
					? csvResponse()
					: Response.json({ success: true, data: activityData() })
			})
		)
		await assert.rejects(
			kind === 'csv'
				? api.exportActivityCsv({ ...options, signal: controller.signal })
				: api.activity({ ...options, signal: controller.signal }),
			code('cancelled')
		)
	}
})

test('CSV timeouts use the shared transport and never produce a downloadable result', async () => {
	const api = createCinaTokenApi(
		transport(
			(_path, init) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true }
					)
				})
		)
	)
	await assert.rejects(
		api.exportActivityCsv({ ...options, timeoutMs: 1 }),
		code('timeout')
	)
})
