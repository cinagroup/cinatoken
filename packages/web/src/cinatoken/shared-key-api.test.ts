import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCinaTokenApi, CinaTokenApiError } from './api'
import {
	SharedKeyHistoryConflict,
	type SharedKeyRequestOptions,
} from './shared-key-api'
import { sharedKeySchema, type SharedKey } from './shared-key-contracts'

const secret = 'sk-shared-fixture-secret'
const options = {
	expectedSellerUserId: 'seller:alice',
	expectedWorkspaceId: 'workspace:team',
}
const row: SharedKey = {
	id: 'shared-listing',
	sellerUserId: options.expectedSellerUserId,
	channelType: 'openai',
	apiKeyMasked: 'sk-…cret',
	keyFingerprint: '…cret',
	label: 'Shared',
	status: 'active',
	sellerPriority: 0,
	weight: 10,
	inputPrice: 2,
	outputPrice: 4,
	cacheReadPrice: null,
	cacheWritePrice: 0,
	validatedAt: null,
	lastUsedAt: null,
	lastFailureAt: null,
	failureReason: null,
	servedInputTokens: 5,
	servedOutputTokens: 9,
	earnedTotal: 0.000014,
	earnedTotalExact: '0.000014',
	createdAt: '2026-09-27T00:00:00Z',
	updatedAt: '2026-09-27T00:00:00Z',
}
const catalog = {
	channels: [
		{
			channelType: 'openai',
			label: 'OpenAI',
			modelsUrl: 'https://api.openai.com/v1/models',
		},
	],
	limits: { maxInputPrice: 20, maxOutputPrice: 40, commissionRate: 0.1 },
	billingCurrency: 'CNY',
}
function transport(
	handler: (path: string, init: RequestInit) => Response | Promise<Response>
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) =>
		handler(String(input), init ?? {})) as typeof fetch
}
function result(value: unknown, status = 200) {
	return Response.json(value, { status })
}
const invalid = (error: unknown) =>
	error instanceof CinaTokenApiError && error.code === 'invalid-response'

test('every shared-key operation requires a workspace Cookie precondition before any request', async () => {
	let calls = 0
	const api = createCinaTokenApi(
		transport(() => {
			calls++
			throw new Error('A request without its precondition must not be sent')
		})
	)
	for (const missingWorkspace of [undefined, '', '   ']) {
		const incomplete = {
			expectedSellerUserId: options.expectedSellerUserId,
			expectedWorkspaceId: missingWorkspace,
		} as unknown as SharedKeyRequestOptions
		const operations = [
			() => api.sharedKeys(incomplete),
			() => api.sharedKeyChannels(incomplete),
			() =>
				api.createSharedKey(
					{
						channelType: 'openai',
						apiKey: secret,
						weight: 10,
						inputPrice: 2,
						outputPrice: 4,
					},
					incomplete
				),
			() => api.updateSharedKey(row.id, { weight: 11 }, incomplete),
			() => api.revalidateSharedKey(row.id, incomplete),
			() => api.deleteSharedKey(row.id, incomplete),
		]
		for (const operation of operations) await assert.rejects(operation())
	}
	assert.equal(calls, 0)
})

