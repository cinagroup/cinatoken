import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GatewayKey } from '../contracts'
import { formatAccountDate, formatKeyLimit, keyStatus } from './key-display'

const key: GatewayKey = {
	id: 'key-id',
	workspaceId: 'workspace-id',
	key: 'sk-test…1234',
	name: null,
	status: 'active',
	limit: null,
	limitReset: null,
	expiresAt: '2026-01-01T00:00:00.000Z',
	lastUsedAt: null,
	createdAt: '2025-01-01T00:00:00.000Z',
}

test('currency display follows server metadata and preserves micro-unit precision', () => {
	assert.match(formatKeyLimit(12.5, 'en', 'CNY'), /^CNY/u)
	assert.match(formatKeyLimit(12.5, 'en', 'USD'), /^USD/u)
	assert.match(formatKeyLimit(0.000001, 'en', 'CNY'), /0\.000001/u)
})

test('UTC database timestamps and canonical ISO timestamps display identically', () => {
	assert.equal(
		formatAccountDate('2026-01-01 12:00:00', 'en'),
		formatAccountDate('2026-01-01T12:00:00.000Z', 'en')
	)
	assert.equal(formatAccountDate('not-a-date', 'en'), '—')
})

test('expiry overrides active status at its boundary without hiding revocation status', () => {
	const expires = Date.parse(key.expiresAt!)
	assert.equal(keyStatus(key, expires - 1), 'active')
	assert.equal(keyStatus(key, expires), 'expired')
	assert.equal(keyStatus({ ...key, status: 'revoked' }, expires), 'revoked')
	assert.equal(keyStatus({ ...key, expiresAt: null }, expires), 'active')
})
