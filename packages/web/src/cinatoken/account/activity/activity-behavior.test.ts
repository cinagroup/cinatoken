import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	activityBudgetSchema,
	type ActivityTimelinePoint,
} from '../../activity-contracts'
import { CinaTokenApiError } from '../../api'
import { requiresSessionRevalidation } from '../account-access'
import { createActivityDownloadScope } from './activity-download'
import {
	activityFormSchema,
	EMPTY_ACTIVITY_FILTERS,
} from './activity-filter-schema'
import {
	accountBudgetRemaining,
	activityMetricValue,
	activitySuccessRate,
	canOpenActivityGeneration,
	formatActivityMoney,
} from './activity-format'
import {
	activityAccessFailure,
	activityErrorKey,
	activityQueryKey,
} from './use-activity-manager'

test('list and budget money stays in billing currency main units, including reservations', () => {
	const budget = activityBudgetSchema.parse({
		status: 'finite',
		budgetMax: 130,
		budgetBase: 130,
		budgetSpent: 4,
		budgetReserved: 0.5,
		budgetReservedMicros: 500_000,
		budgetRemaining: 125.5,
		budgetPeriod: 'monthly',
		budgetResetAt: null,
	})
	assert.match(
		formatActivityMoney(accountBudgetRemaining(budget), 'CNY', 'en', 'unknown'),
		/CNY.*125\.50/u
	)
	assert.match(
		formatActivityMoney(budget.budgetReserved, 'CNY', 'en', 'unknown'),
		/CNY.*0\.50/u
	)
	assert.match(formatActivityMoney(1.25, 'USD', 'en', 'unknown'), /USD.*1\.25/u)
})

test('unknown USD snapshots and budget availability never become a zero charge', () => {
	assert.equal(formatActivityMoney(null, 'USD', 'en', 'Unknown'), 'Unknown')
	assert.match(formatActivityMoney(0, 'USD', 'en', 'Unknown'), /USD.*0\.00/u)
	assert.match(
		formatActivityMoney(0.00000001, 'USD', 'en', 'Unknown'),
		/0\.00000001/u
	)
	const budget = {
		status: 'unlimited' as const,
		budgetMax: null,
		budgetBase: 0,
		budgetSpent: 0,
		budgetReserved: 0,
		budgetReservedMicros: 0,
		budgetRemaining: null,
		budgetPeriod: 'none',
		budgetResetAt: null,
	}
	assert.equal(accountBudgetRemaining(activityBudgetSchema.parse(budget)), null)
	assert.equal(
		accountBudgetRemaining(
			activityBudgetSchema.parse({ ...budget, status: 'unavailable' })
		),
		null
	)
})

test('timeline preserves unknown latency gaps and known zero-cost buckets', () => {
	const point: ActivityTimelinePoint = {
		bucket: '2026-09-27T00:00:00Z',
		requestCount: 2,
		inputTokens: 3,
		outputTokens: 4,
		cacheReadTokens: 1,
		cacheWriteTokens: 1,
		totalTokens: 9,
		chargedCost: 0,
		avgLatencyMs: null,
	}
	assert.equal(activityMetricValue(point, 'latency'), null)
	assert.equal(activityMetricValue(point, 'cost'), 0)
	assert.equal(activityMetricValue(point, 'tokens'), 9)
	assert.equal(activitySuccessRate(0, 0), null)
	assert.equal(activitySuccessRate(1, 2), 0.5)
})

test('filters retain exact IDs, trim boundary whitespace and reject unsupported ranges and controls', () => {
	assert.equal(
		activityFormSchema.parse({
			...EMPTY_ACTIVITY_FILTERS,
			model_id: '  vendor/model  ',
		}).model_id,
		'vendor/model'
	)
	for (const invalid of [
		{ range: '365d' },
		{ status: 'unknown' },
		{ api_key_id: 'a'.repeat(129) },
		{ model_id: 'a'.repeat(257) },
		{ provider_name: 'a'.repeat(201) },
		{ provider_name: 'provider\u0000secret' },
	])
		assert.equal(
			activityFormSchema.safeParse({ ...EMPTY_ACTIVITY_FILTERS, ...invalid })
				.success,
			false
		)
})

