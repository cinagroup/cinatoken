/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError } from '../../../api'
import { analyticsQueryPrefix } from '../models/analytics-drilldowns'
import { userAnalyticsRowSchema } from './user-analytics-contracts'
import {
	emptyUserAnalyticsDrilldowns,
	retryUserAnalyticsKey,
	retryUserAnalyticsRow,
	toggleUserAnalyticsKey,
	toggleUserAnalyticsRow,
	userAnalyticsDetailKey,
	userAnalyticsDrilldownQueryOptions,
	type UserAnalyticsDrilldownEntry,
} from './user-analytics-drilldowns'
import { userAnalyticsFixtureRow } from './user-analytics-fixtures'

const a = userAnalyticsRowSchema.parse(userAnalyticsFixtureRow)
const b = {
	...a,
	user_email: 'other@example.test',
	user_id: 'cf49f288-36f1-4bbb-9ddd-bba34536ca11',
}
const available = [
	{ api_key_id: 'a' },
	{ api_key_id: 'b' },
	{ api_key_id: null },
]
function keysSelection() {
	return toggleUserAnalyticsRow(
		emptyUserAnalyticsDrilldowns('scope'),
		'scope',
		a,
		'keys'
	)
}
function addKey(selection: ReturnType<typeof keysSelection>, id: string) {
	return toggleUserAnalyticsKey(
		selection,
		'scope',
		a.user_email,
		selection.rows.get(a.user_email)!.generation,
		id,
		available
	)
}
const api = {}
const identity = {
	scopeKey: 'console',
	reconciliationKey: 'subject:epoch',
	api,
	instanceKey: 'page-one',
	domain: 'userAnalytics' as const,
}
const prefix = analyticsQueryPrefix(identity)
function options(
	entry: UserAnalyticsDrilldownEntry,
	read: (signal: AbortSignal) => Promise<string[]>,
	keyId?: string,
	queryPrefix: readonly unknown[] = prefix
) {
	return userAnalyticsDrilldownQueryOptions({
		prefix: queryPrefix,
		context: 'scope',
		entry,
		keyId,
		read,
	})
}
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

test('multiple users remain expanded and closing one preserves sibling state without mutation', () => {
	const initial = emptyUserAnalyticsDrilldowns('scope')
	const one = toggleUserAnalyticsRow(initial, 'scope', a, 'models')
	const two = toggleUserAnalyticsRow(one, 'scope', b, 'keys')
	const closed = toggleUserAnalyticsRow(two, 'scope', a, 'models')
	assert.equal(initial.rows.size, 0)
	assert.equal(one.rows.size, 1)
	assert.equal(two.rows.size, 2)
	assert.deepEqual([...closed.rows.keys()], [b.user_email])
	assert.equal(closed.rows.get(b.user_email), two.rows.get(b.user_email))
})

test('changing one user panel removes its child keys and leaves other users expanded', () => {
	let selection = addKey(keysSelection(), 'a')
	selection = toggleUserAnalyticsRow(selection, 'scope', b, 'models')
	const previous = selection.rows.get(a.user_email)!
	const changed = toggleUserAnalyticsRow(selection, 'scope', a, 'models')
	assert.equal(changed.rows.get(a.user_email)?.kind, 'models')
	assert.equal(changed.rows.get(a.user_email)?.keyModels.size, 0)
	assert.notEqual(
		changed.rows.get(a.user_email)?.generation,
		previous.generation
	)
	assert.equal(changed.rows.get(b.user_email), selection.rows.get(b.user_email))
})

test('ambiguous email identities cannot open Keys, and deleted or unlisted key IDs cannot expand', () => {
	const initial = emptyUserAnalyticsDrilldowns('scope')
	assert.equal(
		toggleUserAnalyticsRow(initial, 'scope', { ...a, user_id: null }, 'keys'),
		initial
	)
	const selection = keysSelection()
	for (const id of ['', 'deleted-history', 'not-listed'])
		assert.equal(addKey(selection, id), selection)
})

