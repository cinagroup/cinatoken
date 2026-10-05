/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError } from '../../api'
import { createAdminSharedKeyAuditApi } from './audit-api'
import { adminSharedKeyAuditEntrySchema } from './audit-contracts'
import { encodeSharedKeyAuditCursor } from './audit-cursor'
import { AdminSharedKeyInputError } from './shared-key-errors'

const before = {
	status: 'disabled',
	sellerPriority: 5,
	weight: 30,
	validated: true,
}
const entry = {
	id: '11111111-1111-4111-8111-111111111111',
	keyId: 'shared-1',
	createdAt: '2026-09-30T00:00:00.000Z',
	action: 'restored',
	changeMask: 1,
	actorKind: 'console',
	actorId: 'operator',
	source: 'admin_api',
	reason: 'Review completed',
	before,
	after: { ...before, status: 'paused' },
	beforeRevision: 'sha256:' + 'a'.repeat(64),
	afterRevision: 'sha256:' + 'b'.repeat(64),
}
const page = (entries: unknown[], next_cursor: string | null = null) => ({
	success: true,
	data: { entries, next_cursor, page_size: 20 },
})
const invalid = (error: unknown) =>
	error instanceof CinaTokenApiError && error.code === 'invalid-response'
const priorCursor = encodeSharedKeyAuditCursor({
	v: 1,
	key_id: 'shared-1',
	created_at: '2026-09-30T01:00:00.000001Z',
	id: entry.id,
})

test('trusted audit actor is a bounded display field rather than a URL identifier', async () => {
	const actorId = 'console:ops team/branch?#review'
	const api = createAdminSharedKeyAuditApi(async () =>
		Response.json(page([{ ...entry, actorId }]))
	)
	assert.equal(
		(await api.adminSharedKeyAudit('shared-1', null)).entries[0].actorId,
		actorId
	)
	for (const invalidActor of [
		'',
		'x'.repeat(618),
		'actor\nline',
		'actor\u202e',
	])
		assert.equal(
			adminSharedKeyAuditEntrySchema.safeParse({
				...entry,
				actorId: invalidActor,
			}).success,
			false
		)
})

test('audit raw actor bounds preserve full Console attribution while API-key actors remain limited to 600', async () => {
	for (const [actorKind, length] of [
		['console', 600],
		['console', 601],
		['console', 617],
		['api_key', 600],
	] as const) {
		const actorId = 'a'.repeat(length)
		const result = await createAdminSharedKeyAuditApi(async () =>
			Response.json(page([{ ...entry, actorKind, actorId }]))
		).adminSharedKeyAudit('shared-1', null)
		assert.equal(result.entries[0].actorKind, actorKind)
		assert.equal(result.entries[0].actorId, actorId)
	}
	for (const [actorKind, length] of [
		['console', 618],
		['api_key', 601],
	] as const)
		await assert.rejects(
			createAdminSharedKeyAuditApi(async () =>
				Response.json(
					page([{ ...entry, actorKind, actorId: 'a'.repeat(length) }])
				)
			).adminSharedKeyAudit('shared-1', null),
			invalid
		)
})

test('credential redaction cannot turn an oversized raw audit actor into accepted evidence', async () => {
	for (const [actorKind, limit] of [
		['console', 617],
		['api_key', 600],
	] as const) {
		const actorId = 'sk-' + 'a'.repeat(limit - 3)
		const result = await createAdminSharedKeyAuditApi(async () =>
			Response.json(page([{ ...entry, actorKind, actorId }]))
		).adminSharedKeyAudit('shared-1', null)
		assert.equal(result.entries[0].actorId, '[redacted]')
		assert.equal(JSON.stringify(result).includes(actorId), false)
		for (const oversized of [actorId + 'a', actorId + '\u202e'])
			await assert.rejects(
				createAdminSharedKeyAuditApi(async () =>
					Response.json(page([{ ...entry, actorKind, actorId: oversized }]))
				).adminSharedKeyAudit('shared-1', null),
				invalid
			)
	}
})

