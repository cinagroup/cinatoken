/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdminSharedKeysApi } from './shared-key-api'
import {
	acknowledgeSharedKeyRecovery,
	inspectSharedKeyRecovery,
	SharedKeyManualRecoveryError,
} from './shared-key-manual-recovery'
import { AdminSharedKeyWriteRecovery } from './shared-key-recovery'

const identity = JSON.stringify(['operator', 'shared-qa/ops team%2F', 1])
const bound = { expectedConsoleSubject: 'shared-qa/ops team%2F' }
const row = {
	id: 'shared-1',
	sellerUserId: 'seller-1',
	sellerEmail: null,
	channelType: 'openai',
	label: null,
	status: 'active',
	sellerPriority: 5,
	weight: 30,
	inputPrice: 1,
	outputPrice: 2,
	cacheReadPrice: null,
	cacheWritePrice: null,
	validatedAt: null,
	lastUsedAt: null,
	lastFailureAt: null,
	createdAt: '2026-09-30T00:00:00.000Z',
	updatedAt: '2026-09-30T00:00:00.000Z',
	servedInputTokens: 0,
	servedOutputTokens: 0,
	earnedTotal: 0,
	apiKeyMasked: '••••••••',
	failureCode: null,
	profile_revision: 'sha256:' + 'a'.repeat(64),
	quoteCurrency: null,
	quoteCurrencyAvailability: 'legacy_unrecorded',
	quoteUnit: 'per_million_tokens',
	earningsCurrency: 'USD',
	earningsAmountUnit: 'major',
	statisticsBasis: 'legacy_cached_projection',
}
const capabilities = {
	can_write: true,
	user_detail: true,
	request_logs: true,
	can_review_earnings: true,
}
const reference = {
	currentBillingCurrency: null,
	currentBillingCurrencySource: 'missing',
	currentBillingCurrencyReferenceOnly: true,
}
function fixture(operation: 'governance' | 'review' = 'governance') {
	const values = new Map<string, string>()
	const tab = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value)
		},
		removeItem: (key: string) => {
			values.delete(key)
		},
	}
	const store = new AdminSharedKeyWriteRecovery(operation, tab, true)
	const marker =
		operation === 'governance'
			? store.markPending(identity, {
					kind: 'governance',
					operation: 'delete',
					keyId: row.id,
				})
			: store.markPending(identity, {
					kind: 'review',
					operation: 'apply-review',
					since: '2026-09-30T00:00:00.000Z',
					limit: 20,
				})
	const calls: Array<{ path: string; init: RequestInit }> = []
	const state = {
		subject: bound.expectedConsoleSubject,
		detailStatus: 200,
		auditStatus: 200,
		overviewStatus: 200,
		canWrite: true,
		canReview: true,
		wrongId: false,
		wrongAudit: false,
		malformedOverview: false,
		reviewMalformed: false,
		reviewStatus: 200,
	}
	let delay: ((path: string) => Promise<void>) | null = null
	const api = createAdminSharedKeysApi(async (path, init) => {
		calls.push({ path: String(path), init: init ?? {} })
		await delay?.(String(path))
		if (path === '/api/auth/check')
			return Response.json({
				authenticated: true,
				verification: 'verified',
				principalType: 'console',
				subject: state.subject,
			})
		if (String(path).startsWith('/api/admin/shared-keys/overview'))
			return Response.json(
				{
					success: true,
					data: {
						items: [],
						total: 0,
						page: 1,
						page_size: 20,
						hasMore: false,
						...reference,
						capabilities: state.malformedOverview
							? null
							: {
									...capabilities,
									can_write: state.canWrite,
									can_review_earnings: state.canReview,
								},
					},
				},
				{ status: state.overviewStatus }
			)
		if (String(path).endsWith('/detail'))
			return Response.json(
				state.detailStatus === 200
					? {
							success: true,
							data: {
								...row,
								id: state.wrongId ? 'shared-other' : row.id,
								...reference,
								capabilities,
								apiKey: 'PRIVATE',
								fingerprint: 'PRIVATE',
							},
						}
					: { success: false, message: 'PRIVATE' },
				{ status: state.detailStatus }
			)
		if (String(path).includes('/audit?'))
			return Response.json(
				state.auditStatus === 200
					? {
							success: true,
							data: {
								entries: state.wrongAudit ? [{ id: 'wrong' }] : [],
								next_cursor: null,
								page_size: 20,
							},
						}
					: { success: false, message: 'PRIVATE' },
				{ status: state.auditStatus }
			)
		if (String(path).startsWith('/api/admin/earnings/rederive')) {
			const params = new URL(String(path), 'http://local.test').searchParams
			assert.equal(params.get('apply'), '0')
			const data = {
				windowSince: params.get('since'),
				scanned: 0,
				windowTotal: 0,
				scanComplete: true,
				candidates: 0,
				reviewRequired: 0,
				candidateLogIds: [],
				reviewOnly: true,
				balancesChanged: false,
				queued: false,
				range: {
					since: params.get('since'),
					limit: Number(params.get('limit')),
					page: 1,
				},
				reviewScope: 'first_page_since',
				evidenceRequirement: 'original_price_commission_owner',
			}
			return Response.json(
				{
					success: true,
					dryRun: true,
					data: state.reviewMalformed
						? { ...data, balancesChanged: true }
						: data,
				},
				{ status: state.reviewStatus }
			)
		}
		throw new Error('Unexpected operation')
	})
	return {
		api,
		store,
		marker,
		state,
		calls,
		values,
		setDelay(value: typeof delay) {
			delay = value
		},
	}
}
const manualFailure = (error: unknown) =>
	error instanceof SharedKeyManualRecoveryError

