/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { McpCatalogItem } from './mcp-contracts'

export class McpReviewChangedError extends Error {
	constructor() {
		super('MCP review changed')
	}
}
export function assertMcpReviewCurrent(
	previous: McpCatalogItem,
	current: McpCatalogItem | undefined
): void {
	if (
		previous.reviewState !== 'changed' ||
		previous.pendingDefinition === null ||
		!current ||
		current.id !== previous.id ||
		current.serverId !== previous.serverId ||
		current.kind !== previous.kind ||
		current.upstreamKey !== previous.upstreamKey ||
		current.exposedName !== previous.exposedName ||
		current.status !== previous.status ||
		current.status === 'removed' ||
		current.reviewState !== 'changed' ||
		current.pendingDefinition === null ||
		JSON.stringify(current.definition) !==
			JSON.stringify(previous.definition) ||
		JSON.stringify(current.pendingDefinition) !==
			JSON.stringify(previous.pendingDefinition)
	)
		throw new McpReviewChangedError()
}
