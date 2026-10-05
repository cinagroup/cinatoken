import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError, accountQueryKey, createCinaTokenApi } from './api'
import type { ManagementKey } from './contracts'
import { testUser, testWorkspaceContext } from './test-fixtures'

const guardrailScope = {
	expectedWorkspaceId: 'ws-1',
	expectedUserId: 'u1',
	expectedAccountScopeKey: 'personal:u1',
}
const guardrailConflict = {
	success: false,
	code: 'guardrail_effective_conflict',
	message: 'Rules have no overlapping models',
	workspaceId: 'ws-1',
	userId: 'u1',
	accountScopeKey: 'personal:u1',
	budgetCurrency: 'CNY',
	apiKeyId: null,
	pricingCurrency: 'USD',
	trace: [],
}

test('effective Guardrail conflicts keep validated diagnostic scope without bypassing Cookie transport', async () => {
	const api = createCinaTokenApi(
		transport(async (path, init) => {
			assert.equal(path, '/api/user/guardrails/effective')
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			assert.equal(
				new Headers(init.headers).get('X-CinaToken-Workspace'),
				'ws-1'
			)
			return response(guardrailConflict, 409)
		})
	)
	assert.deepEqual(
		await api.effectiveGuardrails(null, guardrailScope),
		guardrailConflict
	)
})

test('effective Guardrail diagnostics reject another user, malformed trace and wrong context', async () => {
	for (const body of [
		{ ...guardrailConflict, userId: 'u2' },
		{ ...guardrailConflict, accountScopeKey: 'organization:foreign' },
		{ ...guardrailConflict, trace: [{ guardrailId: 'unknown' }] },
	]) {
		const api = createCinaTokenApi(transport(async () => response(body, 409)))
		await assert.rejects(
			api.effectiveGuardrails(null, guardrailScope),
			hasCode('invalid-response')
		)
	}
	const api = createCinaTokenApi(
		transport(async () =>
			response({ ...guardrailConflict, workspaceId: 'ws-2' }, 409)
		)
	)
	await assert.rejects(
		api.effectiveGuardrails(null, guardrailScope),
		hasCode('workspace-mismatch')
	)
})

test('ordinary Guardrail failures and workspace conflicts never become successful diagnostics', async () => {
	for (const status of [200, 400, 401, 403, 503]) {
		const api = createCinaTokenApi(
			transport(async () => response(guardrailConflict, status))
		)
		await assert.rejects(
			api.effectiveGuardrails(null, guardrailScope),
			hasCode(status === 200 ? 'business' : 'http', status)
		)
	}
	const api = createCinaTokenApi(
		transport(async () =>
			response({ ...guardrailConflict, code: 'workspace_mismatch' }, 409)
		)
	)
	await assert.rejects(
		api.effectiveGuardrails(null, guardrailScope),
		hasCode('workspace-mismatch', 409)
	)
	const unknown = createCinaTokenApi(
		transport(async () =>
			response({ ...guardrailConflict, code: 'unknown_conflict' }, 409)
		)
	)
	await assert.rejects(
		unknown.effectiveGuardrails(null, guardrailScope),
		hasCode('http', 409)
	)
})

test('Presets use the shared transport and validate ownership even for empty collections', async () => {
	const scope = { expectedWorkspaceId: 'ws-1', expectedOwnerUserId: 'u1' }
	const value = {
		success: true,
		data: { workspaceId: 'ws-1', ownerUserId: 'u1', presets: [] },
	}
	const api = createCinaTokenApi(
		transport(async (path, init) => {
			assert.equal(path, '/api/user/presets')
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			return response(value)
		})
	)
	assert.deepEqual(await api.presetCollection(scope), value.data)
	const wrong = createCinaTokenApi(
		transport(async () =>
			response({ ...value, data: { ...value.data, ownerUserId: 'u2' } })
		)
	)
	await assert.rejects(
		wrong.presetCollection(scope),
		hasCode('invalid-response')
	)
})

