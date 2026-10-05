/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewAdminDomainUnknown } from './domain-manual-recovery'

test('manual review checks identity before and after one uncached observation and requires both explicit confirmations', async () => {
	for (const flags of [
		[false, true],
		[true, false],
		[false, false],
	]) {
		let calls = 0
		await assert.rejects(
			reviewAdminDomainUnknown({
				options: {},
				verify: async () => {
					calls++
					return 'subject'
				},
				observe: async () => {
					calls++
				},
				reviewedExternal: flags[0]!,
				acceptsUnknown: flags[1]!,
			})
		)
		assert.equal(calls, 0)
	}
	const calls: string[] = []
	await reviewAdminDomainUnknown({
		options: {},
		verify: async () => {
			calls.push('fresh')
			return 'subject'
		},
		observe: async () => {
			calls.push('GET')
		},
		reviewedExternal: true,
		acceptsUnknown: true,
	})
	assert.deepEqual(calls, ['fresh', 'GET', 'fresh'])
})
test('observation failure, changed identity or cancellation cannot authorize an unknown unlock', async () => {
	for (const failure of ['read', 'identity', 'abort']) {
		const calls: string[] = []
		const abort = new AbortController()
		await assert.rejects(
			reviewAdminDomainUnknown({
				options: { signal: abort.signal },
				verify: async () => {
					calls.push('fresh')
					if (failure === 'identity' && calls.length > 1)
						throw new Error('changed')
					return 'subject'
				},
				observe: async () => {
					calls.push('GET')
					if (failure === 'read') throw new Error('503')
					if (failure === 'abort') abort.abort()
				},
				reviewedExternal: true,
				acceptsUnknown: true,
			})
		)
		assert.equal(calls.filter((call) => call === 'GET').length, 1)
		assert.equal(calls.length, failure === 'identity' ? 3 : 2)
	}
})
