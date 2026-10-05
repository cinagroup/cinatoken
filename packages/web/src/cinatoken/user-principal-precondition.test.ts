import { z } from 'zod'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	CinaTokenApiError,
	createCinaTokenApi,
	createCinaTokenCookieTransport,
	type RequestOptions,
} from './api'

const userHeader = 'X-CinaToken-Expected-User-Id'
const workspaceHeader = 'X-CinaToken-Workspace'
const successSchema = z.object({ success: z.literal(true) })
const identity = {
	expectedUserId: 'fixture-user-a',
	expectedWorkspaceId: 'workspace:shared-organization',
}

function fixture(body: unknown = { success: true }, status = 200) {
	const requests: { path: string; init: RequestInit; headers: Headers }[] = []
	const request: typeof fetch = async (input, init = {}) => {
		requests.push({
			path: String(input),
			init,
			headers: new Headers(init.headers),
		})
		return Response.json(body, { status })
	}
	return {
		requests,
		api: createCinaTokenApi(request),
		transport: createCinaTokenCookieTransport(request),
	}
}

function apiError(
	code: CinaTokenApiError['code'],
	status: number,
	serverCode: CinaTokenApiError['serverCode'] = null
) {
	return (error: unknown): boolean =>
		error instanceof CinaTokenApiError &&
		error.code === code &&
		error.status === status &&
		error.serverCode === serverCode
}

test('a read and a write bind the initiating user independently of a shared organization workspace', async () => {
	for (const method of ['GET', 'POST']) {
		const f = fixture({ success: false, code: 'user_mismatch' }, 409)
		await assert.rejects(
			f.transport.send(
				'/api/user/nft/mint',
				successSchema,
				{ method },
				identity
			),
			apiError('user-mismatch', 409, 'user_mismatch')
		)
		assert.equal(f.requests.length, 1)
		assert.equal(f.requests[0].headers.get(userHeader), identity.expectedUserId)
		assert.equal(
			f.requests[0].headers.get(workspaceHeader),
			encodeURIComponent(identity.expectedWorkspaceId)
		)
		assert.equal(f.requests[0].init.credentials, 'same-origin')
		assert.equal(f.requests[0].init.cache, 'no-store')
		assert.equal(f.requests[0].init.redirect, 'error')
	}
})

test('valid Unicode, a literal comma, a literal percent and the length boundary are encoded canonically', async () => {
	for (const id of [
		'用户:é,🙂',
		'comma,user',
		'literal%2Cuser',
		'u'.repeat(600),
	]) {
		const f = fixture()
		await f.transport.send(
			'/api/user/me',
			successSchema,
			{},
			{ expectedUserId: id }
		)
		assert.equal(f.requests[0].headers.get(userHeader), encodeURIComponent(id))
		assert.equal(decodeURIComponent(f.requests[0].headers.get(userHeader)!), id)
	}
})

test('invalid identities reject before fetch rather than relying on a server rejection', async () => {
	for (const id of [
		'',
		' leading',
		'trailing ',
		'line\nbreak',
		'null\u0000byte',
		'delete\u007fbyte',
		'c1\u0085byte',
		'c1\u009fbyte',
		'\ud800',
		'u'.repeat(601),
	]) {
		const f = fixture()
		await assert.rejects(
			f.transport.send(
				'/api/user/nft/mint',
				successSchema,
				{ method: 'POST' },
				{
					expectedUserId: id,
				}
			)
		)
		assert.equal(f.requests.length, 0, JSON.stringify(id))
	}
})

test('caller-supplied stale and duplicate reserved headers are replaced without mutating caller Headers', async () => {
	const headers = new Headers([
		[userHeader, 'stale-user-a'],
		[userHeader.toLowerCase(), 'stale-user-b'],
		['Content-Type', 'application/json'],
	])
	const original = headers.get(userHeader)
	const f = fixture()
	await f.transport.send(
		'/api/user/nft/mint',
		successSchema,
		{ method: 'POST', headers },
		identity
	)
	assert.equal(f.requests[0].headers.get(userHeader), identity.expectedUserId)
	assert.equal(f.requests[0].headers.get('content-type'), 'application/json')
	assert.equal(headers.get(userHeader), original)
})

test('omitted expected user preserves header-less compatibility and cannot reuse a caller identity header', async () => {
	const f = fixture()
	await f.transport.send('/api/user/nft/tiers', successSchema)
	await f.transport.send('/api/user/nft/tiers', successSchema, {
		headers: { [userHeader]: 'manual-user' },
	})
	assert.equal(f.requests.length, 2)
	assert.ok(f.requests.every((request) => !request.headers.has(userHeader)))
})

test('Admin, public, authentication and neighboring paths strip reserved user identity', async () => {
	for (const path of [
		'/api/admin/users',
		'/api/auth/check',
		'/api/auth/logout',
		'/api/catalog/models',
		'/api/userish/nft',
		'/api/user',
		'/api/user?child=nft',
		'/user/nft/tiers',
		'https://outside.example.test/api/user/nft/tiers',
	]) {
		const f = fixture()
		await f.transport.send(
			path,
			successSchema,
			{
				headers: { [userHeader]: 'manual-user' },
			},
			{ expectedUserId: identity.expectedUserId }
		)
		assert.equal(f.requests[0].headers.has(userHeader), false, path)
	}
})