test('withdrawal recovery codes remain allowlisted without retaining arbitrary error payloads', async () => {
	for (const [serverCode, status] of [
		['withdrawal_quote_changed', 409],
		['withdrawal_dispatch_unconfirmed', 503],
	] as const) {
		const api = createCinaTokenApi(
			transport(async () =>
				response(
					{
						success: false,
						code: serverCode,
						withdrawalId: 'private-id',
						message: 'Refresh to confirm',
					},
					status
				)
			)
		)
		await assert.rejects(
			api.me(),
			(error) =>
				error instanceof CinaTokenApiError &&
				error.serverCode === serverCode &&
				error.status === status &&
				!('withdrawalId' in error)
		)
	}
})

const walletScope = {
	expectedWorkspaceId: 'ws-1',
	expectedUserId: 'u1',
	expectedOrigin: 'https://app.cinatoken.test',
}
const walletAddress = `0x${'a'.repeat(40)}`

test('Wallet uses same-origin no-store transport and rejects mismatched owner or workspace', async () => {
	const context = {
		success: true,
		userId: 'u1',
		workspaceId: 'ws-1',
		availability: 'available',
		chainId: 8453,
		data: { walletAddress: null, walletMasked: null, verifiedAt: null },
	}
	const api = createCinaTokenApi(
		transport(async (path, init) => {
			assert.equal(path, '/api/user/wallet')
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			assert.equal(
				new Headers(init.headers).get('X-CinaToken-Workspace'),
				'ws-1'
			)
			return response(context)
		})
	)
	assert.equal((await api.wallet(walletScope)).data.walletAddress, null)
	for (const [field, value, code] of [
		['userId', 'u2', 'invalid-response'],
		['workspaceId', 'ws-2', 'workspace-mismatch'],
	] as const) {
		const wrong = createCinaTokenApi(
			transport(async () => response({ ...context, [field]: value }))
		)
		await assert.rejects(wrong.wallet(walletScope), hasCode(code))
	}
})

test('Wallet challenge and signature failures preserve recovery status without retaining echoed secrets', async () => {
	const challengeToken = 'private.challenge'
	const signature = `0x${'1'.repeat(130)}`
	for (const status of [401, 409, 503]) {
		const requests: string[] = []
		const api = createCinaTokenApi(
			transport(async (path, init) => {
				requests.push(path)
				assert.equal(init.method, 'POST')
				return response(
					{
						success: false,
						code:
							status === 409 ? 'workspace_mismatch' : 'private_server_error',
						message: `${challengeToken}:${signature}`,
						challengeToken,
						signature,
					},
					status
				)
			})
		)
		const safeError = (error: unknown) =>
			error instanceof CinaTokenApiError &&
			error.status === status &&
			error.code === (status === 409 ? 'workspace-mismatch' : 'http') &&
			!error.message.includes(challengeToken) &&
			!error.message.includes(signature) &&
			!('challengeToken' in error) &&
			!('signature' in error)
		await assert.rejects(
			api.createWalletChallenge({ walletAddress }, walletScope),
			safeError
		)
		await assert.rejects(
			api.verifyWallet({ challengeToken, signature }, walletScope),
			safeError
		)
		assert.deepEqual(requests, [
			'/api/user/wallet/challenge',
			'/api/user/wallet/verify',
		])
	}
})

test('Wallet challenge validates the actual signing origin, owner and address before returning a message', async () => {
	const issuedAt = new Date().toISOString()
	const expiresAt = new Date(Date.parse(issuedAt) + 300000).toISOString()
	const origin = walletScope.expectedOrigin
	const message = `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${walletAddress}\n\nVerify ownership of this wallet for CinaToken withdrawals.\n\nURI: ${origin}\nVersion: 1\nChain ID: 8453\nNonce: ${'b'.repeat(32)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}\nRequest ID: u1`
	const challenge = {
		success: true,
		userId: 'u1',
		workspaceId: 'ws-1',
		data: {
			address: walletAddress,
			message,
			challengeToken: 'private.challenge',
			origin,
			chainId: 8453,
			issuedAt,
			expiresAt,
		},
	}
	const api = createCinaTokenApi(transport(async () => response(challenge)))
	assert.equal(
		(await api.createWalletChallenge({ walletAddress }, walletScope)).message,
		message
	)
	for (const data of [
		{ ...challenge.data, origin: 'https://foreign.test' },
		{ ...challenge.data, address: `0x${'c'.repeat(40)}` },
		{
			...challenge.data,
			message: message.replace('Request ID: u1', 'Request ID: u2'),
		},
	]) {
		const wrong = createCinaTokenApi(
			transport(async () => response({ ...challenge, data }))
		)
		await assert.rejects(
			wrong.createWalletChallenge({ walletAddress }, walletScope),
			hasCode('invalid-response')
		)
	}
})

