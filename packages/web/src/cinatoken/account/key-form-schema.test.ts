import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createKeyInput, createKeySchema } from './key-form-schema'

const base = { name: '', limit: '', reset: 'lifetime' as const, expiresAt: '' }

test('blank optional values preserve unlimited lifetime and no expiry', () => {
	assert.deepEqual(createKeyInput(createKeySchema.parse(base)), {
		name: undefined,
		limit: null,
		limit_reset: null,
		expires_at: null,
	})
})

test('zero is an explicit blocking budget and is never converted to unlimited', () => {
	assert.equal(
		createKeyInput(createKeySchema.parse({ ...base, limit: '0' })).limit,
		0
	)
	assert.equal(
		createKeyInput(createKeySchema.parse({ ...base, limit: '0.000001' })).limit,
		0.000001
	)
})

test('budget validation rejects negative, non-finite, rounded and unsafe amounts', () => {
	for (const limit of [
		'-1',
		'NaN',
		'Infinity',
		'1.0000001',
		'100000000000000',
	]) {
		assert.equal(
			createKeySchema.safeParse({ ...base, limit }).success,
			false,
			limit
		)
	}
})

test('local expiry is normalized to canonical UTC and past expiry is rejected', () => {
	const future = '2099-01-02T12:30'
	const input = createKeyInput(
		createKeySchema.parse({
			...base,
			name: ' Production ',
			limit: '20.5',
			reset: 'weekly',
			expiresAt: future,
		})
	)
	assert.equal(input.name, 'Production')
	assert.equal(input.limit_reset, 'weekly')
	assert.equal(input.expires_at, new Date(future).toISOString())
	for (const expiresAt of ['not a date', '2000-01-01T00:00']) {
		assert.equal(
			createKeySchema.safeParse({ ...base, expiresAt }).success,
			false
		)
	}
})

test('names cannot silently be truncated beyond the server limit', () => {
	assert.equal(
		createKeySchema.safeParse({ ...base, name: 'a'.repeat(129) }).success,
		false
	)
	assert.equal(
		createKeySchema.safeParse({ ...base, name: 'a'.repeat(128) }).success,
		true
	)
})
