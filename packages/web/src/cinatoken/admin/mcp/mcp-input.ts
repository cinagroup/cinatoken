/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	mcpPricingSchema,
	mcpSlugSchema,
	type McpPricingRule,
	type McpServer,
} from './mcp-contracts'

export type McpPricingDraft = {
	mode: 'v1' | 'v2'
	standard: string
	charged: string
	metered: string
	chargedFactor: string
	meteredFactor: string
}
export type McpHeaderDraft = { key: string; value: string }
export type McpServerDraft = {
	slug: string
	name: string
	description: string
	url: string
	headers: McpHeaderDraft[]
	pricing: McpPricingDraft
	timeoutMs: string
	maxResponseBytes: string
	status: 'active' | 'disabled'
}
export class McpInputError extends Error {
	constructor(
		readonly field: string,
		readonly code:
			'required' | 'invalid' | 'tooLong' | 'invalidPricing' | 'invalidHeaders'
	) {
		super('Invalid MCP input')
		this.name = 'McpInputError'
	}
}
const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const forbiddenHeader =
	/^(?:host|content-length|connection|transfer-encoding)$/iu
export const mcpAuthHeadersSchema = z
	.record(
		z
			.string()
			.min(1)
			.max(256)
			.refine((key) => headerName.test(key) && !forbiddenHeader.test(key)),
		z
			.string()
			.max(4_096)
			.refine((value) => !/[\r\n]/u.test(value))
	)
	.refine((value) => Object.keys(value).length <= 20)
