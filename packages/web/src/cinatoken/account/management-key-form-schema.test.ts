import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	managementKeyFormSchema,
	managementKeyInput,
} from './management-key-form-schema'

test('management key names are required, trimmed and bounded without silent truncation', () => {
	for (const name of ['', '  ', 'a'.repeat(129)])
		assert.equal(
			managementKeyFormSchema.safeParse({ name, expiresAt: '' }).success,
			false
		)
	assert.deepEqual(
		managementKeyInput(
			managementKeyFormSchema.parse({
				name: ' Deployment automation ',
				expiresAt: '',
			})
		),
		{ name: 'Deployment automation', expires_at: null }
	)
	assert.equal(
		managementKeyFormSchema.safeParse({ name: 'a'.repeat(128), expiresAt: '' })
			.success,
		true
	)
})

test('management key expiry requires a future local time and emits canonical UTC', () => {
	for (const expiresAt of ['not-a-date', '2000-01-01T00:00'])
		assert.equal(
			managementKeyFormSchema.safeParse({ name: 'Automation', expiresAt })
				.success,
			false
		)
	const expiresAt = '2099-01-02T12:30'
	assert.deepEqual(
		managementKeyInput(
			managementKeyFormSchema.parse({ name: 'Automation', expiresAt })
		),
		{ name: 'Automation', expires_at: new Date(expiresAt).toISOString() }
	)
})