const withdrawalContext = {
	success: true,
	userId: 'u1',
	workspaceId: 'ws-1',
	withdrawalCurrency: 'USD',
	amountUnit: 'major',
	tokenSymbol: 'CINA-C',
	tokenAmountUnit: 'major',
	policy: { minAmount: 5, fee: 1, tokenRate: 2, dailyLimit: 3 },
	availability: 'available',
	queueConfigured: true,
	chainId: 8453,
	balance: 20,
	lockedAmount: 0,
	walletAddress,
	walletVerifiedAt: '2026-09-27T00:00:00.000Z',
	activeWithdrawal: null,
	dailyRemaining: 3,
}

test('Withdrawals quote and create preserve USD major amounts, fingerprint and scoped transport', async () => {
	const fingerprint = 'd'.repeat(64)
	const methods: string[] = []
	const api = createCinaTokenApi(
		transport(async (path, init) => {
			methods.push(path)
			assert.equal(init.method, 'POST')
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			assert.equal(
				new Headers(init.headers).get('X-CinaToken-Workspace'),
				'ws-1'
			)
			if (path.endsWith('/quote')) {
				assert.deepEqual(JSON.parse(String(init.body)), { amount: 10 })
				return response({
					...withdrawalContext,
					data: {
						amount: 10,
						fee: 1,
						netAmount: 9,
						tokenAmount: 18,
						fingerprint,
					},
				})
			}
			assert.deepEqual(JSON.parse(String(init.body)), {
				amount: 10,
				expectedQuote: fingerprint,
			})
			return response(
				{
					...withdrawalContext,
					data: {
						id: 'wd1',
						userId: 'u1',
						amount: 10,
						fee: 1,
						netAmount: 9,
						currency: 'USD',
						walletAddress,
						status: 'requested',
						tokenAmount: 18,
						txHash: null,
						chainId: 8453,
						failureReason: null,
						createdAt: '2026-09-27T00:00:00.000Z',
						updatedAt: '2026-09-27T00:00:00.000Z',
						confirmedAt: null,
					},
				},
				201
			)
		})
	)
	const quote = await api.quoteWithdrawal({ amount: 10 }, walletScope)
	assert.equal(quote.data.tokenAmount, 18)
	assert.equal(
		(
			await api.createWithdrawal(
				{ amount: 10, expectedQuote: quote.data.fingerprint },
				walletScope
			)
		).status,
		'requested'
	)
	assert.deepEqual(methods, [
		'/api/user/withdrawals/quote',
		'/api/user/withdrawals',
	])
})

test('Withdrawals validate empty-page identity and never retry an unconfirmed dispatch', async () => {
	for (const value of [
		{ ...withdrawalContext, userId: 'u2' },
		{ ...withdrawalContext, workspaceId: 'ws-2' },
	]) {
		const api = createCinaTokenApi(
			transport(async () =>
				response({ ...value, data: [], total: 0, page: 1, pageSize: 20 })
			)
		)
		await assert.rejects(
			api.withdrawals(walletScope),
			hasCode(value.userId === 'u2' ? 'invalid-response' : 'workspace-mismatch')
		)
	}
	let writes = 0
	const api = createCinaTokenApi(
		transport(async () => {
			writes += 1
			return response(
				{
					success: false,
					code: 'withdrawal_dispatch_unconfirmed',
					withdrawalId: 'wd-private',
					message: 'Refresh history to confirm',
				},
				503
			)
		})
	)
	await assert.rejects(
		api.createWithdrawal(
			{ amount: 10, expectedQuote: 'd'.repeat(64) },
			walletScope
		),
		(error) =>
			error instanceof CinaTokenApiError &&
			error.serverCode === 'withdrawal_dispatch_unconfirmed' &&
			!('withdrawalId' in error)
	)
	assert.equal(writes, 1)
})

