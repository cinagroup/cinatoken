/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { resolveMcpUnitPrices } from '@octafuse/core/mcp/pricing'
import { safeLogJson, safeLogText } from '../request-logs/request-log-domain'
import {
	mcpIdSchema,
	mcpSlugSchema,
	type McpCatalogItem,
	type McpPricingRule,
	type McpServer,
	type McpServerSummary,
} from './mcp-contracts'

export type McpSearch = {
	q: string
	filter: 'all' | 'active' | 'disabled' | 'pending' | 'error'
	server?: string
	kind: 'tool' | 'prompt' | 'resource'
	itemFilter: 'all' | 'enabled' | 'disabled' | 'removed' | 'pending'
	itemQuery: string
	invalidTarget?: true
}
export function validateMcpSearch(input: Record<string, unknown>): McpSearch {
	const server =
		input.server === undefined || input.server === ''
			? null
			: mcpIdSchema.safeParse(input.server)
	return {
		q: typeof input.q === 'string' ? input.q.slice(0, 200) : '',
		filter:
			typeof input.filter === 'string' &&
			['active', 'disabled', 'pending', 'error'].includes(input.filter)
				? (input.filter as McpSearch['filter'])
				: 'all',
		server: server?.success ? server.data : undefined,
		kind:
			input.kind === 'prompt' || input.kind === 'resource'
				? input.kind
				: 'tool',
		itemFilter:
			typeof input.itemFilter === 'string' &&
			['enabled', 'disabled', 'removed', 'pending'].includes(input.itemFilter)
				? (input.itemFilter as McpSearch['itemFilter'])
				: 'all',
		itemQuery:
			typeof input.itemQuery === 'string' ? input.itemQuery.slice(0, 200) : '',
		...((server && !server.success) || input.invalidTarget === true
			? { invalidTarget: true as const }
			: {}),
	}
}
export function filterMcpServers(
	servers: McpServerSummary[],
	search: Pick<McpSearch, 'q' | 'filter'>
): McpServerSummary[] {
	const query = search.q.trim().toLocaleLowerCase()
	return servers.filter((server) => {
		if (
			query &&
			![server.name, server.slug, server.description, server.urlMasked].some(
				(part) => part?.toLocaleLowerCase().includes(query)
			)
		)
			return false
		if (search.filter === 'pending') return server.pendingCount > 0
		if (search.filter === 'error') return Boolean(server.lastSyncError)
		return search.filter === 'all' || server.status === search.filter
	})
}
export function mcpItemDescription(
	item: Pick<McpCatalogItem, 'definition'>
): string {
	const definition = item.definition
	if (
		!definition ||
		typeof definition !== 'object' ||
		Array.isArray(definition)
	)
		return ''
	const record = definition as Record<string, unknown>
	const description =
		typeof record.description === 'string' ? record.description : record.title
	return typeof description === 'string'
		? safeLogText(description).slice(0, 8_192)
		: ''
}
function mcpItemSearchText(item: McpCatalogItem): string[] {
	const definition = item.definition
	if (
		!definition ||
		typeof definition !== 'object' ||
		Array.isArray(definition)
	)
		return []
	const record = definition as Record<string, unknown>
	return [record.title, record.description]
		.filter((value): value is string => typeof value === 'string')
		.map((value) => safeLogText(value))
}
export function filterMcpItems(
	items: McpCatalogItem[],
	search: Pick<McpSearch, 'kind' | 'itemFilter' | 'itemQuery'>
): McpCatalogItem[] {
	const query = search.itemQuery.trim().toLocaleLowerCase()
	return items.filter((item) => {
		if (item.kind !== search.kind) return false
		if (
			query &&
			![item.upstreamKey, item.exposedName, ...mcpItemSearchText(item)].some(
				(part) => part.toLocaleLowerCase().includes(query)
			)
		)
			return false
		if (search.itemFilter === 'pending')
			return item.status !== 'removed' && item.reviewState !== 'none'
		if (search.itemFilter === 'all') return item.status !== 'removed'
		return item.status === search.itemFilter
	})
}
/** This action covers the selected kind across the complete loaded catalog. */
export function newMcpItemIds(
	items: readonly Pick<
		McpCatalogItem,
		'id' | 'kind' | 'status' | 'reviewState'
	>[],
	kind: McpCatalogItem['kind']
): string[] {
	return [
		...new Set(
			items
				.filter(
					(item) =>
						item.kind === kind &&
						item.status === 'disabled' &&
						item.reviewState === 'new'
				)
				.map((item) => item.id)
		),
	]
}
/** Bound traversal before serializing unknown provider definitions; return text only. */
export function safeMcpJson(value: unknown): string {
	let nodes = 0
	let chars = 0
	const seen = new Set<object>()
	function visit(part: unknown, depth: number): boolean {
		if (++nodes > 20_000 || depth > 20) return false
		if (typeof part === 'string') {
			chars += part.length
			return chars <= 262_144
		}
		if (!part || typeof part !== 'object')
			return (
				part === null ||
				typeof part === 'boolean' ||
				(typeof part === 'number' && Number.isFinite(part))
			)
		if (seen.has(part)) return false
		seen.add(part)
		if (Array.isArray(part)) {
			for (const item of part) if (!visit(item, depth + 1)) return false
		} else {
			for (const key in part) {
				if (!Object.hasOwn(part, key)) continue
				chars += key.length
				if (
					chars > 262_144 ||
					!visit((part as Record<string, unknown>)[key], depth + 1)
				)
					return false
			}
		}
		return true
	}
	if (!visit(value, 0))
		return '[unavailable: definition exceeds display limits]'
	try {
		const raw = JSON.stringify(value)
		if (raw.length > 262_144)
			return '[unavailable: definition exceeds display limits]'
		const result = safeLogJson(raw) ?? ''
		return result.length <= 262_144
			? result
			: '[unavailable: definition exceeds display limits]'
	} catch {
		return '[unavailable: invalid definition]'
	}
}
export function effectiveMcpPricing(
	item: McpCatalogItem,
	server: McpServer
): McpPricingRule | null {
	if (item.pricingState === 'invalid') return null
	if (item.pricingState === 'inherit') return server.pricing
	return item.pricing
}
export function mcpItemPricingState(
	item: McpCatalogItem
): 'inherit' | 'override' | 'invalid' | 'unknown' {
	return item.pricingState ?? (item.pricing ? 'override' : 'unknown')
}
export function mcpPricingAmounts(rule: McpPricingRule | null) {
	if (!rule) return null
	try {
		return resolveMcpUnitPrices(rule)
	} catch {
		return null
	}
}
export function mcpInvocationHref(slug?: string): string {
	const params = new URLSearchParams({ source: 'mcp' })
	if (slug !== undefined) params.set('server', mcpSlugSchema.parse(slug))
	return '/admin/tools/invocations?' + params.toString()
}
