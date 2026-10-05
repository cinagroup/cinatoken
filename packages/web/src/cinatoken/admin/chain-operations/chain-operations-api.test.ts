/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError } from '../../api'
import { createCinaTokenAdminApi } from '../api'
import {
	createChainOperationsApi,
	CHAIN_CONSOLE_SUBJECT_HEADER,
} from './chain-operations-api'
import { ChainOperationError } from './chain-operations-errors'
import {
	chainListFixture,
	chainWithdrawalFixture,
	chainNftMintFixture,
	chainProcessFixture,
} from './chain-operations-fixtures'
import { validateChainOperationsSearch } from './chain-operations-search'

const search = validateChainOperationsSearch({}, 'withdrawals')
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
function isUnknown(error: unknown): boolean {
	return error instanceof ChainOperationError && error.causeCode === 'unknown'
}
test('Admin factory lists complete global ledger rows with Cookie, canonical subject and no account workspace or Bearer', async () => {
	const api = createCinaTokenAdminApi(
		fake(async (url, init) => {
			assert.equal(url, '/api/admin/withdrawals')
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			assert.equal(init.redirect, 'error')
			const headers = new Headers(init.headers)
			assert.equal(headers.get(CHAIN_CONSOLE_SUBJECT_HEADER), 'console-user')
			assert.equal(headers.get('Authorization'), null)
			assert.equal(headers.get('X-CinaToken-Workspace'), null)
			return Response.json(
				chainListFixture('withdrawals', [
					{ ...chainWithdrawalFixture, privateKey: 'fixture-signer' },
				])
			)
		})
	)
	const result = await api.chainWithdrawalList(search, {
		expectedConsoleSubject: 'console-user',
	})
	assert.deepEqual(result.data, [chainWithdrawalFixture])
	assert.equal(result.meta.withdrawalCurrencySource, 'stored_row')
})
test('NFT processing status remains filterable and the returned snapshot is USD contribution, not gateway billing currency', async () => {
	const row = { ...chainNftMintFixture, status: 'processing' }
	const api = createChainOperationsApi(
		fake(async (url) => {
			assert.equal(url, '/api/admin/nft-mints?status=processing')
			return Response.json(chainListFixture('nft-mints', [row]))
		})
	)
	const result = await api.chainNftMintList(
		validateChainOperationsSearch({ status: 'processing' }, 'nft-mints')
	)
	assert.equal(result.data[0].status, 'processing')
	assert.equal(
		result.meta.nftValueSnapshotCurrencySource,
		'seller_contribution_ledger'
	)
})
test('duplicate, filtered-mismatch, partial and malformed list responses never enter the query cache', async () => {
	const valid = chainListFixture('withdrawals', [chainWithdrawalFixture])
	for (const body of [
		{ ...valid, total: 2 },
		chainListFixture('withdrawals', [
			chainWithdrawalFixture,
			chainWithdrawalFixture,
		]),
		chainListFixture('withdrawals', [
			{ ...chainWithdrawalFixture, amount: -1 },
		]),
		chainListFixture('withdrawals', [
			{ ...chainWithdrawalFixture, amount: Number.NaN },
		]),
		chainListFixture('withdrawals', [
			{ ...chainWithdrawalFixture, currency: 'usd' },
		]),
		{ ...valid, meta: { ...valid.meta, nftValueSnapshotCurrency: 'CNY' } },
		{ ...valid, meta: { ...valid.meta, scope: 'workspace' } },
	]) {
		const api = createChainOperationsApi(fake(async () => Response.json(body)))
		await assert.rejects(
			api.chainWithdrawalList(search),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
	const api = createChainOperationsApi(fake(async () => Response.json(valid)))
	await assert.rejects(
		api.chainWithdrawalList({ ...search, status: 'failed' }),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
})
test('every queue write verifies the live Console subject and persists immediately before its single POST', async () => {
	const events: string[] = []
	const api = createChainOperationsApi(
		fake(async (url, init) => {
			events.push(url)
			if (url === '/api/auth/check') return Response.json(auth)
			assert.equal(url, '/api/admin/withdrawals/process?limit=20')
			assert.equal(init.method, 'POST')
			assert.equal(
				new Headers(init.headers).get(CHAIN_CONSOLE_SUBJECT_HEADER),
				'console-user'
			)
			assert.equal(init.body, undefined)
			return Response.json(chainProcessFixture)
		})
	)
	assert.deepEqual(
		await api.processChainOperations('withdrawals', 20, {
			expectedConsoleSubject: 'console-user',
			onDispatch: () => {
				events.push('marker')
			},
		}),
		{ queued: 1 }
	)
	assert.deepEqual(events, [
		'/api/auth/check',
		'marker',
		'/api/admin/withdrawals/process?limit=20',
	])
})
test('invalid limits and rejection eligibility perform no read, marker or write request', async () => {
	let requests = 0
	let markers = 0
	const api = createChainOperationsApi(
		fake(async () => {
			requests++
			return Response.json(auth)
		})
	)
	const options = {
		expectedConsoleSubject: 'console-user',
		onDispatch: () => {
			markers++
		},
	}
	for (const limit of [0, 21, 1.5, Infinity])
		await assert.rejects(
			api.processChainOperations('withdrawals', limit, options)
		)
	for (const status of [
		'processing',
		'submitted',
		'confirmed',
		'failed',
	] as const)
		await assert.rejects(
			api.rejectChainWithdrawal(
				{ ...chainWithdrawalFixture, status },
				'reviewed',
				options
			)
		)
	for (const reason of ['', 'x'.repeat(501), 'secret\u0000text'])
		await assert.rejects(
			api.rejectChainWithdrawal(chainWithdrawalFixture, reason, options)
		)
	assert.equal(requests, 0)
	assert.equal(markers, 0)
})
test('changed subject, API-key principal, degraded verification or abort during preflight dispatches no POST', async () => {
	for (const value of [
		{ ...auth, subject: 'another-user' },
		{ ...auth, principalType: 'api_key' },
		{ ...auth, verification: 'degraded' },
		{ ...auth, authenticated: false },
	]) {
		let count = 0
		const api = createChainOperationsApi(
			fake(async (url) => {
				count++
				assert.equal(url, '/api/auth/check')
				return Response.json(value)
			})
		)
		await assert.rejects(
			api.processChainOperations('withdrawals', 5, {
				expectedConsoleSubject: 'console-user',
			}),
			(error: unknown) =>
				error instanceof ChainOperationError && error.causeCode === 'subject'
		)
		assert.equal(count, 1)
	}
	const controller = new AbortController()
	let calls = 0
	const api = createChainOperationsApi(
		fake(async () => {
			calls++
			controller.abort()
			return Response.json(auth)
		})
	)
	await assert.rejects(
		api.processChainOperations('nft-mints', 5, {
			expectedConsoleSubject: 'console-user',
			signal: controller.signal,
		})
	)
	assert.equal(calls, 1)
})
test('storage failure immediately before dispatch prevents the POST', async () => {
	let calls = 0
	const api = createChainOperationsApi(
		fake(async () => {
			calls++
			return Response.json(auth)
		})
	)
	await assert.rejects(
		api.processChainOperations('withdrawals', 5, {
			expectedConsoleSubject: 'console-user',
			onDispatch: () => {
				throw new ChainOperationError('storage')
			},
		}),
		(error: unknown) =>
			error instanceof ChainOperationError && error.causeCode === 'storage'
	)
	assert.equal(calls, 1)
})
test('queue acknowledgments never accept processed/confirmed counts or queued values beyond the requested limit', async () => {
	for (const value of [
		{ success: true, data: { processed: 1, confirmed: 1, failed: 0 } },
		{ ...chainProcessFixture, data: { queued: 6 } },
		{
			...chainProcessFixture,
			meta: { result: 'confirmed', chainConfirmation: true },
		},
	]) {
		let posts = 0
		const api = createChainOperationsApi(
			fake(async (url) => {
				if (url === '/api/auth/check') return Response.json(auth)
				posts++
				return Response.json(value)
			})
		)
		await assert.rejects(
			api.processChainOperations('withdrawals', 5, {
				expectedConsoleSubject: 'console-user',
			}),
			isUnknown
		)
		assert.equal(posts, 1)
	}
})
test('network, timeout, 5xx and malformed successful submissions stay unknown and are never retried', async () => {
	for (const failure of [
		'network',
		'timeout',
		'server',
		'invalid-json',
		'business',
	] as const) {
		let posts = 0
		const api = createChainOperationsApi(
			fake(async (url, init) => {
				if (url === '/api/auth/check') return Response.json(auth)
				posts++
				if (failure === 'network') throw new Error('fixture-private-error')
				if (failure === 'timeout')
					return await new Promise<Response>((_resolve, reject) => {
						init.signal?.addEventListener(
							'abort',
							() => reject(new DOMException('Abort', 'AbortError')),
							{ once: true }
						)
					})
				if (failure === 'server')
					return Response.json(
						{ message: 'fixture-private-error' },
						{ status: 500 }
					)
				if (failure === 'business')
					return Response.json({
						success: false,
						message: 'fixture-private-error',
					})
				return new Response('broken json')
			})
		)
		await assert.rejects(
			api.processChainOperations('nft-mints', 5, {
				expectedConsoleSubject: 'console-user',
				timeoutMs: 10,
			}),
			isUnknown
		)
		assert.equal(posts, 1)
	}
})
test('reject sends only the trimmed reason and requires an exact atomic refund acknowledgment for its target', async () => {
	const api = createChainOperationsApi(
		fake(async (url, init) => {
			if (url === '/api/auth/check') return Response.json(auth)
			assert.equal(url, '/api/admin/withdrawals/withdrawal-1/reject')
			assert.deepEqual(JSON.parse(String(init.body)), { reason: 'reviewed' })
			return Response.json({
				success: true,
				data: {
					withdrawalId: 'withdrawal-1',
					status: 'failed',
					result: 'rejected_and_refunded',
				},
			})
		})
	)
	const result = await api.rejectChainWithdrawal(
		chainWithdrawalFixture,
		' reviewed ',
		{ expectedConsoleSubject: 'console-user' }
	)
	assert.equal(result.result, 'rejected_and_refunded')
	for (const data of [
		{
			withdrawalId: 'another',
			status: 'failed',
			result: 'rejected_and_refunded',
		},
		{
			withdrawalId: 'withdrawal-1',
			status: 'processing',
			result: 'rejected_and_refunded',
		},
	]) {
		const bad = createChainOperationsApi(
			fake(async (url) =>
				Response.json(
					url === '/api/auth/check' ? auth : { success: true, data }
				)
			)
		)
		await assert.rejects(
			bad.rejectChainWithdrawal(chainWithdrawalFixture, 'reviewed', {
				expectedConsoleSubject: 'console-user',
			}),
			isUnknown
		)
	}
})
test('a conflict is a definite rejection, while an aborted dispatched request keeps an unknown outcome', async () => {
	const conflict = createChainOperationsApi(
		fake(async (url) =>
			url === '/api/auth/check'
				? Response.json(auth)
				: Response.json(
						{ success: false, code: 'withdrawal_rejection_conflict' },
						{ status: 409 }
					)
		)
	)
	await assert.rejects(
		conflict.rejectChainWithdrawal(chainWithdrawalFixture, 'reviewed', {
			expectedConsoleSubject: 'console-user',
		}),
		(error: unknown) =>
			error instanceof ChainOperationError &&
			error.causeCode === 'rejected' &&
			error.status === 409
	)
	const abort = new AbortController()
	const api = createChainOperationsApi(
		fake(async (url) => {
			if (url === '/api/auth/check') return Response.json(auth)
			abort.abort()
			return Response.json(chainProcessFixture)
		})
	)
	await assert.rejects(
		api.processChainOperations('withdrawals', 5, {
			expectedConsoleSubject: 'console-user',
			signal: abort.signal,
		}),
		isUnknown
	)
})
