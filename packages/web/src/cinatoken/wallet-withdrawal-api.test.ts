import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	WalletConnection,
	WalletConnectionError,
	type EvmProvider,
} from './account/withdraw/wallet-connection'
import { withdrawalFormSchema } from './account/withdraw/withdrawal-form'
import {
	CinaTokenApiError,
	createCinaTokenApi,
	WORKSPACE_PRECONDITION_HEADER,
} from './api'
import type { WalletApi } from './wallet-api'
import {
	isWalletChallengeContext,
	type WalletChallenge,
} from './wallet-contracts'
import {
	createdWithdrawalResponseSchema,
	withdrawalSchema,
	withdrawalTransactionUrl,
	type Withdrawal,
} from './withdrawal-contracts'

const address = `0x${'1'.repeat(40)}`
const options = {
	expectedUserId: 'user-1',
	expectedWorkspaceId: 'workspace-1',
	expectedOrigin: 'https://wallet.example.test',
}
const row: Withdrawal = {
	id: 'withdrawal-1',
	userId: 'user-1',
	amount: 20,
	fee: 1,
	netAmount: 19,
	currency: 'USD',
	walletAddress: address,
	status: 'requested',
	tokenAmount: 38,
	txHash: null,
	chainId: null,
	failureReason: null,
	createdAt: '2026-09-27T01:00:00Z',
	updatedAt: '2026-09-27T01:00:00Z',
	confirmedAt: null,
}
const context = {
	userId: 'user-1',
	workspaceId: 'workspace-1',
	withdrawalCurrency: 'USD',
	amountUnit: 'major',
	tokenSymbol: 'CINA-C',
	tokenAmountUnit: 'major',
	policy: { minAmount: 10, fee: 1, tokenRate: 2, dailyLimit: 3 },
	availability: 'available',
	queueConfigured: true,
	chainId: 84532,
	balance: 100.123456,
	lockedAmount: 0,
	walletAddress: address,
	walletVerifiedAt: null,
	activeWithdrawal: null,
	dailyRemaining: 3,
}
const list = () => ({
	success: true,
	...context,
	data: [row],
	total: 1,
	page: 1,
	pageSize: 20,
})
const quote = () => ({
	success: true,
	...context,
	data: {
		amount: 20,
		fee: 1,
		netAmount: 19,
		tokenAmount: 38,
		fingerprint: 'a'.repeat(64),
	},
})
function challenge(): WalletChallenge {
	const issuedAt = new Date().toISOString(),
		expiresAt = new Date(Date.now() + 300000).toISOString()
	// Use the same timestamp source to guarantee exact five-minute TTL.
	const expiry = new Date(Date.parse(issuedAt) + 300000).toISOString()
	return {
		address,
		origin: options.expectedOrigin,
		chainId: 84532,
		challengeToken: 'test_challenge.payload',
		issuedAt,
		expiresAt: expiry || expiresAt,
		message: `wallet.example.test wants you to sign in with your Ethereum account:\n${address}\n\nVerify ownership of this wallet for CinaToken withdrawals.\n\nURI: ${options.expectedOrigin}\nVersion: 1\nChain ID: 84532\nNonce: ${'a'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiry}\nRequest ID: user-1`,
	}
}
function fixture(body: unknown, status = 200) {
	const calls: { path: string; init: RequestInit }[] = []
	const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ path: String(input), init: init ?? {} })
		return Response.json(body, { status })
	}) as typeof fetch
	return { api: createCinaTokenApi(request), calls }
}
const invalid = (error: unknown) =>
	error instanceof CinaTokenApiError && error.code === 'invalid-response'

