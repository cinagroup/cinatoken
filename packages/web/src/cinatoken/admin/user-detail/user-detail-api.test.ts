/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { gatewayKeyEditInput } from '../gateway-keys/gateway-key-input'
import { createAdminUserDetailApi } from './user-detail-api'
import { userDetailKeySchema } from './user-detail-contracts'

const userId = 'f2b74bc0-32f3-4613-aea7-96f723d08e12'
const user = {
	id: userId,
	email: 'person@example.test',
	external_system: 'erp',
	external_user_id: '42',
	budget_max: null,
	budget_base: 0,
	budget_spent: 1.5,
	budget_period: 'none',
	budget_reset_at: null,
	status: 'active',
	metadata: null,
	charged_cost_factors: null,
	created_at: '2026-09-28T00:00:00.000Z',
	updated_at: '2026-09-28T01:00:00.000Z',
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
	const api = createAdminUserDetailApi({
		send(path, schema, init, options) {
			return transport.send(path, schema, init, options)
		},
		invalidResponse() {
			throw new CinaTokenApiError(
				'Invalid user detail',
				200,
				'invalid-response'
			)
		},
		sanitizeError(error) {
			return error instanceof CinaTokenApiError
				? new CinaTokenApiError('User detail failed', error.status, error.code)
				: new Error('User detail failed')
		},
	})
	return { api, calls }
}

test('detail and PATCH project only whitelisted data and validate stable ID across external-identity edits', async () => {
	const { api, calls } = fixture((call) =>
		Response.json({
			success: true,
			data: {
				...user,
				external_user_id: call.init.method === 'PATCH' ? '43' : '42',
				legacy_secret: 'PRIVATE',
			},
			legacy_config: 'PRIVATE',
		})
	)
	const detail = await api.userDetail('ext:erp/42')
	assert.equal(JSON.stringify(detail).includes('PRIVATE'), false)
	const changed = await api.patchUserDetail('ext:erp/42', userId, {
		external_user_id: '43',
		reason: 'test',
	})
	assert.equal(changed.external_user_id, '43')
	assert.equal(calls[0]?.path, '/api/admin/users/ext%3Aerp%2F42')
	assert.equal(calls[1]?.init.method, 'PATCH')
	assert.equal(calls[1]?.init.credentials, 'same-origin')
	assert.equal(calls[1]?.init.cache, 'no-store')
})

test('transition preview projects accounting snapshot and apply pins reviewed reset time and epoch', async () => {
	const before = {
		budget_max: 10,
		budget_base: 10,
		budget_spent: 1,
		budget_period: 'monthly',
		budget_reset_at: '2030-01-01T00:00:00.000Z',
		budget_epoch: 4,
		budget_reserved_micros: 500_000,
	}
	const after = {
		...before,
		budget_max: 10.5,
		budget_base: 2,
		budget_spent: 0,
		budget_reset_at: '2030-02-01T00:00:00.000Z',
		budget_epoch: 5,
		budget_reserved_micros: 0,
	}
	const preview = { before, after, carryover: 8.5 }
	const { api, calls } = fixture((call) =>
		Response.json(
			call.path.endsWith('/preview')
				? { success: true, data: { ...preview, private_snapshot: 'PRIVATE' } }
				: {
						success: true,
						data: {
							transition: preview,
							user: { ...user, ...after, private_snapshot: 'PRIVATE' },
						},
					}
		)
	)
	const input = {
		target_budget_base: 2,
		budget_period: 'monthly' as const,
		carryover_strategy: 'remaining_or_overage' as const,
		reset_spent: true,
		reason: 'test transition',
	}
	const reviewed = await api.previewUserBudgetTransition(userId, input)
	assert.equal(JSON.stringify(reviewed).includes('PRIVATE'), false)
	const updated = await api.applyUserBudgetTransition(
		userId,
		userId,
		input,
		reviewed
	)
	assert.equal(updated.budget_max, 10.5)
	assert.equal(
		calls[0]?.path,
		`/api/admin/users/${userId}/budget/transition/preview`
	)
	assert.equal(calls[1]?.path, `/api/admin/users/${userId}/budget/transition`)
	assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
		...input,
		budget_reset_at: after.budget_reset_at,
		expected_before: before,
	})
	assert.equal(JSON.stringify(updated).includes('PRIVATE'), false)
})

