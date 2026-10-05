/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { QueryClient } from '@tanstack/react-query'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	endpointAccessDenied,
	endpointErrorKey,
	endpointInvalidResponse,
} from './endpoint-errors'
import { observeEndpointFailures } from './endpoint-query-scope'

const prefix = ['cinatoken', 'admin', 'console-a:1', 'endpoints', true] as const
const error = (status: number) =>
	Object.assign(new Error('Request failed'), { status })

test('only a failure from the current endpoint console epoch is observed', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	})
	const failures: unknown[] = []
	const unsubscribe = observeEndpointFailures(
		client.getQueryCache(),
		prefix,
		(failure) => failures.push(failure)
	)
	try {
		for (let length = 0; length < prefix.length; length++) {
			await assert.rejects(
				client.fetchQuery({
					queryKey: prefix.slice(0, length),
					queryFn: () => Promise.reject(error(401)),
				})
			)
		}
		await assert.rejects(
			client.fetchQuery({
				queryKey: [
					'cinatoken',
					'admin',
					'console-b:2',
					'endpoints',
					true,
					'list',
				],
				queryFn: () => Promise.reject(error(403)),
			})
		)
		assert.equal(failures.length, 0)
		const ownFailure = error(403)
		await assert.rejects(
			client.fetchQuery({
				queryKey: [...prefix, 'detail', 'endpoint-a'],
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

test('transient read failures do not classify as revocation or discard known rows', async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	})
	const key = [...prefix, 'list']
	const known = [{ id: 'endpoint-a', status: 'verified' }]
	client.setQueryData(key, known)
	await assert.rejects(
		client.fetchQuery({
			queryKey: key,
			queryFn: () => Promise.reject(error(503)),
		})
	)
	assert.deepEqual(client.getQueryData(key), known)
	assert.equal(endpointAccessDenied(error(503)), false)
	assert.equal(endpointInvalidResponse(error(503)), false)
	assert.equal(
		endpointErrorKey(error(409)),
		'cinatoken.adminEndpoints.conflict'
	)
	assert.equal(endpointAccessDenied(error(401)), true)
	assert.equal(
		endpointInvalidResponse({ code: 'invalid-response', status: 0 }),
		true
	)
	client.clear()
})
