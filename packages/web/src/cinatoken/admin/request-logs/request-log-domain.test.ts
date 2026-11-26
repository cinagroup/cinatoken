/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	logModelsCatalogSchema,
	requestLogsResponseSchema,
} from './request-log-contracts'
import {
	cleanLogDate,
	geminiWireAction,
	logUsage,
	requestLogProtocolPath,
	requestLogTags,
	requestLogsPath,
	safeLogJson,
	safeLogText,
	validateRequestLogSearch,
	validateRequestLogRouteSearch,
	updateRequestLogScopedFilter,
} from './request-log-domain'

const row = {
	id: 'log-1',
	input_tokens: 100,
	output_tokens: 20,
	cache_read_tokens: 5,
	cache_write_tokens: 2,
	standard_cost: '0.123456',
	charged_cost: '0.200000',
	metered_cost: '0.100000',
	status: 'error',
	created_at: '2026-09-28 02:05:06',
	request_body:
		'{"stream":true,"messages":[{"content":"private"}]}...[truncated]',
	pricing_audit: '{"kind":"image_per_image","api_key":"secret"}',
	private_db_column: 'never enter UI',
}
test('request log DTO strips extra DB fields, accepts decimal costs and strict SQL UTC', () => {
	const parsed = requestLogsResponseSchema.parse({
		success: true,
		data: [row],
		total: 1,
		page: 1,
		page_size: 50,
		private_top_level: 'drop',
	})
	assert.equal(parsed.data[0].created_at, '2026-09-28T02:05:06.000Z')
	assert.equal(parsed.data[0].charged_cost, 0.2)
	assert.equal('private_db_column' in parsed.data[0], false)
	assert.equal('private_top_level' in parsed, false)
	assert.match(parsed.data[0].request_body ?? '', /truncated/u)
	for (const invalid of ['Infinity', '1e10', 'NaN', '12.1234567'])
		assert.equal(
			requestLogsResponseSchema.safeParse({
				success: true,
				data: [{ ...row, charged_cost: invalid }],
				total: 1,
				page: 1,
				page_size: 50,
			}).success,
			false
		)
	assert.equal(
		requestLogsResponseSchema.safeParse({
			success: true,
			data: [{ ...row, created_at: '2026-09-28T02:05:06+08:00' }],
			total: 1,
			page: 1,
			page_size: 50,
		}).success,
		false
	)
	assert.equal(
		requestLogsResponseSchema.safeParse({
			success: true,
			data: [{ ...row, created_at: '2026-02-30 02:05:06' }],
			total: 1,
			page: 1,
			page_size: 50,
		}).success,
		false
	)
})

test('request-log deep links preserve exact filters, page and one-sided dates', () => {
	const search = validateRequestLogSearch({
		page: '3',
		status: 'error',
		model_id: 'm/a',
		provider_id: 'p1',
		route_group: 'vip',
		user_id: 'user-42',
		user_email: 'a@example.test',
		api_key_id: 'key-1',
		protocol: 'gemini',
		start_date: '2026-09-28 00:00:00',
	})
	assert.equal(search.end_date, undefined)
	const url = new URL(requestLogsPath(search), 'https://example.test')
	assert.equal(url.pathname, '/api/admin/request-logs')
	assert.equal(url.searchParams.get('page'), '3')
	assert.equal(url.searchParams.get('page_size'), '50')
	assert.equal(url.searchParams.get('model_id'), 'm/a')
	assert.equal(url.searchParams.get('user_id'), 'user-42')
	assert.throws(
		() => validateRequestLogSearch({ user_id: 'bad\nuser' }),
		/Invalid request-log user ID/u
	)
	assert.equal(url.searchParams.get('start_date'), '2026-09-28 00:00:00')
	assert.equal(url.searchParams.has('end_date'), false)
	assert.equal(cleanLogDate('2026-09-28T00:00:00.000Z'), '2026-09-28 00:00:00')
	assert.equal(cleanLogDate('2026-02-30'), undefined)
	assert.equal(
		validateRequestLogSearch({ start_date: '', end_date: '' }).start_date,
		''
	)
	assert.equal(
		validateRequestLogSearch({ protocol: 'not-a-protocol' }).protocol,
		''
	)
})

