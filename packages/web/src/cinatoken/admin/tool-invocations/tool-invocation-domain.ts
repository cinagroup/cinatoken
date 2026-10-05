/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { resolveReliabilityRange } from '../reliability/reliability-range'
import {
	cleanLogDate,
	isSensitiveLogKey,
	safeLogJson,
	safeLogText,
} from '../request-logs/request-log-domain'

export const tools = [
	{ id: 'web-search', modelId: 'tool:web-search', label: 'webSearch' },
	{ id: 'web-fetch', modelId: 'tool:web-fetch', label: 'webFetch' },
	{
		id: 'web-deep-search',
		modelId: 'tool:web-deep-search',
		label: 'webDeepSearch',
	},
	{ id: 'ai-detection', modelId: 'tool:ai-detection', label: 'aiDetection' },
] as const
export type ToolId = (typeof tools)[number]['id'] | ''
export type ToolInvocationSearch = {
	page: number
	tool: ToolId
	status: '' | 'success' | 'error'
	start_date?: string
	end_date?: string
}

/** The legacy default is the current business day, falling back to the UTC day. */
export function defaultToolInvocationSearch(
	search: ToolInvocationSearch,
	timezone: string | null,
	now: Date
): ToolInvocationSearch | null {
	const range = resolveReliabilityRange(
		{ kind: 'calendar', preset: 'today' },
		timezone ?? 'UTC',
		now
	)
	return range
		? { ...search, start_date: range.startUtc, end_date: range.endUtc }
		: null
}

