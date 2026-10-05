/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdminSharedKeysApi } from './shared-key-api'
import { adminSharedKeyRowSchema } from './shared-key-contracts'
import {
	AdminSharedKeySubjectError,
	adminSharedKeyAccessDenied,
	adminSharedKeyWriteUnknown,
	sanitizeSharedKeyError,
} from './shared-key-errors'
import {
	SHARED_KEY_CONSOLE_SUBJECT_HEADER,
	type AdminSharedKeyBoundOptions,
} from './shared-key-subject'

const subject = 'cinaauth:ops team/branch %2F 名'
const verified = {
	authenticated: true,
	verification: 'verified',
	principalType: 'console',
	subject,
}
const options = { expectedConsoleSubject: subject }
const row = adminSharedKeyRowSchema.parse({
	id: 'shared-1',
	sellerUserId: 'seller-1',
	sellerEmail: null,
	channelType: 'openai',
	label: null,
	status: 'active',
	sellerPriority: 1,
	weight: 30,
	inputPrice: 0,
	outputPrice: 0,
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
})
const input = { since: '2026-09-29T00:00:00.000Z', limit: 200 }
const data = {
	windowSince: input.since,
	scanned: 0,
	windowTotal: 0,
	scanComplete: true,
	candidates: 0,
	reviewRequired: 0,
	candidateLogIds: [],
	reviewOnly: true,
	balancesChanged: false,
	queued: false,
	range: { ...input, page: 1 },
	reviewScope: 'first_page_since',
	evidenceRequirement: 'original_price_commission_owner',
}
function operation(
	api: ReturnType<typeof createAdminSharedKeysApi>,
	kind: string,
	bound: AdminSharedKeyBoundOptions = options
) {
	if (kind === 'PATCH')
		return api.patchAdminSharedKey(
			row,
			{
				expected_revision: row.profile_revision,
				reason: 'Operator reviewed routing',
				weight: 31,
			},
			bound
		)
	if (kind === 'DELETE')
		return api.deleteAdminSharedKey(row, 'Operator reviewed deletion', bound)
	return api.reviewAdminEarnings(input, kind === 'apply', bound)
}
function success(kind: string) {
	if (kind === 'PATCH')
		return {
			success: true,
			data: {
				id: row.id,
				outcome: 'applied',
				auditId: '11111111-1111-4111-8111-111111111111',
			},
		}
	if (kind === 'DELETE')
		return {
			success: true,
			data: {
				id: row.id,
				deleted: true,
				auditId: '11111111-1111-4111-8111-111111111111',
			},
		}
	return { success: true, dryRun: kind === 'discover', data }
}
test('every governance and review POST reads fresh exact Console identity then sends one canonical subject header', async () => {
	for (const kind of ['PATCH', 'DELETE', 'discover', 'apply']) {
		const calls: Array<{ path: string; init: RequestInit }> = []
		const api = createAdminSharedKeysApi(async (path, init) => {
			calls.push({ path: String(path), init: init ?? {} })
			return Response.json(
				String(path) === '/api/auth/check' ? verified : success(kind)
			)
		})
		await operation(api, kind)
		assert.equal(calls.length, 2)
		assert.equal(calls[0].path, '/api/auth/check')
		assert.equal(calls[0].init.method, undefined)
		assert.equal(
			new Headers(calls[0].init.headers).has(SHARED_KEY_CONSOLE_SUBJECT_HEADER),
			false
		)
		assert.equal(calls[1].init.credentials, 'same-origin')
		assert.equal(calls[1].init.cache, 'no-store')
		const header = new Headers(calls[1].init.headers).get(
			SHARED_KEY_CONSOLE_SUBJECT_HEADER
		)
		assert.equal(header, encodeURIComponent(subject))
		assert.equal(decodeURIComponent(header ?? ''), subject)
		assert.match(header ?? '', /%252F/u)
		assert.equal(
			String(calls[1].init.body ?? '').includes('expectedConsoleSubject'),
			false
		)
	}
})
test('missing, unverified, other-principal and changed-subject preflight responses dispatch zero protected operations', async () => {
	for (const kind of ['PATCH', 'DELETE', 'discover', 'apply'])
		for (const check of [
			{ ...verified, authenticated: false },
			{ ...verified, verification: 'degraded' },
			{ ...verified, principalType: 'api_key' },
			{ ...verified, subject: 'other' },
			{
				authenticated: true,
				verification: 'verified',
				principalType: 'console',
			},
			{ success: true, data: verified },
		]) {
			const calls: string[] = []
			const api = createAdminSharedKeysApi(async (path) => {
				calls.push(String(path))
				return Response.json(check)
			})
			await assert.rejects(
				operation(api, kind),
				(error) =>
					error instanceof AdminSharedKeySubjectError &&
					adminSharedKeyAccessDenied(error) &&
					!adminSharedKeyWriteUnknown(error)
			)
			assert.deepEqual(calls, ['/api/auth/check'])
		}
})
test('no expected subject fails locally, and cancellation during fresh auth never dispatches a late protected operation', async () => {
	let missingCalls = 0
	const missing = createAdminSharedKeysApi(async () => {
		missingCalls++
		return Response.json(verified)
	})
	await assert.rejects(
		missing.deleteAdminSharedKey(row, 'Reviewed deletion'),
		AdminSharedKeySubjectError
	)
	await assert.rejects(
		missing.reviewAdminEarnings(input, false),
		AdminSharedKeySubjectError
	)
	assert.equal(missingCalls, 0)
	for (const expectedConsoleSubject of [
		'',
		' subject ',
		'x'.repeat(601),
		'a\u202e',
		'\ud800',
	]) {
		let count = 0
		const api = createAdminSharedKeysApi(async () => {
			count++
			return Response.json(verified)
		})
		await assert.rejects(
			operation(api, 'PATCH', { expectedConsoleSubject }),
			AdminSharedKeySubjectError
		)
		assert.equal(count, 0)
	}
	for (const kind of ['PATCH', 'DELETE', 'discover', 'apply']) {
		const abort = new AbortController(),
			calls: string[] = []
		const api = createAdminSharedKeysApi(async (path) => {
			calls.push(String(path))
			abort.abort()
			return Response.json(verified)
		})
		await assert.rejects(
			operation(api, kind, { ...options, signal: abort.signal }),
			(error) =>
				error instanceof AdminSharedKeySubjectError &&
				!adminSharedKeyWriteUnknown(error)
		)
		assert.deepEqual(calls, ['/api/auth/check'])
	}
})
test('server Cookie-to-subject rejection stays a definite sanitized refusal after preflight, and preflight failures retain no raw error', async () => {
	for (const kind of ['PATCH', 'DELETE', 'discover', 'apply']) {
		const api = createAdminSharedKeysApi(async (path) =>
			String(path) === '/api/auth/check'
				? Response.json(verified)
				: Response.json(
						{
							success: false,
							code: 'console_subject_mismatch',
							message: 'PRIVATE raw subject',
						},
						{ status: 403 }
					)
		)
		await assert.rejects(
			operation(api, kind),
			(error) =>
				!adminSharedKeyWriteUnknown(error) &&
				error instanceof Error &&
				!error.message.includes('PRIVATE')
		)
	}
	const api = createAdminSharedKeysApi(async () => {
		throw Error('PRIVATE upstream auth secret')
	})
	await assert.rejects(
		operation(api, 'PATCH'),
		(error) =>
			error instanceof AdminSharedKeySubjectError &&
			sanitizeSharedKeyError(error) === error &&
			!error.message.includes('PRIVATE')
	)
})
