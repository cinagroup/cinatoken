/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../../api'
import { createAdminUserAnalyticsApi } from '../users/user-analytics-api'
import {
	modelAnalyticsRowSchema,
	modelProviderRowSchema,
} from './model-analytics-contracts'

const row = {
	model_id: 'model-1',
	route_group: 'default',
	request_count: 3,
	input_tokens: 100,
	output_tokens: 50,
	cache_read_tokens: 20,
	cache_write_tokens: 4,
	cache_hit_rate: 20,
	standard_cost: 0.6,
	charged_cost: 0.4,
	metered_cost: 0.3,
	success_count: 2,
	error_count: 1,
	success_rate: 200 / 3,
	avg_latency_ms: 100,
	avg_first_reasoning_token_ms: null,
	avg_first_token_ms: 20,
	avg_effective_ttft_ms: 20,
	avg_reasoning_phase_ms: null,
	reasoning_ttft_rate: 0,
	content_ttft_rate: 50,
	avg_upstream_response_ms: null,
	tokens_per_second: 30,
	failover_rate: 150,
	avg_attempts: 2.5,
	avg_charged_per_request: 0.4 / 3,
	provider_id: 'provider-a',
	provider_name: 'Provider A',
	distinct_models: 1,
}
const quality = {
	stream_tokens_per_second: 50,
	stream_sample_count: 1,
	failover_request_count: 1,
	failover_request_rate: 100 / 3,
}

for (const [name, schema] of [
	['model', modelAnalyticsRowSchema],
	['provider', modelProviderRowSchema],
] as const) {
	test(`${name} quality pairs remain optional and retain distinct legacy meanings`, () => {
		const legacy = schema.parse(row)
		for (const key of Object.keys(quality))
			assert.equal(Object.hasOwn(legacy, key), false)
		const current = schema.parse({
			...row,
			...quality,
			private_notes: 'PRIVATE',
		})
		for (const key of Object.keys(quality) as Array<keyof typeof quality>)
			assert.equal(current[key], quality[key])
		assert.equal(current.tokens_per_second, 30)
		assert.equal(current.failover_rate, 150)
		assert.equal(Object.hasOwn(current, 'private_notes'), false)
		assert.ok(
			schema.safeParse({
				...row,
				stream_tokens_per_second: 0,
				stream_sample_count: 1,
			}).success
		)
		assert.ok(
			schema.safeParse({
				...row,
				stream_tokens_per_second: null,
				stream_sample_count: 0,
			}).success
		)
		assert.ok(
			schema.safeParse({
				...row,
				failover_request_count: 1,
				failover_request_rate: 33.3333,
			}).success
		)
		assert.ok(
			schema.safeParse({
				...row,
				failover_request_count: 3,
				failover_request_rate: 100,
			}).success
		)
	})
	test(`${name} quality pairs reject partial, non-finite, unsafe and inconsistent cohorts`, () => {
		const invalid = [
			{ stream_tokens_per_second: 10 },
			{ stream_sample_count: 1 },
			{ failover_request_count: 1 },
			{ failover_request_rate: 50 },
			{ stream_tokens_per_second: 0, stream_sample_count: 0 },
			{ stream_tokens_per_second: null, stream_sample_count: 1 },
			{ failover_request_count: 0, failover_request_rate: 1 },
			{ failover_request_count: 3, failover_request_rate: 99 },
			...[3, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(
				(stream_sample_count) => ({
					stream_tokens_per_second: 10,
					stream_sample_count,
				})
			),
			...[-1, Infinity, NaN, '50'].map((stream_tokens_per_second) => ({
				stream_tokens_per_second,
				stream_sample_count: 1,
			})),
			...[4, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(
				(failover_request_count) => ({
					failover_request_count,
					failover_request_rate: 50,
				})
			),
			...[-1, 101, Infinity, NaN, null].map((failover_request_rate) => ({
				failover_request_count: 1,
				failover_request_rate,
			})),
		]
		for (const fields of invalid)
			assert.equal(
				schema.safeParse({ ...row, ...fields }).success,
				false,
				JSON.stringify(fields)
			)
		const empty = {
			...row,
			request_count: 0,
			success_count: 0,
			error_count: 0,
			failover_request_count: 0,
			failover_request_rate: 0,
		}
		assert.ok(schema.safeParse(empty).success)
		assert.equal(
			schema.safeParse({ ...empty, failover_request_rate: 1 }).success,
			false
		)
	})
}

test('user and Key model drilldowns share additive metrics and reject incomplete pairs', async () => {
	const start = '2026-10-01 00:00:00',
		end = '2026-10-02 00:00:00'
	const userId = '11111111-1111-4111-8111-111111111111'
	for (const fields of [{}, quality, { stream_sample_count: 1 }]) {
		const calls: string[] = []
		const transport = createCinaTokenCookieTransport(async (path) => {
			calls.push(String(path))
			return Response.json({
				success: true,
				data: [{ ...row, ...fields }],
				tags: [],
			})
		})
		const api = createAdminUserAnalyticsApi({
			send: (path, schema, init, options) =>
				transport.send(path, schema, init, options),
			invalidResponse(): never {
				throw new CinaTokenApiError('Invalid response', 200, 'invalid-response')
			},
			sanitizeError(error): Error {
				return error instanceof Error ? error : new Error('Read failed')
			},
		})
		const reads = [
			() => api.userModels(start, end, 'alice@example.test'),
			() => api.userKeyModels(start, end, userId, 'key-a'),
		]
		for (const read of reads) {
			if (Object.keys(fields).length === 1) {
				await assert.rejects(
					read,
					(error: unknown) =>
						error instanceof CinaTokenApiError &&
						error.code === 'invalid-response'
				)
			} else {
				const result = (await read())[0]!
				assert.equal(
					result.stream_sample_count,
					Object.keys(fields).length ? 1 : undefined
				)
				assert.equal(
					result.failover_request_rate,
					Object.keys(fields).length ? 100 / 3 : undefined
				)
				assert.equal(result.failover_rate, 150)
			}
		}
		const user = new URL(calls[0]!, 'https://example.test'),
			key = new URL(calls[1]!, 'https://example.test')
		assert.equal(user.searchParams.get('user_email'), 'alice@example.test')
		assert.equal(key.searchParams.get('user_id'), userId)
		assert.equal(key.searchParams.get('api_key_id'), 'key-a')
	}
})