function response(body: unknown, status = 200): Response {
	return Response.json(body, { status })
}
function transport(
	handler: (path: string, init: RequestInit) => Promise<Response>
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) =>
		handler(String(input), init ?? {})) as typeof fetch
}
function hasCode(
	code: CinaTokenApiError['code'],
	status?: number
): (error: unknown) => boolean {
	return (error: unknown) =>
		error instanceof CinaTokenApiError &&
		error.code === code &&
		(status === undefined || error.status === status)
}

test('browser identity requests are same-origin, no-store and omit the legacy identity header', async () => {
	const api = createCinaTokenApi(
		transport(async (path, init) => {
			assert.equal(path, '/api/user/me')
			assert.equal(init.credentials, 'same-origin')
			assert.equal(init.cache, 'no-store')
			assert.equal(new Headers(init.headers).has('New-Api-User'), false)
			return response({ success: true, data: testUser })
		})
	)
	assert.deepEqual(await api.me(), testUser)
})

test('HTTP 200 business failures reject instead of populating a query as successful', async () => {
	const api = createCinaTokenApi(
		transport(async () =>
			response({ success: false, message: 'Budget rejected' })
		)
	)
	await assert.rejects(
		api.createGatewayKey({ limit: 10 }),
		hasCode('business', 200)
	)
})

test('unauthorized and unavailable responses remain distinguishable', async () => {
	for (const status of [401, 403, 503]) {
		const api = createCinaTokenApi(
			transport(async () => response({ success: false }, status))
		)
		await assert.rejects(api.me(), hasCode('http', status))
	}
})

test('a malformed identity cannot be trusted as a successful session', async () => {
	const api = createCinaTokenApi(
		transport(async () =>
			response({ success: true, data: { ...testUser, userId: 1 } })
		)
	)
	await assert.rejects(api.me(), hasCode('invalid-response'))
})

test('workspace context requires current workspace to be authorized', async () => {
	const context = testWorkspaceContext()
	context.workspaces = [context.workspaces[1]]
	const api = createCinaTokenApi(
		transport(async () => response({ success: true, data: context }))
	)
	await assert.rejects(api.workspaces(), hasCode('invalid-response'))
})

test('workspace selection uses PUT and the exact workspace_id contract', async () => {
	const api = createCinaTokenApi(
		transport(async (path, init) => {
			assert.equal(path, '/api/user/workspaces/current')
			assert.equal(init.method, 'PUT')
			assert.deepEqual(JSON.parse(String(init.body)), {
				workspace_id: 'workspace:team',
			})
			return response({
				success: true,
				data: testWorkspaceContext('workspace:team'),
			})
		})
	)
	assert.equal(
		(await api.switchWorkspace('workspace:team')).currentWorkspace.id,
		'workspace:team'
	)
})

test('a full credential in the masked listing endpoint fails closed', async () => {
	const api = createCinaTokenApi(
		transport(async () =>
			response({
				success: true,
				data: [
					{
						id: 'key:1',
						workspaceId: 'personal:alice',
						key: 'sk-privatecredential',
						name: null,
						status: 'active',
						limit: null,
						limitReset: null,
						expiresAt: null,
						lastUsedAt: null,
						createdAt: '',
					},
				],
			})
		)
	)
	await assert.rejects(api.gatewayKeys(), hasCode('invalid-response'))
})