test('a pre-aborted scoped write never calls an injected transport that ignores AbortSignal', async () => {
	const f = fixture()
	const controller = new AbortController()
	controller.abort('scope changed')
	await assert.rejects(
		f.transport.send(
			'/api/user/nft/mint',
			successSchema,
			{ method: 'POST' },
			{
				...identity,
				signal: controller.signal,
			}
		),
		apiError('cancelled', 0)
	)
	assert.equal(f.requests.length, 0)
})

test('a response arriving after abort is discarded and a started write is not replayed', async () => {
	const controller = new AbortController()
	let calls = 0
	const request: typeof fetch = async () => {
		calls += 1
		controller.abort('other tab changed the account')
		return Response.json({ success: true })
	}
	const transport = createCinaTokenCookieTransport(request)
	await assert.rejects(
		transport.send(
			'/api/user/nft/mint',
			successSchema,
			{ method: 'POST' },
			{
				...identity,
				signal: controller.signal,
			}
		),
		apiError('cancelled', 0)
	)
	assert.equal(calls, 1)
})

test('only a server 409 user_mismatch is a recoverable user mismatch', async () => {
	for (const [status, serverCode, code] of [
		[409, 'user_mismatch', 'user-mismatch'],
		[401, 'user_mismatch', 'http'],
		[400, 'invalid_user_precondition', 'http'],
		[409, 'workspace_mismatch', 'workspace-mismatch'],
	] as const) {
		const f = fixture({ success: false, code: serverCode }, status)
		await assert.rejects(
			f.transport.send(
				'/api/user/nft/mint',
				successSchema,
				{ method: 'POST' },
				identity
			),
			apiError(code, status, serverCode)
		)
		assert.equal(f.requests.length, 1)
	}
})

test('unknown error codes, missing error bodies and malformed JSON never become user mismatch', async () => {
	for (const body of [
		{ success: false, code: 'future_user_conflict' },
		{ success: false },
	]) {
		const f = fixture(body, 409)
		await assert.rejects(
			f.transport.send(
				'/api/user/nft/mint',
				successSchema,
				{ method: 'POST' },
				identity
			),
			apiError('http', 409)
		)
		assert.equal(f.requests.length, 1)
	}
	let calls = 0
	const request: typeof fetch = async () => {
		calls += 1
		return new Response('<html>unavailable</html>', { status: 409 })
	}
	await assert.rejects(
		createCinaTokenCookieTransport(request).send(
			'/api/user/nft/mint',
			successSchema,
			{ method: 'POST' },
			identity
		),
		apiError('http', 409)
	)
	assert.equal(calls, 1)
})

test('an HTTP 200 business rejection with the same code is not mistaken for an authenticated 409', async () => {
	const f = fixture({ success: false, code: 'user_mismatch' })
	await assert.rejects(
		f.transport.send('/api/user/nft/tiers', successSchema, {}, identity),
		apiError('business', 200, 'user_mismatch')
	)
})

test('ordinary successful response contracts are still validated after adding the user precondition', async () => {
	const f = fixture({ success: true, data: 'not the expected numeric result' })
	await assert.rejects(
		f.transport.send(
			'/api/user/result',
			z.object({ success: z.literal(true), data: z.number() }),
			{},
			identity
		),
		apiError('invalid-response', 200)
	)
})

const quote = {
	success: true,
	userId: identity.expectedUserId,
	workspaceId: identity.expectedWorkspaceId,
	withdrawalCurrency: 'USD',
	amountUnit: 'major',
	tokenSymbol: 'CINA-C',
	tokenAmountUnit: 'major',
	policy: { minAmount: 1, fee: 1, tokenRate: 2, dailyLimit: 3 },
	availability: 'available',
	queueConfigured: true,
	chainId: 84532,
	balance: 25,
	lockedAmount: 0,
	walletAddress: `0x${'1'.repeat(40)}`,
	walletVerifiedAt: null,
	activeWithdrawal: null,
	dailyRemaining: 3,
	data: {
		amount: 10,
		fee: 1,
		netAmount: 9,
		tokenAmount: 18,
		fingerprint: 'a'.repeat(64),
	},
}

test('a valid financial quote remains scoped and a changed calculation or owner still fails its existing validator', async () => {
	const f = fixture(quote)
	const result = await f.api.quoteWithdrawal({ amount: 10 }, identity)
	assert.equal(result.data.tokenAmount, 18)
	assert.equal(f.requests[0].headers.get(userHeader), identity.expectedUserId)
	for (const body of [
		{ ...quote, userId: 'fixture-user-b' },
		{ ...quote, data: { ...quote.data, tokenAmount: 19 } },
		{ ...quote, data: { ...quote.data, fingerprint: 'invalid' } },
	]) {
		await assert.rejects(
			fixture(body).api.quoteWithdrawal({ amount: 10 }, identity),
			apiError('invalid-response', 200)
		)
	}
})

test('a financial quote conflict stays rejected and is never accepted or retried as a successful quote', async () => {
	const options: RequestOptions = identity
	for (const serverCode of [
		'withdrawal_quote_changed',
		'user_mismatch',
	] as const) {
		const f = fixture({ ...quote, success: false, code: serverCode }, 409)
		await assert.rejects(
			f.api.quoteWithdrawal({ amount: 10 }, { ...options, ...identity }),
			apiError(
				serverCode === 'user_mismatch' ? 'user-mismatch' : 'http',
				409,
				serverCode
			)
		)
		assert.equal(f.requests.length, 1)
	}
})
