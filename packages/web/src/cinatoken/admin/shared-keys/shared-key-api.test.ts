/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError } from '../../api'
import {
	createAdminSharedKeysApi,
	AdminSharedKeyConflictError,
} from './shared-key-api'
import { adminSharedKeyRowSchema } from './shared-key-contracts'
import { AdminSharedKeyInputError } from './shared-key-errors'
import {
	adminSharedKeyEditInput,
	adminSharedKeyConfirmationInput,
} from './shared-key-input'
import {
	validateAdminSharedKeySearch,
	validateAdminSharedKeyRouteSearch,
	adminSharedKeyListPath,
} from './shared-key-search'

const sharedKeyWireRow = {
	id: 'shared-1',
	sellerUserId: 'seller-1',
	sellerEmail: 'seller@example.test',
	channelType: 'openai',
	label: 'Seller key',
	status: 'active',
	sellerPriority: 5,
	weight: 30,
	inputPrice: 0.12,
	outputPrice: 0.23,
	cacheReadPrice: 0.01,
	cacheWritePrice: null,
	validatedAt: '2026-09-29 00:00:00',
	lastUsedAt: null,
	lastFailureAt: null,
	createdAt: '2026-09-29T00:00:00.000Z',
	updatedAt: '2026-09-29 00:00:00.123456',
	servedInputTokens: 100,
	servedOutputTokens: 200,
	earnedTotal: 0.012,
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
const sharedKeyCapabilities = {
	can_write: true,
	user_detail: true,
	request_logs: true,
	can_review_earnings: true,
}
const reference = {
	currentBillingCurrency: 'CNY',
	currentBillingCurrencySource: 'configured',
	currentBillingCurrencyReferenceOnly: true,
}
const row = adminSharedKeyRowSchema.parse(sharedKeyWireRow)
const search = validateAdminSharedKeySearch({})

test('overview honors server page-bound hasMore across separately observed count and short pages', async () => {
	const items = Array.from({ length: 4 }, (_, index) => ({
		...sharedKeyWireRow,
		id: 'shared-' + index,
	}))
	const api = fixture(() =>
		overview(items, { page: 2, total: 25, hasMore: false })
	).api
	const page = await api.adminSharedKeyList({ ...search, page: 2 })
	assert.equal(page.items.length, 4)
	assert.equal(page.hasMore, false)
	assert.equal(page.total, 25)
	const changedCount = await fixture(() =>
		overview([sharedKeyWireRow], { total: 0, hasMore: false })
	).api.adminSharedKeyList(search)
	assert.equal(changedCount.items.length, 1)
	assert.equal(changedCount.total, 0)
})

test('reference currency accepts any configured code and cannot label missing or invalid legacy prices', async () => {
	const api = fixture(() =>
		overview([sharedKeyWireRow], { currentBillingCurrency: 'EUR' })
	).api
	const page = await api.adminSharedKeyList(search)
	assert.equal(page.currentBillingCurrency, 'EUR')
	assert.equal(page.items[0].quoteCurrency, null)
	assert.equal(page.items[0].earningsCurrency, 'USD')
	for (const extra of [
		{
			currentBillingCurrency: null,
			currentBillingCurrencySource: 'configured',
		},
		{ currentBillingCurrency: 'EUR', currentBillingCurrencySource: 'missing' },
		{ currentBillingCurrency: 'eur' },
		{ currentBillingCurrency: 'EURO' },
	]) {
		await assert.rejects(
			fixture(() => overview([sharedKeyWireRow], extra)).api.adminSharedKeyList(
				search
			)
		)
	}
	for (const seller_user_id of ['owner\u202e', '\ud800', ' owner '])
		assert.throws(() => validateAdminSharedKeySearch({ seller_user_id }))
})
function overview(items: unknown[] = [sharedKeyWireRow], extra: object = {}) {
	return Response.json({
		success: true,
		data: {
			items,
			total: items.length,
			page: 1,
			page_size: 20,
			hasMore: false,
			...reference,
			capabilities: sharedKeyCapabilities,
			...extra,
		},
	})
}
function fixture(
	reply: (path: string, init: RequestInit) => Response | Promise<Response>
) {
	const calls: { path: string; init: RequestInit }[] = []
	const authCalls: string[] = []
	const request: typeof fetch = async (path, init) => {
		if (String(path) === '/api/auth/check') {
			authCalls.push(String(path))
			return Response.json({
				authenticated: true,
				verification: 'verified',
				principalType: 'console',
				subject: 'cinaauth:shared-qa',
			})
		}
		const call = { path: String(path), init: init ?? {} }
		calls.push(call)
		return reply(call.path, call.init)
	}
	const original = createAdminSharedKeysApi(request)
	const bound = { expectedConsoleSubject: 'cinaauth:shared-qa' }
	const api = {
		...original,
		patchAdminSharedKey: (
			row: Parameters<typeof original.patchAdminSharedKey>[0],
			input: Parameters<typeof original.patchAdminSharedKey>[1],
			options = bound
		) => original.patchAdminSharedKey(row, input, options),
		deleteAdminSharedKey: (
			row: Parameters<typeof original.deleteAdminSharedKey>[0],
			reason: string,
			options = bound
		) => original.deleteAdminSharedKey(row, reason, options),
	}
	return { api, calls, authCalls }
}
const invalid = (error: unknown) =>
	error instanceof CinaTokenApiError && error.code === 'invalid-response'
test('applied mutations require a real lowercase UUID audit acknowledgment; malformed success stays unknown', async () => {
	for (const auditId of [
		'audit-1',
		'PRIVATE',
		'11111111-1111-4111-8111-11111111111',
		'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
	]) {
		const response = fixture(() =>
			Response.json({
				success: true,
				data: { id: row.id, outcome: 'applied', auditId },
			})
		)
		await assert.rejects(
			response.api.patchAdminSharedKey(row, {
				expected_revision: row.profile_revision,
				reason: 'Reviewed current key',
				weight: 31,
			}),
			invalid
		)
		assert.equal(response.calls.length, 1)
		await assert.rejects(
			fixture(() =>
				Response.json({
					success: true,
					data: { id: row.id, deleted: true, auditId },
				})
			).api.deleteAdminSharedKey(row, 'Reviewed current key'),
			invalid
		)
	}
})
test('initial filters use the approved overview path; invalid explicit filters never broaden a request', () => {
	assert.equal(
		validateAdminSharedKeySearch({ search: 'x'.repeat(200) }).search.length,
		200
	)
	const filtered = validateAdminSharedKeySearch({
		page: '2',
		status: 'paused',
		channelType: 'deepseek',
		seller_user_id: 'seller-1',
		search: 'team',
	})
	assert.equal(
		adminSharedKeyListPath(filtered),
		'/api/admin/shared-keys/overview?page=2&page_size=20&status=paused&channelType=deepseek&seller_user_id=seller-1&search=team'
	)
	for (const input of [
		{ status: 'unknown' },
		{ channelType: 'unknown' },
		{ seller_user_id: 'a/b' },
		{ seller_user_id: 'a'.repeat(256) },
		{ search: 'a\nb' },
		{ search: 'a\u202e' },
		{ search: 'a'.repeat(201) },
		{ page: 0 },
		{ search: ['a', 'b'] },
		{ sort: 'id' },
	]) {
		assert.throws(() => validateAdminSharedKeySearch(input))
		assert.equal(validateAdminSharedKeyRouteSearch(input).invalidFilter, true)
	}
})
test('ordinary overview strips raw secrets, fingerprints and failures and keeps historical price currency separate', async () => {
	const { api, calls } = fixture(() =>
		overview([
			{
				...sharedKeyWireRow,
				apiKey: 'PRIVATE',
				keyFingerprint: 'PRIVATE',
				failureReason: 'Bearer PRIVATE',
				earnedTotalExact: 'PRIVATE',
				future_secret: 'PRIVATE',
			},
		])
	)
	const page = await api.adminSharedKeyList(search)
	assert.equal(JSON.stringify(page).includes('PRIVATE'), false)
	assert.equal(page.items[0]?.quoteCurrency, null)
	assert.equal(page.items[0]?.earningsCurrency, 'USD')
	assert.equal(page.currentBillingCurrency, 'CNY')
	assert.equal(page.items[0]?.updatedAt, '2026-09-29T00:00:00.123Z')
	assert.equal(calls[0]?.init.cache, 'no-store')
	assert.equal(calls[0]?.init.credentials, 'same-origin')
	for (const header of [
		'Authorization',
		'New-Api-User',
		'X-CinaToken-Workspace',
	])
		assert.equal(new Headers(calls[0]?.init.headers).get(header), null)
})
test('bad mask, raw failure enum, money, date, capabilities or pagination cannot enter the safe list', async () => {
	for (const change of [
		{ apiKeyMasked: 'sk-private' },
		{ failureCode: 'Bearer PRIVATE' },
		{ inputPrice: -1 },
		{ earnedTotal: Number.POSITIVE_INFINITY },
		{ createdAt: '2026-02-30 00:00:00' },
		{ id: 'bad/id' },
		{ sellerPriority: 2_147_483_648 },
		{ weight: 0 },
		{ earningsCurrency: 'CNY' },
		{ quoteCurrency: 'USD' },
	])
		await assert.rejects(
			fixture(() =>
				overview([{ ...sharedKeyWireRow, ...change }])
			).api.adminSharedKeyList(search),
			invalid
		)
	for (const extra of [
		{ page: 2 },
		{ page_size: 100 },
		{ hasMore: true },
		{ capabilities: { ...sharedKeyCapabilities, can_write: 'true' } },
	])
		await assert.rejects(
			fixture(() => overview(undefined, extra)).api.adminSharedKeyList(search),
			invalid
		)
	await assert.rejects(
		fixture(() =>
			overview([sharedKeyWireRow, sharedKeyWireRow])
		).api.adminSharedKeyList(search),
		invalid
	)
})
test('explicit detail verifies exact key, seller and channel and ignores aborted late reads', async () => {
	for (const changed of [
		{ id: 'other' },
		{ sellerUserId: 'other' },
		{ channelType: 'anthropic' },
	])
		await assert.rejects(
			fixture(() =>
				Response.json({
					success: true,
					data: {
						...sharedKeyWireRow,
						...reference,
						capabilities: sharedKeyCapabilities,
						...changed,
					},
				})
			).api.adminSharedKeyDetail(row),
			invalid
		)
	const controller = new AbortController()
	const late = fixture(async () => {
		controller.abort()
		return Response.json({
			success: true,
			data: {
				...sharedKeyWireRow,
				...reference,
				capabilities: sharedKeyCapabilities,
			},
		})
	})
	await assert.rejects(
		late.api.adminSharedKeyDetail(row, { signal: controller.signal }),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
})
test('priority and weight edits require real reason, confirmation and revision and never write on blur', async () => {
	const draft = {
		sellerPriority: 7,
		weight: 30,
		reason: 'Operator reviewed seller routing',
		reviewed: true,
	}
	const input = adminSharedKeyEditInput(row, draft)
	assert.deepEqual(input, {
		expected_revision: row.profile_revision,
		reason: draft.reason,
		sellerPriority: 7,
	})
	for (const change of [
		{ reason: '' },
		{ reason: 'a\nb' },
		{ reason: 'a\u202e' },
		{ reviewed: false },
		{ sellerPriority: 2_147_483_648 },
		{ weight: 101 },
	])
		assert.throws(
			() => adminSharedKeyEditInput(row, { ...draft, ...change }),
			AdminSharedKeyInputError
		)
	assert.throws(
		() =>
			adminSharedKeyEditInput(row, {
				...draft,
				sellerPriority: row.sellerPriority,
			}),
		AdminSharedKeyInputError
	)
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: {
				id: row.id,
				outcome: 'applied',
				auditId: '11111111-1111-4111-8111-111111111111',
				secret: 'PRIVATE',
			},
		})
	)
	assert.deepEqual(await api.patchAdminSharedKey(row, input), {
		id: row.id,
		outcome: 'applied',
		auditId: '11111111-1111-4111-8111-111111111111',
	})
	assert.equal(calls[0]?.init.method, 'PATCH')
	assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), input)
})
test('disable and restore only use reviewed safe state transitions; active is never accepted', async () => {
	const draft = { reason: 'Operator reviewed state', reviewed: true }
	assert.equal(
		adminSharedKeyConfirmationInput(row, 'disable', draft).status,
		'disabled'
	)
	assert.throws(
		() => adminSharedKeyConfirmationInput(row, 'restore', draft),
		AdminSharedKeyInputError
	)
	const disabled = { ...row, status: 'disabled' as const }
	assert.equal(
		adminSharedKeyConfirmationInput(disabled, 'restore', draft).status,
		'paused'
	)
	const { api, calls } = fixture(() => overview())
	await assert.rejects(
		api.patchAdminSharedKey(row, {
			expected_revision: row.profile_revision,
			reason: draft.reason,
			status: 'active' as 'paused',
		}),
		AdminSharedKeyInputError
	)
	await assert.rejects(
		api.patchAdminSharedKey(row, {
			expected_revision: row.profile_revision,
			reason: draft.reason,
			status: 'paused',
		}),
		AdminSharedKeyInputError
	)
	assert.equal(calls.length, 0)
})
test('known state/history conflicts retain only safe codes, and malformed success remains unconfirmed', async () => {
	for (const code of [
		'shared_key_state_conflict',
		'shared_key_earning_history_immutable',
	] as const) {
		const { api } = fixture(() =>
			Response.json(
				{
					success: false,
					code,
					message: 'Bearer PRIVATE',
					raw_failure: 'PRIVATE',
				},
				{ status: 409 }
			)
		)
		await assert.rejects(
			api.deleteAdminSharedKey(row, 'Reviewed deletion'),
			(error: unknown) =>
				error instanceof AdminSharedKeyConflictError &&
				error.conflict === code &&
				!error.message.includes('PRIVATE')
		)
	}
	for (const data of [
		{
			id: 'other',
			deleted: true,
			auditId: '11111111-1111-4111-8111-111111111111',
		},
		{ id: row.id, deleted: true, auditId: null },
	])
		await assert.rejects(
			fixture(() =>
				Response.json({ success: true, data })
			).api.deleteAdminSharedKey(row, 'Reviewed deletion'),
			invalid
		)
})
test('delete carries revision and audit reason in JSON and a no-op acknowledgment never invents an audit', async () => {
	const deleted = fixture(() =>
		Response.json({
			success: true,
			data: {
				id: row.id,
				deleted: true,
				auditId: '11111111-1111-4111-8111-111111111111',
			},
		})
	)
	await deleted.api.deleteAdminSharedKey(row, 'Reviewed deletion')
	assert.equal(deleted.calls[0]?.init.method, 'DELETE')
	assert.deepEqual(JSON.parse(String(deleted.calls[0]?.init.body)), {
		expected_revision: row.profile_revision,
		reason: 'Reviewed deletion',
	})
	const unchanged = fixture(() =>
		Response.json({
			success: true,
			data: { id: row.id, outcome: 'unchanged', auditId: null },
		})
	)
	assert.equal(
		(
			await unchanged.api.patchAdminSharedKey(row, {
				expected_revision: row.profile_revision,
				reason: 'Reviewed profile',
				weight: row.weight,
			})
		).auditId,
		null
	)
	await assert.rejects(
		fixture(() =>
			Response.json({
				success: true,
				data: { id: row.id, outcome: 'unchanged', auditId: 'fake' },
			})
		).api.patchAdminSharedKey(row, {
			expected_revision: row.profile_revision,
			reason: 'Reviewed profile',
			weight: row.weight,
		}),
		invalid
	)
})
