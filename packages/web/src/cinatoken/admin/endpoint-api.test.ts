/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
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
	createEndpointsApi,
	type EndpointAdminTransport,
	type EndpointRequestOptions,
} from './endpoint-api'
import { checkedEndpointInput, EndpointInputError } from './endpoint-input'
import { validateEndpointSearch } from './endpoint-search'

const now = '2026-09-27T00:00:00.000Z'
const row = {
	id: 'endpoint/one',
	model_id: 'model/one',
	provider_id: 'provider/one',
	provider_slug: 'custom',
	tag: 'custom',
	endpoint_class: 'standard',
	region: null,
	context_length: 1000,
	max_prompt_tokens: null,
	max_completion_tokens: null,
	quantization: null,
	supported_parameters: ['stream'],
	pricing: null,
	supports_implicit_caching: null,
	supports_voice_cloning: null,
	supports_tool_choice: {
		auto: null,
		function: null,
		none: null,
		required: null,
	},
	image_capabilities: null,
	audio_capabilities: null,
	evidence_url: null,
	verified_by: null,
	verified_at: null,
	expires_at: null,
	status: 'draft',
	created_at: now,
	updated_at: now,
	route_target_ids: ['route/one'],
}
const create = {
	model_id: row.model_id,
	provider_id: row.provider_id,
	provider_slug: 'custom',
	tag: 'custom',
}
type Call = { path: string; init: RequestInit; options: EndpointRequestOptions }
function fixture(
	reply: unknown | ((call: Call) => unknown | Promise<unknown>) = {
		success: true,
		data: [row],
		count: 1,
	}
) {
	const calls: Call[] = []
	const transport: EndpointAdminTransport = {
		async send<T>(
			path: string,
			schema: z.ZodType<T>,
			init: RequestInit,
			options: EndpointRequestOptions
		): Promise<T> {
			const auth = adminDomainFixtureAuth(path)
			if (auth !== undefined) return schema.parse(auth)
			const call = { path, init, options }
			calls.push(call)
			return schema.parse(
				adminDomainFixtureAck(
					path,
					init,
					typeof reply === 'function' ? await reply(call) : reply
				)
			)
		},
		invalidResponse(): never {
			throw new CinaTokenApiError(
				'Invalid endpoint response',
				0,
				'invalid-response'
			)
		},
		sanitizeError(error) {
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'Endpoint request failed',
					error.status,
					error.code,
					error.serverCode
				)
			if (error instanceof DOMException && error.name === 'AbortError')
				return new CinaTokenApiError(
					'Endpoint request cancelled',
					0,
					'cancelled'
				)
			return new Error('Endpoint request failed')
		},
	}
	return {
		api: bindAdminDomainFixtureApi(createEndpointsApi(transport), {
			createEndpoint: 1,
			updateEndpoint: 2,
			deleteEndpoint: 1,
			linkEndpointRoute: 2,
			unlinkEndpointRoute: 2,
			bootstrapDeepSeekEndpoints: 0,
		}),
		calls,
	}
}
test('list encodes exact filters and never forwards account scope options or credentials', async () => {
	const { api, calls } = fixture()
	assert.equal(
		(
			await api.endpointList(
				{
					model_id: row.model_id,
					provider_id: row.provider_id,
					status: 'draft',
				},
				{
					timeoutMs: 500,
					expectedWorkspaceId: 'private-workspace',
				} as EndpointRequestOptions
			)
		).length,
		1
	)
	assert.equal(
		calls[0]!.path,
		'/api/admin/endpoints?model_id=model%2Fone&provider_id=provider%2Fone&status=draft'
	)
	assert.deepEqual(calls[0]!.options, { signal: undefined, timeoutMs: 500 })
	assert.equal(calls[0]!.init.headers, undefined)
})
test('endpoint DTO and dropdowns whitelist fields before caching', async () => {
	const { api } = fixture({
		success: true,
		data: [
			{ ...row, api_key: 'PRIVATE', headers: { Authorization: 'PRIVATE' } },
		],
		count: 1,
	})
	assert.ok(!JSON.stringify(await api.endpointList()).includes('PRIVATE'))
	const choices = fixture((call: Call) => {
		if (call.path.endsWith('/models'))
			return {
				success: true,
				data: [
					{ id: row.model_id, display_name: 'Model', custom_params: 'PRIVATE' },
				],
				count: 1,
			}
		if (call.path.endsWith('/providers'))
			return {
				success: true,
				data: [
					{
						id: row.provider_id,
						name: 'Provider',
						api_key: 'PRIVATE',
						endpoints: 'PRIVATE',
					},
				],
				count: 1,
			}
		return {
			success: true,
			data: [
				{
					id: 'route/one',
					model_id: row.model_id,
					provider_id: row.provider_id,
					headers: 'PRIVATE',
				},
			],
			count: 1,
		}
	})
	assert.ok(
		!JSON.stringify(await choices.api.endpointChoices()).includes('PRIVATE')
	)
	assert.equal(choices.calls.length, 3)
})
test('mismatched collection count, duplicate identity, filter or detail fails closed', async () => {
	for (const data of [
		{ success: true, data: [row], count: 0 },
		{ success: true, data: [row, row], count: 2 },
	])
		await assert.rejects(
			fixture(data).api.endpointList(),
			(error) =>
				(error instanceof CinaTokenApiError &&
					error.code === 'invalid-response') ||
				(error instanceof AdminDomainWriteError && error.code === 'unknown')
		)
	await assert.rejects(
		fixture().api.endpointList({ model_id: 'another' }),
		(error) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
	await assert.rejects(
		fixture({ success: true, data: row }).api.endpoint('another'),
		(error) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
})
test('create normalizes ids and defaults draft; direct publication and unknown fields are rejected locally', async () => {
	const { api, calls } = fixture({
		success: true,
		data: { id: row.id, status: 'draft', audio_capabilities: null },
	})
	await api.createEndpoint({
		...create,
		provider_slug: ' CUSTOM ',
		tag: ' CUSTOM ',
	})
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		...create,
		endpoint_class: null,
		supported_parameters: [],
		status: 'draft',
	})
	for (const input of [
		{ ...create, status: 'verified' },
		{ ...create, api_key: 'PRIVATE' },
		{ ...create, tag: 'custom/fast' },
	])
		assert.throws(
			() => checkedEndpointInput(input as typeof create, true),
			EndpointInputError
		)
})
test('partial PATCH keeps absent fields absent and status-only verification is explicit', async () => {
	const { api, calls } = fixture({
		success: true,
		data: { id: row.id, status: 'verified', audio_capabilities: null },
	})
	await api.updateEndpoint(row.id, { status: 'verified' })
	assert.equal(calls[0]!.path, '/api/admin/endpoints/endpoint%2Fone')
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		status: 'verified',
	})
	await api.updateEndpoint(row.id, { context_length: 2000 })
	assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), {
		context_length: 2000,
	})
	await assert.rejects(
		fixture({
			success: true,
			data: { id: 'another', status: 'draft', audio_capabilities: null },
		}).api.updateEndpoint(row.id, { status: 'draft' })
	)
})
test('full USD pricing preserves all documented decimal and discount fields', () => {
	const input = checkedEndpointInput(
		{
			...create,
			pricing: {
				currency: 'USD',
				prompt: '0.00000000123456789',
				completion: '0',
				request: '0.001',
				audio: '0.02',
				audio_output: '0.01',
				discount: 0.5,
				image: '0.03',
				image_output: '0.04',
				image_token: '0.0000001',
				input_audio_cache: '0',
				input_cache_read: '0',
				input_cache_write: '0',
				input_cache_write_1h: '0',
				internal_reasoning: '0',
				web_search: '0.04',
			},
		},
		true
	)
	assert.equal(input.pricing?.currency, 'USD')
	assert.equal(input.pricing?.prompt, '0.00000000123456789')
	assert.equal(input.pricing?.discount, 0.5)
	assert.equal(input.pricing?.web_search, '0.04')
	assert.throws(
		() =>
			checkedEndpointInput(
				{
					...create,
					pricing: { currency: 'CNY', prompt: '0', completion: '0' },
				},
				true
			),
		EndpointInputError
	)
})
test('audio request evidence cannot silently imply voice cloning, and image provider matches', () => {
	const audio = {
		v: 1,
		pricing_by_operation: {
			'audio.speech': {
				currency: 'USD',
				meter: {
					kind: 'characters',
					unit: 'unicode_code_point',
					price: '0.01',
					minimum_units: 0,
					increment_units: 1,
				},
			},
		},
		speech_by_operation: {
			'audio.speech': {
				supports_default_voice: false,
				reference_audio_media_types: ['audio/wav'],
				reference_audio_default_media_type: 'audio/wav',
			},
		},
	}
	assert.throws(
		() =>
			checkedEndpointInput(
				{ ...create, supports_voice_cloning: false, audio_capabilities: audio },
				true
			),
		EndpointInputError
	)
	assert.equal(
		checkedEndpointInput(
			{ ...create, supports_voice_cloning: true, audio_capabilities: audio },
			true
		).audio_capabilities?.v,
		1
	)
	assert.throws(
		() =>
			checkedEndpointInput(
				{
					...create,
					image_capabilities: {
						provider_slug: 'other',
						provider_tag: null,
						supports_streaming: false,
						supported_parameters: {},
						allowed_passthrough_parameters: [],
						pricing: [],
					},
				},
				true
			),
		EndpointInputError
	)
})
test('route links are individually encoded and dot segments are refused', async () => {
	const { api, calls } = fixture({ success: true })
	await api.linkEndpointRoute(row.id, 'route/one')
	await api.unlinkEndpointRoute(row.id, 'route/one')
	await api.deleteEndpoint(row.id)
	assert.deepEqual(
		calls.map((call) => call.init.method),
		['POST', 'DELETE', 'DELETE']
	)
	assert.equal(
		calls[0]!.path,
		'/api/admin/endpoints/endpoint%2Fone/routes/route%2Fone'
	)
	await assert.rejects(api.linkEndpointRoute(row.id, '..'))
	await assert.rejects(api.deleteEndpoint('.'))
	assert.equal(calls.length, 3)
})
test('bootstrap keeps individual published, skipped and partial failure outcomes and counts', async () => {
	const data = {
		provider_id: 'deepseek-official',
		evidence_url: 'https://api-docs.deepseek.com/quick_start/pricing/',
		evidence_expires_at: now,
		pricing_basis: 'peak',
		published: 1,
		linked_routes: 3,
		skipped: 1,
		failed: 1,
		models: [
			{
				model_id: 'one',
				endpoint_id: row.id,
				status: 'published',
				linked_routes: 1,
				message: null,
			},
			{
				model_id: 'two',
				endpoint_id: null,
				status: 'skipped_no_routes',
				linked_routes: 0,
				message: null,
			},
			{
				model_id: 'three',
				endpoint_id: 'partial',
				status: 'failed',
				linked_routes: 2,
				message: 'Publication failed',
			},
		],
	}
	const { api, calls } = fixture({ success: true, data })
	assert.deepEqual(await api.bootstrapDeepSeekEndpoints(), {
		...data,
		models: data.models.map((model) => ({ ...model, message: null })),
	})
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { publish: true })
	await assert.rejects(
		fixture({
			success: true,
			data: { ...data, linked_routes: 1 },
		}).api.bootstrapDeepSeekEndpoints(),
		(error) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
})
test('401/403/409/503 preserve status but scrub unsafe errors and never retry mutations', async () => {
	for (const status of [401, 403, 409, 503]) {
		const { api, calls } = fixture(() => {
			throw new CinaTokenApiError('PRIVATE unsafe error', status, 'http')
		})
		await assert.rejects(
			api.deleteEndpoint(row.id),
			(error) =>
				(error instanceof CinaTokenApiError ||
					error instanceof AdminDomainWriteError) &&
				error.status === status &&
				!error.message.includes('PRIVATE')
		)
		assert.equal(calls.length, 1)
	}
})
test('abort before request and late cancellation cannot return another console epoch data', async () => {
	const controller = new AbortController()
	controller.abort()
	const aborted = fixture()
	await assert.rejects(
		aborted.api.endpointList({}, { signal: controller.signal }),
		(error) => error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
	assert.equal(aborted.calls.length, 0)
	const late = new AbortController()
	const delayed = fixture(async () => {
		late.abort()
		return { success: true, data: [row], count: 1 }
	})
	await assert.rejects(
		delayed.api.endpointList({}, { signal: late.signal }),
		(error) => error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
})
test('search state rejects unsupported filters, control bytes and oversized IDs', () => {
	for (const invalid of [null, undefined, [], 'query', 1])
		assert.deepEqual(validateEndpointSearch(invalid), {
			q: '',
			status: 'all',
			model: '',
			provider: '',
		})
	assert.deepEqual(
		validateEndpointSearch({
			q: ' hello ',
			status: 'verified',
			model: 'model/one',
			provider: 'provider/one',
		}),
		{
			q: 'hello',
			status: 'verified',
			model: 'model/one',
			provider: 'provider/one',
		}
	)
	assert.deepEqual(
		validateEndpointSearch({
			q: '\u0000private',
			status: 'published',
			model: 'x'.repeat(513),
			provider: null,
		}),
		{ q: '', status: 'all', model: '', provider: '' }
	)
})
