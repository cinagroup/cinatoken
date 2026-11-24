/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { QueryClient } from '@tanstack/react-query'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import {
	listDisplayQueryKey,
	markListDisplayUnauthorized,
} from './list-display-recovery'
import { createAdminUsersApi } from './users-api'

function apiFor(data: unknown, status = 200) {
	const calls: { path: string; init: RequestInit }[] = []
	const transport = createCinaTokenCookieTransport(async (path, init) => {
		calls.push({ path: String(path), init: init ?? {} })
		return Response.json(data, { status })
	})
	const api = createAdminUsersApi({
		send: (path, schema, init, options) =>
			transport.send(path, schema, init, options),
		invalidResponse() {
			throw new Error('Invalid response')
		},
		sanitizeError(error) {
			return error instanceof Error ? error : new Error('Request failed')
		},
	})
	return { api, calls }
}
const billingCurrency = { value: 'CNY', source: 'configured' }
const zone = { value: 'Asia/Singapore', source: 'configured' }

test('display safely projects both settings through one same-origin no-store request', async () => {
	const { api, calls } = apiFor({
		success: true,
		data: {
			businessTimezone: { ...zone, revision: 'PRIVATE' },
			billingCurrency,
			webhooks: { url: 'PRIVATE' },
		},
	})
	assert.deepEqual(await api.userDisplay(), {
		timezone: zone.value,
		timezoneSource: 'configured',
		currency: 'CNY',
		currencySource: 'configured',
	})
	assert.equal(calls.length, 1)
	assert.equal(calls[0].path, '/api/admin/config/overview')
	assert.equal(calls[0].init.credentials, 'same-origin')
	assert.equal(calls[0].init.cache, 'no-store')
	assert.equal(new Headers(calls[0].init.headers).get('Authorization'), null)
})

test('old currency-only overview retains currency and marks timezone unverified', async () => {
	const { api } = apiFor({ success: true, data: { billingCurrency } })
	assert.deepEqual(await api.userDisplay(), {
		timezone: null,
		timezoneSource: null,
		currency: 'CNY',
		currencySource: 'configured',
	})
	assert.deepEqual(await api.userCurrency(), {
		value: 'CNY',
		source: 'configured',
	})
})

test('unsupported or malformed currency does not hide a verified timezone', async () => {
	for (const billing of [
		undefined,
		null,
		{ value: 'EUR', source: 'unsupported' },
		{ value: 'usd', source: 'configured' },
		{ value: 'CNY', source: 'missing' },
	]) {
		const result = await apiFor({
			success: true,
			data: { businessTimezone: zone, billingCurrency: billing },
		}).api.userDisplay()
		assert.equal(result.timezone, 'Asia/Singapore')
		assert.equal(result.currency, null)
		assert.equal(result.currencySource, null)
	}
})

test('missing and invalid timezone fallback must be UTC; configured UTC stays configured', async () => {
	for (const source of ['configured', 'legacy', 'missing', 'invalid']) {
		const result = await apiFor({
			success: true,
			data: {
				billingCurrency: { value: 'USD', source: 'missing' },
				businessTimezone: { value: 'UTC', source },
			},
		}).api.userDisplay()
		assert.equal(result.timezone, 'UTC')
		assert.equal(result.timezoneSource, source)
		assert.equal(result.currency, 'USD')
		assert.equal(result.currencySource, 'missing')
	}
})

test('malformed zones never reach Intl rendering and do not destroy valid currency', async () => {
	for (const value of [
		undefined,
		null,
		{ value: 'Missing/Zone', source: 'configured' },
		{ value: 'Asia/Singapore', source: 'invalid' },
		{ value: 'Asia/Singapore', source: 'missing' },
		{ value: 'UTC', source: 'other' },
		{ value: '', source: 'configured' },
	]) {
		const result = await apiFor({
			success: true,
			data: { billingCurrency, businessTimezone: value },
		}).api.userDisplay()
		assert.equal(result.timezone, null)
		assert.equal(result.timezoneSource, null)
		assert.equal(result.currency, 'CNY')
	}
})

test('HTTP and envelope errors stay failures; abort prevents a display request', async () => {
	for (const status of [401, 403, 503]) {
		await assert.rejects(
			apiFor({ success: false }, status).api.userDisplay(),
			(error) => error instanceof CinaTokenApiError && error.status === status
		)
	}
	for (const data of [
		{ success: false, data: {} },
		{ success: true, data: null },
		{},
	])
		await assert.rejects(apiFor(data).api.userDisplay())
	const { api, calls } = apiFor({ success: true, data: { billingCurrency } })
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(api.userDisplay({ signal: controller.signal }))
	assert.equal(calls.length, 0)
})

test('401 revalidation is bounded per principal across epochs and separated across APIs', () => {
	const api = {}
	const identity = (epoch: number, user = 'a') =>
		JSON.stringify([user, 'console', epoch])
	assert.equal(markListDisplayUnauthorized(api, identity(1)), true)
	assert.equal(markListDisplayUnauthorized(api, identity(2)), false)
	assert.equal(markListDisplayUnauthorized(api, identity(3)), false)
	assert.equal(markListDisplayUnauthorized(api, identity(1, 'b')), true)
	assert.equal(markListDisplayUnauthorized({}, identity(1)), true)
})

test('display query caches isolate scope identity API domain and mounted consumer', () => {
	const api = {}
	const key = listDisplayQueryKey('scope', 'identity', 'users', api, 'instance')
	const others = [
		listDisplayQueryKey('other', 'identity', 'users', api, 'instance'),
		listDisplayQueryKey('scope', 'other', 'users', api, 'instance'),
		listDisplayQueryKey('scope', 'identity', 'gateway-keys', api, 'instance'),
		listDisplayQueryKey('scope', 'identity', 'users', {}, 'instance'),
		listDisplayQueryKey('scope', 'identity', 'users', api, 'other'),
	]
	for (const other of others) assert.notDeepEqual(other, key)
	assert.deepEqual(
		listDisplayQueryKey('scope', 'identity', 'users', api, 'instance'),
		key
	)
})

test('Integration Key display data cannot replace another list or consumer cache', () => {
	const client = new QueryClient()
	const api = {}
	const key = listDisplayQueryKey(
		'scope',
		'identity',
		'access-keys',
		api,
		'instance'
	)
	const others = [
		listDisplayQueryKey('scope', 'identity', 'users', api, 'instance'),
		listDisplayQueryKey('scope', 'identity', 'gateway-keys', api, 'instance'),
		listDisplayQueryKey('other', 'identity', 'access-keys', api, 'instance'),
		listDisplayQueryKey('scope', 'other', 'access-keys', api, 'instance'),
		listDisplayQueryKey('scope', 'identity', 'access-keys', {}, 'instance'),
		listDisplayQueryKey('scope', 'identity', 'access-keys', api, 'other'),
	]
	try {
		client.setQueryData(key, { timezone: 'America/New_York' })
		for (const other of others) {
			assert.equal(client.getQueryData(other), undefined)
			client.setQueryData(other, { timezone: 'Asia/Singapore' })
		}
		assert.deepEqual(client.getQueryData(key), {
			timezone: 'America/New_York',
		})
		client.removeQueries({ queryKey: key, exact: true })
		assert.equal(client.getQueryData(key), undefined)
		for (const other of others)
			assert.deepEqual(client.getQueryData(other), {
				timezone: 'Asia/Singapore',
			})
	} finally {
		client.clear()
	}
})