test('raw field rendering and copying share a plain-text redacted projection', () => {
	assert.equal(
		safeLogJson(
			'{"authorization":"Bearer abc","nested":{"apiKey":"sk-abc123abc123abc123","messages":["private"]}}'
		),
		'{\n  "authorization": "[redacted]",\n  "nested": {\n    "apiKey": "[redacted]",\n    "messages": "[redacted]"\n  }\n}'
	)
	const truncated = safeLogJson(
		'{"model":"m1","api_key":"sk-abc123abc123abc123"}...[truncated]'
	)
	assert.equal(truncated, '[redacted: truncated log]')
	assert.equal(
		safeLogJson('{"token":"unclosed...[truncated]'),
		'[redacted: truncated log]'
	)
	assert.equal(safeLogJson('{"token":"unclosed'), '[redacted: malformed log]')
	const tokens = safeLogJson(
		'{"token":"private-root","nested":{"id_token":"private-id","sessionToken":"private-session","tokenValue":"private-token-value"},"input_tokens":42,"output_tokens":7}'
	)
	assert.deepEqual(JSON.parse(tokens ?? '{}'), {
		token: '[redacted]',
		nested: {
			id_token: '[redacted]',
			sessionToken: '[redacted]',
			tokenValue: '[redacted]',
		},
		input_tokens: 42,
		output_tokens: 7,
	})
	assert.deepEqual(
		JSON.parse(
			safeLogJson(
				'{"snippet":"embedded {\\"id_token\\":\\"private-inside\\"}","url":"https://example.test/?token=private-query&q=safe"}'
			) ?? '{}'
		),
		{
			snippet: 'embedded {"id_token":"[redacted]"}',
			url: 'https://example.test/?token=[redacted]&q=safe',
		}
	)
	const embedded = safeLogText(
		'preview {"token":"private-root","id_token":"private-id","input_tokens":42}'
	)
	assert.doesNotMatch(embedded, /private-root|private-id/u)
	assert.match(embedded, /"input_tokens":42/u)
	assert.doesNotMatch(
		safeLogText('preview {"id_token":"private-unclosed'),
		/private-unclosed/u
	)
	assert.equal(safeLogJson(null), null)
})

test('route, trace and multimodal usage match log semantics', () => {
	const log = requestLogsResponseSchema.parse({
		success: true,
		data: [
			{
				...row,
				billing_kind: 'image_per_image',
				input_image_count: 1,
				output_image_count: 2,
				route_trace: '{"gemini":{"action":"streamGenerateContent"}}',
				upstream_failover_count: 1,
				first_reasoning_token_ms: 10,
			},
		],
		total: 1,
		page: 1,
		page_size: 50,
	}).data[0]
	assert.equal(geminiWireAction(log.route_trace), 'streamGenerateContent')
	assert.deepEqual(requestLogTags(log), [
		'image',
		'stream',
		'reasoning',
		'failover',
	])
	assert.equal(
		logUsage(log, {
			images: 'img',
			seconds: 's',
			characters: 'chars',
			tokens: 'tok',
		}),
		'1×2 img'
	)
	assert.equal(
		requestLogProtocolPath('gemini', 'models.generate'),
		'/v1beta/models'
	)
	assert.equal(requestLogProtocolPath('openai', 'chat'), '/v1/chat/completions')
	assert.equal(requestLogProtocolPath('anthropic', 'messages'), '/v1/messages')
	assert.equal(
		requestLogProtocolPath('dashscope', 'audio.speech.realtime.inference'),
		'/v1/dashscope/realtime?model={model}&operation=audio.speech.realtime.inference'
	)
	assert.equal(
		requestLogProtocolPath('dashscope', 'audio.transcriptions.multimodal'),
		'/dashscope/api/v1/services/aigc/multimodal-generation/generation'
	)
	const catalog = logModelsCatalogSchema.parse({
		success: true,
		count: 1,
		data: [
			{
				id: 'image-m',
				display_name: 'Image',
				input_modalities: '["text"]',
				output_modalities: '["image"]',
				pricing_profile: null,
				private_prices: 'removed',
			},
		],
	})
	assert.deepEqual(catalog.data[0], {
		id: 'image-m',
		display_name: 'Image',
		kind: 'image',
	})
	assert.equal(
		requestLogTags(
			{
				...log,
				billing_kind: null,
				request_operation: 'chat',
				upstream_operation: 'chat',
				provider_id: 'p1',
				model_id: 'image-m',
				upstream_failover_count: 0,
				first_reasoning_token_ms: null,
			},
			catalog.data[0].kind
		)[0],
		'image'
	)
	const labels = {
		images: 'img',
		seconds: 's',
		characters: 'chars',
		tokens: 'tok',
	}
	assert.equal(
		logUsage(
			{
				...log,
				billing_kind: 'audio_per_second',
				audio_duration_seconds: 1.25,
			},
			labels
		),
		'1.25 s'
	)
	assert.equal(
		logUsage(
			{ ...log, billing_kind: 'audio_per_character', audio_characters: 42 },
			labels
		),
		'42 chars'
	)
	assert.deepEqual(
		requestLogTags({
			...log,
			request_operation: 'audio.speech.realtime.inference',
		}),
		['image', 'realtime', 'reasoning', 'failover']
	)
})

