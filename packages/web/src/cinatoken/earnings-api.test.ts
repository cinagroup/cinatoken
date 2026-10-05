import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	formatEarningsMoney,
	earningsPageCount,
} from './account/earnings/earnings-display'
import {
	CinaTokenApiError,
	createCinaTokenApi,
	WORKSPACE_PRECONDITION_HEADER,
} from './api'
import {
	earningsSummaryResponseSchema,
	earningsResponseSchema,
	type EarningsSummary,
	type Earning,
} from './earnings-contracts'

const options = {
	expectedSellerUserId: 'seller-1',
	expectedWorkspaceId: 'workspace-1',
}
const summary: EarningsSummary = {
	userId: 'seller-1',
	balance: 1.234567,
	lockedAmount: 0.5,
	lifetimeEarned: 10,
	lifetimeWithdrawn: 8,
	contributionValue: 10,
	walletAddress: null,
	walletVerifiedAt: null,
	highestBadgeTier: 0,
	updatedAt: '2026-09-27 09:00:00',
}
const earning: Earning = {
	id: 'earning-1',
	requestLogId: 'request-1',
	sharedKeyId: 'shared-1',
	sellerUserId: 'seller-1',
	inputTokens: 10,
	outputTokens: 5,
	cacheReadTokens: 2,
	cacheWriteTokens: 1,
	grossAmount: 0.123456,
	platformFee: 0.012346,
	netAmount: 0.11111,
	currency: 'USD',
	createdAt: summary.updatedAt,
}
const metadata = {
	sellerUserId: 'seller-1',
	workspaceId: 'workspace-1',
	earningsCurrency: 'USD',
	amountUnit: 'major',
}
const summaryResponse = () => ({
	success: true,
	data: summary,
	...metadata,
	availability: 'available',
})
const listResponse = () => ({
	success: true,
	data: [earning],
	total: 1,
	page: 1,
	pageSize: 20,
	...metadata,
})
function transport(
	handler: (path: string, init: RequestInit) => Response | Promise<Response>
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) =>
		handler(String(input), init ?? {})) as typeof fetch
}

function code(expected: CinaTokenApiError['code'], status?: number) {
	return (error: unknown) =>
		error instanceof CinaTokenApiError &&
		error.code === expected &&
		(status === undefined || error.status === status)
}

function fixture(body: unknown, status = 200) {
	const calls: { path: string; init: RequestInit }[] = []
	const api = createCinaTokenApi(
		transport((path, init) => {
			calls.push({ path, init })
			return Response.json(body, { status })
		})
	)
	return { api, calls }
}

test('summary and page retain six-decimal major amounts and distinguish request billing currency', async () => {
	const { api } = fixture(summaryResponse())
	const response = await api.earningsSummary(options)
	assert.equal(response.data?.balance, 1.234567)
	assert.equal(response.earningsCurrency, 'USD')
	assert.match(
		formatEarningsMoney(
			response.data!.balance,
			response.earningsCurrency,
			'en'
		),
		/1\.234567/
	)
	const page = await fixture(listResponse()).api.earnings(options)
	assert.equal(page.data[0].netAmount, 0.11111)
	assert.equal(page.data[0].cacheReadTokens, 2)
})

test('missing summary remains explicit unavailable and inconsistent availability is rejected', async () => {
	const unavailable = {
		...summaryResponse(),
		data: null,
		availability: 'unavailable',
	}
	assert.equal(
		(await fixture(unavailable).api.earningsSummary(options)).data,
		null
	)
	assert.equal(
		earningsSummaryResponseSchema.safeParse({
			...unavailable,
			availability: 'available',
		}).success,
		false
	)
	assert.equal(
		earningsSummaryResponseSchema.safeParse({
			...summaryResponse(),
			availability: 'unavailable',
		}).success,
		false
	)
})

