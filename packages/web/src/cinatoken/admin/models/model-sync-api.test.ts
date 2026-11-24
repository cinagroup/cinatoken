/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { deferred } from '../../test-fixtures'
import { adminDomainFixtureAuth } from '../domain-api-test-fixture'
import { AdminDomainWriteError } from '../domain-write-recovery'
import { createModelsApi, type ModelRequestOptions } from '../model-api'
import type { ModelSyncItem } from '../model-contracts'
import { modelSyncFixture } from './model-sync-fixtures'
import { ModelWriteRecovery } from './model-write-recovery'

const items: ModelSyncItem[] = [
	{ model_id: 'openai/text', fields: ['display_name'] },
	{ model_id: 'openai/image', fields: ['max_tokens'] },
	{ model_id: 'alibaba/speech', fields: ['vendor'] },
]
const options: ModelRequestOptions = {
	expectedConsoleSubject: 'fixture-subject',
	expectedUserId: 'fixture-user',
	onDispatch: () => undefined,
}
const ack = { domain: 'models', operation: 'sync' }
type Call = { path: string; init: RequestInit }
function fixture(
	reply: (call: Call) => Promise<Response>,
	auth?: (path: string) => unknown
) {
	const calls: Call[] = []
	const transport = createCinaTokenCookieTransport(async (input, init) => {
		const call = { path: String(input), init: init ?? {} }
		calls.push(call)
		const check = auth?.(call.path) ?? adminDomainFixtureAuth(call.path)
		if (check !== undefined) return Response.json(check)
		return reply(call)
	})
	const api = createModelsApi({
		send: (path, schema, init, requestOptions) =>
			transport.send(path, schema, init, requestOptions),
		invalidResponse: () => {
			throw new CinaTokenApiError('Invalid response', 200, 'invalid-response')
		},
		sanitizeError: (error) =>
			error instanceof CinaTokenApiError
				? new CinaTokenApiError('Safe model error', error.status, error.code)
				: new Error('Safe model error'),
	})
	return { api, calls }
}
function memory() {
	const values = new Map<string, string>()
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value)
		},
		removeItem: (key: string) => {
			values.delete(key)
		},
	}
}

test('sync diff uses the exact read endpoint and validates grouped identities without a write', async () => {
	const f = fixture(async () =>
		Response.json({ success: true, data: modelSyncFixture })
	)
	assert.deepEqual(await f.api.modelSyncReport(), modelSyncFixture)
	assert.deepEqual(
		f.calls.map((call) => call.path),
		['/api/admin/models/sync/diff']
	)
	assert.equal(
		new Headers(f.calls[0]!.init.headers).has('Authorization'),
		false
	)
	assert.equal(f.calls[0]!.init.credentials, 'same-origin')
	const invalid = fixture(async () =>
		Response.json({
			success: true,
			data: { ...modelSyncFixture, models_with_diff: 999 },
		})
	)
	await assert.rejects(invalid.api.modelSyncReport())
})

test('apply rechecks Console identity, sends only selected fields and accepts the real partial result', async () => {
	const f = fixture(async () =>
		Response.json({
			success: true,
			data: {
				updated: 1,
				skipped: 1,
				failed: [
					{
						model_id: 'alibaba/speech',
						message: 'private SQL sk-secret-do-not-retain',
					},
				],
			},
			acknowledgement: ack,
		})
	)
	const operations: string[] = []
	const result = await f.api.applyModelSync(items, {
		...options,
		onDispatch: (operation) => operations.push(operation),
	})
	assert.deepEqual(
		f.calls.map((call) => call.path),
		['/api/auth/check', '/api/user/me', '/api/admin/models/sync/apply']
	)
	assert.deepEqual(operations, ['sync'])
	const call = f.calls.at(-1)!
	assert.deepEqual(JSON.parse(String(call.init.body)), { items })
	assert.equal(
		new Headers(call.init.headers).get('X-CinaToken-Expected-Console-Subject'),
		'fixture-subject'
	)
	assert.equal(new Headers(call.init.headers).has('Authorization'), false)
	assert.deepEqual(result, {
		updated: 1,
		skipped: 1,
		failed: [{ model_id: 'alibaba/speech', message: 'Model sync failed' }],
	})
	assert.equal(JSON.stringify(result).includes('sk-secret'), false)
})