test('several keys expand independently and a single-key retry preserves its parent and sibling generation', () => {
	const selection = addKey(addKey(keysSelection(), 'a'), 'b')
	const parent = selection.rows.get(a.user_email)!
	const retry = retryUserAnalyticsKey(
		selection,
		'scope',
		a.user_email,
		parent.generation,
		'a',
		parent.keyModels.get('a')!
	)
	const after = retry.rows.get(a.user_email)!
	assert.equal(after.generation, parent.generation)
	assert.equal(after.keyModels.get('b'), parent.keyModels.get('b'))
	assert.notEqual(after.keyModels.get('a'), parent.keyModels.get('a'))
	assert.deepEqual(
		[...addKey(retry, 'a').rows.get(a.user_email)!.keyModels.keys()],
		['b']
	)
})

test('parent retry discards only its descendants and stale nested callbacks cannot reopen or retry them', () => {
	let selection = addKey(keysSelection(), 'a')
	selection = toggleUserAnalyticsRow(selection, 'scope', b, 'models')
	const parent = selection.rows.get(a.user_email)!
	const retry = retryUserAnalyticsRow(
		selection,
		'scope',
		a.user_email,
		parent.generation
	)
	assert.equal(retry.rows.get(a.user_email)?.keyModels.size, 0)
	assert.equal(retry.rows.get(b.user_email), selection.rows.get(b.user_email))
	assert.equal(
		toggleUserAnalyticsKey(
			retry,
			'scope',
			a.user_email,
			parent.generation,
			'a',
			available
		),
		retry
	)
	assert.equal(
		retryUserAnalyticsKey(
			retry,
			'scope',
			a.user_email,
			parent.generation,
			'a',
			parent.keyModels.get('a')!
		),
		retry
	)
	assert.equal(
		retryUserAnalyticsRow(retry, 'scope', a.user_email, parent.generation),
		retry
	)
})

test('context reset and close/reopen never reuse generations or accept stale callbacks', () => {
	const before = addKey(keysSelection(), 'a')
	const parent = before.rows.get(a.user_email)!
	const closed = toggleUserAnalyticsRow(before, 'scope', a, 'keys')
	const reopened = toggleUserAnalyticsRow(closed, 'scope', a, 'keys')
	assert.ok(reopened.rows.get(a.user_email)!.generation > parent.generation)
	const reset = toggleUserAnalyticsRow(reopened, 'new-range', b, 'models')
	assert.deepEqual([...reset.rows.keys()], [b.user_email])
	assert.equal(
		retryUserAnalyticsRow(reset, 'scope', a.user_email, parent.generation),
		reset
	)
})

test('query identities bind email, exact account, key ID, panel kind and page identity separately', () => {
	const entry = addKey(keysSelection(), 'a').rows.get(a.user_email)!
	const keys = [
		userAnalyticsDetailKey(entry),
		userAnalyticsDetailKey(entry, 'a'),
		userAnalyticsDetailKey(
			{ ...entry, row: { ...a, user_email: b.user_email } },
			'a'
		),
		userAnalyticsDetailKey({ ...entry, row: b }, 'a'),
		userAnalyticsDetailKey({ ...entry, kind: 'models' }),
	]
	assert.equal(new Set(keys).size, keys.length)
	assert.notDeepEqual(
		prefix,
		analyticsQueryPrefix({ ...identity, instanceKey: 'page-two' })
	)
	assert.notDeepEqual(prefix, analyticsQueryPrefix({ ...identity, api: {} }))
	assert.notDeepEqual(
		prefix,
		analyticsQueryPrefix({ ...identity, reconciliationKey: 'new-subject' })
	)
})

test('unsubscribing one nested detail cancels its late result while another user keeps its data', async () => {
	const client = new QueryClient()
	const entry = addKey(keysSelection(), 'a').rows.get(a.user_email)!
	const pending = deferred<string[]>()
	let signal!: AbortSignal
	const first = options(
		entry,
		async (value) => {
			signal = value
			return pending.promise
		},
		'a'
	)
	const siblingEntry = { ...entry, row: b }
	const sibling = options(siblingEntry, async () => ['sibling'], 'a')
	const observer = new QueryObserver(client, first)
	const siblingObserver = new QueryObserver(client, sibling)
	const unsubscribe = observer.subscribe(() => {})
	const stopSibling = siblingObserver.subscribe(() => {})
	await client.fetchQuery(sibling)
	unsubscribe()
	assert.equal(signal.aborted, true)
	pending.resolve(['stale'])
	await Promise.resolve()
	await Promise.resolve()
	assert.equal(client.getQueryData(first.queryKey), undefined)
	assert.deepEqual(siblingObserver.getCurrentResult().data?.rows, ['sibling'])
	stopSibling()
	client.clear()
})