test('audit reason keeps its raw 600-character and control-character bounds before redaction', () => {
	assert.equal(
		adminSharedKeyAuditEntrySchema.parse({
			...entry,
			reason: 'r'.repeat(600),
		}).reason.length,
		600
	)
	assert.equal(
		adminSharedKeyAuditEntrySchema.parse({
			...entry,
			reason: 'sk-' + 'a'.repeat(597),
		}).reason,
		'[redacted]'
	)
	for (const reason of [
		'r'.repeat(601),
		'sk-' + 'a'.repeat(598),
		'reason\nline',
		'reason\u202e',
	])
		assert.equal(
			adminSharedKeyAuditEntrySchema.safeParse({ ...entry, reason }).success,
			false
		)
})

test('audit reads exact key and opaque cursor, strips unrelated fields, and keeps deleted-key evidence', async () => {
	const calls: Array<{ path: string; init: RequestInit }> = []
	const deleted = {
		...entry,
		action: 'deleted',
		changeMask: 8,
		after: null,
		afterRevision: null,
		fingerprint: 'private',
		label: 'private',
		raw_failure: 'private',
	}
	const api = createAdminSharedKeyAuditApi(async (path, init) => {
		calls.push({ path: String(path), init: init ?? {} })
		return Response.json(page([deleted]))
	})
	const result = await api.adminSharedKeyAudit('shared-1', priorCursor)
	assert.equal(
		calls[0].path,
		'/api/admin/shared-keys/shared-1/audit?page_size=20&cursor=' + priorCursor
	)
	assert.equal(calls[0].init.credentials, 'same-origin')
	assert.equal(calls[0].init.cache, 'no-store')
	assert.equal(result.entries[0].after, null)
	assert.equal(result.entries[0].afterRevision, null)
	assert.equal(JSON.stringify(result).includes('private'), false)
	assert.equal(result.next_cursor, null)
})
test('audit binds every entry to the target and rejects duplicate, malformed and repeated pages', async () => {
	for (const data of [
		page([{ ...entry, keyId: 'other' }]),
		page([entry, entry]),
		page([{ ...entry, changeMask: 4 }]),
		page([{ ...entry, after: { ...before, status: 'active' } }]),
		page([{ ...entry, action: 'deleted', changeMask: 8 }]),
		page([entry], priorCursor),
		{ ...page([entry]), data: { ...page([entry]).data, page_size: 100 } },
	]) {
		await assert.rejects(
			createAdminSharedKeyAuditApi(async () =>
				Response.json(data)
			).adminSharedKeyAudit('shared-1', priorCursor),
			invalid
		)
	}
	assert.equal(
		adminSharedKeyAuditEntrySchema.safeParse({
			...entry,
			before: { ...before, fingerprint: 'private' },
		}).success,
		false
	)
})
test('audit never expands a bad key/cursor into an unbound read and rejects late canceled results', async () => {
	let calls = 0
	const controller = new AbortController()
	const api = createAdminSharedKeyAuditApi(async () => {
		calls++
		controller.abort()
		return Response.json(page([entry]))
	})
	await assert.rejects(
		api.adminSharedKeyAudit('shared-1', 'cursor?raw=secret'),
		AdminSharedKeyInputError
	)
	assert.equal(calls, 0)
	await assert.rejects(
		api.adminSharedKeyAudit('shared-1', null, { signal: controller.signal })
	)
	assert.equal(calls, 1)
})

test('audit preserves microseconds, exact descending boundaries and canonical key-bound next cursors', async () => {
	const entries = Array.from({ length: 20 }, (_, index) => ({
		...entry,
		id:
			'11111111-1111-4111-8111-' + (100 - index).toString(16).padStart(12, '0'),
		createdAt:
			'2026-09-30T00:00:00.000' + String(999 - index).padStart(3, '0') + 'Z',
	}))
	const last = entries[19]
	const cursor = encodeSharedKeyAuditCursor({
		v: 1,
		key_id: 'shared-1',
		created_at: last.createdAt,
		id: last.id,
	})
	const api = createAdminSharedKeyAuditApi(async (path) =>
		Response.json(
			String(path).includes('&cursor=') ? page([]) : page(entries, cursor)
		)
	)
	const first = await api.adminSharedKeyAudit('shared-1', null)
	assert.equal(first.entries[0].createdAt, '2026-09-30T00:00:00.000999Z')
	assert.equal(first.next_cursor, cursor)
	assert.equal(
		(await api.adminSharedKeyAudit('shared-1', cursor)).entries.length,
		0
	)
})