test('created secret is returned once and rejected if it belongs to another workspace', async () => {
	const api = createCinaTokenApi(
		transport(async () =>
			response({
				success: true,
				data: {
					key: 'sk-0123456789abcdefghijklmnopqrstuv',
					key_id: 'key:1',
					workspace_id: 'workspace:team',
				},
			})
		)
	)
	await assert.rejects(
		api.createGatewayKey({}, { expectedWorkspaceId: 'personal:alice' }),
		hasCode('workspace-mismatch')
	)
})

test('cancellation is respected even when the transport completes after abort', async () => {
	const controller = new AbortController()
	const api = createCinaTokenApi(
		transport(async () => {
			controller.abort()
			return response({ success: true, data: testUser })
		})
	)
	await assert.rejects(
		api.me({ signal: controller.signal }),
		hasCode('cancelled')
	)
})

test('timeouts are distinct from logout-worthy authentication failures', async () => {
	const api = createCinaTokenApi(
		transport(
			(_path, init) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true }
					)
				})
		)
	)
	await assert.rejects(api.me({ timeoutMs: 1 }), hasCode('timeout'))
})

test('logout revokes every browser session via the unified endpoint', async () => {
	const api = createCinaTokenApi(
		transport(async (path, init) => {
			assert.equal(path, '/api/auth/logout')
			assert.equal(init.method, 'POST')
			return response({ success: true })
		})
	)
	await api.logout()
})

test('cache keys isolate users and workspaces without delimiter collisions', () => {
	assert.notDeepEqual(
		accountQueryKey('a:b', 'c', 'keys'),
		accountQueryKey('a', 'b:c', 'keys')
	)
	assert.notDeepEqual(
		accountQueryKey('alice', 'one', 'keys'),
		accountQueryKey('alice', 'two', 'keys')
	)
})

test('key budget currency comes from the server instead of a frontend default', async () => {
	const api = createCinaTokenApi(
		transport(async () =>
			response({
				success: true,
				data: [],
				billingCurrency: 'CNY',
				workspaceId: 'personal:alice',
			})
		)
	)
	assert.deepEqual(await api.gatewayKeyContext(), {
		keys: [],
		billingCurrency: 'CNY',
		workspaceId: 'personal:alice',
	})
})

test('missing or malformed budget currency never silently defaults to USD', async () => {
	for (const billingCurrency of [undefined, 'bad-value', 'usd']) {
		const api = createCinaTokenApi(
			transport(async () =>
				response({
					success: true,
					data: [],
					billingCurrency,
					workspaceId: 'personal:alice',
				})
			)
		)
		await assert.rejects(api.gatewayKeyContext(), hasCode('invalid-response'))
	}
})

test('gateway listings retain administratively disabled and custom inactive statuses', async () => {
	for (const status of [
		'active',
		'disabled',
		'revoked',
		'expired',
		'paused_by_support',
	]) {
		const row = {
			id: 'key:1',
			workspaceId: 'personal:alice',
			key: 'sk-test0…1234',
			name: null,
			status,
			limit: null,
			limitReset: null,
			expiresAt: null,
			lastUsedAt: null,
			createdAt: '',
		}
		const api = createCinaTokenApi(
			transport(async () => response({ success: true, data: [row] }))
		)
		assert.equal((await api.gatewayKeys())[0].status, status)
	}
})

test('a migration-era unavailable key preview remains a safe masked listing', async () => {
	const row = {
		id: 'key:1',
		workspaceId: 'personal:alice',
		key: 'sk-…',
		name: null,
		status: 'disabled',
		limit: null,
		limitReset: null,
		expiresAt: null,
		lastUsedAt: null,
		createdAt: '',
	}
	const api = createCinaTokenApi(
		transport(async () => response({ success: true, data: [row] }))
	)
	assert.equal((await api.gatewayKeys())[0].key, 'sk-…')
})

test('created credential matches the current generator and never accepts masked or shortened data', async () => {
	for (const key of ['sk-short', 'sk-test…1234', `sk-${'a'.repeat(64)}`]) {
		const api = createCinaTokenApi(
			transport(async () =>
				response({
					success: true,
					data: {
						key,
						key_id: 'key:1',
						workspace_id: 'personal:alice',
					},
				})
			)
		)
		await assert.rejects(api.createGatewayKey({}), hasCode('invalid-response'))
	}
})

