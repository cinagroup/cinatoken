/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { accessKeySecretSchema } from './access-key-contracts'
import {
	AccessKeyInputError,
	accessKeyDraft,
	generateAccessKeySecret,
	toggleAccessKeyPermission,
} from './access-key-domain'
import { adminAccessKeyMessages } from './messages'

test('fresh drafts contain 256 random bits and normalize minimum-permission metadata', () => {
	const first = generateAccessKeySecret()
	const second = generateAccessKeySecret()
	assert.equal(accessKeySecretSchema.safeParse(first).success, true)
	assert.notEqual(first, second)
	assert.deepEqual(
		accessKeyDraft('  ERP  ', '  ', ['routes.read', 'routes.read']),
		{
			name: 'ERP',
			description: null,
			permissions: ['routes.read'],
		}
	)
	assert.deepEqual(
		accessKeyDraft('ERP', 'ERP sync', ['routes.read', '*'], first),
		{
			name: 'ERP',
			description: 'ERP sync',
			permissions: ['*'],
			secret_key: first,
		}
	)
})

test('wildcard replaces delegated permissions and individual choice clears wildcard', () => {
	assert.deepEqual(toggleAccessKeyPermission(['routes.read'], '*'), ['*'])
	assert.deepEqual(toggleAccessKeyPermission(['*'], '*'), [])
	assert.deepEqual(toggleAccessKeyPermission(['*'], 'routes.read'), [
		'routes.read',
	])
	assert.deepEqual(
		toggleAccessKeyPermission(['routes.read'], 'routes.read'),
		[]
	)
})

test('invalid metadata, no permissions and invalid rotation draft fail before writing', () => {
	for (const create of [
		() => accessKeyDraft(' ', '', ['routes.read']),
		() => accessKeyDraft('bad\nname', '', ['routes.read']),
		() => accessKeyDraft('a'.repeat(256), '', ['routes.read']),
		() => accessKeyDraft('ERP', 'a'.repeat(10_001), ['routes.read']),
		() => accessKeyDraft('ERP', '', []),
		() => accessKeyDraft('ERP', '', ['routes.read'], 'not-a-secret'),
	])
		assert.throws(create, AccessKeyInputError)
})

test('all supported locales explain draft expiry, console-only wildcard and unknown-write recovery', () => {
	for (const messages of Object.values(adminAccessKeyMessages)) {
		assert.deepEqual(
			Object.keys(messages),
			Object.keys(adminAccessKeyMessages.en)
		)
		for (const message of Object.values(messages))
			assert.equal(message.length > 0, true)
	}
})