function toolById(value: unknown): (typeof tools)[number] | undefined {
	return tools.find((tool) => value === tool.id || value === tool.modelId)
}
export function validateToolInvocationSearch(
	input: Record<string, unknown>
): ToolInvocationSearch {
	const page = Number(input.page)
	return {
		page:
			Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000 ? page : 1,
		tool: toolById(input.tool)?.id ?? '',
		status:
			input.status === 'success' || input.status === 'error'
				? input.status
				: '',
		start_date: cleanLogDate(input.start_date),
		end_date: cleanLogDate(input.end_date),
	}
}
function paramsFor(search: ToolInvocationSearch): URLSearchParams {
	const safe = validateToolInvocationSearch(
		search as unknown as Record<string, unknown>
	)
	if (
		safe.page !== search.page ||
		safe.tool !== search.tool ||
		safe.status !== search.status ||
		(search.start_date && safe.start_date !== search.start_date) ||
		(search.end_date && safe.end_date !== search.end_date)
	)
		throw new TypeError('Invalid tool-invocation search')
	const params = new URLSearchParams()
	const tool = toolById(safe.tool)
	if (tool) params.set('model_id', tool.modelId)
	else params.set('provider_id', 'octafuse-tools')
	if (safe.status) params.set('status', safe.status)
	if (safe.start_date) params.set('start_date', safe.start_date)
	if (safe.end_date) params.set('end_date', safe.end_date)
	return params
}
export function toolInvocationsPath(search: ToolInvocationSearch): string {
	const params = paramsFor(search)
	params.set('page', String(search.page))
	params.set('page_size', '50')
	return `/api/admin/request-logs?${params.toString()}`
}
export function toolRequestLogsHref(search: ToolInvocationSearch): string {
	return `/admin/request-logs?${paramsFor(search).toString()}`
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}
function parseJson(raw: string | null | undefined): unknown | null {
	if (!raw?.trim()) return null
	try {
		return JSON.parse(raw) as unknown
	} catch {
		return null
	}
}
/** Plain text for summaries and safe link destinations. */
export function safeToolText(value: string): string {
	return safeLogText(value)
}
export function safeToolRaw(value: string | null | undefined): string | null {
	const safe = safeLogJson(value)
	return safe ? safeToolText(safe) : null
}
export function toolRequestSummary(raw: string | null | undefined): {
	query: string | null
	provider: string | null
} {
	const data = record(parseJson(raw))
	if (!data) return { query: null, provider: null }
	const query =
		typeof data.query === 'string'
			? data.query
			: typeof data.url === 'string'
				? data.url
				: null
	return {
		query: query ? safeToolText(query) : null,
		provider:
			typeof data.provider === 'string' ? safeToolText(data.provider) : null,
	}
}
export function toolEngine(log: {
	model_id?: string | null
	provider_model_name?: string | null
	request_body?: string | null
	pricing_audit?: string | null
}): string | null {
	const model = log.model_id?.trim() || ''
	const stored = log.provider_model_name?.trim() || ''
	if (stored && stored !== model && !stored.startsWith('tool:'))
		return safeToolText(stored)
	const requested = toolRequestSummary(log.request_body).provider?.trim()
	if (requested) return requested
	const audit = record(parseJson(log.pricing_audit))
	return typeof audit?.provider === 'string'
		? safeToolText(audit.provider.trim()) || null
		: null
}
export type ToolResult = {
	title: string | null
	url: string | null
	snippet: string | null
	siteName: string | null
}
export type ToolResponseSummary = {
	resultCount: number | null
	results: ToolResult[]
	overallScore: number | null
	segmentCount: number | null
	segments: Array<{
		index: number | null
		score: number | null
		chars: number | null
	}>
}
function finite(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function textValue(value: unknown): string | null {
	return typeof value === 'string' ? safeToolText(value) : null
}
export function toolResponseSummary(
	raw: string | null | undefined
): ToolResponseSummary {
	const data = record(parseJson(raw))
	if (!data)
		return {
			resultCount: null,
			results: [],
			overallScore: null,
			segmentCount: null,
			segments: [],
		}
	const results = (Array.isArray(data.results) ? data.results : [])
		.map(record)
		.filter((item): item is Record<string, unknown> => item !== null)
		.map((item): ToolResult => ({
			title: textValue(item.title),
			url: textValue(item.url),
			snippet: textValue(item.snippet) ?? textValue(item.content_preview),
			siteName: textValue(item.siteName),
		}))
	if (
		!results.length &&
		(typeof data.content_preview === 'string' || typeof data.url === 'string')
	)
		results.push({
			title: textValue(data.title),
			url: textValue(data.url),
			snippet: textValue(data.content_preview),
			siteName: null,
		})
	const segments = (Array.isArray(data.segments) ? data.segments : [])
		.map(record)
		.filter((item): item is Record<string, unknown> => item !== null)
		.map((item) => ({
			index: finite(item.index),
			score: finite(item.score),
			chars: finite(item.chars),
		}))
	const count = finite(data.result_count)
	return {
		resultCount: count !== null ? count : results.length || null,
		results,
		overallScore: finite(data.overall_score),
		segmentCount: finite(data.segment_count) ?? (segments.length || null),
		segments,
	}
}
export function safeResultHref(value: string | null): string | null {
	if (!value) return null
	try {
		const url = new URL(safeToolText(value))
		for (const [key, queryValue] of url.searchParams) {
			if (
				queryValue !== '[redacted]' &&
				(isSensitiveLogKey(key) || /^(?:key|auth)$/iu.test(key))
			)
				url.searchParams.set(key, '[redacted]')
		}
		return (url.protocol === 'http:' || url.protocol === 'https:') &&
			!url.username &&
			!url.password
			? url.toString()
			: null
	} catch {
		return null
	}
}

/** A hidden amount must not disclose its sign through color or row emphasis. */
export function toolProfitPresentation(
	profit: number,
	currency: 'USD' | 'CNY' | null
): { tone: string; row: string } {
	if (!currency) return { tone: '', row: '' }
	if (profit < 0)
		return {
			tone: 'text-red-700 dark:text-red-400',
			row: 'bg-amber-500/5',
		}
	if (profit > 0)
		return { tone: 'text-emerald-700 dark:text-emerald-400', row: '' }
	return { tone: '', row: '' }
}