test('wrong top-level seller is rejected even for empty or missing data', async () => {
	await assert.rejects(
		fixture({
			...summaryResponse(),
			data: null,
			availability: 'unavailable',
			sellerUserId: 'another-seller',
		}).api.earningsSummary(options),
		code('invalid-response')
	)
	await assert.rejects(
		fixture({
			...listResponse(),
			data: [],
			total: 0,
			sellerUserId: 'another-seller',
		}).api.earnings(options),
		code('invalid-response')
	)
})

test('row ownership cannot be inferred from organization workspace access', async () => {
	await assert.rejects(
		fixture({
			...summaryResponse(),
			data: { ...summary, userId: 'org-admin' },
		}).api.earningsSummary(options),
		code('invalid-response')
	)
	await assert.rejects(
		fixture({
			...listResponse(),
			data: [{ ...earning, sellerUserId: 'org-owner' }],
		}).api.earnings(options),
		code('invalid-response')
	)
})

test('empty pages still verify workspace metadata and use the Cookie transport', async () => {
	await assert.rejects(
		fixture({
			...listResponse(),
			data: [],
			total: 0,
			workspaceId: 'workspace-2',
		}).api.earnings(options),
		code('workspace-mismatch')
	)
	const { api, calls } = fixture({ ...listResponse(), data: [], total: 0 })
	const controller = new AbortController()
	await api.earnings({ ...options, signal: controller.signal })
	assert.ok(calls[0].init.signal instanceof AbortSignal)
	assert.equal(calls[0].init.signal.aborted, false)
	assert.equal(calls[0].init.credentials, 'same-origin')
	assert.equal(calls[0].init.cache, 'no-store')
	assert.equal(calls[0].init.body, undefined)
	const headers = new Headers(calls[0].init.headers)
	assert.equal(headers.get('Accept'), 'application/json')
	assert.equal(headers.get(WORKSPACE_PRECONDITION_HEADER), 'workspace-1')
	assert.equal(headers.has('Authorization'), false)
	assert.equal(headers.has('New-Api-User'), false)
	assert.equal(calls[0].path, '/api/user/earnings?page=1&pageSize=20')
})

