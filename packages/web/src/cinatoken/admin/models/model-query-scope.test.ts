import { QueryClient } from '@tanstack/react-query'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	modelAccessDenied,
	modelErrorKey,
	modelInvalidResponse,
	modelWriteNeedsReconciliation,
} from './model-errors'
import {
	confirmedModelCurrency,
	observeModelFailures,
} from './model-query-scope'

const prefix = ['cinatoken', 'admin', 'subject-a:3', 'models', true] as const
const error = (status: number) =>
	Object.assign(new Error('Request failed'), { status })
test('shorter, unrelated, checking and old identity queries cannot revoke the current model domain', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	})
	const failures: unknown[] = []
	const stop = observeModelFailures(client.getQueryCache(), prefix, (failure) =>
		failures.push(failure)
	)
	try {
		for (const key of [
			prefix.slice(0, 4),
			['cinatoken', 'admin', 'subject-old:1', 'models', true, 'list'],
			['cinatoken', 'admin', 'subject-a:3', 'providers', true, 'list'],
			['cinatoken', 'admin', 'subject-a:3', 'models', false, 'list'],
		])
			await assert.rejects(
				client.fetchQuery({
					queryKey: key,
					queryFn: () => Promise.reject(error(403)),
				})
			)
		assert.deepEqual(failures, [])
		const failure = error(401)
		await assert.rejects(
			client.fetchQuery({
				queryKey: [...prefix, 'detail', 'model'],
				queryFn: () => Promise.reject(failure),
			})
		)
		assert.deepEqual(failures, [failure])
		stop()
		await assert.rejects(
			client.fetchQuery({
				queryKey: [...prefix, 'catalog'],
				queryFn: () => Promise.reject(error(403)),
			})
		)
		assert.equal(failures.length, 1)
	} finally {
		stop()
		client.clear()
	}
})
test('cancel and remove prevent a transport that ignores abort from restoring an old console cache', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	})
	let resolve!: (value: unknown[]) => void
	const queryKey = [...prefix, 'list']
	const pending = client
		.fetchQuery({
			queryKey,
			queryFn: () =>
				new Promise<unknown[]>((done) => {
					resolve = done
				}),
		})
		.catch(() => undefined)
	await client.cancelQueries({ queryKey: prefix })
	client.removeQueries({ queryKey: prefix })
	client.setQueryData(
		['cinatoken', 'admin', 'subject-b:4', 'models', true, 'list'],
		[{ id: 'new-model' }]
	)
	resolve([{ id: 'old-model' }])
	await pending
	assert.equal(client.getQueryData(queryKey), undefined)
	assert.deepEqual(
		client.getQueryData([
			'cinatoken',
			'admin',
			'subject-b:4',
			'models',
			true,
			'list',
		]),
		[{ id: 'new-model' }]
	)
	client.clear()
})
test('read degradation retains the previous projection for recovery without treating 503 as identity revocation', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	})
	const queryKey = [...prefix, 'list']
	const rows = [{ id: 'model', pricing_profile: 'original' }]
	const original = { rows, billingCurrency: 'USD' }
	client.setQueryData(queryKey, original)
	assert.equal(
		confirmedModelCurrency(client.getQueryData(queryKey), null, false),
		'USD'
	)
	await assert.rejects(
		client.fetchQuery({ queryKey, queryFn: () => Promise.reject(error(503)) })
	)
	assert.deepEqual(client.getQueryData(queryKey), original)
	assert.equal(
		confirmedModelCurrency(
			client.getQueryData(queryKey),
			client.getQueryState(queryKey)?.error,
			false
		),
		null
	)
	assert.equal(
		confirmedModelCurrency(client.getQueryData(queryKey), null, true),
		null
	)
	assert.equal(modelAccessDenied(error(503)), false)
	assert.equal(modelInvalidResponse(error(503)), false)
	await client.fetchQuery({
		queryKey,
		queryFn: () =>
			Promise.resolve({ rows: [{ id: 'updated' }], billingCurrency: 'CNY' }),
	})
	assert.deepEqual(client.getQueryData(queryKey), {
		rows: [{ id: 'updated' }],
		billingCurrency: 'CNY',
	})
	assert.equal(
		confirmedModelCurrency(
			client.getQueryData(queryKey),
			client.getQueryState(queryKey)?.error,
			false
		),
		'CNY'
	)
	client.clear()
})
test('unknown writes require reconciliation while authorization, validation and resource conflicts are distinct', () => {
	for (const failure of [
		error(0),
		error(500),
		error(503),
		{ status: 200, code: 'invalid-response' },
	])
		assert.equal(modelWriteNeedsReconciliation(failure), true)
	for (const status of [400, 401, 403, 404, 409, 413])
		assert.equal(modelWriteNeedsReconciliation(error(status)), false)
	assert.equal(modelAccessDenied(error(403)), true)
	assert.equal(modelErrorKey(error(409)), 'cinatoken.adminModels.conflict')
	assert.equal(
		modelErrorKey({ status: 0, code: 'invalid-response' }),
		'cinatoken.adminModels.invalidResponse'
	)
	assert.equal(modelErrorKey(error(503)), 'cinatoken.adminModels.requestFailed')
})