export const mcpUrlSchema = z
	.string()
	.trim()
	.min(1)
	.max(2_048)
	.transform((value, context) => {
		try {
			const url = new URL(value)
			const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
			const loopback = ['localhost', '127.0.0.1', '::1'].includes(host)
			if (
				url.username ||
				url.password ||
				['metadata.google.internal', 'metadata.google.com'].includes(host) ||
				(url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
			)
				throw new Error('Invalid MCP URL')
			return url.toString()
		} catch {
			context.addIssue({ code: 'custom', message: 'Invalid MCP URL' })
			return z.NEVER
		}
	})
export const mcpCreateInputSchema = z
	.object({
		slug: mcpSlugSchema,
		name: z.string().trim().min(1).max(120),
		description: z.string().trim().min(1).max(2_000).nullable(),
		url: mcpUrlSchema,
		authHeaders: mcpAuthHeadersSchema.optional(),
		status: z.enum(['active', 'disabled']).optional(),
		pricing: mcpPricingSchema.optional(),
		timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
		maxResponseBytes: z.number().int().min(1_000).max(8_000_000).optional(),
	})
	.strict()
export const mcpUpdateInputSchema = mcpCreateInputSchema
	.omit({ slug: true })
	.partial()
	.strict()
export type McpCreateInput = z.infer<typeof mcpCreateInputSchema>
export type McpUpdateInput = z.infer<typeof mcpUpdateInputSchema>

export function mcpPricingDraftFrom(
	rule?: McpPricingRule | null
): McpPricingDraft {
	const draft: McpPricingDraft = {
		mode: 'v2',
		standard: '',
		charged: '',
		metered: '',
		chargedFactor: '',
		meteredFactor: '',
	}
	if (rule === null) return draft
	if (!rule)
		return { ...draft, standard: '0', chargedFactor: '0', meteredFactor: '1' }
	if (rule.v === 1)
		return {
			...draft,
			mode: 'v1',
			standard: String(rule.prices.standard),
			charged: String(rule.prices.charged),
			metered: String(rule.prices.metered),
		}
	return {
		...draft,
		standard: String(rule.standard),
		chargedFactor: String(rule.chargedFactor),
		meteredFactor: String(rule.meteredFactor),
	}
}
export function mcpPricingFromDraft(draft: McpPricingDraft): McpPricingRule {
	const fields =
		draft.mode === 'v1'
			? (['standard', 'charged', 'metered'] as const)
			: (['standard', 'chargedFactor', 'meteredFactor'] as const)
	if (
		(draft.mode !== 'v1' && draft.mode !== 'v2') ||
		fields.some((key) => typeof draft[key] !== 'string' || !draft[key].trim())
	)
		throw new McpInputError('pricing', 'invalidPricing')
	const raw =
		draft.mode === 'v1'
			? {
					v: 1,
					unit: 'request',
					prices: {
						standard: draft.standard,
						charged: draft.charged,
						metered: draft.metered,
					},
					config: {},
				}
			: {
					v: 2,
					unit: 'request',
					standard: draft.standard,
					chargedFactor: draft.chargedFactor,
					meteredFactor: draft.meteredFactor,
					config: {},
				}
	const parsed = mcpPricingSchema.safeParse(raw)
	if (!parsed.success) throw new McpInputError('pricing', 'invalidPricing')
	return parsed.data
}
export function emptyMcpServerDraft(): McpServerDraft {
	return {
		slug: '',
		name: '',
		description: '',
		url: '',
		headers: [{ key: '', value: '' }],
		pricing: mcpPricingDraftFrom(),
		timeoutMs: '30000',
		maxResponseBytes: '1048576',
		status: 'active',
	}
}
export function mcpServerDraftFrom(server: McpServer): McpServerDraft {
	return {
		slug: server.slug,
		name: server.name,
		description: server.description ?? '',
		url: '',
		headers: server.authHeaderNames.length
			? server.authHeaderNames.map((key) => ({ key, value: '' }))
			: [{ key: '', value: '' }],
		pricing: mcpPricingDraftFrom(server.pricing),
		timeoutMs: String(server.timeoutMs),
		maxResponseBytes: String(server.maxResponseBytes),
		status: server.status,
	}
}
function headersFrom(
	rows: McpHeaderDraft[],
	current?: McpServer
): Record<string, string> {
	if (!Array.isArray(rows) || rows.length > 21)
		throw new McpInputError('headers', 'invalidHeaders')
	const entries: Array<[string, string]> = []
	for (const row of rows) {
		if (typeof row?.key !== 'string' || typeof row?.value !== 'string')
			throw new McpInputError('headers', 'invalidHeaders')
		const key = row.key.trim()
		if (!key && !row.value) continue
		if (
			!key ||
			(current && row.value === '' && !current.authHeaderNames.includes(key))
		)
			throw new McpInputError('headers', 'invalidHeaders')
		entries.push([key, row.value])
	}
	if (
		new Set(entries.map(([key]) => key.toLowerCase())).size !== entries.length
	)
		throw new McpInputError('headers', 'invalidHeaders')
	const parsed = mcpAuthHeadersSchema.safeParse(Object.fromEntries(entries))
	if (!parsed.success) throw new McpInputError('headers', 'invalidHeaders')
	return parsed.data
}
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value)
	if (result.success) return result.data
	const issue = result.error.issues[0]
	throw new McpInputError(
		String(issue?.path[0] ?? 'form'),
		issue?.code === 'too_big' ? 'tooLong' : 'invalid'
	)
}
export function mcpCreateInput(draft: McpServerDraft): McpCreateInput {
	return checked(mcpCreateInputSchema, {
		slug: draft.slug.trim(),
		name: draft.name.trim(),
		description: draft.description.trim() || null,
		url: draft.url.trim(),
		authHeaders: headersFrom(draft.headers),
		pricing: mcpPricingFromDraft(draft.pricing),
		timeoutMs: Number(draft.timeoutMs),
		maxResponseBytes: Number(draft.maxResponseBytes),
		status: draft.status,
	})
}
export function mcpUpdateInput(
	draft: McpServerDraft,
	current: McpServer
): McpUpdateInput {
	if (draft.slug !== current.slug) throw new McpInputError('slug', 'invalid')
	const original = mcpServerDraftFrom(current)
	const patch: Record<string, unknown> = {}
	if (draft.name.trim() !== current.name) patch.name = draft.name.trim()
	if ((draft.description.trim() || null) !== current.description)
		patch.description = draft.description.trim() || null
	if (draft.url.trim()) patch.url = draft.url.trim()
	if (draft.status !== current.status) patch.status = draft.status
	if (draft.timeoutMs !== original.timeoutMs)
		patch.timeoutMs = Number(draft.timeoutMs)
	if (draft.maxResponseBytes !== original.maxResponseBytes)
		patch.maxResponseBytes = Number(draft.maxResponseBytes)
	if (JSON.stringify(draft.pricing) !== JSON.stringify(original.pricing))
		patch.pricing = mcpPricingFromDraft(draft.pricing)
	const rows = draft.headers.filter((row) => row.key.trim() || row.value)
	const unchanged =
		rows.length === current.authHeaderNames.length &&
		new Set(rows.map((row) => row.key.trim())).size === rows.length &&
		rows.every(
			(row) =>
				row.value === '' && current.authHeaderNames.includes(row.key.trim())
		)
	if (!unchanged) patch.authHeaders = headersFrom(draft.headers, current)
	return checked(mcpUpdateInputSchema, patch)
}

