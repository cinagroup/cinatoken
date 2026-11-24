/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError } from '../../../api'
import {
	analyticsDetailState,
	analyticsDrilldownQueryOptions,
	analyticsQueryPrefix,
	emptyAnalyticsDrilldowns,
	modelAnalyticsRowKey,
	retryAnalyticsDrilldown,
	toggleAnalyticsDrilldown,
} from './analytics-drilldowns'

type Row = { value: string }
const a: Row = { value: 'a' }
const b: Row = { value: 'b' }
const api = {}
const identity = {
	scopeKey: 'scope',
	reconciliationKey: JSON.stringify(['user', 'subject', 1]),
	api,
	instanceKey: 'page-a',
	domain: 'modelAnalytics' as const,
}
const prefix = [...analyticsQueryPrefix(identity), 'providers']
function client(): QueryClient {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
function options(
	key: string,
	read: (signal: AbortSignal) => Promise<Row[]>,
	generation = 1,
	context = 'range+tag',
	queryPrefix: readonly unknown[] = prefix
) {
	return analyticsDrilldownQueryOptions({
		prefix: queryPrefix,
		context,
		key,
		generation,
		read,
	})
}

test('model row identity keeps route groups and delimiter-like IDs distinct', () => {
	const keys = [
		{ model_id: 'same', route_group: 'default' },
		{ model_id: 'same', route_group: 'paid' },
		{ model_id: 'a\tb', route_group: 'c' },
		{ model_id: 'a', route_group: 'b\tc' },
		{ model_id: 'a","b', route_group: 'c' },
	].map(modelAnalyticsRowKey)
	assert.equal(new Set(keys).size, keys.length)
	assert.equal(keys[0], JSON.stringify(['same', 'default']))
})

test('multiple selections preserve siblings and source maps while closing only the selected row', () => {
	const initial = emptyAnalyticsDrilldowns<Row>('scope')
	const one = toggleAnalyticsDrilldown(initial, 'scope', 'a', a)
	const two = toggleAnalyticsDrilldown(one, 'scope', 'b', b)
	const closed = toggleAnalyticsDrilldown(two, 'scope', 'a', a)
	assert.equal(initial.rows.size, 0)
	assert.deepEqual([...one.rows.keys()], ['a'])
	assert.deepEqual([...two.rows.keys()], ['a', 'b'])
	assert.deepEqual([...closed.rows.keys()], ['b'])
	assert.equal(closed.rows.get('b'), two.rows.get('b'))
	assert.equal(two.rows.get('a')?.row, a)
})

test('row retry changes only its generation and stale callbacks cannot retry a reopened row or another context', () => {
	let selection = toggleAnalyticsDrilldown(
		emptyAnalyticsDrilldowns<Row>('old'),
		'old',
		'a',
		a
	)
	selection = toggleAnalyticsDrilldown(selection, 'old', 'b', b)
	const original = selection.rows.get('a')!
	const retry = retryAnalyticsDrilldown(
		selection,
		'old',
		'a',
		original.generation
	)
	assert.notEqual(retry.rows.get('a')?.generation, original.generation)
	assert.equal(retry.rows.get('b'), selection.rows.get('b'))
	assert.equal(
		retryAnalyticsDrilldown(retry, 'old', 'a', original.generation),
		retry
	)
	const closed = toggleAnalyticsDrilldown(retry, 'old', 'a', a)
	const reopened = toggleAnalyticsDrilldown(closed, 'old', 'a', a)
	assert.equal(
		retryAnalyticsDrilldown(reopened, 'old', 'a', original.generation),
		reopened
	)
	const changed = toggleAnalyticsDrilldown(reopened, 'new', 'a', a)
	assert.deepEqual([...changed.rows.keys()], ['a'])
	assert.equal(
		retryAnalyticsDrilldown(changed, 'old', 'a', original.generation),
		changed
	)
	const cleared = emptyAnalyticsDrilldowns<Row>('new', changed.nextGeneration)
	assert.equal(cleared.rows.size, 0)
	assert.ok(
		toggleAnalyticsDrilldown(cleared, 'new', 'a', a).rows.get('a')!.generation >
			original.generation
	)
})

test('query ownership separates scope, identity epoch, API instance, page instance and domain', () => {
	const base = analyticsQueryPrefix(identity)
	assert.deepEqual(analyticsQueryPrefix(identity), base)
	for (const change of [
		{ scopeKey: 'different' },
		{ reconciliationKey: JSON.stringify(['user', 'subject', 2]) },
		{ api: {} },
		{ instanceKey: 'page-b' },
		{ domain: 'providerAnalytics' as const },
	])
		assert.notDeepEqual(analyticsQueryPrefix({ ...identity, ...change }), base)
	const read = async () => [a]
	assert.notDeepEqual(options('a', read).queryKey, options('b', read).queryKey)
	assert.notDeepEqual(
		options('a', read).queryKey,
		options('a', read, 2).queryKey
	)
	assert.notDeepEqual(
		options('a', read).queryKey,
		options('a', read, 1, 'new').queryKey
	)
})

test('successful and empty details cache only projected rows and state flags', async () => {
	const cache = client()
	try {
		assert.deepEqual(await cache.fetchQuery(options('a', async () => [a])), {
			rows: [a],
			error: false,
			denied: false,
		})
		assert.deepEqual(await cache.fetchQuery(options('empty', async () => [])), {
			rows: [],
			error: false,
			denied: false,
		})
	} finally {
		cache.clear()
	}
})

test('detail failures cache no raw error and only permission failures mark the analytics domain denied', async () => {
	const cache = client()
	try {
		for (const [index, error] of [
			new Error('PRIVATE server payload'),
			new CinaTokenApiError('PRIVATE server payload', 503, 'http'),
			new CinaTokenApiError('PRIVATE server payload', 401, 'http'),
			new CinaTokenApiError('PRIVATE server payload', 403, 'http'),
		].entries()) {
			const query = options(String(index), async () => {
				throw error
			})
			const result = await cache.fetchQuery(query)
			assert.deepEqual(result, {
				rows: undefined,
				error: true,
				denied: index >= 2,
			})
			assert.doesNotMatch(
				JSON.stringify(cache.getQueryData(query.queryKey)),
				/PRIVATE|payload/
			)
			assert.equal(cache.getQueryState(query.queryKey)?.error, null)
		}
	} finally {
		cache.clear()
	}
})

test('render projection hides rows during loading, errors and sibling denial while preserving a confirmed empty result', () => {
	const retry = () => undefined
	const base = {
		data: { rows: [a], error: false, denied: false },
		isFetching: false,
		isPending: false,
		error: null,
		denied: false,
		retry,
	}
	assert.deepEqual(analyticsDetailState(base).rows, [a])
	for (const flags of [
		{ isFetching: true },
		{ isPending: true },
		{ error: new Error('private') },
		{ denied: true },
	])
		assert.equal(analyticsDetailState({ ...base, ...flags }).rows, undefined)
	assert.equal(analyticsDetailState({ ...base, denied: true }).error, true)
	assert.equal(
		analyticsDetailState({
			...base,
			data: { rows: undefined, error: true, denied: false },
		}).error,
		true
	)
	assert.deepEqual(
		analyticsDetailState({
			...base,
			data: { rows: [], error: false, denied: false },
		}).rows,
		[]
	)
})

test('two open row observers load independently and one failure leaves its successful sibling intact', async () => {
	const cache = client(),
		first = deferred<Row[]>(),
		second = deferred<Row[]>()
	const qa = options('a', () => first.promise),
		qb = options('b', () => second.promise)
	const oa = new QueryObserver(cache, qa),
		ob = new QueryObserver(cache, qb)
	const ua = oa.subscribe(() => undefined),
		ub = ob.subscribe(() => undefined)
	const pa = oa.refetch({ cancelRefetch: false }),
		pb = ob.refetch({ cancelRefetch: false })
	try {
		first.resolve([a])
		await pa
		assert.deepEqual(oa.getCurrentResult().data?.rows, [a])
		assert.equal(ob.getCurrentResult().isFetching, true)
		second.reject(new Error('unavailable'))
		await pb
		assert.equal(ob.getCurrentResult().data?.error, true)
		assert.deepEqual(oa.getCurrentResult().data?.rows, [a])
	} finally {
		ua()
		ub()
		cache.clear()
	}
})

test('retrying one failed row reads it once more without refetching its sibling', async () => {
	const cache = client()
	let aCalls = 0,
		bCalls = 0
	const qa = options('a', async () => {
		aCalls++
		throw new Error('failed')
	})
	const qb = options('b', async () => {
		bCalls++
		return [b]
	})
	const oa = new QueryObserver(cache, qa),
		ob = new QueryObserver(cache, qb)
	const ua = oa.subscribe(() => undefined),
		ub = ob.subscribe(() => undefined)
	try {
		await Promise.all([
			oa.refetch({ cancelRefetch: false }),
			ob.refetch({ cancelRefetch: false }),
		])
		await cache.cancelQueries({ queryKey: qa.queryKey, exact: true })
		cache.removeQueries({ queryKey: qa.queryKey, exact: true })
		oa.setOptions(
			options(
				'a',
				async () => {
					aCalls++
					return [a]
				},
				2
			)
		)
		await oa.refetch({ cancelRefetch: false })
		assert.equal(aCalls, 2)
		assert.equal(bCalls, 1)
		assert.deepEqual(oa.getCurrentResult().data?.rows, [a])
		assert.deepEqual(ob.getCurrentResult().data?.rows, [b])
	} finally {
		ua()
		ub()
		cache.clear()
	}
})

test('closing a row cancels its signal and its ignored late response cannot populate a reopened generation', async () => {
	const cache = client(),
		pending = deferred<Row[]>()
	let signal: AbortSignal | undefined
	const old = options('a', async (s) => {
		signal = s
		return pending.promise
	})
	const observer = new QueryObserver(cache, old)
	const unsubscribe = observer.subscribe(() => undefined)
	const oldRead = observer.refetch({ cancelRefetch: false })
	try {
		await cache.cancelQueries({ queryKey: old.queryKey, exact: true })
		cache.removeQueries({ queryKey: old.queryKey, exact: true })
		unsubscribe()
		assert.equal(signal?.aborted, true)
		const current = options('a', async () => [b], 2)
		await cache.fetchQuery(current)
		pending.resolve([a])
		await oldRead
		assert.equal(cache.getQueryData(old.queryKey), undefined)
		assert.deepEqual(cache.getQueryData(current.queryKey)?.rows, [b])
	} finally {
		unsubscribe()
		cache.clear()
	}
})

test('late permission failure from a cancelled identity cannot deny the replacement identity', async () => {
	const cache = client(),
		pending = deferred<Row[]>()
	const old = options('a', () => pending.promise)
	const observer = new QueryObserver(cache, old),
		unsubscribe = observer.subscribe(() => undefined)
	const oldRead = observer.refetch({ cancelRefetch: false })
	try {
		unsubscribe()
		const currentPrefix = [
			...analyticsQueryPrefix({
				...identity,
				reconciliationKey: 'next-identity',
			}),
			'providers',
		]
		const current = options('a', async () => [b], 1, 'range+tag', currentPrefix)
		await cache.fetchQuery(current)
		pending.reject(new CinaTokenApiError('late', 403, 'http'))
		await oldRead
		assert.deepEqual(cache.getQueryData(current.queryKey), {
			rows: [b],
			error: false,
			denied: false,
		})
		assert.notEqual(cache.getQueryData(old.queryKey)?.denied, true)
	} finally {
		unsubscribe()
		cache.clear()
	}
})

test('unmounting one page observer cannot cancel another page with the same row and context', async () => {
	const cache = client(),
		first = deferred<Row[]>(),
		second = deferred<Row[]>()
	const signals: AbortSignal[] = []
	const qa = options('a', async (s) => {
		signals.push(s)
		return first.promise
	})
	const qb = options(
		'a',
		async (s) => {
			signals.push(s)
			return second.promise
		},
		1,
		'range+tag',
		[
			...analyticsQueryPrefix({ ...identity, instanceKey: 'page-b' }),
			'providers',
		]
	)
	const oa = new QueryObserver(cache, qa),
		ob = new QueryObserver(cache, qb)
	const ua = oa.subscribe(() => undefined),
		ub = ob.subscribe(() => undefined)
	const pa = oa.refetch({ cancelRefetch: false }),
		pb = ob.refetch({ cancelRefetch: false })
	try {
		ua()
		assert.equal(signals[0].aborted, true)
		assert.equal(signals[1].aborted, false)
		second.resolve([b])
		await pb
		first.resolve([a])
		await pa
		assert.deepEqual(ob.getCurrentResult().data?.rows, [b])
	} finally {
		ua()
		ub()
		cache.clear()
	}
})

test('effect-like unsubscribe and resubscribe restarts pending reads without reviving the cancelled result', async () => {
	const cache = client(),
		first = deferred<Row[]>(),
		second = deferred<Row[]>()
	const signals: AbortSignal[] = []
	const query = options('a', async (signal) => {
		signals.push(signal)
		return signals.length === 1 ? first.promise : second.promise
	})
	const observer = new QueryObserver(cache, query)
	const unsubscribeFirst = observer.subscribe(() => undefined)
	const initial = observer.refetch({ cancelRefetch: false })
	assert.equal(signals.length, 1)
	unsubscribeFirst()
	assert.equal(signals[0].aborted, true)
	const unsubscribeSecond = observer.subscribe(() => undefined)
	const restored = observer.refetch({ cancelRefetch: false })
	try {
		assert.equal(signals.length, 2)
		second.resolve([b])
		await restored
		first.resolve([a])
		await initial
		assert.equal(observer.getCurrentResult().isPending, false)
		assert.deepEqual(observer.getCurrentResult().data?.rows, [b])
	} finally {
		unsubscribeSecond()
		cache.clear()
	}
})