test('create payloads match server finite safe micro-unit budgets and canonical future UTC expiry', async () => {
	let writes = 0
	const api = createCinaTokenApi(
		transport(async () => {
			writes += 1
			return response({
				success: true,
				data: {
					key: 'sk-0123456789abcdefghijklmnopqrstuv',
					key_id: 'key:1',
					workspace_id: 'personal:alice',
				},
			})
		})
	)
	const future = new Date(Date.now() + 86_400_000).toISOString()
	await api.createGatewayKey({ limit: 0.000001, expires_at: future })
	assert.equal(writes, 1)
	for (const limit of [Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, -1]) {
		await assert.rejects(api.createGatewayKey({ limit }))
	}
	for (const expires_at of [
		future.replace('Z', '+00:00'),
		future.replace(/\.\d{3}Z/u, 'Z'),
		new Date(Date.now() - 1000).toISOString(),
	]) {
		await assert.rejects(api.createGatewayKey({ expires_at }))
	}
	assert.equal(writes, 1)
})

test('gateway reads, creation and revocation send the encoded workspace precondition', async () => {
	const methods: string[] = []
	const api = createCinaTokenApi(
		transport(async (_path, init) => {
			assert.equal(
				new Headers(init.headers).get('X-CinaToken-Workspace'),
				'personal%3Aalice'
			)
			const method = init.method ?? 'GET'
			methods.push(method)
			if (method === 'GET')
				return response({
					success: true,
					data: [],
					workspaceId: 'personal:alice',
					billingCurrency: 'CNY',
				})
			if (method === 'POST')
				return response({
					success: true,
					data: {
						key: 'sk-0123456789abcdefghijklmnopqrstuv',
						key_id: 'key:1',
						workspace_id: 'personal:alice',
					},
				})
			return response({ success: true })
		})
	)
	const options = { expectedWorkspaceId: 'personal:alice' }
	await api.gatewayKeyContext(options)
	await api.createGatewayKey({ name: 'CI' }, options)
	await api.revokeGatewayKey('key:1', options)
	assert.deepEqual(methods, ['GET', 'POST', 'DELETE'])
})

test('empty gateway lists cannot conceal a different selected workspace', async () => {
	const api = createCinaTokenApi(
		transport(async () =>
			response({
				success: true,
				data: [],
				workspaceId: 'workspace:team',
				billingCurrency: 'USD',
			})
		)
	)
	await assert.rejects(
		api.gatewayKeyContext({ expectedWorkspaceId: 'personal:alice' }),
		hasCode('workspace-mismatch')
	)
	await assert.rejects(
		api.gatewayKeys({ expectedWorkspaceId: 'personal:alice' }),
		hasCode('workspace-mismatch')
	)
})

test('scoped gateway lists require server workspace metadata even when empty', async () => {
	const api = createCinaTokenApi(
		transport(async () =>
			response({ success: true, data: [], billingCurrency: 'USD' })
		)
	)
	await assert.rejects(
		api.gatewayKeys({ expectedWorkspaceId: 'personal:alice' }),
		hasCode('invalid-response')
	)
	await assert.rejects(api.gatewayKeyContext(), hasCode('invalid-response'))
})

test('server workspace conflicts use a distinct recoverable error without retrying writes', async () => {
	let writes = 0
	const api = createCinaTokenApi(
		transport(async () => {
			writes += 1
			return response(
				{
					success: false,
					code: 'workspace_mismatch',
					message: 'Workspace changed',
				},
				409
			)
		})
	)
	await assert.rejects(
		api.createGatewayKey({}, { expectedWorkspaceId: 'personal:alice' }),
		hasCode('workspace-mismatch', 409)
	)
	assert.equal(writes, 1)
})