export type McpImportCandidate = {
	name: string
	slug: string
	url: string
	headers: McpHeaderDraft[]
}
export type McpImportFailure =
	'empty' | 'invalid' | 'stdio' | 'sse' | 'oauth' | 'tooLarge'
export type McpImportParseResult =
	| { ok: true; servers: McpImportCandidate[] }
	| { ok: false; reason: McpImportFailure }
const failurePriority: McpImportFailure[] = ['sse', 'stdio', 'oauth', 'invalid']
function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}
function textField(value: Record<string, unknown>, key: string): string {
	return typeof value[key] === 'string' ? value[key].trim() : ''
}
export function slugFromMcpName(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 40)
		.replace(/-+$/u, '')
	return mcpSlugSchema.safeParse(slug).success ? slug : ''
}
function imported(
	name: string,
	rawUrl: string,
	rawHeaders?: unknown
): McpImportCandidate | null {
	const url = mcpUrlSchema.safeParse(rawUrl)
	const headers = mcpAuthHeadersSchema.safeParse(rawHeaders ?? {})
	if (!url.success || !headers.success) return null
	return {
		name: name.trim().slice(0, 120),
		slug: slugFromMcpName(name),
		url: url.data,
		headers: Object.entries(headers.data).map(([key, value]) => ({
			key,
			value,
		})),
	}
}
export function parseMcpClientConfig(input: string): McpImportParseResult {
	if (input.length > 131_072) return { ok: false, reason: 'tooLarge' }
	const raw = input.trim()
	if (!raw) return { ok: false, reason: 'empty' }
	if (/^https?:\/\//iu.test(raw)) {
		const server = imported('', raw)
		return server
			? { ok: true, servers: [server] }
			: { ok: false, reason: 'invalid' }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return { ok: false, reason: 'invalid' }
	}
	if (typeof parsed === 'string') {
		const server = imported('', parsed)
		return server
			? { ok: true, servers: [server] }
			: { ok: false, reason: 'invalid' }
	}
	const root = object(parsed)
	if (!root) return { ok: false, reason: 'invalid' }
	const map = object(root.mcpServers) ?? object(root.servers)
	const entries = map ? Object.entries(map) : [['', root] as const]
	if (entries.length > 100) return { ok: false, reason: 'tooLarge' }
	const servers: McpImportCandidate[] = []
	const failures: McpImportFailure[] = []
	for (const [fallback, value] of entries) {
		const config = object(value)
		if (!config) {
			failures.push('invalid')
			continue
		}
		const transport = (
			textField(config, 'type') || textField(config, 'transport')
		).toLowerCase()
		if (transport === 'sse') {
			failures.push('sse')
			continue
		}
		let url =
			textField(config, 'url') ||
			textField(config, 'serverUrl') ||
			textField(config, 'server_url')
		if (!url) {
			const command = [
				config.command,
				...(Array.isArray(config.args) ? config.args : []),
			].filter((part): part is string => typeof part === 'string')
			for (const part of command) {
				const match = part.match(/https?:\/\/[^\s"']+/iu)
				if (match) {
					url = match[0]
					break
				}
			}
		}
		if (!url) {
			const oauth =
				transport === 'oauth' ||
				config.oauth === true ||
				config.auth === 'oauth' ||
				object(config.auth)?.type === 'oauth'
			if (oauth) failures.push('oauth')
			else
				failures.push(
					transport === 'stdio' ||
						config.command !== undefined ||
						config.args !== undefined
						? 'stdio'
						: 'invalid'
				)
			continue
		}
		const name =
			textField(config, 'name') ||
			textField(config, 'server_label') ||
			textField(config, 'serverLabel') ||
			fallback
		const server = imported(name, url, config.headers)
		if (server) servers.push(server)
		else failures.push('invalid')
	}
	if (servers.length) return { ok: true, servers }
	return {
		ok: false,
		reason:
			failurePriority.find((failure) => failures.includes(failure)) ??
			'invalid',
	}
}
export function applyMcpImport<
	T extends Pick<McpServerDraft, 'slug' | 'name' | 'url' | 'headers'>,
>(form: T, candidate: McpImportCandidate, mode: 'create' | 'edit'): T {
	return {
		...form,
		slug: mode === 'create' && !form.slug.trim() ? candidate.slug : form.slug,
		name: mode === 'create' && !form.name.trim() ? candidate.name : form.name,
		url: candidate.url,
		headers: candidate.headers.length
			? candidate.headers.map((row) => ({ ...row }))
			: [{ key: '', value: '' }],
	}
}
