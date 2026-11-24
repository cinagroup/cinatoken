/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { adminDomainFixtureAuth } from '../domain-api-test-fixture'
import {
	userChargedCostFactorsSchema,
	chargedFactorRows,
	normalizeChargedFactorRows,
	chargedFactorsEqual,
} from '../user-charged-factors'
import { adminUserListRowSchema } from '../users/users-contracts'
import { UserDetailFactors } from './UserDetailFactors'
import { adminUserDetailMessages } from './messages'
import { createAdminUserDetailApi } from './user-detail-api'
import { userDetailSchema } from './user-detail-contracts'
import { buildFactorPatch } from './user-detail-domain'
import {
	factorFixtureUser as user,
	factorFixturePreview as preview,
} from './user-factor-fixtures'
import {
	userModelPreviewSchema,
	userModelPreviewQuery,
	formatUserModelPreviewFactor,
} from './user-factor-preview'

const options = {
	expectedConsoleSubject: 'fixture-subject',
	expectedUserId: 'fixture-user',
}
test('list/detail accept group factors and retain wallet and RPM', () => {
	const detail = userDetailSchema.parse(user),
		list = adminUserListRowSchema.parse({
			...user,
			active_keys_count: 1,
			keys_count: 1,
		})
	assert.deepEqual(detail.charged_cost_factors, user.charged_cost_factors)
	assert.deepEqual(list.charged_cost_factors, user.charged_cost_factors)
	assert.equal(detail.wallet_balance, 17)
	assert.deepEqual(list.rate_limit, { rpm: 120 })
	for (const value of [
		{ m: { vip: -1 } },
		{ m: { vip: '0.5' } },
		{ m: Infinity },
	])
		assert.equal(userChargedCostFactorsSchema.safeParse(value).success, false)
})
test('group edits canonicalize specific groups and wildcard and preserve zero/tiny amounts', () => {
	assert.deepEqual(
		normalizeChargedFactorRows([
			{ modelId: ' Model ', routeGroup: ' VIP ', factor: '0' },
			{ modelId: 'Model', routeGroup: '*', factor: '1e-12' },
			{ modelId: 'other', factor: '0.8' },
		]),
		{ Model: { vip: 0, '*': 1e-12 }, other: 0.8 }
	)
	assert.deepEqual(
		normalizeChargedFactorRows([
			{ modelId: 'm', routeGroup: '*', factor: '0' },
		]),
		{ m: 0 }
	)
	assert.equal(normalizeChargedFactorRows([]), null)
})
test('duplicate canonical pairs and invalid values reject before dispatch', () => {
	for (const rows of [
		[
			{ modelId: 'm', routeGroup: 'VIP', factor: '1' },
			{ modelId: 'm', routeGroup: ' vip ', factor: '0.5' },
		],
		[{ modelId: 'm', factor: '-1' }],
		[{ modelId: 'm', factor: 'Infinity' }],
		[{ modelId: 'm', factor: '1e999' }],
		[{ modelId: 'm', routeGroup: ' ', factor: '1' }],
		[{ modelId: '', factor: '1' }],
	])
		assert.throws(() => normalizeChargedFactorRows(rows))
})
test('no-op detection ignores order and wildcard-only representation; removal is explicit null', () => {
	assert.equal(
		buildFactorPatch(user.charged_cost_factors, [
			{ modelId: 'image/model', factor: '1' },
			{ modelId: 'vendor/model', routeGroup: 'vip', factor: '0.5' },
			{ modelId: 'vendor/model', routeGroup: '*', factor: '0.8' },
		]),
		null
	)
	assert.equal(chargedFactorsEqual({ m: { '*': 0.5 } }, { m: 0.5 }), true)
	assert.deepEqual(buildFactorPatch({ m: 1 }, []), {
		charged_cost_factors: null,
		reason: 'gwui:charged-cost-factors',
	})
})
test('prototype-named model/group rows stay own entries', () => {
	const value = normalizeChargedFactorRows([
		{ modelId: 'constructor', routeGroup: 'toString', factor: '0.5' },
		{ modelId: 'constructor', routeGroup: '*', factor: '1' },
	])
	assert.deepEqual(Object.keys(value ?? {}), ['constructor'])
	assert.deepEqual(
		chargedFactorRows(value).map((row) => row.routeGroup),
		['tostring', '*']
	)
})
function fixture(reply: (path: string, init: RequestInit) => unknown) {
	const calls: { path: string; init: RequestInit }[] = []
	const transport = createCinaTokenCookieTransport(async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		calls.push(call)
		return new Response(
			JSON.stringify(
				adminDomainFixtureAuth(call.path) ?? reply(call.path, call.init)
			),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		)
	})
	const api = createAdminUserDetailApi({
		...transport,
		invalidResponse() {
			throw new CinaTokenApiError('Invalid', 200, 'invalid-response')
		},
		sanitizeError(error) {
			return error instanceof Error ? error : new Error('Failed')
		},
	})
	return { api, calls }
}
test('factor PATCH uses fresh subject, exact factor/reason payload and normalized saved confirmation', async () => {
	const { api, calls } = fixture(() => ({
		success: true,
		data: { ...user, charged_cost_factors: { m: 0.5 } },
	}))
	let dispatch = 0
	const result = await api.saveUserFactors(
		user.id,
		user.id,
		{ m: { '*': 0.5 } },
		' reason ',
		{
			...options,
			onDispatch: () => {
				dispatch++
			},
		}
	)
	assert.equal(dispatch, 1)
	assert.deepEqual(
		calls.map((call) => call.path),
		['/api/auth/check', '/api/user/me', '/api/admin/users/' + user.id]
	)
	assert.equal(
		new Headers(calls[2]!.init.headers).get(
			'X-CinaToken-Expected-Console-Subject'
		),
		'fixture-subject'
	)
	assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), {
		charged_cost_factors: { m: { '*': 0.5 } },
		reason: 'reason',
	})
	assert.deepEqual(result.charged_cost_factors, { m: 0.5 })
})
test('wrong saved factor or user identity never reports success', async () => {
	for (const reply of [
		{ ...user, charged_cost_factors: { m: 0.6 } },
		{ ...user, id: 'other', charged_cost_factors: { m: 0.5 } },
	]) {
		const { api } = fixture(() => ({ success: true, data: reply }))
		await assert.rejects(
			api.saveUserFactors(user.id, user.id, { m: 0.5 }, 'reason', options),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
})
test('preview GET canonicalizes filters, retains price/schedule/mode and drops private metadata', async () => {
	const { api, calls } = fixture(() => ({
		success: true,
		data: {
			...preview,
			data: preview.data.map((item) => ({
				...item,
				model_info: { ...item.model_info, metadata: { secret: 'PRIVATE' } },
			})),
		},
	}))
	const result = await api.userModelPricePreview(
		user.id,
		{ model: '', routeGroups: ' Default,FREE, default ', kind: 'llm' },
		options
	)
	assert.equal(
		calls[2]!.path,
		'/api/admin/users/' +
			user.id +
			'/models?route_groups=default%2Cfree&kind=llm'
	)
	assert.equal(calls[2]!.init.method, undefined)
	assert.equal(result.preview.user_charged_factor_mode, 'min')
	assert.equal(result.data[0]!.model_info.discounts.default!.windows.length, 1)
	assert.equal(
		result.data[0]!.model_info.pricing_profile?.tiers[0]!.input_price,
		1
	)
	assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
	assert.equal(
		userModelPreviewQuery({ model: 'x/y', routeGroups: '', kind: 'audio' }).get(
			'model'
		),
		'x/y'
	)
})
test('preview rejects contradictory filter echo and duplicate models', async () => {
	assert.equal(
		userModelPreviewSchema.safeParse({
			...preview,
			data: [...preview.data, ...preview.data],
		}).success,
		false
	)
	const { api } = fixture(() => ({
		success: true,
		data: { ...preview, preview: { ...preview.preview, kind: 'image' } },
	}))
	await assert.rejects(
		api.userModelPricePreview(
			user.id,
			{ model: '', routeGroups: '', kind: 'llm' },
			options
		)
	)
})
test('route suggestions project only canonical unique model/groups', async () => {
	const { api } = fixture(() => ({
		success: true,
		data: [
			{ model_id: 'm', route_group: 'VIP', api_key: 'PRIVATE' },
			{ model_id: 'm', route_group: 'vip' },
			{ model_id: 'm', route_group: null },
		],
	}))
	assert.deepEqual(
		[...(await api.userFactorGroups(options))],
		[['m', ['default', 'vip']]]
	)
})
test('four-language editor renders group values without automatically loading preview/suggestions', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const i18n = createInstance()
		await i18n.init({
			lng: locale,
			interpolation: { escapeValue: false },
			resources: {
				[locale]: {
					translation: {
						cinatoken: { adminUserDetail: adminUserDetailMessages[locale] },
					},
				},
			},
		})
		let reads = 0
		const html = renderToStaticMarkup(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(UserDetailFactors, {
					user: userDetailSchema.parse(user),
					models: [],
					modelsDenied: false,
					canWrite: true,
					busy: false,
					api: {
						userFactorGroups: () => {
							reads++
							throw new Error('No automatic query')
						},
					} as never,
					options,
					previewDenied: false,
					onPreviewDenied: () => {},
					onSave: async () => {},
				})
			)
		)
		assert.ok(html.includes('value="vip"'))
		assert.ok(html.includes('value="0.5"'))
		assert.ok(html.includes(adminUserDetailMessages[locale].factorPreviewTitle))
		assert.equal(reads, 0)
	}
})

test('preview factors hide binary rounding noise but preserve zero and tiny nonzero values', () => {
	assert.equal(formatUserModelPreviewFactor(0.4 * 0.8, 'en'), '0.32')
	assert.equal(formatUserModelPreviewFactor(0, 'en'), '0')
	assert.equal(formatUserModelPreviewFactor(1e-20, 'en'), '1E-20')
	assert.equal(
		formatUserModelPreviewFactor(0.123456789012345, 'en'),
		'0.123456789012345'
	)
	assert.equal(formatUserModelPreviewFactor(0.32, 'de'), '0,32')
})
