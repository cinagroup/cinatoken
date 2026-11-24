/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError } from '../../../api'
import { ADMIN_DOMAIN_SUBJECT_HEADER } from '../../domain-transport'
import { AdminDomainWriteError } from '../../domain-write-recovery'
import {
	createProvidersApi,
	type ProviderAdminTransport,
	type ProvidersApi,
} from '../../provider-api'
import {
	adminProviderSchema,
	type AdminProvider,
} from '../../provider-contracts'
import {
	AnalyticsProviderDirectoryRechecks,
	analyticsProviderDirectoryQueryOptions,
	readAnalyticsProviderDirectory,
	visibleAnalyticsProviderDirectory,
} from './analytics-provider-directory'

const raw = {
	id: 'provider-one',
	name: 'Provider account',
	kind: 'custom/type',
	kind_labels: { en: 'Custom type', zh: '自定义类型' },
	vendor_key: 'other',
	icon_key: 'other',
	endpoints: JSON.stringify({
		openai: { base: 'https://upstream.example/v1/' },
	}),
	api_key: 'sk-…abcd',
	status: 'active',
	description: 'INTERNAL-DESCRIPTION',
	created_at: '2026-10-23T00:00:00Z',
	has_pending_key: false,
	routes_count: 2,
	active_routes_count: 1,
	raw_api_key: 'PRIVATE-CREDENTIAL',
}
const entry = {
	id: raw.id,
	name: raw.name,
	kind: raw.kind,
	kind_labels: raw.kind_labels,
}
const input = {
	scopeKey: 'console-scope-a',
	reconciliationKey: JSON.stringify(['user-a', 'console-a', 1]),
	subject: 'console-a',
	enabled: true,
}
function client(): QueryClient {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	})
}
function apiWith(
	providerList: Pick<ProvidersApi, 'providerList'>['providerList']
): Pick<ProvidersApi, 'providerList'> {
	return { providerList }
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
function transportFixture(body: unknown) {
	const calls: { path: string; init: RequestInit; signal?: AbortSignal }[] = []
	const transport: ProviderAdminTransport = {
		async send(path, schema, init, options) {
			calls.push({ path, init, signal: options.signal })
			return schema.parse(body)
		},
		invalidResponse(message): never {
			throw new CinaTokenApiError(message, 200, 'invalid-response')
		},
		sanitizeError(error) {
			return error instanceof Error ? error : new Error('Read failed')
		},
	}
	return { api: createProvidersApi(transport), calls }
}

test('directory projects only identity and kind fields and detaches localized labels before caching', async () => {
	const row = adminProviderSchema.parse(raw)
	const api = apiWith(async () => [row])
	const controller = new AbortController()
	const result = await readAnalyticsProviderDirectory(
		api,
		input.subject,
		controller.signal
	)
	assert.equal(result.status, 'ready')
	if (result.status !== 'ready') assert.fail('Expected a complete directory')
	assert.deepEqual([...result.providers.values()], [entry])
	assert.notEqual(result.providers.get(row.id), row)
	assert.notEqual(result.providers.get(row.id)?.kind_labels, row.kind_labels)
	row.kind_labels!.en = 'changed'
	assert.equal(result.providers.get(row.id)?.kind_labels?.en, 'Custom type')
	assert.doesNotMatch(
		JSON.stringify([...result.providers]),
		/api_key|endpoints|description|PRIVATE|INTERNAL/
	)
})

test('the provider transport uses an expected subject header and signal with no extra identity or catalog request', async () => {
	const f = transportFixture({ success: true, data: [raw], count: 1 })
	const controller = new AbortController()
	const result = await readAnalyticsProviderDirectory(
		f.api,
		'console:测试',
		controller.signal
	)
	assert.equal(result.status, 'ready')
	assert.equal(f.calls.length, 1)
	assert.equal(f.calls[0]?.path, '/api/admin/providers')
	assert.equal(f.calls[0]?.init.method ?? 'GET', 'GET')
	assert.equal(f.calls[0]?.signal, controller.signal)
	const headers = new Headers(f.calls[0]?.init.headers)
	assert.equal(
		headers.get(ADMIN_DOMAIN_SUBJECT_HEADER),
		encodeURIComponent('console:测试')
	)
	assert.equal(headers.get('Authorization'), null)
	assert.equal(headers.get('Cookie'), null)
	assert.equal(headers.get('X-CinaToken-Workspace'), null)
})

test('malformed expected subjects are rejected before the provider transport dispatches', async () => {
	for (const subject of [' console-a ', 'console\u0000a']) {
		const f = transportFixture({ success: true, data: [raw], count: 1 })
		await assert.rejects(
			readAnalyticsProviderDirectory(
				f.api,
				subject,
				new AbortController().signal
			),
			(error: unknown) =>
				error instanceof AdminDomainWriteError && error.code === 'subject'
		)
		assert.equal(f.calls.length, 0)
	}
})

test('complete empty directories are ready and missing optional kind fields remain absent', async () => {
	const empty = transportFixture({ success: true, data: [], count: 0 })
	const ready = await readAnalyticsProviderDirectory(
		empty.api,
		input.subject,
		new AbortController().signal
	)
	assert.equal(ready.status, 'ready')
	if (ready.status !== 'ready')
		assert.fail('Expected an empty complete directory')
	assert.equal(ready.providers.size, 0)
	const legacy = transportFixture({
		success: true,
		data: [{ ...raw, kind: undefined, kind_labels: undefined }],
		count: 1,
	})
	const result = await readAnalyticsProviderDirectory(
		legacy.api,
		input.subject,
		new AbortController().signal
	)
	if (result.status !== 'ready') assert.fail('Expected a legacy directory')
	assert.deepEqual(
		[...result.providers.values()],
		[{ id: raw.id, name: raw.name }]
	)
})

test('invalid provider collections are unavailable instead of becoming partial or missing directories', async () => {
	const cache = client()
	try {
		for (const body of [
			{ success: true, data: [raw], count: 2 },
			{ success: true, data: [raw, raw], count: 2 },
			{ success: true, data: [{ ...raw, kind: 42 }], count: 1 },
			{ success: true, data: [], count: 1 },
		]) {
			const f = transportFixture(body)
			const options = analyticsProviderDirectoryQueryOptions({
				...input,
				api: f.api,
			})
			assert.deepEqual(await cache.fetchQuery(options), {
				directory: { status: 'unavailable' },
				identityInvalid: false,
			})
		}
	} finally {
		cache.clear()
	}
})

test('only an HTTP 401 requests identity reconciliation; 403 and other failures stay local', async () => {
	const cache = client()
	try {
		for (const [error, identityInvalid] of [
			[new CinaTokenApiError('Denied', 401, 'http'), true],
			[new CinaTokenApiError('Forbidden', 403, 'http'), false],
			[new CinaTokenApiError('Unavailable', 503, 'http'), false],
			[new CinaTokenApiError('Network', 0, 'network'), false],
			[new CinaTokenApiError('Malformed', 401, 'invalid-response'), false],
			[new AdminDomainWriteError('subject', 401), false],
		] as const) {
			const options = analyticsProviderDirectoryQueryOptions({
				...input,
				api: apiWith(async () => {
					throw error
				}),
			})
			assert.deepEqual(await cache.fetchQuery(options), {
				directory: { status: 'unavailable' },
				identityInvalid,
			})
		}
	} finally {
		cache.clear()
	}
})

test('disabled, missing subject and absent API never dispatch even when options are explicitly fetched', async () => {
	let calls = 0
	const api = apiWith(async () => {
		calls++
		return []
	})
	const cache = client()
	try {
		for (const patch of [
			{ enabled: false },
			{ subject: undefined },
			{ subject: '' },
			{ api: undefined },
		]) {
			const options = analyticsProviderDirectoryQueryOptions({
				...input,
				api,
				...patch,
			})
			assert.equal(options.enabled, false)
			assert.deepEqual(await cache.fetchQuery(options), {
				directory: { status: 'unavailable' },
				identityInvalid: false,
			})
		}
		assert.equal(calls, 0)
	} finally {
		cache.clear()
	}
})

test('scope, reconciliation, subject, API and disabled transitions cannot share a directory cache key', () => {
	const api = apiWith(async () => [])
	const original = analyticsProviderDirectoryQueryOptions({
		...input,
		api,
	}).queryKey
	assert.deepEqual(
		analyticsProviderDirectoryQueryOptions({ ...input, api }).queryKey,
		original
	)
	for (const patch of [
		{ scopeKey: 'console-scope-b' },
		{ reconciliationKey: JSON.stringify(['user-a', 'console-a', 2]) },
		{ subject: 'console-b' },
		{ api: apiWith(async () => []) },
		{ enabled: false },
	])
		assert.notDeepEqual(
			analyticsProviderDirectoryQueryOptions({ ...input, api, ...patch })
				.queryKey,
			original
		)
})

test('refresh hides old directory immediately and a failed refresh replaces its cached projection', async () => {
	const cache = client()
	const response = deferred<AdminProvider[]>()
	let reads = 0
	const api = apiWith(async () =>
		++reads === 1 ? [adminProviderSchema.parse(raw)] : response.promise
	)
	const options = analyticsProviderDirectoryQueryOptions({ ...input, api })
	try {
		const first = await cache.fetchQuery(options)
		assert.equal(first.directory.status, 'ready')
		const refresh = cache.fetchQuery(options)
		assert.deepEqual(
			visibleAnalyticsProviderDirectory({
				enabled: true,
				isFetching: true,
				isPending: false,
				error: null,
				data: first,
			}),
			{ status: 'loading' }
		)
		response.reject(new CinaTokenApiError('Forbidden', 403, 'http'))
		const next = await refresh
		assert.deepEqual(next, {
			directory: { status: 'unavailable' },
			identityInvalid: false,
		})
		assert.deepEqual(cache.getQueryData(options.queryKey), next)
		assert.equal(
			JSON.stringify(cache.getQueryData(options.queryKey)).includes(
				'provider-one'
			),
			false
		)
		assert.deepEqual(
			visibleAnalyticsProviderDirectory({
				enabled: true,
				isFetching: false,
				isPending: false,
				error: null,
				data: next,
			}),
			{ status: 'unavailable' }
		)
	} finally {
		cache.clear()
	}
})

test('render guards withhold ready data while disabled, pending, fetching or errored', () => {
	const data = {
		directory: {
			status: 'ready' as const,
			providers: new Map([[entry.id, entry]]),
		},
		identityInvalid: false,
	}
	const base = {
		enabled: true,
		isFetching: false,
		isPending: false,
		error: null,
		data,
	}
	assert.equal(visibleAnalyticsProviderDirectory(base), data.directory)
	assert.deepEqual(
		visibleAnalyticsProviderDirectory({ ...base, enabled: false }),
		{ status: 'unavailable' }
	)
	assert.deepEqual(
		visibleAnalyticsProviderDirectory({ ...base, isPending: true }),
		{ status: 'loading' }
	)
	assert.deepEqual(
		visibleAnalyticsProviderDirectory({ ...base, isFetching: true }),
		{ status: 'loading' }
	)
	assert.deepEqual(
		visibleAnalyticsProviderDirectory({
			...base,
			error: new Error('Unavailable'),
		}),
		{ status: 'unavailable' }
	)
})

test('pre-aborted reads and late successful responses cannot publish a directory', async () => {
	const controller = new AbortController()
	let calls = 0
	const response = deferred<AdminProvider[]>()
	const api = apiWith(async () => {
		calls++
		return response.promise
	})
	controller.abort()
	await assert.rejects(
		readAnalyticsProviderDirectory(api, input.subject, controller.signal),
		{ name: 'AbortError' }
	)
	assert.equal(calls, 0)
	const late = new AbortController()
	const reading = readAnalyticsProviderDirectory(
		api,
		input.subject,
		late.signal
	)
	const rejected = assert.rejects(reading, { name: 'AbortError' })
	late.abort()
	response.resolve([adminProviderSchema.parse(raw)])
	await rejected
})

test('query cancellation fences a late 401 and successful explicit retry can recover the same scope', async () => {
	const cache = client()
	const response = deferred<AdminProvider[]>()
	let reads = 0
	const options = analyticsProviderDirectoryQueryOptions({
		...input,
		api: apiWith(async () => (++reads === 1 ? response.promise : [])),
	})
	try {
		const reading = cache.fetchQuery(options)
		const rejected = assert.rejects(reading)
		await cache.cancelQueries({ queryKey: options.queryKey, exact: true })
		response.reject(new CinaTokenApiError('Old identity', 401, 'http'))
		await rejected
		await Promise.resolve()
		assert.equal(cache.getQueryData(options.queryKey), undefined)
		const retried = await cache.fetchQuery(options)
		assert.equal(retried.directory.status, 'ready')
		assert.equal(retried.identityInvalid, false)
		assert.equal(reads, 2)
	} finally {
		cache.clear()
	}
})

test('automatic identity rechecks are reserved once across epoch changes and remount-like scopes', () => {
	const checks = new AnalyticsProviderDirectoryRechecks()
	assert.equal(checks.reserve(input.reconciliationKey, input.subject), true)
	assert.equal(checks.reserve(input.reconciliationKey, input.subject), false)
	assert.equal(
		checks.reserve(JSON.stringify(['user-a', 'console-a', 99]), input.subject),
		false
	)
	assert.equal(
		checks.reserve(JSON.stringify(['user-b', 'console-a', 99]), input.subject),
		true
	)
	assert.equal(
		checks.reserve(JSON.stringify(['user-a', 'console-b', 99]), 'console-b'),
		true
	)
})

test('same-identity page observers have isolated keys so old-page cleanup cannot cancel the new page', async () => {
	const cache = client()
	const oldResponse = deferred<AdminProvider[]>()
	const newResponse = deferred<AdminProvider[]>()
	const signals: AbortSignal[] = []
	const api = apiWith(async (options) => {
		assert.ok(options?.signal)
		signals.push(options.signal)
		return signals.length === 1 ? oldResponse.promise : newResponse.promise
	})
	const oldOptions = analyticsProviderDirectoryQueryOptions(
		{ ...input, api },
		'old-page'
	)
	const newOptions = analyticsProviderDirectoryQueryOptions(
		{ ...input, api },
		'new-page'
	)
	const oldObserver = new QueryObserver(cache, oldOptions)
	const newObserver = new QueryObserver(cache, newOptions)
	const unsubscribeOld = oldObserver.subscribe(() => undefined)
	const oldSetup = oldObserver.refetch({ cancelRefetch: false })
	const unsubscribeNew = newObserver.subscribe(() => undefined)
	const newSetup = newObserver.refetch({ cancelRefetch: false })
	try {
		assert.notDeepEqual(oldOptions.queryKey, newOptions.queryKey)
		assert.equal(signals.length, 2)
		await cache.cancelQueries({ queryKey: oldOptions.queryKey, exact: true })
		cache.removeQueries({ queryKey: oldOptions.queryKey, exact: true })
		unsubscribeOld()
		assert.equal(signals[0]?.aborted, true)
		assert.equal(signals[1]?.aborted, false)
		assert.ok(
			cache.getQueryCache().find({ queryKey: newOptions.queryKey, exact: true })
		)
		newResponse.resolve([
			adminProviderSchema.parse({ ...raw, name: 'New page' }),
		])
		const current = await newSetup
		assert.equal(current.isPending, false)
		assert.equal(current.data?.directory.status, 'ready')
		if (current.data?.directory.status !== 'ready')
			assert.fail('New page must complete')
		assert.equal(current.data.directory.providers.get(raw.id)?.name, 'New page')
		oldResponse.resolve([
			adminProviderSchema.parse({ ...raw, name: 'Late old page' }),
		])
		await oldSetup
		assert.equal(cache.getQueryData(oldOptions.queryKey), undefined)
		assert.equal(newObserver.getCurrentResult().data, current.data)
	} finally {
		unsubscribeOld()
		unsubscribeNew()
		cache.clear()
	}
})

test('same-instance setup cleanup setup restores a removed query and cannot remain pending after StrictMode replay', async () => {
	const cache = client()
	const firstResponse = deferred<AdminProvider[]>()
	const secondResponse = deferred<AdminProvider[]>()
	const signals: AbortSignal[] = []
	const api = apiWith(async (options) => {
		assert.ok(options?.signal)
		signals.push(options.signal)
		return signals.length === 1 ? firstResponse.promise : secondResponse.promise
	})
	const options = analyticsProviderDirectoryQueryOptions(
		{ ...input, api },
		'same-instance'
	)
	const observer = new QueryObserver(cache, options)
	const unsubscribe = observer.subscribe(() => undefined)
	const firstSetup = observer.refetch({ cancelRefetch: false })
	try {
		assert.equal(
			signals.length,
			1,
			'Initial setup must reuse the in-flight mount read'
		)
		await cache.cancelQueries({ queryKey: options.queryKey, exact: true })
		cache.removeQueries({ queryKey: options.queryKey, exact: true })
		assert.equal(signals[0]?.aborted, true)
		const secondSetup = observer.refetch({ cancelRefetch: false })
		assert.equal(signals.length, 2)
		assert.equal(signals[1]?.aborted, false)
		firstResponse.resolve([
			adminProviderSchema.parse({ ...raw, name: 'Cancelled result' }),
		])
		secondResponse.resolve([
			adminProviderSchema.parse({ ...raw, name: 'Restored result' }),
		])
		await firstSetup
		const current = await secondSetup
		assert.equal(current.isPending, false)
		assert.equal(current.isFetching, false)
		if (current.data?.directory.status !== 'ready')
			assert.fail('Replay must restore a ready directory')
		assert.equal(
			current.data.directory.providers.get(raw.id)?.name,
			'Restored result'
		)
		assert.deepEqual(cache.getQueryData(options.queryKey), current.data)
	} finally {
		unsubscribe()
		cache.clear()
	}
})