test('MCP model-prefix deep links remain scoped through route validation and API serialization', () => {
	const filters = validateRequestLogSearch({
		provider_id: 'octafuse-mcp',
		model_id_prefix: 'mcp:qa-server/',
		status: 'success',
	})
	const url = new URL(requestLogsPath(filters), 'https://example.test')
	assert.equal(filters.model_id_prefix, 'mcp:qa-server/')
	assert.equal(url.searchParams.get('model_id_prefix'), 'mcp:qa-server/')
	assert.equal(url.searchParams.get('provider_id'), 'octafuse-mcp')
	assert.equal(url.searchParams.get('status'), 'success')
	assert.equal(url.searchParams.has('model_id'), false)
	for (const invalid of ['mcp:qa\nserver/', 'x'.repeat(601), ['mcp:qa/']]) {
		assert.throws(() => validateRequestLogSearch({ model_id_prefix: invalid }))
		assert.throws(() =>
			requestLogsPath({ ...filters, model_id_prefix: invalid as string })
		)
	}
})

test('native media protocols retain filters and show actual Proxy entry paths', () => {
	for (const [protocol, operation, path] of [
		['minimax', 'audio.speech', '/minimax/v1/t2a_v2'],
		['minimax', 'audio.transcriptions', '/minimax/v1/speech_to_text'],
		['minimax', 'images.generations', '/minimax/v1/image_generation'],
		[
			'volcengine',
			'images.generations',
			'/volcengine/api/v3/images/generations',
		],
		[
			'dashscope',
			'audio.speech',
			'/dashscope/api/v1/services/audio/tts/SpeechSynthesizer',
		],
		[
			'dashscope',
			'audio.speech.multimodal',
			'/dashscope/api/v1/services/aigc/multimodal-generation/generation',
		],
		[
			'dashscope',
			'audio.transcriptions.async',
			'/dashscope/api/v1/services/audio/asr/transcription',
		],
	]) {
		const filters = validateRequestLogSearch({ protocol })
		assert.equal(filters.protocol, protocol)
		assert.equal(
			new URL(
				requestLogsPath(filters),
				'https://example.test'
			).searchParams.get('protocol'),
			protocol
		)
		assert.equal(requestLogProtocolPath(protocol, operation), path)
	}
})

test('ingress host deep links preserve stored case and port alongside MCP, identity, dates and pagination', () => {
	for (const ingress_host of [
		'Gateway.Example.test:8443',
		'[2001:db8::1]:8787',
		'x'.repeat(255),
	]) {
		const filters = validateRequestLogSearch({
			ingress_host,
			page: 3,
			provider_id: 'octafuse-mcp',
			model_id_prefix: 'mcp:qa/',
			user_id: 'user-1',
			api_key_id: 'key-1',
			protocol: 'minimax',
			start_date: '2026-10-18',
		})
		const params = new URL(requestLogsPath(filters), 'https://example.test')
			.searchParams
		assert.equal(filters.ingress_host, ingress_host)
		assert.equal(params.get('ingress_host'), ingress_host)
		assert.equal(params.get('model_id_prefix'), 'mcp:qa/')
		assert.equal(params.get('provider_id'), 'octafuse-mcp')
		assert.equal(params.get('api_key_id'), 'key-1')
		assert.equal(params.get('user_id'), 'user-1')
		assert.equal(params.get('protocol'), 'minimax')
		assert.equal(params.get('page'), '3')
		assert.equal(params.get('start_date'), '2026-10-18')
	}
	for (const ingress_host of [undefined, ''])
		assert.equal(
			new URL(
				requestLogsPath(validateRequestLogSearch({ ingress_host })),
				'https://example.test'
			).searchParams.has('ingress_host'),
			false
		)
	assert.equal(
		validateRequestLogSearch({ ingress_host: ' Edge.Test:8080 ' }).ingress_host,
		'Edge.Test:8080'
	)
})

