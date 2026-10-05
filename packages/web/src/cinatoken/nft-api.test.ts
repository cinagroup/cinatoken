import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenApi } from './api'
import {
	canRequestNft,
	hasPendingNft,
	nftTiersResponseSchema,
	nftTransactionUrl,
	type NftMint,
} from './nft-contracts'

const scope = {
	expectedUserId: 'seller-1',
	expectedWorkspaceId: 'org-workspace',
}
const mint: NftMint = {
	id: 'mint-1',
	userId: 'seller-1',
	badgeTokenId: 105,
	tierName: 'Bronze',
	walletAddress: `0x${'1'.repeat(40)}`,
	status: 'pending',
	txHash: null,
	chainId: null,
	valueSnapshot: 25.123456,
	failureReason: null,
	createdAt: '2026-09-27T00:00:00.000Z',
	confirmedAt: null,
}
const tier = {
	badgeTokenId: 105,
	tierName: 'Bronze',
	threshold: 10,
	eligible: true,
	minted: false,
	progress: 1,
}
const snapshot = {
	success: true as const,
	sellerUserId: 'seller-1',
	workspaceId: 'org-workspace',
	contributionCurrency: 'USD' as const,
	amountUnit: 'major' as const,
	availability: 'available' as const,
	data: {
		contributionValue: 25.123456,
		highestBadgeTier: 0,
		tiers: [tier],
		mints: [] as NftMint[],
		chainConfigured: true,
		walletBound: true,
	},
}
function fixture(body: unknown = snapshot, status = 200) {
	const calls: { path: string; init: RequestInit }[] = []
	const api = createCinaTokenApi(async (path, init = {}) => {
		calls.push({ path: String(path), init })
		return Response.json(body, { status })
	})
	return { api, calls }
}
test('NFT eligibility carries exact personal owner, workspace, net USD and decimal contribution', async () => {
	const { api, calls } = fixture()
	const result = await api.nftTiers(scope)
	assert.equal(result.data.contributionValue, 25.123456)
	assert.equal(result.contributionCurrency, 'USD')
	assert.equal(result.sellerUserId, scope.expectedUserId)
	assert.equal(calls[0].path, '/api/user/nft/tiers')
	const headers = new Headers(calls[0].init.headers)
	assert.equal(
		headers.get('X-CinaToken-Workspace'),
		encodeURIComponent(scope.expectedWorkspaceId)
	)
	assert.equal(headers.get('Accept'), 'application/json')
	assert.equal(calls[0].init.credentials, 'same-origin')
	assert.equal(calls[0].init.cache, 'no-store')
	for (const name of ['Authorization', 'X-User-Id', 'X-API-Key'])
		assert.equal(headers.has(name), false)
})
test('empty tier/history pages cannot silently change asset owner or workspace', async () => {
	await assert.rejects(
		fixture({ ...snapshot, sellerUserId: 'other' }).api.nftTiers(scope),
		/owner/
	)
	await assert.rejects(
		fixture({ ...snapshot, workspaceId: 'other' }).api.nftTiers(scope),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'workspace-mismatch'
	)
	const history = { ...snapshot, data: [] }
	assert.deepEqual((await fixture(history).api.nftMints(scope)).data, [])
	await assert.rejects(
		fixture({ ...history, sellerUserId: 'other' }).api.nftMints(scope),
		/owner/
	)
})
test('foreign user history, duplicate rows and duplicate tiers are rejected', async () => {
	await assert.rejects(
		fixture({
			...snapshot,
			data: { ...snapshot.data, mints: [{ ...mint, userId: 'other' }] },
		}).api.nftTiers(scope),
		/owner/
	)
	await assert.rejects(
		fixture({
			...snapshot,
			data: { ...snapshot.data, mints: [mint, mint] },
		}).api.nftTiers(scope),
		/duplicate/
	)
	await assert.rejects(
		fixture({
			...snapshot,
			data: { ...snapshot.data, tiers: [tier, tier] },
		}).api.nftTiers(scope),
		/duplicate/
	)
})
test('mint submission sends only selected numeric tier with scope/cancellation, never wallet or user selectors', async () => {
	const { api, calls } = fixture({ ...snapshot, data: mint })
	const controller = new AbortController()
	const result = await api.mintNft(
		{ badgeTokenId: 105 },
		{ ...scope, signal: controller.signal }
	)
	assert.equal(result.data?.status, 'pending')
	assert.equal(calls[0].path, '/api/user/nft/mint')
	assert.equal(calls[0].init.method, 'POST')
	assert.equal(calls[0].init.body, '{"badgeTokenId":105}')
	assert.equal(calls[0].init.signal?.aborted, false)
	assert.equal(
		new Headers(calls[0].init.headers).get('X-CinaToken-Workspace'),
		encodeURIComponent(scope.expectedWorkspaceId)
	)
})
test('invalid tier inputs fail before transport and a different returned owner/tier fails verification', async () => {
	const fixtureApi = fixture({ ...snapshot, data: mint })
	for (const badgeTokenId of [-1, 0.1, Infinity, NaN])
		await assert.rejects(fixtureApi.api.mintNft({ badgeTokenId }, scope))
	assert.equal(fixtureApi.calls.length, 0)
	await assert.rejects(
		fixture({ ...snapshot, data: { ...mint, badgeTokenId: 106 } }).api.mintNft(
			{ badgeTokenId: 105 },
			scope
		),
		/tier/
	)
	await assert.rejects(
		fixture({ ...snapshot, sellerUserId: 'other', data: mint }).api.mintNft(
			{ badgeTokenId: 105 },
			scope
		),
		/owner/
	)
})
test('accepted mint with no immediate ledger row remains an accepted request, never a fake confirmed record', async () => {
	assert.equal(
		(
			await fixture({ ...snapshot, data: null }).api.mintNft(
				{ badgeTokenId: 105 },
				scope
			)
		).data,
		null
	)
})
test('public transport preserves 401/403/duplicate 409 and distinguishes workspace 409 without replaying a mint', async () => {
	for (const status of [401, 403, 409, 503]) {
		const f = fixture({ success: false, message: 'Rejected' }, status)
		await assert.rejects(
			f.api.mintNft({ badgeTokenId: 105 }, scope),
			(error: unknown) =>
				error instanceof CinaTokenApiError &&
				error.status === status &&
				error.code === 'http'
		)
		assert.equal(f.calls.length, 1)
	}
	const f = fixture(
		{ success: false, code: 'workspace_mismatch', message: 'Changed' },
		409
	)
	await assert.rejects(
		f.api.nftTiers(scope),
		(error: unknown) =>
			error instanceof CinaTokenApiError &&
			error.status === 409 &&
			error.code === 'workspace-mismatch' &&
			error.serverCode === 'workspace_mismatch'
	)
	assert.equal(f.calls.length, 1)
})
test('public transport cancellation rejects a late mint reply and never replays the write', async () => {
	let resolve: (response: Response) => void = () => undefined
	let calls = 0
	let requestSignal: AbortSignal | null | undefined
	const api = createCinaTokenApi(async (_path, init) => {
		calls++
		requestSignal = init?.signal
		return new Promise<Response>((done) => {
			resolve = done
		})
	})
	const controller = new AbortController()
	const result = api.mintNft(
		{ badgeTokenId: 105 },
		{ ...scope, signal: controller.signal }
	)
	controller.abort()
	assert.equal(requestSignal?.aborted, true)
	resolve(Response.json({ ...snapshot, data: mint }))
	await assert.rejects(
		result,
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
	assert.equal(calls, 1)
})
test('chain, wallet, availability, eligibility and existing failed/active history all prevent duplicate requests', () => {
	assert.equal(canRequestNft(snapshot, tier), true)
	assert.equal(
		canRequestNft({ ...snapshot, availability: 'unavailable' }, tier),
		false
	)
	for (const change of [
		{ chainConfigured: false },
		{ walletBound: false },
		{ mints: [mint] },
		{ mints: [{ ...mint, status: 'failed' as const }] },
	])
		assert.equal(
			canRequestNft(
				{ ...snapshot, data: { ...snapshot.data, ...change } },
				tier
			),
			false
		)
	assert.equal(canRequestNft(snapshot, { ...tier, eligible: false }), false)
	assert.equal(canRequestNft(snapshot, { ...tier, minted: true }), false)
})
test('only active chain states request polling; terminal states stop', () => {
	for (const status of ['pending', 'processing', 'submitted'] as const)
		assert.equal(hasPendingNft([{ ...mint, status }]), true)
	for (const status of ['confirmed', 'failed'] as const)
		assert.equal(hasPendingNft([{ ...mint, status }]), false)
	assert.equal(hasPendingNft([]), false)
})
test('transaction URLs require the supported chain and a validated hash', () => {
	const txHash = `0x${'a'.repeat(64)}`
	assert.equal(
		nftTransactionUrl({ chainId: 84532, txHash }),
		`https://sepolia.basescan.org/tx/${txHash}`
	)
	for (const chainId of [null, 1, 8453])
		assert.equal(nftTransactionUrl({ chainId, txHash }), null)
	for (const txHash of [null, 'javascript:alert(1)', '../../evil', '0xabc'])
		assert.equal(nftTransactionUrl({ chainId: 84532, txHash }), null)
})
test('unavailable ledger is explicit and money/unknown statuses do not silently coerce', () => {
	assert.equal(
		nftTiersResponseSchema.parse({ ...snapshot, availability: 'unavailable' })
			.availability,
		'unavailable'
	)
	assert.equal(
		nftTiersResponseSchema.safeParse({
			...snapshot,
			contributionCurrency: 'CNY',
		}).success,
		false
	)
	assert.equal(
		nftTiersResponseSchema.safeParse({
			...snapshot,
			data: { ...snapshot.data, contributionValue: '25' },
		}).success,
		false
	)
	assert.equal(
		nftTiersResponseSchema.safeParse({
			...snapshot,
			data: { ...snapshot.data, mints: [{ ...mint, status: 'unknown' }] },
		}).success,
		false
	)
})
