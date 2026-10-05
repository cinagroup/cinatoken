/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { userDetailKeySchema } from './user-detail-contracts'

const row = {
	id: 'key-1',
	key: 'legacy-password',
	user_id: 'user-1',
	workspace_id: 'personal:user-1',
	name: 'Main key',
	status: 'active',
	metadata: '{"password":"SECRET","ordinary":"visible"}',
	last_used_at: null,
	created_at: '2026-09-28 00:00:00',
	updated_at: '2026-09-28T01:00:00.000Z',
}

test('legacy key rows retain only a masked key and metadata count, never raw names or values', () => {
	const result = userDetailKeySchema.parse({
		...row,
		metadata_raw: '{"token":"RAW-SECRET"}',
		extra: 'PRIVATE',
	})
	assert.equal(result.key, 'sk-…')
	assert.deepEqual(result.metadata_preview, { field_count: 2 })
	assert.equal(result.metadata_unavailable, false)
	assert.equal(result.created_at, '2026-09-28T00:00:00.000Z')
	assert.equal(JSON.stringify(result).includes('SECRET'), false)
	assert.equal(JSON.stringify(result).includes('password'), false)
	assert.equal(JSON.stringify(result).includes('ordinary'), false)
	assert.equal('metadata' in result, false)
	assert.equal('metadata_raw' in result, false)
})

test('server summaries discard legacy raw fields and accept an unavailable metadata row without failing the list', () => {
	const result = userDetailKeySchema.parse({
		...row,
		metadata_preview: '{"field_count":1}',
		metadata_unavailable: false,
	})
	assert.deepEqual(result.metadata_preview, { field_count: 1 })
	assert.equal(JSON.stringify(result).includes('SECRET'), false)
	const unavailable = userDetailKeySchema.parse({
		...row,
		metadata_preview: null,
		metadata_unavailable: true,
	})
	assert.equal(unavailable.metadata_preview, null)
	assert.equal(unavailable.metadata_unavailable, true)
})

test('unsafe, malformed and oversized legacy JSON become unavailable summaries without retaining the value', () => {
	for (const raw of [
		'{',
		'[1]',
		'{"__proto__":{"token":"SECRET"}}',
		'{"x":"' + '界'.repeat(23_000) + '"}',
		7,
		undefined,
	]) {
		const result = userDetailKeySchema.parse({ ...row, metadata: raw })
		assert.equal(result.metadata_preview, null)
		assert.equal(result.metadata_unavailable, true)
		assert.equal('metadata' in result, false)
	}
})

test('malformed or secret-bearing summaries are rejected before Query state', () => {
	for (const summary of [
		'{',
		'{"field_count":-1}',
		'{"field_count":"1"}',
		'{"field_count":1001}',
		'{"field_count":1,"password":"SECRET"}',
	]) {
		assert.equal(
			userDetailKeySchema.safeParse({
				...row,
				metadata_preview: summary,
				metadata_unavailable: false,
			}).success,
			false
		)
	}
	assert.equal(
		userDetailKeySchema.safeParse({
			...row,
			metadata_preview: '{"field_count":1}',
			metadata_unavailable: true,
		}).success,
		false
	)
})

test('key rows require immutable ownership and reject invalid timestamps before retention', () => {
	for (const changed of [
		{ workspace_id: undefined },
		{ id: 'sk-secret' },
		{ user_id: 'user\n1' },
		{ created_at: '2026-02-30 00:00:00' },
	]) {
		assert.equal(
			userDetailKeySchema.safeParse({ ...row, ...changed }).success,
			false
		)
	}
})