const managementRow: ManagementKey = {
	id: 'management:1',
	label: 'sk-cina-…1234',
	name: 'CI',
	status: 'active',
	account_type: 'personal',
	personal_owner_user_id: 'user:alice',
	organization_id: null,
	expires_at: null,
	last_used_at: null,
	created_at: '',
	updated_at: '',
}
const managementOptions = {
	expectedWorkspaceId: 'personal:alice',
	expectedManagementAccount: {
		account_type: 'personal' as const,
		personal_owner_user_id: 'user:alice',
		organization_id: null,
	},
}

test('management listing matches the account-wide contract and includes revocation tombstones', async () => {
	const api = createCinaTokenApi(
		transport(async (path, init) => {
			assert.equal(path, '/api/user/management-keys?include_revoked=true')
			assert.equal(
				new Headers(init.headers).get('X-CinaToken-Workspace'),
				'personal%3Aalice'
			)
			return response({
				success: true,
				data: [
					managementRow,
					{ ...managementRow, id: 'revoked:1', status: 'revoked' },
				],
			})
		})
	)
	assert.equal((await api.managementKeys(managementOptions)).length, 2)
})

test('management list cannot accept a plaintext label or mismatched account shape', async () => {
	for (const row of [
		{ ...managementRow, label: `sk-cina-mgmt-${'a'.repeat(64)}` },
		{ ...managementRow, organization_id: 'org:other' },
	]) {
		const api = createCinaTokenApi(
			transport(async () => response({ success: true, data: [row] }))
		)
		await assert.rejects(
			api.managementKeys(managementOptions),
			hasCode('invalid-response')
		)
	}
})

test('management response account identity is checked against the requested context', async () => {
	const api = createCinaTokenApi(
		transport(async () =>
			response({
				success: true,
				data: [
					{
						...managementRow,
						account_type: 'organization',
						personal_owner_user_id: null,
						organization_id: 'org:other',
					},
				],
			})
		)
	)
	await assert.rejects(
		api.managementKeys(managementOptions),
		hasCode('workspace-mismatch')
	)
})

test('management creation reads the once-only top-level secret and revocation is scoped', async () => {
	const secret = `sk-cina-mgmt-${'a'.repeat(64)}`
	const methods: string[] = []
	const api = createCinaTokenApi(
		transport(async (path, init) => {
			assert.equal(
				new Headers(init.headers).get('X-CinaToken-Workspace'),
				'personal%3Aalice'
			)
			methods.push(init.method ?? 'GET')
			if (init.method === 'POST') {
				assert.equal(path, '/api/user/management-keys')
				assert.deepEqual(JSON.parse(String(init.body)), { name: 'CI' })
				return response(
					{ success: true, data: managementRow, key: secret },
					201
				)
			}
			assert.equal(path, '/api/user/management-keys/management%3A1')
			return response({ success: true })
		})
	)
	assert.deepEqual(
		await api.createManagementKey({ name: '  CI  ' }, managementOptions),
		{ data: managementRow, key: secret }
	)
	await api.revokeManagementKey(managementRow.id, managementOptions)
	assert.deepEqual(methods, ['POST', 'DELETE'])
})

test('management creation rejects missing, malformed and gateway-purpose credentials', async () => {
	for (const key of [
		undefined,
		'sk-short',
		'sk-0123456789abcdefghijklmnopqrstuv',
		'sk-cina-…1234',
	]) {
		const api = createCinaTokenApi(
			transport(async () =>
				response({ success: true, data: managementRow, key }, 201)
			)
		)
		await assert.rejects(
			api.createManagementKey({ name: 'CI' }, managementOptions),
			hasCode('invalid-response')
		)
	}
})

test('management input validation rejects unsupported names and expiries before issuing writes', async () => {
	let writes = 0
	const api = createCinaTokenApi(
		transport(async () => {
			writes += 1
			return response({ success: true })
		})
	)
	for (const input of [
		{ name: '' },
		{ name: 'x'.repeat(129) },
		{ name: 'CI', expires_at: '2020-01-01T00:00:00.000Z' },
	]) {
		await assert.rejects(api.createManagementKey(input, managementOptions))
	}
	assert.equal(writes, 0)
})