test('all malformed financial values and unexpected private fields fail the public schema', () => {
	for (const value of [null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(
			earningsResponseSchema.safeParse({
				...listResponse(),
				data: [{ ...earning, grossAmount: value }],
			}).success,
			false
		)
	}
	assert.equal(
		earningsResponseSchema.safeParse({
			...listResponse(),
			data: [{ ...earning, secret: 'must-not-be-exposed' }],
		}).success,
		false
	)
	assert.equal(
		earningsSummaryResponseSchema.safeParse({
			...summaryResponse(),
			earningsCurrency: 'CNY',
		}).success,
		false
	)
	assert.equal(
		earningsSummaryResponseSchema.safeParse({
			...summaryResponse(),
			amountUnit: 'micros',
		}).success,
		false
	)
})

test('page identity, totals, duplicates and local pagination bounds are checked', async () => {
	for (const body of [
		{ ...listResponse(), page: 2 },
		{ ...listResponse(), pageSize: 50 },
		{ ...listResponse(), total: 0 },
		{ ...listResponse(), data: [earning, earning], total: 2 },
	])
		await assert.rejects(
			fixture(body).api.earnings(options),
			code('invalid-response')
		)
	const { api, calls } = fixture(listResponse())
	for (const query of [
		{ page: 0 },
		{ page: 1.5 },
		{ pageSize: 101 },
		{ pageSize: 0 },
	])
		await assert.rejects(api.earnings({ ...options, ...query }))
	assert.equal(calls.length, 0)
	assert.equal(earningsPageCount(0), 1)
	assert.equal(earningsPageCount(21), 2)
	assert.equal(earningsPageCount(40), 2)
})

test('each historical earning keeps its own currency without relabeling the USD projection', async () => {
	const page = await fixture({
		...listResponse(),
		data: [{ ...earning, currency: 'CNY' }],
	}).api.earnings(options)
	assert.equal(page.earningsCurrency, 'USD')
	assert.equal(page.data[0].currency, 'CNY')
	assert.match(
		formatEarningsMoney(page.data[0].netAmount, page.data[0].currency, 'en'),
		/CNY/
	)
})

test('pagination uses the requested offset and encoded workspace precondition without changing seller ownership', async () => {
	const workspaceId = 'organization:team 1'
	const { api, calls } = fixture({
		...listResponse(),
		page: 2,
		total: 21,
		workspaceId,
	})
	const page = await api.earnings({
		...options,
		expectedWorkspaceId: workspaceId,
		page: 2,
	})
	assert.equal(page.data[0].sellerUserId, options.expectedSellerUserId)
	assert.equal(page.page, 2)
	assert.equal(calls[0].path, '/api/user/earnings?page=2&pageSize=20')
	assert.equal(
		new Headers(calls[0].init.headers).get(WORKSPACE_PRECONDITION_HEADER),
		encodeURIComponent(workspaceId)
	)
	const empty = await fixture({
		...listResponse(),
		data: [],
		total: 0,
		page: 2,
	}).api.earnings({ ...options, page: 2 })
	assert.deepEqual(empty.data, [])
})

test('public transport reports 401, 403, 400 and server failures without retrying or treating resource conflicts as workspace changes', async () => {
	for (const status of [401, 403, 400, 409, 500, 503]) {
		const { api, calls } = fixture(
			{ success: false, code: 'ledger_conflict', message: 'Rejected' },
			status
		)
		await assert.rejects(api.earningsSummary(options), code('http', status))
		assert.equal(calls.length, 1)
	}
	const { api, calls } = fixture(
		{
			success: false,
			code: 'workspace_mismatch',
			message: 'Workspace changed',
		},
		409
	)
	await assert.rejects(api.earnings(options), code('workspace-mismatch', 409))
	assert.equal(calls.length, 1)
})

test('business rejection, missing scope metadata, invalid JSON and network failures remain explicit errors', async () => {
	await assert.rejects(
		fixture({
			success: false,
			message: 'Ledger unavailable',
		}).api.earningsSummary(options),
		code('business', 200)
	)
	const { workspaceId: _workspaceId, ...missingScope } = listResponse()
	await assert.rejects(
		fixture(missingScope).api.earnings(options),
		code('invalid-response', 200)
	)
	const invalidJson = createCinaTokenApi(
		transport(() => new Response('not JSON'))
	)
	await assert.rejects(
		invalidJson.earningsSummary(options),
		code('invalid-response', 200)
	)
	const unreachable = createCinaTokenApi(
		transport(() => {
			throw new TypeError('fetch failed')
		})
	)
	await assert.rejects(unreachable.earningsSummary(options), code('network', 0))
})

test('cancelled earnings responses cannot restore data even when the injected transport finishes late', async () => {
	const controller = new AbortController()
	let finish!: (response: Response) => void
	let requestSignal: AbortSignal | null | undefined
	const api = createCinaTokenApi(
		transport((_path, init) => {
			requestSignal = init.signal
			return new Promise<Response>((resolve) => {
				finish = resolve
			})
		})
	)
	const pending = api.earningsSummary({ ...options, signal: controller.signal })
	controller.abort()
	assert.equal(requestSignal?.aborted, true)
	finish(Response.json(summaryResponse()))
	await assert.rejects(pending, code('cancelled', 0))
})

test('timeout remains authoritative when a response arrives after the deadline', async () => {
	const api = createCinaTokenApi(
		transport(async (_path, init) => {
			await new Promise<void>((resolve) => {
				init.signal?.addEventListener('abort', () => resolve(), { once: true })
			})
			return Response.json(listResponse())
		})
	)
	await assert.rejects(
		api.earnings({ ...options, timeoutMs: 1 }),
		code('timeout', 0)
	)
})