test('transition apply rejects a mismatched confirmation before retaining a user', async () => {
	const before = {
		budget_max: 10,
		budget_base: 10,
		budget_spent: 1,
		budget_period: 'monthly' as const,
		budget_reset_at: '2030-01-01T00:00:00.000Z',
		budget_epoch: 4,
		budget_reserved_micros: 0,
	}
	const preview = {
		before,
		after: { ...before, budget_epoch: 5 },
		carryover: 9,
	}
	const { api } = fixture(() =>
		Response.json({
			success: true,
			data: {
				transition: { ...preview, before: { ...before, budget_epoch: 3 } },
				user: {
					...user,
					budget_max: 10,
					budget_base: 10,
					budget_spent: 1,
					budget_period: 'monthly',
					budget_reset_at: before.budget_reset_at,
				},
			},
		})
	)
	await assert.rejects(
		api.applyUserBudgetTransition(
			userId,
			userId,
			{
				target_budget_base: 10,
				budget_period: 'monthly',
				carryover_strategy: 'none',
				reset_spent: true,
				reason: 'test',
			},
			preview
		)
	)
})

test('user, keys, logs, and audits reject cross-user rows before state retention', async () => {
	const other = 'e37db7be-f79b-4978-9cdb-887bd9628492'
	const responses = [
		{ path: 'user', payload: { success: true, data: { ...user, id: other } } },
		{
			path: 'keys',
			payload: {
				success: true,
				data: [
					{
						id: 'key-1',
						key: 'sk-secret',
						user_id: other,
						workspace_id: 'personal:' + other,
						name: null,
						status: 'active',
						metadata: null,
						last_used_at: null,
						created_at: user.created_at,
						updated_at: user.updated_at,
					},
				],
			},
		},
		{
			path: 'logs',
			payload: {
				success: true,
				data: [
					{
						id: 'log-1',
						user_id: other,
						input_tokens: 1,
						output_tokens: 2,
						cache_read_tokens: 0,
						cache_write_tokens: 0,
						metered_cost: '1.250000',
						charged_cost: '1.500000',
						status: 'success',
						created_at: user.created_at,
					},
				],
				total: 1,
				page: 1,
				page_size: 5,
			},
		},
		{
			path: 'audit-logs',
			payload: {
				success: true,
				data: [
					{
						id: 'audit-1',
						user_id: other,
						event_type: 'user_updated',
						actor_type: 'admin',
						created_at: user.created_at,
					},
				],
				total: 1,
				page: 1,
				page_size: 5,
			},
		},
	]
	for (const item of responses) {
		const { api } = fixture(() => Response.json(item.payload))
		if (item.path === 'user') await assert.rejects(api.userDetail(userId))
		if (item.path === 'keys')
			await assert.rejects(api.userDetailKeys(userId, userId))
		if (item.path === 'logs')
			await assert.rejects(api.userDetailLogs(userId, userId))
		if (item.path === 'audit-logs')
			await assert.rejects(api.userDetailAudits(userId, userId))
	}
})

test('key list never retains a full secret, while POST delivers a one-time secret outside Query cache', async () => {
	const secret = 'sk-synthetic-secret-value-1234567890'
	const { api, calls } = fixture((call) => {
		if (call.init.method === 'POST')
			return Response.json({
				success: true,
				data: {
					key: secret,
					key_id: 'key-1',
					workspace_id: 'workspace-1',
					extra: 'PRIVATE',
				},
			})
		return Response.json({
			success: true,
			data: [
				{
					id: 'key-1',
					key: secret,
					user_id: userId,
					workspace_id: 'workspace-1',
					name: 'main',
					status: 'active',
					metadata: null,
					last_used_at: null,
					created_at: user.created_at,
					updated_at: user.updated_at,
					extra: 'PRIVATE',
				},
			],
		})
	})
	const keys = await api.userDetailKeys(userId, userId)
	assert.equal(JSON.stringify(keys).includes(secret), false)
	assert.equal(JSON.stringify(keys).includes('PRIVATE'), false)
	let delivered: string | null = null
	const created = await api.createUserDetailKey(
		userId,
		'main',
		null,
		(value) => {
			delivered = value
		}
	)
	assert.deepEqual(created, { keyId: 'key-1' })
	assert.equal(delivered, secret)
	assert.equal(JSON.stringify(created).includes(secret), false)
	assert.equal(calls[1]?.init.method, 'POST')
	const short = fixture(() =>
		Response.json({
			success: true,
			data: [
				{
					id: 'key-2',
					key: 'sk-short',
					user_id: userId,
					workspace_id: 'workspace-1',
					name: null,
					status: 'active',
					metadata: null,
					last_used_at: null,
					created_at: user.created_at,
					updated_at: user.updated_at,
				},
			],
		})
	)
	const shortRows = await short.api.userDetailKeys(userId, userId)
	assert.equal(shortRows[0]?.key, 'sk-…')
	assert.equal(JSON.stringify(shortRows).includes('sk-short'), false)
})

