/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { McpServerSummary } from './mcp-contracts'

export type McpSummary = {
	total: number
	active: number
	disabled: number
	pendingServers: number
	errorServers: number
	enabledItems: bigint
	pendingItems: bigint
}

type SummaryServer = Pick<
	McpServerSummary,
	'status' | 'enabledCount' | 'pendingCount' | 'lastSyncError'
>

/** Counts have already passed the per-server safe-integer API contract. */
export function summarizeMcpServers(
	servers: readonly SummaryServer[]
): McpSummary {
	const summary: McpSummary = {
		total: servers.length,
		active: 0,
		disabled: 0,
		pendingServers: 0,
		errorServers: 0,
		enabledItems: 0n,
		pendingItems: 0n,
	}

	for (const server of servers) {
		if (server.status === 'active') {
			summary.active += 1
			summary.enabledItems += BigInt(server.enabledCount)
		} else summary.disabled += 1
		if (server.pendingCount > 0) summary.pendingServers += 1
		if (server.lastSyncError) summary.errorServers += 1
		summary.pendingItems += BigInt(server.pendingCount)
	}
	return summary
}
