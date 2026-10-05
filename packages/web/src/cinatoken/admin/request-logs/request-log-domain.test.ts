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
		'/v1/dashscope/services/aigc/multimodal-generation/generation'
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
