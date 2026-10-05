import { QueryClient } from '@tanstack/react-query'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	providerAccessDenied,
	providerErrorKey,
	providerInvalidResponse,
} from './provider-errors'
import { observeProviderFailures } from './provider-query-scope'

const prefix = ['cinatoken', 'admin', 'console-a:1', 'providers', true] as const
const error = (status: number) =>
	Object.assign(new Error('Request failed'), { status })

test('unrelated shorter cache keys and other console epochs cannot revoke this provider domain', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	})
	const failures: unknown[] = []
	const unsubscribe = observeProviderFailures(
		client.getQueryCache(),
		prefix,
		(failure) => failures.push(failure)
	)
	try {
		for (let length = 0; length < prefix.length; length++) {
			const failure = error(401)
			await assert.rejects(
				client.fetchQuery({
					queryKey: prefix.slice(0, length),
					queryFn: () => Promise.reject(failure),
				}),
				failure
			)
		}
		await assert.rejects(
			client.fetchQuery({
				queryKey: [
					'cinatoken',
					'admin',
					'console-b:2',
					'providers',
					true,
					'list',
				],
				queryFn: () => Promise.reject(error(403)),
			})
		)
		await assert.rejects(
			client.fetchQuery({
				queryKey: [
					'cinatoken',
					'account',
					'console-a:1',
					'providers',
					true,
					'list',
				],
				queryFn: () => Promise.reject(error(401)),
			})
		)
		assert.equal(failures.length, 0)
		const ownFailure = error(403)
		await assert.rejects(
			client.fetchQuery({
				queryKey: [...prefix, 'detail', 'provider-a'],
				queryFn: () => Promise.reject(ownFailure),
			}),
			ownFailure
		)
		assert.deepEqual(failures, [ownFailure])
	} finally {
		unsubscribe()
		client.clear()
	}
})

test('transient read failures preserve known masked rows for recovery and are not identity revocation', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	})
	const queryKey = [...prefix, 'list']
	const masked = [{ id: 'provider-a', api_key: 'abc…1234' }]
	client.setQueryData(queryKey, masked)
	const serviceUnavailable = error(503)
	await assert.rejects(
		client.fetchQuery({
			queryKey,
			queryFn: () => Promise.reject(error(503)),
		}),
		{ status: 503 }
	)
	assert.equal(client.getQueryState(queryKey)?.status, 'error')
	assert.deepEqual(client.getQueryData(queryKey), masked)
	assert.equal(providerAccessDenied(serviceUnavailable), false)
	assert.equal(providerInvalidResponse(serviceUnavailable), false)
	await client.fetchQuery({
		queryKey,
		queryFn: () => Promise.resolve([{ id: 'provider-a', api_key: 'abc…1234' }]),
	})
	assert.equal(client.getQueryState(queryKey)?.status, 'success')
	client.clear()
})

test('authentication failure, invalid DTO and resource conflict have separate recovery semantics', () => {
	assert.equal(providerAccessDenied(error(401)), true)
	assert.equal(providerAccessDenied(error(403)), true)
	assert.equal(providerAccessDenied(error(409)), false)
	assert.equal(
		providerInvalidResponse({ code: 'invalid-response', status: 0 }),
		true
	)
	assert.equal(
		providerErrorKey(error(409)),
		'cinatoken.adminProviders.conflict'
	)
	assert.equal(
		providerErrorKey(error(503)),
		'cinatoken.adminProviders.requestFailed'
	)
})