test('bad audit order, crossed boundaries, false next rows and incomplete cursor evidence are rejected', async () => {
	const newer = { ...entry, createdAt: '2026-09-30T00:00:00.000002Z' }
	const older = {
		...entry,
		id: '22222222-2222-4222-8222-222222222222',
		createdAt: '2026-09-30T00:00:00.000001Z',
	}
	const full = Array.from({ length: 20 }, (_, index) => ({
		...entry,
		id:
			'11111111-1111-4111-8111-' + (100 - index).toString(16).padStart(12, '0'),
		createdAt:
			'2026-09-30T00:00:00.000' + String(999 - index).padStart(3, '0') + 'Z',
	}))
	const exact = encodeSharedKeyAuditCursor({
		v: 1,
		key_id: 'shared-1',
		created_at: full[19].createdAt,
		id: full[19].id,
	})
	for (const body of [
		page([older, newer]),
		page(full),
		page([entry], exact),
		page(full, priorCursor),
		page([{ ...entry, id: 'audit-1' }]),
		page([{ ...entry, createdAt: '2026-02-30T00:00:00.000001Z' }]),
	])
		await assert.rejects(
			createAdminSharedKeyAuditApi(async () =>
				Response.json(body)
			).adminSharedKeyAudit('shared-1', null),
			invalid
		)
	await assert.rejects(
		createAdminSharedKeyAuditApi(async () =>
			Response.json(page([newer]))
		).adminSharedKeyAudit(
			'shared-1',
			encodeSharedKeyAuditCursor({
				v: 1,
				key_id: 'shared-1',
				created_at: older.createdAt,
				id: older.id,
			})
		),
		invalid
	)
})

test('incoming audit cursor must be canonical UTF-8 JSON and bound to the exact key before dispatch', async () => {
	let calls = 0
	const api = createAdminSharedKeyAuditApi(async () => {
		calls++
		return Response.json(page([]))
	})
	const raw = (value: object) =>
		btoa(JSON.stringify(value))
			.replace(/\+/gu, '-')
			.replace(/\//gu, '_')
			.replace(/=+$/u, '')
	for (const cursor of [
		'opaque_cursor',
		priorCursor + '=',
		raw({
			v: 2,
			key_id: 'shared-1',
			created_at: entry.createdAt,
			id: entry.id,
		}),
		raw({ v: 1, key_id: 'other', created_at: entry.createdAt, id: entry.id }),
		raw({
			v: 1,
			key_id: 'shared-1',
			created_at: entry.createdAt,
			id: entry.id,
			extra: 'private',
		}),
		raw({
			key_id: 'shared-1',
			v: 1,
			created_at: entry.createdAt,
			id: entry.id,
		}),
		raw({
			v: 1,
			key_id: 'shared-1',
			created_at: '2026-02-30T00:00:00.000Z',
			id: entry.id,
		}),
	])
		await assert.rejects(
			api.adminSharedKeyAudit('shared-1', cursor),
			AdminSharedKeyInputError
		)
	assert.equal(calls, 0)
})

test('audit snapshots must match the exact change mask, stable validation flag and changed profile revision', () => {
	const updated = {
		...entry,
		action: 'updated',
		changeMask: 6,
		before: { ...before, status: 'active' },
		after: { ...before, status: 'active', sellerPriority: 7, weight: 31 },
	}
	assert.equal(adminSharedKeyAuditEntrySchema.safeParse(updated).success, true)
	for (const value of [
		{ ...updated, changeMask: 2 },
		{ ...updated, after: { ...updated.after, validated: false } },
		{ ...updated, afterRevision: updated.beforeRevision },
		{
			...updated,
			after: { ...updated.after, status: 'disabled' },
			changeMask: 7,
		},
		{ ...updated, id: entry.id.toUpperCase().replace('1111', 'ABCD') },
	])
		assert.equal(adminSharedKeyAuditEntrySchema.safeParse(value).success, false)
})
