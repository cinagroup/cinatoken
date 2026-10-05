/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { usersAccessIdentityKey } from './users-access-recovery'
import { createAdminUsersApi } from './users-api'
import { normalizeUserCreate, type UserCreateDraft } from './users-input'
import { usersListPath, validateUsersSearch } from './users-search'
import {
	UsersWritePersistenceError,
	UsersWriteRecovery,
} from './users-write-recovery'

const row = {
	id: 'user-1',
	email: 'person@example.test',
	external_system: 'erp',
	external_user_id: '42',
	budget_max: 25,
	budget_base: 25,
	budget_spent: 4.5,
	budget_period: 'monthly',
	budget_reset_at: '2026-10-01T00:00:00.000Z',
	status: 'active',
	metadata: '{"plan_id":"team"}',
	charged_cost_factors: { 'vendor/model': 0.8 },
	created_at: '2026-09-28T00:00:00.000Z',
	updated_at: '2026-09-28T01:00:00.000Z',
	active_keys_count: 1,
	keys_count: 2,
}
const overview = {
	billingCurrency: { value: 'CNY', source: 'configured' },
	webhooks: { wecom: { rawUrl: 'PRIVATE' } },
}
type Call = { path: string; init: RequestInit }
function fixture(reply: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = []
	const request: typeof fetch = async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		calls.push(call)
		return reply(call)
	}
	const transport = createCinaTokenCookieTransport(request)
	const api = createAdminUsersApi({
		send(path, schema, init, options) {
			return transport.send(path, schema, init, options)
		},
		invalidResponse() {
			throw new CinaTokenApiError(
				'Invalid users response',
				200,
				'invalid-response'
			)
		},
		sanitizeError(error) {
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'User operation failed',
					error.status,
					error.code
				)
			return new Error('User operation failed')
		},
	})
	return { api, calls }
}
const search = validateUsersSearch({})

test('list reads only same-origin Console API, strips other user columns, and checks page identity', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: [{ ...row, budget_epoch: 17, secret_from_legacy_row: 'PRIVATE' }],
			total: 1,
			page: 1,
			page_size: 20,
		})
	)
	const result = await api.userList(search)
	assert.equal(result.data[0]?.id, 'user-1')
	assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
	assert.equal(calls[0]?.path, usersListPath(search))
	assert.equal(calls[0]?.init.credentials, 'same-origin')
	assert.equal(calls[0]?.init.cache, 'no-store')
	for (const name of ['Authorization', 'New-Api-User', 'X-CinaToken-Workspace'])
		assert.equal(new Headers(calls[0]?.init.headers).get(name), null)
})

test('URL filters and sort stay inside the server whitelist', () => {
	const checked = validateUsersSearch({
		page: '2',
		email: ' person ',
		external_system: ' erp ',
		external_user_id: '42',
		status: 'active',
		max_budget: 'null',
		sort: 'budget_reset_at',
		order: 'asc',
	})
	assert.equal(
		usersListPath(checked),
		'/api/admin/users?page=2&page_size=20&sort=budget_reset_at&order=asc&email=person&external_system=erp&external_user_id=42&status=active&max_budget=null'
	)
	assert.deepEqual(
		validateUsersSearch({ sort: 'DROP TABLE users', order: 'sideways' }),
		search
	)
})

test('list errors never become empty results and mismatched or unsafe rows fail closed', async () => {
	for (const data of [
		{ ...row, active_keys_count: 3 },
		{ ...row, created_at: '2026-09-28 00:00:00' },
		{ ...row, charged_cost_factors: { model: -1 } },
	]) {
		const { api } = fixture(() =>
			Response.json({
				success: true,
				data: [data],
				total: 1,
				page: 1,
				page_size: 20,
			})
		)
		await assert.rejects(api.userList(search))
	}
	const { api } = fixture(() =>
		Response.json({ success: true, data: [], total: 0, page: 2, page_size: 20 })
	)
	await assert.rejects(api.userList(search))
})