test('wallet and withdrawal factories use same-origin Cookie requests with workspace precondition and no legacy identity header', async () => {
	const f = fixture(list())
	await f.api.withdrawals(options)
	const init = f.calls[0].init
	const headers = new Headers(init.headers)
	assert.equal(init.credentials, 'same-origin')
	assert.equal(init.cache, 'no-store')
	assert.equal(
		headers.get(WORKSPACE_PRECONDITION_HEADER),
		options.expectedWorkspaceId
	)
	assert.equal(headers.has('New-Api-User'), false)
	assert.equal(headers.has('Authorization'), false)
	const q = fixture(quote())
	await q.api.quoteWithdrawal({ amount: 20 }, options)
	assert.equal(q.calls[0].init.method, 'POST')
	assert.equal(q.calls[0].path, '/api/user/withdrawals/quote')
	assert.deepEqual(JSON.parse(String(q.calls[0].init.body)), { amount: 20 })
})
test('withdrawal history preserves historical currency and null token/chain fields while new create must remain USD', async () => {
	const historical = { ...row, currency: 'CNY', tokenAmount: null }
	const result = await fixture({
		...list(),
		data: [historical],
	}).api.withdrawals(options)
	assert.equal(result.data[0].currency, 'CNY')
	assert.equal(result.data[0].tokenAmount, null)
	assert.equal(result.balance, 100.123456)
	assert.equal(result.withdrawalCurrency, 'USD')
	assert.equal(
		createdWithdrawalResponseSchema.safeParse({
			success: true,
			...context,
			data: historical,
		}).success,
		false
	)
})
test('empty history and active order validate user/workspace ownership independently of visible rows', async () => {
	const empty = { ...list(), data: [], total: 0 }
	await assert.rejects(
		fixture({ ...empty, userId: 'another' }).api.withdrawals(options),
		invalid
	)
	await assert.rejects(
		fixture({
			...empty,
			activeWithdrawal: { ...row, userId: 'another' },
		}).api.withdrawals(options),
		invalid
	)
	await assert.rejects(
		fixture({ ...empty, workspaceId: 'another' }).api.withdrawals(options),
		(error) =>
			error instanceof CinaTokenApiError && error.code === 'workspace-mismatch'
	)
	const { workspaceId: _workspace, ...missing } = empty
	await assert.rejects(fixture(missing).api.withdrawals(options), invalid)
})
test('pagination and public withdrawal DTO reject duplicates, invalid totals, ownership and private storage fields', async () => {
	for (const response of [
		{ ...list(), page: 2 },
		{ ...list(), total: 0 },
		{ ...list(), data: [row, row], total: 2 },
		{ ...list(), data: [{ ...row, userId: 'other' }] },
		{ ...list(), data: [{ ...row, amountMicros: 20000000 }] },
	])
		await assert.rejects(fixture(response).api.withdrawals(options), invalid)
})
test('quote validates server fee, post-fee conversion, balance, minimum, daily limit, queue and chain availability', async () => {
	const valid = await fixture(quote()).api.quoteWithdrawal(
		{ amount: 20 },
		options
	)
	assert.equal(valid.data.netAmount, 19)
	assert.equal(valid.data.tokenAmount, 38)
	for (const response of [
		{ ...quote(), data: { ...quote().data, tokenAmount: 40 } },
		{ ...quote(), data: { ...quote().data, fee: 2 } },
		{ ...quote(), balance: 10 },
		{ ...quote(), policy: { ...context.policy, minAmount: 21 } },
		{ ...quote(), dailyRemaining: 0 },
		{ ...quote(), dailyRemaining: 4 },
		{ ...quote(), queueConfigured: false },
		{ ...quote(), chainId: null },
		{ ...quote(), activeWithdrawal: row },
	])
		await assert.rejects(
			fixture(response).api.quoteWithdrawal({ amount: 20 }, options),
			invalid
		)
})
test('row amount arithmetic and timestamps must be coherent; explorer links require a known chain and valid hash', () => {
	for (const value of [
		{ ...row, netAmount: 20 },
		{ ...row, fee: 21 },
		{ ...row, updatedAt: '2026-09-26T01:00:00Z' },
		{ ...row, confirmedAt: row.createdAt },
		{ ...row, txHash: 'javascript:alert(1)' },
	])
		assert.equal(withdrawalSchema.safeParse(value).success, false)
	assert.equal(
		withdrawalTransactionUrl({
			...row,
			txHash: `0x${'a'.repeat(64)}`,
			chainId: 99999,
		}),
		null
	)
	assert.match(
		withdrawalTransactionUrl({
			...row,
			txHash: `0x${'a'.repeat(64)}`,
			chainId: 84532,
		}) ?? '',
		/^https:\/\/sepolia\.basescan\.org/u
	)
	assert.equal(
		withdrawalSchema.safeParse({
			...row,
			status: 'confirmed',
			confirmedAt: row.createdAt,
		}).success,
		true
	)
})
test('modern amount form supports six decimals and rejects exponent, sign, unsafe magnitude and extra precision without a request', async () => {
	assert.equal(
		withdrawalFormSchema.safeParse({ amount: '10.123456' }).success,
		true
	)
	for (const amount of [
		'0',
		'-1',
		'+10',
		'1e3',
		'10.1234567',
		'9007199254740991',
	])
		assert.equal(withdrawalFormSchema.safeParse({ amount }).success, false)
	const f = fixture(quote())
	await assert.rejects(f.api.quoteWithdrawal({ amount: 20.1234567 }, options))
	assert.equal(f.calls.length, 0)
})
test('quote changed and dispatch unconfirmed preserve stable server code and never replay create', async () => {
	for (const [status, serverCode] of [
		[409, 'withdrawal_quote_changed'],
		[503, 'withdrawal_dispatch_unconfirmed'],
	] as const) {
		const f = fixture(
			{
				success: false,
				code: serverCode,
				message: 'Refresh',
				withdrawalId: 'private-recorded-id',
			},
			status
		)
		await assert.rejects(
			f.api.createWithdrawal(
				{ amount: 20, expectedQuote: 'a'.repeat(64) },
				options
			),
			(error) =>
				error instanceof CinaTokenApiError &&
				error.serverCode === serverCode &&
				error.status === status &&
				!('withdrawalId' in error)
		)
		assert.equal(f.calls.length, 1)
	}
})
test('401, 403, resource 409 and server 5xx remain errors without automatic replay', async () => {
	for (const status of [401, 403, 409, 500]) {
		const f = fixture({ success: false, message: 'Denied' }, status)
		await assert.rejects(
			f.api.withdrawals(options),
			(error) => error instanceof CinaTokenApiError && error.status === status
		)
		assert.equal(f.calls.length, 1)
	}
})
test('wallet challenge validates exact signed origin, address, chain, expiry and user before it reaches the provider', async () => {
	const data = challenge()
	assert.equal(
		isWalletChallengeContext(
			data,
			options.expectedUserId,
			options.expectedOrigin,
			address
		),
		true
	)
	const response = {
		success: true,
		userId: 'user-1',
		workspaceId: 'workspace-1',
		data,
	}
	assert.deepEqual(
		await fixture(response).api.createWalletChallenge(
			{ walletAddress: address },
			options
		),
		data
	)
	for (const changed of [
		{ ...data, origin: 'https://other.test' },
		{
			...data,
			message: data.message.replace('Request ID: user-1', 'Request ID: other'),
		},
		{ ...data, address: `0x${'2'.repeat(40)}` },
		{ ...data, chainId: 1 },
		{
			...data,
			expiresAt: new Date(Date.parse(data.issuedAt) + 300001).toISOString(),
		},
	])
		await assert.rejects(
			fixture({ ...response, data: changed }).api.createWalletChallenge(
				{ walletAddress: address },
				options
			),
			invalid
		)
})
test('wallet API sanitizes credential-echoing errors and validates even empty wallet ownership', async () => {
	const artifact = 'test_challenge.payload'
	const f = fixture({ success: false, message: artifact }, 400)
	await assert.rejects(
		f.api.verifyWallet(
			{ challengeToken: artifact, signature: `0x${'a'.repeat(130)}` },
			options
		),
		(error) =>
			error instanceof CinaTokenApiError && !error.message.includes(artifact)
	)
	const wrongOwner = {
		success: true,
		userId: 'other',
		workspaceId: 'workspace-1',
		availability: 'available',
		chainId: 84532,
		data: { walletAddress: null, walletMasked: null, verifiedAt: null },
	}
	await assert.rejects(fixture(wrongOwner).api.wallet(options), invalid)
})
test('withdrawal reads and wallet verification support abort and timeout through shared transport', async () => {
	const request = (async (_input: RequestInfo | URL, init?: RequestInit) =>
		await new Promise<Response>((_resolve, reject) => {
			const abort = () => reject(new DOMException('Aborted', 'AbortError'))
			init?.signal?.addEventListener('abort', abort, { once: true })
			if (init?.signal?.aborted) abort()
		})) as typeof fetch
	const api = createCinaTokenApi(request)
	const controller = new AbortController()
	const pending = api.withdrawals({ ...options, signal: controller.signal })
	controller.abort()
	await assert.rejects(
		pending,
		(error) => error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
	await assert.rejects(
		api.verifyWallet(
			{
				challengeToken: 'test_challenge.payload',
				signature: `0x${'a'.repeat(130)}`,
			},
			{ ...options, timeoutMs: 1 }
		),
		(error) => error instanceof CinaTokenApiError && error.code === 'timeout'
	)
})

function connectionFixture(
	settings: {
		pendingSign?: boolean
		initialChain?: string
		changedAccountWithoutEvent?: boolean
		rejection?: boolean
	} = {}
) {
	const listeners = new Map<string, (value: unknown) => void>()
	const methods: string[] = []
	let verified = 0
	let signResolve: (value: unknown) => void = () => {}
	let signed: () => void = () => {}
	const signing = new Promise<void>((resolve) => {
		signed = resolve
	})
	const provider: EvmProvider = {
		on: (event, listener) => {
			listeners.set(event, listener)
		},
		removeListener: (event) => {
			listeners.delete(event)
		},
		request: async (input) => {
			methods.push(input.method)
			if (input.method === 'eth_requestAccounts') return [address]
			if (input.method === 'eth_accounts')
				return [
					settings.changedAccountWithoutEvent ? `0x${'2'.repeat(40)}` : address,
				]
			if (input.method === 'eth_chainId')
				return settings.initialChain ?? '0x14a34'
			if (input.method === 'personal_sign') {
				signed()
				if (settings.rejection)
					throw { code: 4001, message: 'private signature echo' }
				if (settings.pendingSign)
					return new Promise((resolve) => {
						signResolve = resolve
					})
				return `0x${'a'.repeat(130)}`
			}
			throw new Error('Unexpected provider method')
		},
	}
	const api = {
		wallet: async () => {
			throw new Error('Not called')
		},
		createWalletChallenge: async () => challenge(),
		verifyWallet: async () => {
			verified += 1
			return { walletAddress: address, verifiedAt: new Date().toISOString() }
		},
	} satisfies WalletApi
	return {
		api,
		provider,
		methods,
		signing,
		verified: () => verified,
		emit: (event: string) => listeners.get(event)?.([]),
		lateSignature: () => signResolve(`0x${'a'.repeat(130)}`),
		listeners,
	}
}
test('EOA connection signs the exact challenge and rechecks account/chain before verify', async () => {
	const f = connectionFixture()
	const flow = new WalletConnection()
	const phases: string[] = []
	const result = await flow.connect(f.api, options, f.provider, (phase) =>
		phases.push(phase)
	)
	assert.equal(result, undefined)
	assert.equal(f.verified(), 1)
	assert.deepEqual(f.methods, [
		'eth_requestAccounts',
		'eth_chainId',
		'personal_sign',
		'eth_accounts',
		'eth_chainId',
	])
	assert.deepEqual(phases, ['connecting', 'challenge', 'signing', 'verifying'])
	assert.equal(f.listeners.size, 0)
})
test('account/chain events or cancellation abort pending signature promptly and late provider result never verifies', async () => {
	for (const event of ['accountsChanged', 'chainChanged', 'cancel']) {
		const f = connectionFixture({ pendingSign: true })
		const flow = new WalletConnection()
		const pending = flow.connect(f.api, options, f.provider, () => {})
		const rejected = assert.rejects(
			pending,
			(error) =>
				error instanceof WalletConnectionError && error.reason === 'changed'
		)
		await f.signing
		if (event === 'cancel') flow.cancel()
		else f.emit(event)
		await rejected
		f.lateSignature()
		await Promise.resolve()
		assert.equal(f.verified(), 0)
		assert.equal(f.listeners.size, 0)
	}
})
test('wrong chain, silently changed account and rejected provider requests never send wallet verification', async () => {
	for (const settings of [
		{ initialChain: '0x1' },
		{ changedAccountWithoutEvent: true },
		{ rejection: true },
	]) {
		const f = connectionFixture(settings)
		await assert.rejects(
			new WalletConnection().connect(f.api, options, f.provider, () => {}),
			(error) => error instanceof WalletConnectionError
		)
		assert.equal(f.verified(), 0)
	}
})
