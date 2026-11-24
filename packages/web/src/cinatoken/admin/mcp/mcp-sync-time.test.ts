/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMcpSyncTime } from './mcp-sync-time'

test('MCP sync times retain the already-standard ISO timestamps emitted by the service', () => {
	for (const value of [
		'2026-10-24T03:04:05.123Z',
		'1970-01-01T00:00:00.000Z',
		'2024-02-29T12:30:00.000Z',
	])
		assert.deepEqual(parseMcpSyncTime(value), { status: 'valid', iso: value })
	assert.deepEqual(parseMcpSyncTime('2026-10-24T03:04:05Z'), {
		status: 'valid',
		iso: '2026-10-24T03:04:05.000Z',
	})
})

test('MCP sync times honor explicit ISO offsets without guessing the business or browser zone', () => {
	for (const value of [
		'2026-10-24T00:00:00+08:00',
		'2026-10-23T12:00:00-04:00',
		'2026-10-23T21:30:00+05:30',
	])
		assert.deepEqual(parseMcpSyncTime(value), {
			status: 'valid',
			iso: '2026-10-23T16:00:00.000Z',
		})
	assert.deepEqual(parseMcpSyncTime('2026-10-24T00:00:00.123456+08:00'), {
		status: 'valid',
		iso: '2026-10-23T16:00:00.123Z',
	})
})

test('MCP SQL sync times are explicitly UTC and accept database fractional seconds', () => {
	for (const [value, expected] of [
		['2026-10-23 16:00:00', '2026-10-23T16:00:00.000Z'],
		['2026-10-23 16:00:00.1', '2026-10-23T16:00:00.100Z'],
		['2026-10-23 16:00:00.123', '2026-10-23T16:00:00.123Z'],
		['2026-10-23 16:00:00.123456', '2026-10-23T16:00:00.123Z'],
	])
		assert.deepEqual(parseMcpSyncTime(value), {
			status: 'valid',
			iso: expected,
		})
})

test('MCP sync times distinguish no record from malformed values and a real epoch observation', () => {
	assert.deepEqual(parseMcpSyncTime(null), { status: 'missing' })
	for (const value of ['', 'invalid', '0', 'x'.repeat(81)])
		assert.deepEqual(parseMcpSyncTime(value), { status: 'unavailable' })
	assert.deepEqual(parseMcpSyncTime('1970-01-01 00:00:00'), {
		status: 'valid',
		iso: '1970-01-01T00:00:00.000Z',
	})
})

test('MCP sync times reject calendar and clock rollover before native Date normalization', () => {
	for (const value of [
		'2026-02-29T00:00:00Z',
		'2026-02-30T00:00:00Z',
		'1900-02-29T00:00:00+08:00',
		'2026-04-31T00:00:00-04:00',
		'2026-13-01T00:00:00Z',
		'2026-00-01T00:00:00Z',
		'2026-10-24T24:00:00Z',
		'2026-10-24T00:60:00Z',
		'2026-10-24T00:00:60Z',
		'2026-10-24T00:00:00+24:00',
		'2026-10-24T00:00:00+08:60',
		'2026-02-30 00:00:00',
		'2026-04-31 00:00:00.123456',
		'2026-10-24 24:00:00',
	])
		assert.deepEqual(parseMcpSyncTime(value), { status: 'unavailable' }, value)
	assert.deepEqual(parseMcpSyncTime('2000-02-29 00:00:00'), {
		status: 'valid',
		iso: '2000-02-29T00:00:00.000Z',
	})
})

test('MCP sync times reject local or loosely parsed spellings instead of using the host timezone', () => {
	for (const value of [
		'2026-10-24',
		'2026-10-24T03:04:05',
		'10/24/2026 03:04:05',
		'October 24, 2026',
		' 2026-10-24T03:04:05Z',
		'2026-10-24T03:04:05Z ',
		'2026-10-24 03:04:05Z',
		'2026-10-24T03:04:05+0800',
		'2026-10-24 03:04',
		'2026-10-24 03:04:05.1234567',
		'2026-10-24T03:04:05z',
		'2026-10-24t03:04:05Z',
	])
		assert.deepEqual(parseMcpSyncTime(value), { status: 'unavailable' }, value)
})