test('shared seller operations use exact Cookie contracts, workspace precondition and no legacy headers', async () => {
	const calls: string[] = []
	const api = createCinaTokenApi(
		transport((path, init) => {
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			const headers = new Headers(init.headers)
			assert.equal(headers.get('X-CinaToken-Workspace'), 'workspace%3Ateam')
			assert.equal(headers.has('New-Api-User'), false)
			calls.push(`${init.method ?? 'GET'} ${path}`)
			if (path.endsWith('/channels'))
				return result({ success: true, data: catalog })
			if (init.method === 'DELETE') return result({ success: true })
			if (path === '/api/user/shared-keys' && init.method === 'POST') {
				const input = JSON.parse(String(init.body)) as Record<string, unknown>
				assert.equal(input.apiKey, secret)
				assert.equal('workspace_id' in input, false)
				assert.equal('sellerUserId' in input, false)
				return result({
					success: true,
					data: {
						...row,
						apiKey: secret,
						validation: 'active',
						validationReason: null,
					},
				})
			}
			if (init.method === 'PATCH' || path.endsWith('/revalidate'))
				return result({ success: true, data: row })
			return result({
				success: true,
				data: [row],
				sellerUserId: row.sellerUserId,
				earningsCurrency: 'USD',
			})
		})
	)
	const list = await api.sharedKeys(options)
	assert.deepEqual(list, { keys: [row], earningsCurrency: 'USD' })
	assert.equal(JSON.stringify(list).includes(secret), false)
	assert.equal((await api.sharedKeyChannels(options)).billingCurrency, 'CNY')
	const created = await api.createSharedKey(
		{
			channelType: 'openai',
			apiKey: `  ${secret}  `,
			inputPrice: 2,
			outputPrice: 4,
			weight: 10,
		},
		options
	)
	assert.equal(JSON.stringify(created).includes(secret), false)
	assert.equal('apiKey' in created.row, false)
	await api.updateSharedKey(
		row.id,
		{ weight: 11, cacheReadPrice: null },
		options
	)
	await api.revalidateSharedKey(row.id, options)
	await api.deleteSharedKey(row.id, options)
	assert.deepEqual(calls, [
		'GET /api/user/shared-keys',
		'GET /api/user/shared-keys/channels',
		'POST /api/user/shared-keys',
		'PATCH /api/user/shared-keys/shared-listing',
		'POST /api/user/shared-keys/shared-listing/revalidate',
		'DELETE /api/user/shared-keys/shared-listing',
	])
})
test('shared listing rejects another seller and missing or mismatched identity on empty collections', async () => {
	for (const body of [
		{ success: true, data: [], sellerUserId: 'other', earningsCurrency: 'USD' },
		{ success: true, data: [], earningsCurrency: 'USD' },
		{
			success: true,
			data: [{ ...row, sellerUserId: 'other' }],
			sellerUserId: row.sellerUserId,
			earningsCurrency: 'USD',
		},
		{
			success: true,
			data: [row, row],
			sellerUserId: row.sellerUserId,
			earningsCurrency: 'USD',
		},
	]) {
		const api = createCinaTokenApi(transport(() => result(body)))
		await assert.rejects(api.sharedKeys(options), invalid)
	}
})
test('shared public rows forbid reusable secrets, encrypted fields, unmasked values and invalid states', async () => {
	for (const patch of [
		{ apiKey: secret },
		{ encrypted: 'ciphertext' },
		{ apiKeyMasked: secret },
		{ keyFingerprint: secret },
		{ status: 'unknown' },
	])
		assert.equal(sharedKeySchema.safeParse({ ...row, ...patch }).success, false)
	const api = createCinaTokenApi(
		transport(() => result({ success: true, data: { ...row, apiKey: secret } }))
	)
	await assert.rejects(
		api.updateSharedKey(row.id, { weight: 12 }, options),
		invalid
	)
})
test('quotes require server currency and channels reject duplicates', async () => {
	for (const data of [
		{ ...catalog, billingCurrency: undefined },
		{ ...catalog, billingCurrency: 'usd' },
		{ ...catalog, channels: [...catalog.channels, ...catalog.channels] },
	]) {
		const api = createCinaTokenApi(
			transport(() => result({ success: true, data }))
		)
		await assert.rejects(api.sharedKeyChannels(options), invalid)
	}
})
test('creation checks returned seller/channel/echo and metadata writes verify the listing id', async () => {
	const input = {
		channelType: 'openai' as const,
		apiKey: secret,
		weight: 10,
		inputPrice: 2,
		outputPrice: 4,
	}
	for (const patch of [
		{ sellerUserId: 'other' },
		{ channelType: 'anthropic' },
		{ apiKey: 'different-secret' },
	]) {
		const api = createCinaTokenApi(
			transport(() =>
				result({
					success: true,
					data: {
						...row,
						apiKey: secret,
						validation: 'active',
						validationReason: null,
						...patch,
					},
				})
			)
		)
		await assert.rejects(api.createSharedKey(input, options), invalid)
	}
	const api = createCinaTokenApi(
		transport(() => result({ success: true, data: { ...row, id: 'other' } }))
	)
	await assert.rejects(
		api.updateSharedKey(row.id, { weight: 12 }, options),
		invalid
	)
	await assert.rejects(api.revalidateSharedKey(row.id, options), invalid)
})
test('credited deletion conflict differs from real workspace conflict and does not replay', async () => {
	let calls = 0
	const api = createCinaTokenApi(
		transport(() => {
			calls++
			return result(
				{
					success: false,
					code: 'shared_key_earning_history_immutable',
					message: 'Immutable history',
				},
				409
			)
		})
	)
	await assert.rejects(
		api.deleteSharedKey(row.id, options),
		SharedKeyHistoryConflict
	)
	assert.equal(calls, 1)
	const scoped = createCinaTokenApi(
		transport(() =>
			result(
				{
					success: false,
					code: 'workspace_mismatch',
					message: 'Workspace changed',
				},
				409
			)
		)
	)
	await assert.rejects(
		scoped.deleteSharedKey(row.id, options),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'workspace-mismatch'
	)
	const unknown = createCinaTokenApi(
		transport(() =>
			result({ success: false, message: 'Unspecified conflict' }, 409)
		)
	)
	await assert.rejects(
		unknown.deleteSharedKey(row.id, options),
		(error: unknown) =>
			error instanceof CinaTokenApiError &&
			error.status === 409 &&
			error.serverCode === null &&
			!(error instanceof SharedKeyHistoryConflict)
	)
	const unrecognized = createCinaTokenApi(
		transport(() =>
			result(
				{
					success: false,
					code: 'future_resource_conflict',
					message: `Unknown conflict ${secret}`,
				},
				409
			)
		)
	)
	await assert.rejects(
		unrecognized.deleteSharedKey(row.id, options),
		(error: unknown) =>
			error instanceof CinaTokenApiError &&
			error.status === 409 &&
			error.serverCode === null &&
			!error.message.includes(secret)
	)
})
test('unconfirmed write errors omit any server-echoed secret and cancelled late responses cannot escape scope', async () => {
	const input = {
		channelType: 'openai' as const,
		apiKey: secret,
		weight: 10,
		inputPrice: 2,
		outputPrice: 4,
	}
	const api = createCinaTokenApi(
		transport(() =>
			result({ success: false, message: `Rejected ${secret}` }, 400)
		)
	)
	await assert.rejects(
		api.createSharedKey(input, options),
		(error: unknown) =>
			error instanceof CinaTokenApiError &&
			error.status === 400 &&
			!error.message.includes(secret)
	)
	const controller = new AbortController()
	const late = createCinaTokenApi(
		transport(() => {
			controller.abort()
			return result({
				success: true,
				data: [],
				sellerUserId: row.sellerUserId,
				earningsCurrency: 'USD',
			})
		})
	)
	await assert.rejects(
		late.sharedKeys({ ...options, signal: controller.signal }),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
})
