/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../../api'
import { UserAnalyticsTable } from './UserAnalyticsTable'
import { adminUserAnalyticsMessages } from './messages'
import { createAdminUserAnalyticsApi } from './user-analytics-api'
import { userAnalyticsRowSchema } from './user-analytics-contracts'
import {
	userAnalyticsWalletBalance,
	formatUserAnalyticsWallet,
	userAnalyticsCsv,
	userKeyLogHref,
} from './user-analytics-domain'
import {
	userAnalyticsFixtureId as userId,
	userAnalyticsFixtureRow as row,
	userAnalyticsFixtureKeys as keys,
	userAnalyticsFixtureModel as model,
} from './user-analytics-fixtures'
import {
	userKeyAnalyticsResponseSchema,
	userKeysPath,
	userKeyModelsPath,
} from './user-key-analytics'

const range = { startUtc: '2026-10-18 00:00:00', endUtc: '2026-10-18 08:00:00' }

test('wallet snapshots keep signed balances and micro amounts, with no balance guessed from ambiguous or partial groups', () => {
	assert.equal(
		userAnalyticsWalletBalance(userAnalyticsRowSchema.parse(row)),
		-2
	)
	for (const patch of [
		{ user_id: null },
		{ user_id: undefined },
		{ wallet_spent: undefined },
		{ wallet_granted: null },
	])
		assert.equal(userAnalyticsWalletBalance({ ...row, ...patch }), null)
	assert.equal(
		userAnalyticsWalletBalance({
			...row,
			wallet_granted: 0.000002,
			wallet_spent: 0.000001,
		}),
		0.000001
	)
	assert.equal(
		userAnalyticsWalletBalance({ ...row, wallet_granted: 0, wallet_spent: 0 }),
		0
	)
	assert.match(formatUserAnalyticsWallet(0.000001, 'USD', 'en')!, /0\.000001/)
	assert.equal(formatUserAnalyticsWallet(undefined, 'USD', 'en'), null)
	assert.equal(formatUserAnalyticsWallet(0, null, 'en'), null)
	for (const patch of [
		{ wallet_granted: -1 },
		{ wallet_spent: Infinity },
		{ user_id: 'not-a-user-id' },
	])
		assert.equal(
			userAnalyticsRowSchema.safeParse({ ...row, ...patch }).success,
			false
		)
})
test('CSV appends account/wallet snapshots without inventing a balance for merged email groups', () => {
	const csv = userAnalyticsCsv(
		[row, { ...row, user_id: null, user_email: 'shared@example.test' }],
		range,
		'USD'
	)
	const [header, unique, shared] = csv
		.replace(/^\uFEFF/u, '')
		.split('\r\n')
		.map((line) => line.split(','))
	assert.deepEqual(header!.slice(-4), [
		'user_id',
		'wallet_granted',
		'wallet_spent',
		'wallet_balance',
	])
	assert.deepEqual(unique!.slice(-4), [userId, '1', '3', '-2'])
	assert.deepEqual(shared!.slice(-4), ['', '1', '3', ''])
})
test('key aggregate projection retains unused and deleted history but rejects duplicate identities and contradictory counts', () => {
	const result = userKeyAnalyticsResponseSchema.parse({
		success: true,
		data: keys.map((key) => ({ ...key, key_hash: 'PRIVATE' })),
		private_notes: 'PRIVATE',
	})
	assert.equal(result.data[1]?.request_count, 0)
	assert.equal(result.data[2]?.api_key_id, null)
	assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
	for (const data of [
		[keys[0], keys[0]],
		[keys[2], keys[2]],
		[{ ...keys[0], success_count: 3 }],
		[{ ...keys[0], distinct_models: 3 }],
		[{ ...keys[2], key_name: 'Arbitrary key' }],
		[{ ...keys[0], api_key_id: ' key ' }],
	])
		assert.equal(
			userKeyAnalyticsResponseSchema.safeParse({ success: true, data }).success,
			false
		)
})
function fixture(
	reply: (path: string, init: RequestInit) => Promise<Response> | Response
) {
	const calls: { path: string; init: RequestInit }[] = []
	const transport = createCinaTokenCookieTransport(async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		calls.push(call)
		return reply(call.path, call.init)
	})
	const api = createAdminUserAnalyticsApi({
		...transport,
		invalidResponse() {
			throw new CinaTokenApiError('Invalid', 200, 'invalid-response')
		},
		sanitizeError(error) {
			return error instanceof Error ? error : new Error('Read failed')
		},
	})
	return { api, calls }
}
test('key and model reads bind exact user/Key IDs and range, without substituting a log email', async () => {
	const { api, calls } = fixture((path) =>
		Response.json({
			success: true,
			data: path.includes('/keys?') ? keys : [model],
			tags: [],
		})
	)
	await api.userKeys(range.startUtc, range.endUtc, userId)
	await api.userKeyModels(
		range.startUtc,
		range.endUtc,
		userId,
		keys[0]!.api_key_id!
	)
	for (const call of calls) {
		assert.equal(call.init.credentials, 'same-origin')
		assert.equal(call.init.cache, 'no-store')
		assert.equal(call.init.method, undefined)
		assert.equal(new Headers(call.init.headers).get('Authorization'), null)
	}
	const keyQuery = new URL(calls[0]!.path, 'https://example.test').searchParams
	assert.deepEqual(Object.fromEntries(keyQuery), {
		start_date: range.startUtc,
		end_date: range.endUtc,
		user_id: userId,
	})
	const modelQuery = new URL(calls[1]!.path, 'https://example.test')
		.searchParams
	assert.deepEqual(Object.fromEntries(modelQuery), {
		start_date: range.startUtc,
		end_date: range.endUtc,
		user_id: userId,
		api_key_id: keys[0]!.api_key_id,
	})
	assert.deepEqual(
		Object.fromEntries(
			new URL(
				userKeyLogHref(userId, keys[0]!.api_key_id!, range, model),
				'https://example.test'
			).searchParams
		),
		{
			...Object.fromEntries(modelQuery),
			model_id: model.model_id,
			route_group: 'default',
		}
	)
	assert.throws(() =>
		userKeysPath(range.startUtc, range.endUtc, 'alice@example.test')
	)
	assert.throws(() =>
		userKeyModelsPath(range.startUtc, range.endUtc, userId, '')
	)
	assert.throws(() =>
		userKeyModelsPath(range.startUtc, range.endUtc, userId, ' key ')
	)
})
test('late key results are discarded after cancellation and malformed success is never accepted', async () => {
	const controller = new AbortController()
	const { api } = fixture(() => {
		controller.abort()
		return Response.json({ success: true, data: keys })
	})
	await assert.rejects(
		api.userKeys(range.startUtc, range.endUtc, userId, {
			signal: controller.signal,
		})
	)
	const invalid = fixture(() =>
		Response.json({ success: true, data: [keys[0], keys[0]] })
	)
	await assert.rejects(
		invalid.api.userKeys(range.startUtc, range.endUtc, userId)
	)
})
test('four-language rendered Key drilldown keeps deleted history inert, wallet signs and exact model log links', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const i18n = createInstance()
		await i18n.init({
			lng: locale,
			resources: {
				[locale]: {
					translation: {
						cinatoken: {
							adminUserAnalytics: adminUserAnalyticsMessages[locale],
						},
					},
				},
			},
			interpolation: { escapeValue: false },
		})
		const html = renderToStaticMarkup(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(UserAnalyticsTable, {
					rows: [row],
					range,
					view: 'all',
					details: new Map([
						[
							row.user_email,
							{
								kind: 'keys' as const,
								state: { rows: keys, loading: false, error: false, retry() {} },
								keyModels: new Map([
									[
										keys[0]!.api_key_id!,
										{ rows: [model], loading: false, error: false, retry() {} },
									],
								]),
								toggleKey() {},
							},
						],
					]),
					logsAllowed: true,
					currency: 'USD',
					timezone: 'UTC',
					locale,
					tokenMode: 'numeric',
					sortKey: 'request_count',
					sortDirection: 'desc',
					onSort() {},
					onToggle() {},
				})
			)
		)
		assert.ok(html.includes(adminUserAnalyticsMessages[locale].deletedKey))
		assert.ok(html.includes(formatUserAnalyticsWallet(-2, 'USD', locale)!))
		assert.match(html, /colSpan="14"/u)
		assert.ok(html.includes('user_id=' + userId))
		assert.ok(html.includes('api_key_id=' + keys[0]!.api_key_id!))
		assert.ok(!html.includes('api_key_id=null'))
		assert.ok(!html.includes('cinatoken.adminUserAnalytics.'))
	}
})
