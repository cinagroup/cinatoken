/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeMcpServers } from './mcp-summary'

test('an empty MCP list has known zero counts and exact zero item totals', () => {
	assert.deepEqual(summarizeMcpServers([]), {
		total: 0,
		active: 0,
		disabled: 0,
		pendingServers: 0,
		errorServers: 0,
		enabledItems: 0n,
		pendingItems: 0n,
	})
})

test('MCP overview excludes disabled enabled items but includes their pending items and errors', () => {
	assert.deepEqual(
		summarizeMcpServers([
			{
				status: 'active',
				enabledCount: 3,
				pendingCount: 2,
				lastSyncError: null,
			},
			{
				status: 'active',
				enabledCount: 5,
				pendingCount: 0,
				lastSyncError: 'MCP synchronization failed',
			},
			{
				status: 'disabled',
				enabledCount: 100,
				pendingCount: 4,
				lastSyncError: 'MCP synchronization failed',
			},
		]),
		{
			total: 3,
			active: 2,
			disabled: 1,
			pendingServers: 2,
			errorServers: 2,
			enabledItems: 8n,
			pendingItems: 6n,
		}
	)
})

test('an entirely disabled MCP directory retains review counts without publishing enabled items', () => {
	const result = summarizeMcpServers([
		{
			status: 'disabled',
			enabledCount: Number.MAX_SAFE_INTEGER,
			pendingCount: 1,
			lastSyncError: null,
		},
	])
	assert.equal(result.active, 0)
	assert.equal(result.disabled, 1)
	assert.equal(result.pendingServers, 1)
	assert.equal(result.enabledItems, 0n)
	assert.equal(result.pendingItems, 1n)
})

test('MCP item totals retain exact units when safe per-server counts sum beyond Number precision', () => {
	const maximum = Number.MAX_SAFE_INTEGER
	const result = summarizeMcpServers([
		{
			status: 'active',
			enabledCount: maximum,
			pendingCount: maximum,
			lastSyncError: null,
		},
		{
			status: 'active',
			enabledCount: 2,
			pendingCount: 2,
			lastSyncError: null,
		},
	])
	assert.equal(result.enabledItems, 9_007_199_254_740_993n)
	assert.equal(result.pendingItems, 9_007_199_254_740_993n)
})

test('MCP synchronization error presence preserves existing null and empty-string semantics', () => {
	const servers = [null, '', ' ', 'MCP synchronization failed'].map(
		(lastSyncError) => ({
			status: 'active' as const,
			enabledCount: 0,
			pendingCount: 0,
			lastSyncError,
		})
	)
	const result = summarizeMcpServers(servers)
	assert.equal(result.errorServers, 2)
	assert.equal(result.pendingServers, 0)
})

test('MCP summaries do not mutate input and remain independent of directory ordering', () => {
	const servers = Object.freeze([
		Object.freeze({
			status: 'active' as const,
			enabledCount: 7,
			pendingCount: 1,
			lastSyncError: null,
		}),
		Object.freeze({
			status: 'disabled' as const,
			enabledCount: 10,
			pendingCount: 4,
			lastSyncError: 'MCP synchronization failed',
		}),
	])
	const before = JSON.stringify(servers)
	assert.deepEqual(
		summarizeMcpServers(servers),
		summarizeMcpServers([...servers].reverse())
	)
	assert.equal(JSON.stringify(servers), before)
})