test('manual governance reads uncached exact-ID evidence, acknowledges uncertainty, and never replays a write', async () => {
	const f = fixture()
	const evidence = await inspectSharedKeyRecovery(f.api, f.marker, bound)
	assert.equal(evidence.kind, 'governance')
	if (evidence.kind !== 'governance') assert.fail()
	assert.equal(evidence.row?.id, row.id)
	assert.equal(JSON.stringify(evidence).includes('PRIVATE'), false)
	assert.equal(f.store.status(identity), 'pending')
	await assert.rejects(
		acknowledgeSharedKeyRecovery(
			f.api,
			f.store,
			identity,
			evidence,
			false,
			bound
		)
	)
	await acknowledgeSharedKeyRecovery(
		f.api,
		f.store,
		identity,
		evidence,
		true,
		bound
	)
	assert.equal(f.store.status(identity), 'ready')
	for (const call of f.calls) {
		assert.equal(call.init.cache, 'no-store')
		assert.equal(call.init.credentials, 'same-origin')
		assert.equal(call.init.method ?? 'GET', 'GET')
		assert.equal(new Headers(call.init.headers).has('Authorization'), false)
	}
	assert.ok(
		f.calls.some(
			(call) => call.path === '/api/admin/shared-keys/shared-1/detail'
		)
	)
	assert.equal(
		f.calls.filter((call) => call.path === '/api/auth/check').length,
		3
	)
})

test('absent exact key plus safe empty audit permits only a fresh review, and never claims the old delete succeeded', async () => {
	const f = fixture()
	f.state.detailStatus = 404
	const evidence = await inspectSharedKeyRecovery(f.api, f.marker, bound)
	assert.equal(evidence.kind, 'governance')
	if (evidence.kind !== 'governance') assert.fail()
	assert.equal(evidence.row, null)
	assert.equal(evidence.audit.entries.length, 0)
	await acknowledgeSharedKeyRecovery(
		f.api,
		f.store,
		identity,
		evidence,
		true,
		bound
	)
	assert.equal(f.store.status(identity), 'ready')
	assert.equal('deleted' in evidence, false)
})

test('detail, audit, capability and malformed evidence failures cannot unlock a marker', async () => {
	for (const mode of [
		'detail403',
		'audit403',
		'auditMalformed',
		'wrongId',
		'overview403',
		'overview401',
		'overviewMalformed',
		'capFalse',
	]) {
		const f = fixture()
		if (mode === 'detail403') f.state.detailStatus = 403
		if (mode === 'audit403') f.state.auditStatus = 403
		if (mode === 'auditMalformed') f.state.wrongAudit = true
		if (mode === 'wrongId') f.state.wrongId = true
		if (mode === 'overview403') f.state.overviewStatus = 403
		if (mode === 'overview401') f.state.overviewStatus = 401
		if (mode === 'overviewMalformed') f.state.malformedOverview = true
		if (mode === 'capFalse') {
			f.state.detailStatus = 404
			f.state.canWrite = false
		}
		await assert.rejects(
			inspectSharedKeyRecovery(f.api, f.marker, bound),
			manualFailure
		)
		assert.equal(f.store.status(identity), 'pending', mode)
	}
})
test('overview read denial is distinct from a revoked write capability for page cleanup', async () => {
	const read = fixture()
	read.state.overviewStatus = 403
	await assert.rejects(
		inspectSharedKeyRecovery(read.api, read.marker, bound),
		(error: unknown) =>
			error instanceof SharedKeyManualRecoveryError &&
			error.stage === 'detail' &&
			error.status === 403
	)
	const write = fixture()
	write.state.canWrite = false
	await assert.rejects(
		inspectSharedKeyRecovery(write.api, write.marker, bound),
		(error: unknown) =>
			error instanceof SharedKeyManualRecoveryError &&
			error.stage === 'subject' &&
			error.status === 403
	)
})