test('invalid ingress URL filters remain blocked and cannot serialize to an expanded query', () => {
	for (const ingress_host of [
		' ',
		'a\nb',
		'x'.repeat(256),
		null,
		0,
		['a', 'b'],
	]) {
		assert.throws(() => validateRequestLogSearch({ ingress_host }))
		const search = validateRequestLogRouteSearch({
			ingress_host,
			provider_id: 'octafuse-mcp',
			model_id_prefix: 'mcp:qa/',
		})
		assert.equal(search.invalidFilter, true)
		assert.equal(
			validateRequestLogRouteSearch({ ...search, status: 'error' })
				.invalidFilter,
			true
		)
		assert.equal(search.provider_id, 'octafuse-mcp')
		assert.equal(search.model_id_prefix, 'mcp:qa/')
		assert.throws(() => requestLogsPath(search))
		assert.throws(() =>
			requestLogsPath({
				...validateRequestLogSearch({}),
				ingress_host: ingress_host as string,
			})
		)
	}
})

test('host snapshots are bounded nullable optional text and do not invalidate legacy logs', () => {
	for (const ingress_host of [
		undefined,
		null,
		'Gateway.Example.test:8443',
		'[2001:db8::1]:8787',
	]) {
		const data = requestLogsResponseSchema.parse({
			success: true,
			data: [{ ...row, ingress_host }],
			total: 1,
			page: 1,
			page_size: 50,
		}).data[0]
		assert.equal(data.ingress_host, ingress_host)
	}
	for (const ingress_host of [42, {}, 'x'.repeat(256)])
		assert.equal(
			requestLogsResponseSchema.safeParse({
				success: true,
				data: [{ ...row, ingress_host }],
				total: 1,
				page: 1,
				page_size: 50,
			}).success,
			false
		)
})

test('model prefix normalization preserves literal Unicode and rejects malformed encoding before building a request', () => {
	for (const model_id_prefix of [
		'\ud800',
		'\udfff',
		' ',
		'a\nb',
		'x'.repeat(601),
	]) {
		assert.throws(() => validateRequestLogSearch({ model_id_prefix }))
		assert.throws(() =>
			requestLogsPath({ ...validateRequestLogSearch({}), model_id_prefix })
		)
	}
	const prefix = 'mcp:模型%_\\Case/'
	const search = validateRequestLogSearch({
		model_id_prefix: ' ' + prefix + ' ',
	})
	assert.equal(search.model_id_prefix, prefix)
	assert.equal(
		new URL(requestLogsPath(search), 'https://example.test').searchParams.get(
			'model_id_prefix'
		),
		prefix
	)
})

test('invalid prefix URLs remain editable, scoped and unqueryable until explicitly repaired or cleared', () => {
	const scope = {
		provider_id: 'octafuse-mcp',
		user_id: 'user-1',
		api_key_id: 'key-1',
		status: 'success',
		start_date: '2026-10-18',
		end_date: '2026-10-19',
		ingress_host: 'Gateway.Test:8443',
		page: 3,
	}
	for (const model_id_prefix of [
		' ',
		'a\nb',
		'x'.repeat(601),
		'\ud800',
		null,
		['mcp:a/'],
	]) {
		const search = validateRequestLogRouteSearch({ ...scope, model_id_prefix })
		assert.equal(search.invalidFilter, true)
		assert.equal(search.invalidModelPrefix, true)
		assert.equal(search.invalidIngressHost, undefined)
		assert.ok(search.model_id_prefix)
		assert.equal(search.provider_id, scope.provider_id)
		assert.equal(search.user_id, scope.user_id)
		assert.equal(search.api_key_id, scope.api_key_id)
		assert.equal(search.ingress_host, scope.ingress_host)
		assert.equal(search.start_date, scope.start_date)
		assert.equal(search.end_date, scope.end_date)
		assert.throws(() => requestLogsPath(search))
		const changedStatus = validateRequestLogRouteSearch({
			...search,
			status: 'error',
		})
		assert.equal(changedStatus.invalidModelPrefix, true)
		assert.throws(() => requestLogsPath(changedStatus))
		for (const prefix of ['mcp:Fixed_%/', '']) {
			const repaired = updateRequestLogScopedFilter(
				search,
				'model_id_prefix',
				prefix
			)
			assert.equal(repaired.invalidFilter, undefined)
			assert.equal(repaired.invalidModelPrefix, undefined)
			assert.equal(repaired.page, 1)
			const params = new URL(requestLogsPath(repaired), 'https://example.test')
				.searchParams
			assert.equal(params.get('model_id_prefix'), prefix || null)
			assert.equal(params.get('ingress_host'), scope.ingress_host)
			assert.equal(params.get('provider_id'), scope.provider_id)
			assert.equal(params.get('api_key_id'), scope.api_key_id)
		}
	}
})