test('retrying a failed key query leaves a successful sibling and parent query untouched', async () => {
	const client = new QueryClient()
	const selection = addKey(addKey(keysSelection(), 'a'), 'b')
	const entry = selection.rows.get(a.user_email)!
	let parentReads = 0,
		siblingReads = 0,
		failedReads = 0
	const parent = options(entry, async () => {
		parentReads++
		return ['keys']
	})
	const sibling = options(
		entry,
		async () => {
			siblingReads++
			return ['b']
		},
		'b'
	)
	const failure = options(
		entry,
		async () => {
			failedReads++
			throw new Error('private upstream error')
		},
		'a'
	)
	await Promise.all([
		client.fetchQuery(parent),
		client.fetchQuery(sibling),
		client.fetchQuery(failure),
	])
	const retried = retryUserAnalyticsKey(
		selection,
		'scope',
		a.user_email,
		entry.generation,
		'a',
		entry.keyModels.get('a')!
	).rows.get(a.user_email)!
	const result = await client.fetchQuery(
		options(
			retried,
			async () => {
				failedReads++
				return ['recovered']
			},
			'a'
		)
	)
	assert.deepEqual([parentReads, siblingReads, failedReads], [1, 1, 2])
	assert.deepEqual(result.rows, ['recovered'])
	assert.deepEqual(client.getQueryData(sibling.queryKey), {
		rows: ['b'],
		error: false,
		denied: false,
	})
	assert.equal(
		JSON.stringify(client.getQueryData(failure.queryKey)).includes('private'),
		false
	)
	client.clear()
})

test('cancelled parent-context late403 cannot deny a replacement exact-account query', async () => {
	const client = new QueryClient()
	const entry = addKey(keysSelection(), 'a').rows.get(a.user_email)!
	const pending = deferred<string[]>()
	const old = options(entry, () => pending.promise, 'a')
	const observer = new QueryObserver(client, old)
	const unsubscribe = observer.subscribe(() => {})
	unsubscribe()
	const fresh = options(
		{ ...entry, row: b, generation: entry.generation + 1 },
		async () => ['new-owner'],
		'a'
	)
	const current = await client.fetchQuery(fresh)
	pending.reject(new CinaTokenApiError('private', 403, 'http'))
	await Promise.resolve()
	await Promise.resolve()
	assert.deepEqual(current, {
		rows: ['new-owner'],
		error: false,
		denied: false,
	})
	assert.equal(client.getQueryData(old.queryKey), undefined)
	client.clear()
})

test('pending Key details restart on observer replay while independent pages cannot cancel each other', async () => {
	const client = new QueryClient()
	const entry = addKey(keysSelection(), 'a').rows.get(a.user_email)!
	const first = deferred<string[]>(),
		second = deferred<string[]>(),
		other = deferred<string[]>()
	const signals: AbortSignal[] = []
	const query = options(
		entry,
		async (signal) => {
			signals.push(signal)
			return signals.length === 1 ? first.promise : second.promise
		},
		'a'
	)
	let otherSignal!: AbortSignal
	const otherQuery = options(
		entry,
		async (signal) => {
			otherSignal = signal
			return other.promise
		},
		'a',
		analyticsQueryPrefix({ ...identity, instanceKey: 'page-two' })
	)
	const observer = new QueryObserver(client, query)
	const otherObserver = new QueryObserver(client, otherQuery)
	const stopFirst = observer.subscribe(() => {})
	const stopOther = otherObserver.subscribe(() => {})
	const initial = observer.refetch({ cancelRefetch: false })
	stopFirst()
	assert.equal(signals[0].aborted, true)
	assert.equal(otherSignal.aborted, false)
	const stopSecond = observer.subscribe(() => {})
	const restarted = observer.refetch({ cancelRefetch: false })
	try {
		assert.equal(signals.length, 2)
		second.resolve(['restarted'])
		await restarted
		first.resolve(['stale'])
		await initial
		assert.equal(observer.getCurrentResult().isPending, false)
		assert.deepEqual(observer.getCurrentResult().data?.rows, ['restarted'])
		other.resolve(['independent'])
		await otherObserver.refetch({ cancelRefetch: false })
		assert.deepEqual(otherObserver.getCurrentResult().data?.rows, [
			'independent',
		])
	} finally {
		stopSecond()
		stopOther()
		client.clear()
	}
})