test('currency read keeps only the safe projection and distinguishes server fallback from failure', async () => {
	const { api, calls } = fixture(() =>
		Response.json({ success: true, data: overview })
	)
	assert.deepEqual(await api.userCurrency(), {
		value: 'CNY',
		source: 'configured',
	})
	assert.equal(calls[0]?.path, '/api/admin/config/overview')
	for (const source of ['invalid', 'unsupported']) {
		const other = fixture(() =>
			Response.json({
				success: true,
				data: { billingCurrency: { value: 'EUR', source } },
			})
		)
		assert.equal(await other.api.userCurrency(), null)
	}
	const fallback = fixture(() =>
		Response.json({
			success: true,
			data: { billingCurrency: { value: 'USD', source: 'missing' } },
		})
	)
	assert.deepEqual(await fallback.api.userCurrency(), {
		value: 'USD',
		source: 'missing',
	})
	const denied = fixture(() =>
		Response.json({ success: false }, { status: 403 })
	)
	await assert.rejects(denied.api.userCurrency())
})

test('create uses a narrow POST body and never adds account workspace or integration credentials', async () => {
	const { api, calls } = fixture(() =>
		Response.json({ success: true, data: { id: 'user-2', email: 'PRIVATE' } })
	)
	const draft: UserCreateDraft = {
		email: ' Person@example.test ',
		externalSystem: 'erp',
		externalUserId: '42',
		budgetMax: '25.000001',
		budgetBase: '25',
		budgetPeriod: 'monthly',
		metadata: '{"plan_id":"team"}',
	}
	assert.equal(await api.createUser(draft), 'user-2')
	assert.equal(calls[0]?.path, '/api/admin/users')
	assert.equal(calls[0]?.init.method, 'POST')
	assert.deepEqual(
		JSON.parse(String(calls[0]?.init.body)),
		normalizeUserCreate(draft)
	)
	assert.equal(calls[0]?.init.credentials, 'same-origin')
	assert.equal(new Headers(calls[0]?.init.headers).get('Authorization'), null)
	assert.equal(
		new Headers(calls[0]?.init.headers).get('X-CinaToken-Workspace'),
		null
	)
})

test('unknown POST is never replayed or unlocked by a successful unrelated disabled list', async () => {
	const values = new Map<string, string>()
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value)
		},
		removeItem: (key: string) => {
			values.delete(key)
		},
	}
	const identity = usersAccessIdentityKey(
		JSON.stringify(['admin', 'cinaauth', 1])
	)
	const recovery = new UsersWriteRecovery(storage, true)
	const { api, calls } = fixture((call) =>
		call.init.method === 'POST'
			? Response.json({ success: false }, { status: 503 })
			: Response.json({
					success: true,
					data: [],
					total: 0,
					page: 2,
					page_size: 20,
				})
	)
	const draft: UserCreateDraft = {
		email: 'person@example.test',
		externalSystem: '',
		externalUserId: '',
		budgetMax: '10',
		budgetBase: '10',
		budgetPeriod: 'none',
		metadata: '',
	}
	recovery.markPending(identity)
	await assert.rejects(api.createUser(draft), (error: unknown) => {
		assert.ok(error instanceof CinaTokenApiError)
		return error.status === 503
	})
	const disabled = validateUsersSearch({ status: 'disabled', page: '2' })
	assert.deepEqual((await api.userList(disabled)).data, [])
	assert.equal(calls[1]?.path, usersListPath(disabled))
	assert.equal(recovery.getSnapshot(identity), true)
	const afterHardRefresh = new UsersWriteRecovery(storage, true)
	assert.equal(afterHardRefresh.getSnapshot(identity), true)
	assert.throws(
		() => afterHardRefresh.markPending(identity),
		UsersWritePersistenceError
	)
	assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1)
})