test('safe overview is independent from user access, rejects unverifiable currency, and strips private config', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: {
				businessTimezone: { value: 'UTC', source: 'missing' },
				billingCurrency: { value: 'XXX', source: 'unsupported' },
				webhooks: { rawUrl: 'PRIVATE' },
			},
		})
	)
	const display = await api.userDetailDisplay()
	assert.equal(display.currency, null)
	assert.equal(JSON.stringify(display).includes('PRIVATE'), false)
	assert.equal(calls[0]?.path, '/api/admin/config/overview')
	const denied = fixture(() =>
		Response.json({ success: false, message: 'denied' }, { status: 403 })
	)
	await assert.rejects(denied.api.userDetailDisplay())
})

test('recent pages and model directory retain only projected rows and the exact five-row scope', async () => {
	const { api, calls } = fixture((call) => {
		if (call.path.endsWith('/logs?page=1&page_size=5'))
			return Response.json({
				success: true,
				data: [
					{
						id: 'log-1',
						user_id: userId,
						input_tokens: 1,
						output_tokens: 2,
						cache_read_tokens: 0,
						cache_write_tokens: 0,
						metered_cost: '1.250000',
						charged_cost: '1.500000',
						status: 'success',
						created_at: user.created_at,
						private_raw_column: 'PRIVATE',
					},
				],
				total: 1,
				page: 1,
				page_size: 5,
			})
		if (call.path.endsWith('/audit-logs?page=1&page_size=5'))
			return Response.json({
				success: true,
				data: [
					{
						id: 'audit-1',
						user_id: userId,
						event_type: 'user_updated',
						actor_type: 'admin',
						created_at: user.created_at,
						private_raw_column: 'PRIVATE',
					},
				],
				total: 1,
				page: 1,
				page_size: 5,
			})
		return Response.json({
			success: true,
			count: 1,
			data: [
				{
					id: 'vendor/model',
					display_name: 'Example',
					vendor: 'Vendor',
					private_raw_column: 'PRIVATE',
				},
			],
		})
	})
	const logs = await api.userDetailLogs(userId, userId)
	const audits = await api.userDetailAudits(userId, userId)
	const models = await api.userDetailModels()
	assert.equal(logs[0]?.metered_cost, 1.25)
	assert.equal(
		JSON.stringify([logs, audits, models]).includes('PRIVATE'),
		false
	)
	assert.equal(calls[2]?.path, '/api/admin/models')
})

const keyRow = {
	id: 'key-1',
	key: 'sk-…',
	user_id: userId,
	workspace_id: 'personal:' + userId,
	name: 'Main key',
	status: 'active',
	metadata_preview: '{"field_count":2}',
	metadata_unavailable: false,
	last_used_at: null,
	created_at: user.created_at,
	updated_at: user.updated_at,
}
const keyDetail = {
	...keyRow,
	user_email: user.email,
	budget_max: null,
	budget_base: 0,
	budget_spent: 0,
	budget_period: 'none',
	budget_reset_at: null,
	profile_revision: 'sha256:' + 'a'.repeat(64),
	metadata_raw: '{ "password": "PRIVATE", "team": "A" }',
}

test('ordinary user key API discards raw metadata before its response can enter Query', async () => {
	const { api } = fixture(() =>
		Response.json({
			success: true,
			data: [
				{
					...keyRow,
					metadata: '{"token":"PRIVATE"}',
					metadata_raw: 'RAW-PRIVATE',
				},
			],
		})
	)
	const rows = await api.userDetailKeys(userId, userId)
	assert.deepEqual(rows[0]?.metadata_preview, { field_count: 2 })
	assert.equal(JSON.stringify(rows).includes('PRIVATE'), false)
	assert.equal('metadata_raw' in (rows[0] ?? {}), false)
})

test('explicit editor GET returns precise raw JSON uncached and validates key, user and workspace ownership', async () => {
	const expected = userDetailKeySchema.parse(keyRow)
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: { ...keyDetail, extra_secret: 'PRIVATE-EXTRA' },
		})
	)
	const detail = await api.userDetailKeyEditDetail(expected)
	assert.equal(detail.metadata_raw, keyDetail.metadata_raw)
	assert.equal(JSON.stringify(detail).includes('PRIVATE-EXTRA'), false)
	assert.equal(calls[0]?.path, '/api/admin/keys/key-1')
	assert.equal(calls[0]?.init.cache, 'no-store')
	for (const changed of [
		{ id: 'key-other' },
		{ user_id: 'user-other' },
		{ workspace_id: 'workspace-other' },
	]) {
		const wrong = fixture(() =>
			Response.json({ success: true, data: { ...keyDetail, ...changed } })
		)
		await assert.rejects(wrong.api.userDetailKeyEditDetail(expected))
	}
})