test('combined host and prefix errors survive repairing the other field and never broaden a query', () => {
	const search = validateRequestLogRouteSearch({
		provider_id: 'octafuse-mcp',
		ingress_host: ' ',
		model_id_prefix: ' ',
		page: 3,
	})
	assert.equal(search.invalidIngressHost, true)
	assert.equal(search.invalidModelPrefix, true)
	assert.throws(() => requestLogsPath(search))
	const hostFirst = updateRequestLogScopedFilter(
		search,
		'ingress_host',
		'Fixed.Gateway:8443'
	)
	assert.equal(hostFirst.invalidFilter, true)
	assert.equal(hostFirst.invalidIngressHost, undefined)
	assert.equal(hostFirst.invalidModelPrefix, true)
	assert.equal(hostFirst.model_id_prefix, ' ')
	assert.throws(() => requestLogsPath(hostFirst))
	const prefixFirst = updateRequestLogScopedFilter(
		search,
		'model_id_prefix',
		'mcp:Fixed/'
	)
	assert.equal(prefixFirst.invalidFilter, true)
	assert.equal(prefixFirst.invalidIngressHost, true)
	assert.equal(prefixFirst.invalidModelPrefix, undefined)
	assert.equal(prefixFirst.ingress_host, ' ')
	assert.throws(() => requestLogsPath(prefixFirst))
	for (const fixed of [
		updateRequestLogScopedFilter(hostFirst, 'model_id_prefix', ''),
		updateRequestLogScopedFilter(prefixFirst, 'ingress_host', ''),
	]) {
		assert.equal(fixed.invalidFilter, undefined)
		assert.equal(fixed.provider_id, 'octafuse-mcp')
		assert.doesNotThrow(() => requestLogsPath(fixed))
	}
})

test('provider set URLs canonicalize literal IDs while retaining the exact-provider intersection', () => {
	const search = validateRequestLogSearch({
		provider_ids: ' z,目录🧪,A,,z ',
		provider_id: 'z',
		page: 3,
		ingress_host: 'Gateway.Test:8443',
		model_id_prefix: 'mcp:qa/',
	})
	assert.equal(search.provider_ids, 'A,z,目录🧪')
	const params = new URL(requestLogsPath(search), 'https://example.test')
		.searchParams
	assert.equal(params.get('provider_ids'), search.provider_ids)
	assert.equal(params.get('provider_id'), 'z')
	assert.equal(params.get('ingress_host'), search.ingress_host)
	assert.equal(params.get('model_id_prefix'), search.model_id_prefix)
	assert.equal(params.get('page'), '3')
	for (const provider_ids of [undefined, '']) {
		const legacy = validateRequestLogSearch({ provider_ids })
		assert.equal(legacy.provider_ids, '')
		assert.equal(
			new URL(requestLogsPath(legacy), 'https://example.test').searchParams.has(
				'provider_ids'
			),
			false
		)
	}
})

