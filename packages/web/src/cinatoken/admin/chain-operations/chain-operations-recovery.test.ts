/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChainOperationsApi } from './chain-operations-api'
import { ChainOperationError } from './chain-operations-errors'
import {
	chainListFixture,
	chainWithdrawalFixture,
	chainNftMintFixture,
} from './chain-operations-fixtures'
import { reviewUnknownChainOperation } from './chain-operations-manual-recovery'
import { ChainOperationWriteRecovery } from './chain-operations-recovery'
import { validateChainOperationsSearch } from './chain-operations-search'

function memory() {
	const map = new Map<string, string>()
	return {
		map,
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value)
		},
		removeItem: (key: string) => {
			map.delete(key)
		},
	}
}
const identity = (epoch = 1) =>
	JSON.stringify(['portal-user-1', 'console-user', epoch])
const auth = {
	authenticated: true,
	verification: 'verified',
	principalType: 'console',
	subject: 'console-user',
}
function fake(
	run: (url: string, init: RequestInit) => Promise<Response>
): typeof fetch {
	return ((url: RequestInfo | URL, init?: RequestInit) =>
		run(String(url), init ?? {})) as typeof fetch
}
test('pending markers survive remount and epoch changes without persisting any record, financial draft or credential', () => {
	const storage = memory()
	const first = new ChainOperationWriteRecovery(storage, true)
	first.markPending(identity(), 'withdrawals', 'reject')
	const next = new ChainOperationWriteRecovery(storage, true)
	assert.equal(next.status(identity(10), 'withdrawals'), 'pending')
	assert.equal(next.status(identity(), 'nft-mints'), 'ready')
	assert.equal(
		next.status(JSON.stringify(['other', 'other-subject', 1]), 'withdrawals'),
		'ready'
	)
	const raw = [...storage.map.values()][0]
	assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), [
		'generation',
		'operation',
		'version',
	])
	for (const forbidden of [
		'withdrawal-1',
		'reason',
		'walletAddress',
		'amount',
		'privateKey',
		'tokenAmount',
	])
		assert.equal(raw.includes(forbidden), false)
})
test('confirmed acknowledgment or definite rejection clears only its matching generation', () => {
	for (const outcome of ['confirmed-2xx', 'definitive-rejection'] as const) {
		const storage = memory()
		const recovery = new ChainOperationWriteRecovery(storage, true)
		const marker = recovery.markPending(identity(), 'nft-mints', 'process')
		recovery.settleKnown(identity(), 'nft-mints', marker, outcome)
		assert.equal(recovery.status(identity(), 'nft-mints'), 'ready')
	}
	const storage = memory()
	const recovery = new ChainOperationWriteRecovery(storage, true)
	const marker = recovery.markPending(identity(), 'withdrawals', 'process')
	assert.throws(() =>
		recovery.settleKnown(
			identity(),
			'withdrawals',
			{ ...marker, generation: crypto.randomUUID() },
			'confirmed-2xx'
		)
	)
	assert.equal(storage.map.size, 1)
})
test('a list observation, another principal, another domain, or malformed marker cannot release an unknown write', () => {
	const storage = memory()
	const recovery = new ChainOperationWriteRecovery(storage, true)
	const marker = recovery.markPending(identity(), 'withdrawals', 'reject')
	assert.equal(recovery.status(identity(), 'withdrawals'), 'pending')
	assert.throws(() =>
		recovery.settleKnown(
			identity(),
			'withdrawals',
			marker,
			'list-get' as 'confirmed-2xx'
		)
	)
	assert.throws(() =>
		recovery.acknowledgeUnknown('another-principal', 'withdrawals', marker)
	)
	assert.throws(() =>
		recovery.acknowledgeUnknown(identity(), 'nft-mints', marker)
	)
	const key = [...storage.map.keys()][0]
	storage.map.set(key, '{corrupted')
	assert.equal(recovery.marker(identity(), 'withdrawals'), null)
	assert.equal(recovery.status(identity(), 'withdrawals'), 'pending')
})
test('unavailable storage, failed write/readback or failed clearing prevents new writes', () => {
	const missing = new ChainOperationWriteRecovery(null, true)
	assert.equal(missing.status(identity(), 'withdrawals'), 'unavailable')
	assert.throws(() => missing.markPending(identity(), 'withdrawals', 'process'))
	for (const fault of ['set', 'readback', 'remove'] as const) {
		const base = memory()
		let marked = false
		const storage = {
			...base,
			getItem: (key: string) => {
				if (fault === 'readback' && marked) throw new Error('readback')
				return base.getItem(key)
			},
			setItem: (key: string, value: string) => {
				if (fault === 'set') throw new Error('set')
				base.setItem(key, value)
				marked = true
			},
			removeItem: (key: string) => {
				if (fault === 'remove') throw new Error('remove')
				base.removeItem(key)
			},
		}
		const recovery = new ChainOperationWriteRecovery(storage, true)
		if (fault === 'remove') {
			const marker = recovery.markPending(identity(), 'withdrawals', 'process')
			assert.throws(() =>
				recovery.settleKnown(identity(), 'withdrawals', marker, 'confirmed-2xx')
			)
		} else
			assert.throws(() =>
				recovery.markPending(identity(), 'withdrawals', 'process')
			)
		assert.equal(recovery.status(identity(), 'withdrawals'), 'unavailable')
	}
})
test('manual recovery requires both explicit confirmations before any network request', async () => {
	let calls = 0
	const api = createChainOperationsApi(
		fake(async () => {
			calls++
			return Response.json(auth)
		})
	)
	for (const checked of [
		{ reviewedExternal: false, acceptsUnknown: true },
		{ reviewedExternal: true, acceptsUnknown: false },
	]) {
		await assert.rejects(
			reviewUnknownChainOperation({
				api,
				kind: 'withdrawals',
				search: validateChainOperationsSearch({}, 'withdrawals'),
				options: { expectedConsoleSubject: 'console-user' },
				...checked,
			})
		)
	}
	assert.equal(calls, 0)
})
test('manual review observes the current complete ledger between two live subject checks and sends no POST', async () => {
	for (const kind of ['withdrawals', 'nft-mints'] as const) {
		const calls: string[] = []
		const storage = memory()
		const recovery = new ChainOperationWriteRecovery(storage, true)
		const marker = recovery.markPending(identity(), kind, 'process')
		const api = createChainOperationsApi(
			fake(async (url, init) => {
				calls.push(url)
				assert.notEqual(init.method, 'POST')
				assert.equal(recovery.status(identity(), kind), 'pending')
				if (url === '/api/auth/check') return Response.json(auth)
				return Response.json(
					chainListFixture(kind, [
						kind === 'withdrawals'
							? chainWithdrawalFixture
							: chainNftMintFixture,
					])
				)
			})
		)
		const observation = await reviewUnknownChainOperation({
			api,
			kind,
			search: validateChainOperationsSearch({}, kind),
			options: { expectedConsoleSubject: 'console-user' },
			reviewedExternal: true,
			acceptsUnknown: true,
		})
		assert.equal(observation.data.length, 1)
		assert.equal(recovery.status(identity(), kind), 'pending')
		assert.deepEqual(calls, [
			'/api/auth/check',
			'/api/admin/' + kind,
			'/api/auth/check',
		])
		recovery.acknowledgeUnknown(identity(), kind, marker)
		assert.equal(recovery.status(identity(), kind), 'ready')
	}
})
test('subject drift, malformed observation or final denied check leaves the unknown marker intact', async () => {
	for (const fault of [
		'first-subject',
		'observation',
		'final-subject',
	] as const) {
		const storage = memory()
		const recovery = new ChainOperationWriteRecovery(storage, true)
		recovery.markPending(identity(), 'withdrawals', 'reject')
		let authCalls = 0
		const api = createChainOperationsApi(
			fake(async (url) => {
				if (url === '/api/auth/check') {
					authCalls++
					if (
						fault === 'first-subject' ||
						(fault === 'final-subject' && authCalls === 2)
					)
						return Response.json({ ...auth, subject: 'other-user' })
					return Response.json(auth)
				}
				return Response.json(
					fault === 'observation'
						? { success: true, data: [] }
						: chainListFixture('withdrawals')
				)
			})
		)
		await assert.rejects(
			reviewUnknownChainOperation({
				api,
				kind: 'withdrawals',
				search: validateChainOperationsSearch({}, 'withdrawals'),
				options: { expectedConsoleSubject: 'console-user' },
				reviewedExternal: true,
				acceptsUnknown: true,
			})
		)
		assert.equal(recovery.status(identity(), 'withdrawals'), 'pending')
	}
})
test('cancelled manual recovery cannot authorize release even when the observation transport ignores AbortSignal', async () => {
	const storage = memory()
	const recovery = new ChainOperationWriteRecovery(storage, true)
	const marker = recovery.markPending(identity(), 'withdrawals', 'process')
	const controller = new AbortController()
	const api = createChainOperationsApi(
		fake(async (url) => {
			if (url === '/api/auth/check') return Response.json(auth)
			controller.abort()
			return Response.json(chainListFixture('withdrawals'))
		})
	)
	await assert.rejects(
		reviewUnknownChainOperation({
			api,
			kind: 'withdrawals',
			search: validateChainOperationsSearch({}, 'withdrawals'),
			options: {
				expectedConsoleSubject: 'console-user',
				signal: controller.signal,
			},
			reviewedExternal: true,
			acceptsUnknown: true,
		})
	)
	assert.deepEqual(recovery.marker(identity(), 'withdrawals'), marker)
	assert.equal(recovery.status(identity(), 'withdrawals'), 'pending')
})
test('marker listeners report durable transitions and failed marking never calls a queue or refund', () => {
	const storage = memory()
	const recovery = new ChainOperationWriteRecovery(storage, true)
	let transitions = 0
	const unsubscribe = recovery.subscribe(() => {
		transitions++
	})
	const marker = recovery.markPending(identity(), 'withdrawals', 'process')
	recovery.acknowledgeUnknown(identity(), 'withdrawals', marker)
	unsubscribe()
	assert.equal(transitions, 2)
	const locked = new ChainOperationWriteRecovery(null, true)
	assert.throws(
		() => locked.markPending(identity(), 'withdrawals', 'process'),
		(error: unknown) =>
			error instanceof ChainOperationError && error.causeCode === 'storage'
	)
})