test('cancelled editor detail and cancelled creation never deliver a late raw value or secret', async () => {
	const controller = new AbortController()
	let release: (() => void) | undefined
	const delayed = new Promise<void>((resolve) => {
		release = resolve
	})
	const { api } = fixture(async (call) => {
		await delayed
		return Response.json({
			success: true,
			data:
				call.init.method === 'POST'
					? {
							key: 'sk-' + 'S'.repeat(32),
							key_id: 'key-1',
							workspace_id: keyRow.workspace_id,
						}
					: keyDetail,
		})
	})
	const expected = userDetailKeySchema.parse(keyRow)
	let delivered = false
	const read = api.userDetailKeyEditDetail(expected, {
		signal: controller.signal,
	})
	const post = api.createUserDetailKey(
		userId,
		'Main key',
		null,
		() => {
			delivered = true
		},
		{ signal: controller.signal }
	)
	controller.abort()
	release?.()
	await assert.rejects(read)
	await assert.rejects(post)
	assert.equal(delivered, false)
})

test('key editor PATCH passes reviewed revision, preserves merge versus replacement, and returns no raw mutation data', async () => {
	const expected = userDetailKeySchema.parse(keyRow)
	const { api, calls } = fixture((call) => {
		const body = JSON.parse(String(call.init.body)) as { name: string }
		return Response.json({
			success: true,
			data: {
				...keyDetail,
				name: body.name,
				metadata_raw: '{"token":"PRIVATE"}',
			},
		})
	})
	const base = {
		expected_revision: keyDetail.profile_revision,
		name: 'Updated',
		reason: 'Review user key',
	}
	const merged = await api.saveUserDetailKeyEdit(expected, {
		...base,
		metadata: { team: 'B' },
	})
	const replaced = await api.saveUserDetailKeyEdit(expected, {
		...base,
		metadata_replace: { password: 'PRIVATE-REPLACEMENT' },
	})
	assert.equal(merged, undefined)
	assert.equal(replaced, undefined)
	assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
		...base,
		metadata: { team: 'B' },
	})
	assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
		...base,
		metadata_replace: { password: 'PRIVATE-REPLACEMENT' },
	})
	assert.equal(calls[0]?.init.method, 'PATCH')
	assert.equal(calls[0]?.path, '/api/admin/keys/key-1')
})

test('editor PATCH rejects conflicting ownership, stale revision and invalid tokens without retry', async () => {
	const expected = userDetailKeySchema.parse(keyRow)
	const base = {
		expected_revision: keyDetail.profile_revision,
		reason: 'Review user key',
	}
	const wrong = fixture(() =>
		Response.json({
			success: true,
			data: { ...keyDetail, workspace_id: 'workspace-other' },
		})
	)
	await assert.rejects(wrong.api.saveUserDetailKeyEdit(expected, base))
	const conflict = fixture(() =>
		Response.json({ success: false }, { status: 409 })
	)
	await assert.rejects(
		conflict.api.saveUserDetailKeyEdit(expected, base),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.status === 409
	)
	assert.equal(conflict.calls.length, 1)
	const invalid = fixture(() => {
		throw new Error('Must not dispatch')
	})
	await assert.rejects(
		invalid.api.saveUserDetailKeyEdit(expected, {
			...base,
			expected_revision: 'wrong',
		})
	)
	assert.equal(invalid.calls.length, 0)
})

test('unavailable editor metadata permits name-only editing and cannot generate a merge or replacement', async () => {
	const expected = userDetailKeySchema.parse(keyRow)
	const { api, calls } = fixture((call) =>
		Response.json({
			success: true,
			data: {
				...keyDetail,
				name: call.init.method === 'PATCH' ? 'Updated' : keyDetail.name,
				metadata_raw: null,
				metadata_preview: null,
				metadata_unavailable: true,
			},
		})
	)
	const detail = await api.userDetailKeyEditDetail(expected)
	const draft = {
		name: 'Updated',
		status: 'active' as const,
		statusConfirmed: false,
		metadataMode: 'unchanged' as const,
		metadata: '',
		reason: 'Rename only',
	}
	const patch = gatewayKeyEditInput(detail, draft)
	await api.saveUserDetailKeyEdit(expected, patch)
	const body = JSON.parse(String(calls[1]?.init.body)) as object
	assert.equal('metadata' in body, false)
	assert.equal('metadata_replace' in body, false)
	assert.throws(() =>
		gatewayKeyEditInput(detail, {
			...draft,
			metadataMode: 'merge',
			metadata: '{"team":"B"}',
		})
	)
	assert.throws(() =>
		gatewayKeyEditInput(detail, {
			...draft,
			metadataMode: 'replace',
			metadata: '{}',
		})
	)
})
