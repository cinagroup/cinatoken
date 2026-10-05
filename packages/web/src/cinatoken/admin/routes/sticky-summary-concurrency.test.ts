/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStickySummaryScheduler } from './sticky-summary-concurrency'

test('summary scheduler bounds concurrency and drops queued aborts without an API call', async () => {
	const schedule = createStickySummaryScheduler(2)
	const controllers = Array.from({ length: 5 }, () => new AbortController())
	let active = 0,
		max = 0,
		calls = 0
	const release: (() => void)[] = []
	const jobs = controllers.map((controller) =>
		schedule(controller.signal, async () => {
			calls++
			active++
			max = Math.max(max, active)
			await new Promise<void>((resolve) => release.push(resolve))
			active--
			return calls
		}).catch((error) => error)
	)
	await Promise.resolve()
	await Promise.resolve()
	assert.equal(calls, 2)
	controllers[2]!.abort()
	release.shift()!()
	await Promise.resolve()
	await Promise.resolve()
	await Promise.resolve()
	assert.equal(calls, 3)
	while (release.length) {
		release.shift()!()
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()
	}
	const outcomes = await Promise.all(jobs)
	assert.equal(max, 2)
	assert.equal(calls, 4)
	assert.equal(outcomes[2].name, 'AbortError')
})