test('invalid count, failed identity and domain ACK leave the batch unknown across remount, with no replay on a read', async () => {
	const invalid = [
		{ data: { updated: 2, skipped: 0, failed: [] }, acknowledgement: ack },
		{
			data: {
				updated: 2,
				skipped: 0,
				failed: [{ model_id: 'unselected', message: 'private' }],
			},
			acknowledgement: ack,
		},
		{
			data: {
				updated: 1,
				skipped: 0,
				failed: [
					{ model_id: 'openai/text', message: 'x' },
					{ model_id: 'openai/text', message: 'x' },
				],
			},
			acknowledgement: ack,
		},
		{ data: { updated: 3, skipped: 0, failed: [] } },
		{
			data: { updated: 3, skipped: 0, failed: [] },
			acknowledgement: { domain: 'providers', operation: 'sync' },
		},
	]
	for (const body of invalid) {
		const storage = memory()
		const recovery = new ModelWriteRecovery(storage)
		const identity = JSON.stringify(['fixture-user', 'fixture-subject', 1])
		const f = fixture(async (call) =>
			Response.json(
				call.path.endsWith('/sync/diff')
					? { success: true, data: modelSyncFixture }
					: { success: true, ...body }
			)
		)
		await assert.rejects(
			f.api.applyModelSync(items, {
				...options,
				onDispatch: (operation) => {
					recovery.markPending(identity, 'models', operation)
				},
			}),
			(error) =>
				error instanceof AdminDomainWriteError && error.code === 'unknown'
		)
		const remount = new ModelWriteRecovery(storage)
		assert.equal(remount.status(identity, 'models'), 'pending')
		assert.throws(() => remount.markPending(identity, 'models', 'sync'))
		await f.api.modelSyncReport()
		assert.equal(remount.status(identity, 'models'), 'pending')
		assert.equal(
			f.calls.filter((call) => call.init.method === 'POST').length,
			1
		)
	}
})

test('a fully skipped or failed batch is a known result and does not replay', async () => {
	for (const data of [
		{ updated: 0, skipped: 3, failed: [] },
		{
			updated: 0,
			skipped: 0,
			failed: items.map((item) => ({
				model_id: item.model_id,
				message: 'private failure',
			})),
		},
	]) {
		const f = fixture(async () =>
			Response.json({ success: true, data, acknowledgement: ack })
		)
		const result = await f.api.applyModelSync(items, options)
		assert.equal(result.updated, 0)
		assert.equal(result.skipped + result.failed.length, 3)
		assert.equal(
			f.calls.filter((call) => call.init.method === 'POST').length,
			1
		)
	}
})

test('invalid selections and changed identity cannot dispatch a sync batch', async () => {
	const f = fixture(async () => {
		throw new Error('Must not dispatch')
	})
	await assert.rejects(f.api.applyModelSync([], options))
	assert.equal(f.calls.length, 0)
	const changed = fixture(
		async () => {
			throw new Error('Must not dispatch')
		},
		(path) =>
			path === '/api/auth/check'
				? {
						authenticated: true,
						verification: 'verified',
						principalType: 'console',
						subject: 'another-subject',
					}
				: undefined
	)
	await assert.rejects(
		changed.api.applyModelSync(items, options),
		(error) =>
			error instanceof AdminDomainWriteError && error.code === 'subject'
	)
	assert.equal(
		changed.calls.some((call) => call.init.method === 'POST'),
		false
	)
})

test('cancel after dispatch remains unknown, does not accept a late result and never retries', async () => {
	const started = deferred<void>()
	const response = deferred<Response>()
	const f = fixture(async () => {
		started.resolve(undefined)
		return response.promise
	})
	const controller = new AbortController()
	const run = f.api.applyModelSync(items, {
		...options,
		signal: controller.signal,
	})
	await started.promise
	controller.abort()
	response.resolve(
		Response.json({
			success: true,
			data: { updated: 3, skipped: 0, failed: [] },
			acknowledgement: ack,
		})
	)
	await assert.rejects(
		run,
		(error) =>
			error instanceof AdminDomainWriteError && error.code === 'unknown'
	)
	assert.equal(f.calls.filter((call) => call.init.method === 'POST').length, 1)
})

test('definitive rejection is distinguishable from an unavailable write and neither is replayed', async () => {
	for (const status of [400, 503]) {
		const f = fixture(async () =>
			Response.json(
				{ success: false, message: 'private DB failure' },
				{ status }
			)
		)
		await assert.rejects(
			f.api.applyModelSync(items, options),
			(error) =>
				error instanceof AdminDomainWriteError &&
				error.code === (status === 400 ? 'rejected' : 'unknown') &&
				!error.message.includes('private')
		)
		assert.equal(
			f.calls.filter((call) => call.init.method === 'POST').length,
			1
		)
	}
})
