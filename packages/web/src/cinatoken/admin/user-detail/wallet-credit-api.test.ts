/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { adminDomainFixtureAuth } from '../domain-api-test-fixture'
import { createUserWalletCreditApi } from './wallet-credit-api'
import { WalletCreditClientError } from './wallet-credit-contracts'
import {
	walletCreditFixtureInput as input,
	walletCreditFixtureReceipt as receipt,
	walletCreditFixtureUserId as userId,
} from './wallet-credit-fixtures'

type Call = { path: string; init: RequestInit }
const options = {
	expectedConsoleSubject: 'fixture-subject',
	expectedUserId: 'fixture-user',
}
const ack = () => ({
	success: true,
	status: 'applied',
	data: { status: 'applied', ...receipt.after, receipt },
})
function fixture(
	reply: (call: Call) => Response | Promise<Response>,
	auth = adminDomainFixtureAuth
) {
	const calls: Call[] = []
	const transport = createCinaTokenCookieTransport(async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		calls.push(call)
		const authentication = auth(call.path)
		return authentication ? Response.json(authentication) : reply(call)
	})
	return {
		calls,
		api: createUserWalletCreditApi({
			...transport,
			invalidResponse() {
				throw new CinaTokenApiError('Invalid receipt', 200, 'invalid-response')
			},
			sanitizeError(error) {
				return error instanceof Error ? error : new Error('Failed')
			},
		}),
	}
}
const notFound = () =>
	Response.json({ success: true, data: { version: 1, status: 'not_found' } })
