/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError } from '../../api'
import { createAdminEarningReviewApi } from './review-api'
import { adminEarningReviewInputSchema } from './review-contracts'
import { AdminSharedKeyInputError } from './shared-key-errors'

const input = { since: '2026-09-29T00:00:00.000Z', limit: 200 }
const data = {
	windowSince: input.since,
	scanned: 2,
	windowTotal: 2,
	scanComplete: true,
	candidates: 1,
	reviewRequired: 1,
	candidateLogIds: ['request-1'],
	reviewOnly: true,
	balancesChanged: false,
	queued: false,
	range: { ...input, page: 1 },
	reviewScope: 'first_page_since',
	evidenceRequirement: 'original_price_commission_owner',
}
const invalid = (error: unknown) =>
	error instanceof CinaTokenApiError && error.code === 'invalid-response'
function fixtureApi(reply: typeof fetch) {
	const original = createAdminEarningReviewApi(async (url, init) =>
		String(url) === '/api/auth/check'
			? Response.json({
					authenticated: true,
					verification: 'verified',
					principalType: 'console',
					subject: 'cinaauth:shared-qa',
				})
			: reply(url, init)
	)
	return {
		reviewAdminEarnings: (
			input: Parameters<typeof original.reviewAdminEarnings>[0],
			apply: boolean,
			options: Parameters<typeof original.reviewAdminEarnings>[2] = {
				expectedConsoleSubject: 'cinaauth:shared-qa',
			}
		) => original.reviewAdminEarnings(input, apply, options),
	}
}

test('earnings discovery uses bounded UTC query-only POST and strips secrets without claiming compensation', async () => {
	let path = ''
	let init: RequestInit = {}
	const api = fixtureApi(async (url, options) => {
		path = String(url)
		init = options ?? {}
		return Response.json({
			success: true,
			dryRun: true,
			data: { ...data, raw_failure: 'private', taskId: 'fake' },
		})
	})
	const result = await api.reviewAdminEarnings(input, false)
	const query = new URL(path, 'https://example.test').searchParams
	assert.equal(query.get('since'), input.since)
	assert.equal(query.get('limit'), '200')
	assert.equal(query.get('apply'), '0')
	assert.equal(init.method, 'POST')
	assert.equal(init.body, undefined)
	assert.equal(init.credentials, 'same-origin')
	assert.equal(init.cache, 'no-store')
	assert.equal(JSON.stringify(result).includes('private'), false)
	assert.equal('taskId' in result.data, false)
	assert.equal(result.data.balancesChanged, false)
	assert.equal(result.data.queued, false)
})
test('review application accepts typed evidence/incomplete 409 only and never implies crediting', async () => {
	for (const [code, payload] of [
		['historical_earning_evidence_required', data],
		[
			'historical_earning_scan_incomplete',
			{ ...data, windowTotal: 3, scanComplete: false },
		],
	] as const) {
		const api = fixtureApi(async () =>
			Response.json(
				{
					success: false,
					dryRun: false,
					code,
					data: payload,
					message: 'Bearer secret',
				},
				{ status: 409 }
			)
		)
		const result = await api.reviewAdminEarnings(input, true)
		assert.equal(result.success, false)
		assert.equal(result.data.reviewOnly, true)
		assert.equal(JSON.stringify(result).includes('Bearer'), false)
	}
	const empty = {
		...data,
		candidates: 0,
		reviewRequired: 0,
		candidateLogIds: [],
	}
	const api = fixtureApi(async () =>
		Response.json({ success: true, dryRun: false, data: empty })
	)
	assert.equal(
		(await api.reviewAdminEarnings(input, true)).data.balancesChanged,
		false
	)
})
test('review rejects contradictory range, scan counts, candidate IDs, money effects and malformed 2xx', async () => {
	for (const patch of [
		{ windowSince: '2026-09-28T00:00:00.000Z' },
		{ scanned: 201 },
		{ windowTotal: 3 },
		{ reviewRequired: 0 },
		{
			candidates: 2,
			candidateLogIds: ['request-1', 'request-1'],
			reviewRequired: 2,
		},
		{ candidateLogIds: ['sk-secret'] },
		{ candidateLogIds: ['request\u202e'] },
		{ balancesChanged: true },
		{ queued: true },
		{ reviewOnly: false },
		{ range: { ...input, limit: 199, page: 1 } },
	]) {
		const api = fixtureApi(async () =>
			Response.json({
				success: true,
				dryRun: true,
				data: { ...data, ...patch },
			})
		)
		await assert.rejects(api.reviewAdminEarnings(input, false), invalid)
	}
	for (const [result, apply] of [
		[{ success: true, dryRun: false, data }, true],
		[
			{
				success: false,
				dryRun: false,
				code: 'historical_earning_scan_incomplete',
				data,
			},
			true,
		],
		[
			{
				success: false,
				dryRun: false,
				code: 'historical_earning_evidence_required',
				data: {
					...data,
					candidates: 0,
					reviewRequired: 0,
					candidateLogIds: [],
				},
			},
			true,
		],
		[
			{
				success: false,
				dryRun: false,
				code: 'historical_earning_evidence_required',
				data,
			},
			false,
		],
	] as const) {
		await assert.rejects(
			fixtureApi(async () =>
				Response.json(result, { status: result.success ? 200 : 409 })
			).reviewAdminEarnings(input, apply),
			invalid
		)
	}
})
test('invalid discovery inputs dispatch nothing and late canceled review results are discarded', async () => {
	let calls = 0
	const abort = new AbortController()
	const api = fixtureApi(async () => {
		calls++
		abort.abort()
		return Response.json({ success: true, dryRun: true, data })
	})
	for (const value of [
		{ ...input, since: '2026-02-30T00:00:00Z' },
		{ ...input, since: '2026-09-29T00:00:00+08:00' },
		{ ...input, limit: 1001 },
	]) {
		assert.equal(adminEarningReviewInputSchema.safeParse(value).success, false)
		await assert.rejects(
			api.reviewAdminEarnings(value, false),
			AdminSharedKeyInputError
		)
	}
	assert.equal(calls, 0)
	await assert.rejects(
		api.reviewAdminEarnings(input, false, {
			signal: abort.signal,
			expectedConsoleSubject: 'cinaauth:shared-qa',
		})
	)
	assert.equal(calls, 1)
})