test('invalid provider set URLs remain editable, scoped and unqueryable until repaired', () => {
	for (const provider_ids of [
		null,
		0,
		[],
		['p'],
		{},
		' ',
		', ,',
		'a\nb',
		'\ud800',
		'x'.repeat(601),
		'x'.repeat(6010),
		Array.from({ length: 11 }, (_, i) => `p${i}`).join(','),
	]) {
		assert.throws(() => validateRequestLogSearch({ provider_ids }))
		const search = validateRequestLogRouteSearch({
			provider_ids,
			user_id: 'u',
			api_key_id: 'k',
			provider_id: 'p',
			ingress_host: 'Gateway.Test',
			model_id_prefix: 'mcp:q/',
			page: 3,
		})
		assert.equal(search.invalidProviderIds, true)
		assert.equal(search.invalidFilter, true)
		assert.ok(search.provider_ids)
		assert.equal(search.user_id, 'u')
		assert.equal(search.api_key_id, 'k')
		assert.equal(search.provider_id, 'p')
		assert.equal(search.ingress_host, 'Gateway.Test')
		assert.equal(search.model_id_prefix, 'mcp:q/')
		assert.throws(() => requestLogsPath(search))
		assert.throws(() =>
			requestLogsPath({
				...validateRequestLogSearch({}),
				provider_ids: provider_ids as string,
			})
		)
		const next = validateRequestLogRouteSearch({ ...search, status: 'error' })
		assert.equal(next.invalidProviderIds, true)
		assert.throws(() => requestLogsPath(next))
		for (const value of ['', ' p2,p1,p2 ']) {
			const fixed = updateRequestLogScopedFilter(search, 'provider_ids', value)
			assert.equal(fixed.invalidProviderIds, undefined)
			assert.equal(fixed.invalidFilter, undefined)
			assert.equal(fixed.page, 1)
			assert.equal(fixed.provider_ids, value ? 'p1,p2' : '')
			assert.equal(fixed.provider_id, 'p')
			assert.doesNotThrow(() => requestLogsPath(fixed))
		}
	}
})

test('all three scoped errors survive independent repairs in every order', () => {
	const orders = [
		['ingress_host', 'model_id_prefix', 'provider_ids'],
		['ingress_host', 'provider_ids', 'model_id_prefix'],
		['model_id_prefix', 'ingress_host', 'provider_ids'],
		['model_id_prefix', 'provider_ids', 'ingress_host'],
		['provider_ids', 'ingress_host', 'model_id_prefix'],
		['provider_ids', 'model_id_prefix', 'ingress_host'],
	] as const
	const flags = {
		ingress_host: 'invalidIngressHost',
		model_id_prefix: 'invalidModelPrefix',
		provider_ids: 'invalidProviderIds',
	} as const
	for (const order of orders) {
		let search = validateRequestLogRouteSearch({
			ingress_host: ' ',
			model_id_prefix: ' ',
			provider_ids: ', ,',
			provider_id: 'p',
			page: 3,
		})
		for (const [index, key] of order.entries()) {
			assert.equal(search[flags[key]], true)
			search = updateRequestLogScopedFilter(search, key, '')
			assert.equal(search[flags[key]], undefined)
			assert.equal(search.provider_id, 'p')
			assert.equal(search.page, 1)
			if (index < 2) {
				assert.equal(search.invalidFilter, true)
				assert.throws(() => requestLogsPath(search))
			} else {
				assert.equal(search.invalidFilter, undefined)
				assert.doesNotThrow(() => requestLogsPath(search))
			}
		}
	}
})

test('provider scope ACK is an optional canonical array, never coerced or normalized from malformed replies', () => {
	const base = { success: true, data: [], total: 0, page: 1, page_size: 50 }
	for (const provider_ids of [
		[],
		null,
		'a,b',
		[''],
		['a', 'a'],
		['b', 'a'],
		[' a'],
		['a,b'],
		['a\nb'],
		['\ud800'],
		['x'.repeat(601)],
		Array.from({ length: 11 }, (_, i) => `p${i}`),
	])
		assert.equal(
			requestLogsResponseSchema.safeParse({
				...base,
				applied_filters: { provider_ids },
			}).success,
			false
		)
	assert.deepEqual(
		requestLogsResponseSchema.parse({
			...base,
			applied_filters: { provider_ids: ['A', 'a', '目录🧪'], secret: 'drop' },
		}).applied_filters,
		{ provider_ids: ['A', 'a', '目录🧪'] }
	)
	assert.equal(requestLogsResponseSchema.safeParse(base).success, true)
})
