/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { safeLogText } from '../request-logs/request-log-domain'
import { groupMcpClientEntries, type McpClientMethod } from './mcp-client'
import type { McpServerSummary } from './mcp-contracts'

export type McpClientCatalogGroup = {
	slug: string
	name: string | null
	entries: Record<string, unknown>[]
}
export const MCP_CLIENT_CATALOG_PAGE_SIZE = 50

/** Entries have already passed the client response contract and secret redaction. */
export function filterMcpClientCatalog(
	entries: Record<string, unknown>[],
	method: McpClientMethod,
	slug: string,
	servers: readonly Pick<McpServerSummary, 'slug' | 'name'>[],
	search: string
): { groups: McpClientCatalogGroup[]; total: number; matched: number } {
	const names = new Map(
		servers.map((server) => [server.slug, safeLogText(server.name)])
	)
	const query = search.trim().toLocaleLowerCase()
	const groups: McpClientCatalogGroup[] = []
	let total = 0
	let matched = 0
	for (const group of groupMcpClientEntries(entries, method, slug)) {
		total += group.entries.length
		const name = names.get(group.slug) ?? null
		const matchesServer =
			!query ||
			[group.slug, name].some(
				(value) =>
					typeof value === 'string' && value.toLocaleLowerCase().includes(query)
			)
		const visible = group.entries.filter(
			(entry) =>
				matchesServer ||
				[entry.name, entry.uri, entry.title, entry.description].some(
					(value) =>
						typeof value === 'string' &&
						value.toLocaleLowerCase().includes(query)
				)
		)
		matched += visible.length
		if (visible.length)
			groups.push({ slug: group.slug, name, entries: visible })
	}
	return { groups, total, matched }
}

/** The page budget covers entries across all groups, including a single large server. */
export function paginateMcpClientCatalog(
	groups: readonly McpClientCatalogGroup[],
	requestedPage: number
): {
	groups: McpClientCatalogGroup[]
	page: number
	pages: number
	from: number
	to: number
} {
	const total = groups.reduce((sum, group) => sum + group.entries.length, 0)
	const pages = Math.max(1, Math.ceil(total / MCP_CLIENT_CATALOG_PAGE_SIZE))
	const page = Number.isSafeInteger(requestedPage)
		? Math.min(pages, Math.max(1, requestedPage))
		: 1
	const start = (page - 1) * MCP_CLIENT_CATALOG_PAGE_SIZE
	const end = start + MCP_CLIENT_CATALOG_PAGE_SIZE
	const visible: McpClientCatalogGroup[] = []
	let offset = 0
	for (const group of groups) {
		if (offset >= end) break
		const next = offset + group.entries.length
		if (next > start)
			visible.push({
				...group,
				entries: group.entries.slice(Math.max(0, start - offset), end - offset),
			})
		offset = next
	}
	return {
		groups: visible,
		page,
		pages,
		from: total ? start + 1 : 0,
		to: Math.min(end, total),
	}
}

export function mcpClientResponseView(
	preferred: 'raw' | 'grouped',
	entries: Record<string, unknown>[] | null
): 'raw' | 'grouped' {
	return entries === null ? 'raw' : preferred
}
