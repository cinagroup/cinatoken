/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { createAdminGatewayKeysApi } from './gateway-key-api'
import {
	gatewayKeyDetailSchema,
	gatewayKeyRowSchema,
	gatewayKeyUpdatedResponseSchema,
} from './gateway-key-contracts'
import { gatewayKeyEditInput } from './gateway-key-input'
import { validateGatewayKeySearch } from './gateway-key-search'

const wire = {
	id: 'usage-key',
	key: 'sk-…',
	user_id: 'usage-user',
	workspace_id: 'personal:usage-user',
	name: 'Usage key',
	user_email: null,
	budget_max: 25,
	budget_base: 25,
	budget_spent: 4.5,
	budget_period: 'monthly',
	budget_reset_at: null,
	status: 'active',
	created_at: '2026-09-01T00:00:00.000Z',
	updated_at: '2026-10-01T00:00:00.000Z',
	metadata_preview: null,
	metadata_raw: null,
	metadata_unavailable: false,
	profile_revision: 'sha256:' + 'a'.repeat(64),
}
const row = gatewayKeyRowSchema.parse(wire)
const search = validateGatewayKeySearch({})
const capabilities = {
	user_detail: true,
	request_logs: true,
	budget_audit: true,
	effective_guardrails: false,
	can_write: true,
}
const cases = [
	{ value: undefined, normalized: undefined },
	{ value: null, normalized: null },
	{ value: '2026-10-23T16:00:00.000Z', normalized: '2026-10-23T16:00:00.000Z' },
	{
		value: '2026-10-23 16:00:00.123456',
		normalized: '2026-10-23T16:00:00.123Z',
	},
]
function fixture(value: unknown) {
	const calls: { path: string; init: RequestInit }[] = []
	const cookie = createCinaTokenCookieTransport(async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		calls.push(call)
		const data = {
			...wire,
			last_used_at: value,
			status: init?.method === 'DELETE' ? 'revoked' : 'active',
		}
		if (call.path.startsWith('/api/admin/keys?'))
			return Response.json({
				success: true,
				data: [data],
				total: 1,
				page: 1,
				page_size: 20,
				capabilities,
			})
		return Response.json({ success: true, data })
	})
	const api = createAdminGatewayKeysApi({
		send: (path, schema, init, options) =>
			cookie.send(path, schema, init, options),
		invalidResponse() {
			throw new CinaTokenApiError('Invalid response', 200, 'invalid-response')
		},
		sanitizeError(error) {
			return error instanceof Error ? error : new Error('Request failed')
		},
	})
	return { api, calls }
}
const invalid = (error: unknown) =>
	error instanceof CinaTokenApiError && error.code === 'invalid-response'

test('last-used contracts retain valid UTC and SQL instants, null and missing independently', () => {
	for (const item of cases) {
		const data = {
			...wire,
			...(item.value === undefined ? {} : { last_used_at: item.value }),
		}
		for (const parsed of [
			gatewayKeyRowSchema.parse(data),
			gatewayKeyDetailSchema.parse(data),
			gatewayKeyUpdatedResponseSchema.parse({ success: true, data }).data,
		]) {
			assert.equal(parsed.last_used_at, item.normalized)
			assert.equal(
				Object.hasOwn(parsed, 'last_used_at'),
				item.value !== undefined
			)
			assert.equal(parsed.profile_revision, wire.profile_revision)
		}
	}
})

test('present malformed last-used values cannot become missing or no usage in any read contract', () => {
	for (const value of [
		'',
		'not-a-date',
		'2026-02-30T00:00:00Z',
		'2026-10-23T16:00:00+08:00',
		0,
		false,
		{},
		[],
		'x'.repeat(41),
	]) {
		const data = { ...wire, last_used_at: value }
		assert.equal(gatewayKeyRowSchema.safeParse(data).success, false)
		assert.equal(gatewayKeyDetailSchema.safeParse(data).success, false)
		assert.equal(
			gatewayKeyUpdatedResponseSchema.safeParse({ success: true, data })
				.success,
			false
		)
	}
})

test('list and explicit editor APIs preserve last-used values without changing identity or list scope', async () => {
	for (const item of cases) {
		const { api, calls } = fixture(item.value)
		const list = await api.gatewayKeyList(search)
		const detail = await api.gatewayKeyEditDetail(row)
		assert.equal(list.data[0]?.last_used_at, item.normalized)
		assert.equal(detail.last_used_at, item.normalized)
		assert.equal(detail.id, row.id)
		assert.equal(detail.profile_revision, row.profile_revision)
		assert.equal(calls.length, 2)
		assert.equal(
			calls[0].path,
			'/api/admin/keys?page=1&page_size=20&sort=created_at&order=desc'
		)
		assert.equal(calls[1].path, '/api/admin/keys/usage-key')
		assert.ok(calls.every((call) => (call.init.method ?? 'GET') === 'GET'))
	}
})

test('PATCH and tombstone acknowledgements retain last-used independently from profile revision', async () => {
	for (const item of cases) {
		const { api, calls } = fixture(item.value)
		const expected = { ...row, last_used_at: '2026-10-01T01:00:00.000Z' }
		const patch = { expected_revision: row.profile_revision, reason: 'Review' }
		assert.equal(
			(await api.patchGatewayKey(expected, patch)).last_used_at,
			item.normalized
		)
		assert.equal(
			(await api.tombstoneGatewayKey(expected, 'Retire')).last_used_at,
			item.normalized
		)
		assert.deepEqual(JSON.parse(String(calls[0].init.body)), patch)
		assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
			expected_revision: row.profile_revision,
			reason: 'Retire',
		})
	}
})

test('invalid last-used responses reject all four API paths once without replay', async () => {
	for (const value of ['', '2026-02-30T00:00:00Z', 0]) {
		const { api, calls } = fixture(value)
		await assert.rejects(api.gatewayKeyList(search), invalid)
		await assert.rejects(api.gatewayKeyEditDetail(row), invalid)
		await assert.rejects(
			api.patchGatewayKey(row, {
				expected_revision: row.profile_revision,
				reason: 'Review',
			}),
			invalid
		)
		await assert.rejects(api.tombstoneGatewayKey(row, 'Retire'), invalid)
		assert.equal(calls.length, 4)
	}
})

test('editor patches do not acquire read-only last-used timestamps or change their revision', async () => {
	const draft = {
		name: 'Usage key',
		status: 'active' as const,
		statusConfirmed: false,
		metadataMode: 'unchanged' as const,
		metadata: '',
		reason: 'Review',
	}
	const expected = {
		expected_revision: row.profile_revision,
		name: 'Usage key',
		status: 'active',
		reason: 'Review',
	}
	for (const item of cases) {
		const detail = gatewayKeyDetailSchema.parse({
			...wire,
			last_used_at: item.value,
		})
		const input = gatewayKeyEditInput(detail, draft)
		assert.deepEqual(input, expected)
		const { api, calls } = fixture(item.value)
		await api.patchGatewayKey(row, input)
		assert.deepEqual(JSON.parse(String(calls[0].init.body)), expected)
	}
})