test('credit verifies subject and exact reference capability before marking and POSTing the versioned endpoint', async () => {
	const { api, calls } = fixture((call) =>
		call.init.method === 'POST' ? Response.json(ack()) : notFound()
	)
	let dispatched = 0
	const result = await api.creditUserWallet(userId, input, {
		...options,
		onDispatch: () => {
			dispatched++
			assert.equal(calls.length, 3)
		},
	})
	assert.deepEqual(result, receipt)
	assert.equal(dispatched, 1)
	assert.deepEqual(
		calls.map((call) => call.path.split('?')[0]),
		[
			'/api/auth/check',
			'/api/user/me',
			`/api/admin/users/${userId}/wallet/credit/receipt`,
			`/api/admin/users/${userId}/wallet/credit/verified`,
		]
	)
	assert.equal(
		new Headers(calls[3].init.headers).get(
			'X-CinaToken-Expected-Console-Subject'
		),
		'fixture-subject'
	)
	assert.deepEqual(JSON.parse(String(calls[3].init.body)), {
		...input,
		require_receipt_version: 1,
	})
})
test('an exact recorded order returns its immutable receipt without another POST or marker', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: { version: 1, status: 'recorded', receipt },
		})
	)
	assert.deepEqual(
		await api.creditUserWallet(userId, input, {
			...options,
			onDispatch: () => {
				throw new Error('No dispatch')
			},
		}),
		receipt
	)
	assert.equal(
		calls.some((call) => call.init.method === 'POST'),
		false
	)
})
test('a duplicate acknowledgement can retain current-wallet fields while its order receipt remains historical', async () => {
	const response = {
		success: true,
		status: 'duplicate',
		data: {
			status: 'duplicate',
			walletGranted: 30,
			walletSpent: 7,
			walletBalance: 23,
			receipt,
		},
	}
	const { api } = fixture((call) =>
		call.init.method === 'POST' ? Response.json(response) : notFound()
	)
	assert.deepEqual(
		await api.creditUserWallet(userId, input, { ...options, onDispatch() {} }),
		receipt
	)
})
test('recorded payload conflicts and legacy evidence cannot dispatch a credit', async () => {
	for (const status of ['recorded', 'legacy_unverified'] as const) {
		const { api, calls } = fixture(() =>
			Response.json({
				success: true,
				data:
					status === 'recorded'
						? { version: 1, status, receipt }
						: { version: 1, status },
			})
		)
		await assert.rejects(
			api.creditUserWallet(
				userId,
				{ ...input, amount: 2 },
				{ ...options, onDispatch() {} }
			),
			WalletCreditClientError
		)
		assert.equal(
			calls.some((call) => call.init.method === 'POST'),
			false
		)
	}
})
test('old receipt endpoints and unknown versions fail before financial dispatch', async () => {
	for (const response of [
		() => Response.json({ success: false }, { status: 404 }),
		() =>
			Response.json({
				success: true,
				data: { version: 2, status: 'not_found' },
			}),
	]) {
		const { api, calls } = fixture(response)
		await assert.rejects(
			api.creditUserWallet(userId, input, { ...options, onDispatch() {} })
		)
		assert.equal(
			calls.some((call) => call.init.method === 'POST'),
			false
		)
	}
})
test('frozen input cannot change during asynchronous identity verification', async () => {
	const raw = { ...input },
		{ api, calls } = fixture((call) =>
			call.init.method === 'POST' ? Response.json(ack()) : notFound()
		)
	const pending = api.creditUserWallet(userId, raw, {
		...options,
		onDispatch() {},
	})
	raw.amount = 9
	raw.external_ref = 'MUTATED'
	raw.kind = 'refund'
	assert.deepEqual(await pending, receipt)
	assert.equal(
		JSON.parse(String(calls.at(-1)!.init.body)).external_ref,
		input.external_ref
	)
})
test('wrong user/reference, missing receipts, status disagreement and incorrect totals are not acknowledgements', async () => {
	for (const response of [
		{
			success: true,
			status: 'applied',
			data: { status: 'applied', ...receipt.after },
		},
		{ ...ack(), status: 'duplicate' },
		{ ...ack(), data: { ...ack().data, walletGranted: 99 } },
		{
			...ack(),
			data: {
				...ack().data,
				receipt: { ...receipt, userId: crypto.randomUUID() },
			},
		},
		{
			...ack(),
			data: { ...ack().data, receipt: { ...receipt, externalRef: 'wrong' } },
		},
	]) {
		let dispatched = false
		const { api } = fixture((call) =>
			call.init.method === 'POST' ? Response.json(response) : notFound()
		)
		await assert.rejects(
			api.creditUserWallet(userId, input, {
				...options,
				onDispatch() {
					dispatched = true
				},
			})
		)
		assert.equal(dispatched, true)
	}
})
test('failed storage, missing identity, changed principal and cancelled checks produce no POST', async () => {
	const { api, calls } = fixture(notFound)
	await assert.rejects(api.creditUserWallet(userId, input, options))
	await assert.rejects(
		api.creditUserWallet(userId, input, {
			...options,
			onDispatch() {
				throw new WalletCreditClientError('storage')
			},
		})
	)
	await assert.rejects(api.creditUserWallet(userId, input, { onDispatch() {} }))
	const abort = new AbortController()
	abort.abort()
	await assert.rejects(
		api.creditUserWallet(userId, input, {
			...options,
			signal: abort.signal,
			onDispatch() {},
		})
	)
	const changed = fixture(notFound, (path) =>
		path === '/api/auth/check'
			? {
					authenticated: true,
					verification: 'verified',
					principalType: 'console',
					subject: 'another',
				}
			: adminDomainFixtureAuth(path)
	)
	await assert.rejects(
		changed.api.creditUserWallet(userId, input, { ...options, onDispatch() {} })
	)
	assert.equal(
		[...calls, ...changed.calls].some((call) => call.init.method === 'POST'),
		false
	)
})
test('receipt reads use exact encoded reference, subject precondition and private reads', async () => {
	const reference = '付款 + / é 😀',
		{ api, calls } = fixture(() =>
			Response.json({
				success: true,
				data: { version: 1, status: 'not_found' },
			})
		)
	assert.deepEqual(
		await api.userWalletCreditReceipt(userId, reference, options),
		{ version: 1, status: 'not_found' }
	)
	const call = calls.at(-1)!
	assert.equal(
		new URL(call.path, 'https://fixture.invalid').searchParams.get(
			'external_ref'
		),
		reference
	)
	assert.equal(call.init.cache, 'no-store')
	assert.equal(
		new Headers(call.init.headers).get('X-CinaToken-Expected-Console-Subject'),
		'fixture-subject'
	)
})