test('only bounded generation IDs can become detail requests', () => {
	assert.equal(canOpenActivityGeneration({ id: 'gen-abc_DEF-123' }), true)
	for (const id of [
		'request-id',
		'gen-',
		'gen-../other',
		'gen-' + 'x'.repeat(129),
	])
		assert.equal(canOpenActivityGeneration({ id }), false)
})

test('server scope conflicts require explicit revalidation while malformed metadata does not loop identity resets', () => {
	const user = new CinaTokenApiError('user changed', 409, 'user-mismatch')
	const server = new CinaTokenApiError('changed', 409, 'workspace-mismatch')
	const metadata = new CinaTokenApiError(
		'mismatched payload',
		0,
		'workspace-mismatch'
	)
	const conflict = new CinaTokenApiError('other conflict', 409, 'http')
	assert.equal(activityAccessFailure(user), 'user')
	assert.equal(activityErrorKey(user), 'cinatoken.account.sessionChanged')
	assert.equal(requiresSessionRevalidation(user), true)
	assert.equal(activityAccessFailure(server), 'workspace')
	assert.equal(activityAccessFailure(metadata), 'metadata')
	assert.equal(requiresSessionRevalidation(server), true)
	assert.equal(requiresSessionRevalidation(metadata), false)
	assert.equal(activityAccessFailure(conflict), null)
	assert.equal(
		activityErrorKey(conflict),
		'cinatoken.account.activity.conflict'
	)
	for (const status of [401, 403])
		assert.equal(
			activityAccessFailure(new CinaTokenApiError('denied', status, 'http')),
			'permission'
		)
	assert.equal(
		activityAccessFailure(new CinaTokenApiError('temporary', 503, 'http')),
		null
	)
})

test('query identity changes with user, workspace and authority revision', () => {
	const base = { userId: 'u1', workspaceId: 'w1', scopeVersion: 1 }
	const first = activityQueryKey(base, 'list')
	for (const scope of [
		{ ...base, userId: 'u2' },
		{ ...base, workspaceId: 'w2' },
		{ ...base, scopeVersion: 2 },
	])
		assert.notDeepEqual(activityQueryKey(scope, 'list'), first)
})

function downloadFixture(fail = false) {
	const clicks: string[] = []
	const revoked: string[] = []
	const callbacks: Array<{ run: () => void; cancelled: boolean }> = []
	let sequence = 0
	const scope = createActivityDownloadScope({
		create: () => 'blob:fixture-' + ++sequence,
		revoke: (url) => revoked.push(url),
		click: (url, name) => {
			if (fail) throw new Error('download unavailable')
			clicks.push(url + '|' + name)
		},
		later: (run) => {
			const timer = { run, cancelled: false }
			callbacks.push(timer)
			return () => {
				timer.cancelled = true
			}
		},
	})
	return { scope, clicks, revoked, callbacks }
}

test('completed CSV downloads revoke their Object URL exactly once', () => {
	const fixture = downloadFixture()
	fixture.scope.download(
		new Blob(['redacted usage']),
		'cinatoken-activity-2026-09-27.csv'
	)
	assert.equal(fixture.clicks.length, 1)
	assert.equal(fixture.revoked.length, 0)
	fixture.callbacks[0].run()
	fixture.scope.clear()
	assert.deepEqual(fixture.revoked, ['blob:fixture-1'])
})

test('scope disposal clears every pending download and cancels completion timers', () => {
	const fixture = downloadFixture()
	fixture.scope.download(new Blob(), 'one.csv')
	fixture.scope.download(new Blob(), 'two.csv')
	fixture.scope.clear()
	for (const callback of fixture.callbacks) {
		assert.equal(callback.cancelled, true)
		callback.run()
	}
	assert.deepEqual(fixture.revoked, ['blob:fixture-1', 'blob:fixture-2'])
})

test('failed browser download cannot leave a Blob URL behind', () => {
	const fixture = downloadFixture(true)
	assert.throws(() => fixture.scope.download(new Blob(), 'one.csv'))
	assert.deepEqual(fixture.revoked, ['blob:fixture-1'])
	assert.equal(fixture.callbacks.length, 0)
})