test('subject mismatch before inspection sends no evidence request and mismatch at acknowledgment leaves persistence untouched', async () => {
	const f = fixture()
	f.state.subject = 'other-subject'
	await assert.rejects(
		inspectSharedKeyRecovery(f.api, f.marker, bound),
		manualFailure
	)
	assert.deepEqual(
		f.calls.map((call) => call.path),
		['/api/auth/check']
	)
	f.state.subject = bound.expectedConsoleSubject
	const evidence = await inspectSharedKeyRecovery(f.api, f.marker, bound)
	const previous = [...f.values.entries()]
	f.state.subject = 'other-subject'
	await assert.rejects(
		acknowledgeSharedKeyRecovery(
			f.api,
			f.store,
			identity,
			evidence,
			true,
			bound
		),
		manualFailure
	)
	assert.deepEqual([...f.values.entries()], previous)
})

test('capability loss or malformed recheck at acknowledgment retains the captured safety marker', async () => {
	for (const mode of ['false', 'malformed', 'denied']) {
		const f = fixture()
		f.state.detailStatus = 404
		const evidence = await inspectSharedKeyRecovery(f.api, f.marker, bound)
		if (mode === 'false') f.state.canWrite = false
		if (mode === 'malformed') f.state.malformedOverview = true
		if (mode === 'denied') f.state.overviewStatus = 401
		await assert.rejects(
			acknowledgeSharedKeyRecovery(
				f.api,
				f.store,
				identity,
				evidence,
				true,
				bound
			),
			manualFailure
		)
		assert.equal(f.store.status(identity), 'pending')
	}
})

test('cancelled late inspection and acknowledgement cannot reveal evidence or clear persistence', async () => {
	const f = fixture()
	const controller = new AbortController()
	f.setDelay(async (path) => {
		if (path.endsWith('/detail')) controller.abort()
	})
	await assert.rejects(
		inspectSharedKeyRecovery(f.api, f.marker, {
			...bound,
			signal: controller.signal,
		}),
		manualFailure
	)
	assert.equal(
		f.calls.some((call) => call.path.includes('/audit?')),
		false
	)
	f.setDelay(null)
	const evidence = await inspectSharedKeyRecovery(f.api, f.marker, bound)
	const ack = new AbortController()
	f.setDelay(async (path) => {
		if (path === '/api/auth/check') ack.abort()
	})
	await assert.rejects(
		acknowledgeSharedKeyRecovery(f.api, f.store, identity, evidence, true, {
			...bound,
			signal: ack.signal,
		}),
		manualFailure
	)
	assert.equal(f.store.status(identity), 'pending')
})

test('a newer generation cannot be cleared by old inspected evidence after reauthentication', async () => {
	const f = fixture()
	const evidence = await inspectSharedKeyRecovery(f.api, f.marker, bound)
	f.store.acknowledgeUnknown(identity, f.marker)
	const next = f.store.markPending(identity, {
		kind: 'governance',
		keyId: 'shared-2',
		operation: 'edit',
	})
	await assert.rejects(
		acknowledgeSharedKeyRecovery(
			f.api,
			f.store,
			identity,
			evidence,
			true,
			bound
		),
		manualFailure
	)
	assert.deepEqual(f.store.marker(identity), next)
})

test('review recovery discovers only the captured UTC range and never repeats the original apply request', async () => {
	const f = fixture('review')
	const evidence = await inspectSharedKeyRecovery(f.api, f.marker, bound)
	assert.equal(evidence.kind, 'review')
	await acknowledgeSharedKeyRecovery(
		f.api,
		f.store,
		identity,
		evidence,
		true,
		bound
	)
	assert.equal(f.store.status(identity), 'ready')
	const posts = f.calls.filter((call) => call.init.method === 'POST')
	assert.equal(posts.length, 1)
	const params = new URL(posts[0].path, 'http://local.test').searchParams
	assert.equal(params.get('apply'), '0')
	assert.equal(params.get('since'), '2026-09-30T00:00:00.000Z')
	assert.equal(params.get('limit'), '20')
	assert.equal(
		new Headers(posts[0].init.headers).get(
			'X-CinaToken-Expected-Console-Subject'
		),
		encodeURIComponent(bound.expectedConsoleSubject)
	)
})

test('review malformed discovery, denied read, or revoked review capability cannot clear an unknown apply marker', async () => {
	for (const mode of ['malformed', 'denied', 'capFalse']) {
		const f = fixture('review')
		if (mode === 'malformed') f.state.reviewMalformed = true
		if (mode === 'denied') f.state.reviewStatus = 403
		if (mode === 'capFalse') {
			const evidence = await inspectSharedKeyRecovery(f.api, f.marker, bound)
			f.state.canReview = false
			await assert.rejects(
				acknowledgeSharedKeyRecovery(
					f.api,
					f.store,
					identity,
					evidence,
					true,
					bound
				),
				manualFailure
			)
		} else
			await assert.rejects(
				inspectSharedKeyRecovery(f.api, f.marker, bound),
				manualFailure
			)
		assert.equal(f.store.status(identity), 'pending')
	}
})
