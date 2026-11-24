/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { isSensitiveLogKey } from '../request-logs/request-log-domain'
import { isOriginalGatewaySecret } from '../simulator/simulator-api'
import {
	mcpClientDiagnosticHeaders,
	mcpClientJsonDiagnosticBody,
	mcpClientTextDiagnosticBody,
	safeMcpClientDiagnosticText,
	type McpClientDiagnostic,
} from './mcp-client-diagnostics'
import { mcpSlugSchema } from './mcp-contracts'

export type { McpClientDiagnostic } from './mcp-client-diagnostics'

export const MCP_CLIENT_METHODS = [
	'initialize',
	'tools/list',
	'prompts/list',
	'resources/list',
] as const
export const MCP_CLIENT_VERSIONS = ['2025-06-18', '2025-03-26'] as const
export type McpClientMethod = (typeof MCP_CLIENT_METHODS)[number]
export type McpClientRequest = {
	url: string
	method: 'POST'
	headers: Record<string, string>
	bodyText: string
	id: number
	rpcMethod: McpClientMethod
	slug: string
}
export type McpClientParsed = {
	valid: boolean
	json: unknown
	entries: Record<string, unknown>[] | null
	rpcError: boolean
}
export class McpClientError extends Error {
	constructor(
		readonly code: 'invalid' | 'network' | 'cancelled' | 'timeout' | 'tooLarge',
		readonly diagnostic?: McpClientDiagnostic
	) {
		super('MCP client request could not be confirmed')
		this.name = 'McpClientError'
	}
}
const maxResponseBytes = 8 * 1024 * 1024
const maxEntries = 25_000
function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}
function isMethod(value: unknown): value is McpClientMethod {
	return MCP_CLIENT_METHODS.some((method) => method === value)
}
function isVersion(
	value: unknown
): value is (typeof MCP_CLIENT_VERSIONS)[number] {
	return MCP_CLIENT_VERSIONS.some((version) => version === value)
}
export function mcpClientBase(raw: string): string | null {
	try {
		if (
			typeof raw !== 'string' ||
			raw.length > 2_048 ||
			/[\p{Cc}\p{Cf}]/u.test(raw)
		)
			return null
		const url = new URL(raw.trim())
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			/\/mcp(?:\/[^/]+)?\/?$/u.test(url.pathname)
		)
			return null
		return url.href.replace(/\/+$/u, '')
	} catch {
		return null
	}
}
export function normalizeMcpClientSecret(raw: string): string {
	if (typeof raw !== 'string') throw new McpClientError('invalid')
	const secret = raw
		.trim()
		.replace(/^Bearer\s+/iu, '')
		.trim()
	if (!isOriginalGatewaySecret(secret)) throw new McpClientError('invalid')
	return secret
}
export function buildMcpClientRequest(input: {
	base: string
	slug: string
	method: McpClientMethod
	version: string
	id: number
}): McpClientRequest {
	const base = mcpClientBase(input.base)
	if (
		!base ||
		(input.slug !== '' && !mcpSlugSchema.safeParse(input.slug).success) ||
		!isMethod(input.method) ||
		!isVersion(input.version) ||
		!Number.isSafeInteger(input.id) ||
		input.id < 1
	)
		throw new McpClientError('invalid')
	return {
		url: `${base}/mcp${input.slug ? '/' + encodeURIComponent(input.slug) : ''}`,
		method: 'POST',
		rpcMethod: input.method,
		slug: input.slug,
		id: input.id,
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			Authorization: 'Bearer ***',
			'MCP-Protocol-Version': input.version,
		},
		bodyText: JSON.stringify(
			{
				jsonrpc: '2.0',
				id: input.id,
				method: input.method,
				params:
					input.method === 'initialize'
						? {
								protocolVersion: input.version,
								capabilities: {},
								clientInfo: {
									name: 'cinatoken-web-catalog-test',
									version: '1.0.0',
								},
							}
						: {},
			},
			null,
			2
		),
	}
}
/** Rebuild an owned snapshot; neither fetch nor cURL accepts custom RPC bodies or headers. */
function checkedRequest(request: McpClientRequest): McpClientRequest {
	try {
		const suffix =
			'/mcp' + (request.slug ? '/' + encodeURIComponent(request.slug) : '')
		if (!request.url.endsWith(suffix)) throw new McpClientError('invalid')
		const expected = buildMcpClientRequest({
			base: request.url.slice(0, -suffix.length),
			slug: request.slug,
			method: request.rpcMethod,
			version: request.headers['MCP-Protocol-Version'] ?? '',
			id: request.id,
		})
		const keys = Object.keys(expected) as Array<keyof McpClientRequest>
		if (
			Object.keys(request).length !== keys.length ||
			keys.some((key) => key !== 'headers' && expected[key] !== request[key]) ||
			Object.keys(request.headers).length !==
				Object.keys(expected.headers).length ||
			Object.entries(expected.headers).some(
				([key, value]) => request.headers[key] !== value
			)
		)
			throw new McpClientError('invalid')
		Object.freeze(expected.headers)
		return Object.freeze(expected)
	} catch {
		throw new McpClientError('invalid')
	}
}
/** Redact after JSON decoding, including escaped echoes of the original Gateway secret. */
function safeResponseJson(raw: string, secret: string): unknown {
	let nodes = 0
	function text(value: string): string {
		return safeMcpClientDiagnosticText(value, secret)
	}
	function visit(value: unknown, depth: number): unknown {
		if (++nodes > 250_000 || depth > 32) throw new McpClientError('tooLarge')
		if (typeof value === 'string') return text(value)
		if (typeof value === 'number' && !Number.isFinite(value))
			throw new McpClientError('invalid')
		if (Array.isArray(value))
			return value.map((entry) => visit(entry, depth + 1))
		const record = object(value)
		if (!record) return value
		return Object.fromEntries(
			Object.entries(record).map(([key, part]) => [
				text(key),
				isSensitiveLogKey(key) ? '[redacted]' : visit(part, depth + 1),
			])
		)
	}
	return visit(JSON.parse(raw) as unknown, 0)
}
function parsedJsonResponse(
	json: unknown,
	request: Pick<McpClientRequest, 'id' | 'rpcMethod'>
): McpClientParsed {
	const invalid: McpClientParsed = {
		valid: false,
		json,
		entries: null,
		rpcError: false,
	}
	const envelope = object(json)
	if (
		!isMethod(request.rpcMethod) ||
		!Number.isSafeInteger(request.id) ||
		request.id < 1 ||
		!envelope ||
		envelope.jsonrpc !== '2.0' ||
		envelope.id !== request.id
	)
		return invalid
	if (Object.hasOwn(envelope, 'error')) {
		const error = object(envelope.error)
		return {
			...invalid,
			rpcError:
				!Object.hasOwn(envelope, 'result') &&
				Boolean(
					error &&
					Number.isSafeInteger(error.code) &&
					typeof error.message === 'string'
				),
		}
	}
	const result = object(envelope.result)
	if (!result) return invalid
	if (request.rpcMethod === 'initialize') {
		const info = object(result.serverInfo)
		return {
			...invalid,
			valid:
				isVersion(result.protocolVersion) &&
				object(result.capabilities) !== null &&
				Boolean(
					info &&
					typeof info.name === 'string' &&
					info.name &&
					typeof info.version === 'string' &&
					info.version
				),
		}
	}
	const field = {
		'tools/list': 'tools',
		'prompts/list': 'prompts',
		'resources/list': 'resources',
	}[request.rpcMethod]
	const entries = result[field],
		identity = field === 'resources' ? 'uri' : 'name'
	if (
		!Array.isArray(entries) ||
		entries.length > maxEntries ||
		entries.some((entry) => {
			const record = object(entry)
			return (
				!record || typeof record[identity] !== 'string' || !record[identity]
			)
		}) ||
		(Object.hasOwn(result, 'nextCursor') &&
			typeof result.nextCursor !== 'string')
	)
		return invalid
	return {
		valid: true,
		json,
		entries: entries as Record<string, unknown>[],
		rpcError: false,
	}
}
export function parseMcpClientResponse(
	raw: string,
	request: Pick<McpClientRequest, 'id' | 'rpcMethod'>
): McpClientParsed {
	try {
		if (typeof raw !== 'string' || raw.length > maxResponseBytes)
			throw new McpClientError('tooLarge')
		return parsedJsonResponse(safeResponseJson(raw, ''), request)
	} catch {
		return { valid: false, json: null, entries: null, rpcError: false }
	}
}
export function groupMcpClientEntries(
	entries: Record<string, unknown>[],
	method: McpClientMethod,
	fallback = ''
): Array<{ slug: string; entries: Record<string, unknown>[] }> {
	const groups = new Map<string, Record<string, unknown>[]>()
	const scopedSlug = mcpSlugSchema.safeParse(fallback).success ? fallback : ''
	for (const entry of entries.slice(0, maxEntries)) {
		let slug = scopedSlug
		if (method === 'resources/list' && typeof entry.uri === 'string') {
			const match = /^octafuse:\/\/([a-z0-9-]+)\/(.+)$/u.exec(entry.uri)
			try {
				if (
					match &&
					mcpSlugSchema.safeParse(match[1]).success &&
					encodeURIComponent(decodeURIComponent(match[2])) === match[2]
				)
					slug = match[1]
			} catch {
				/* Malformed or foreign URI namespaces stay in the scoped group. */
			}
		} else if (
			(method === 'tools/list' || method === 'prompts/list') &&
			typeof entry.name === 'string'
		) {
			const match = /^([a-z0-9-]+)__(.+)$/u.exec(entry.name)
			if (match && mcpSlugSchema.safeParse(match[1]).success) slug = match[1]
		}
		const values = groups.get(slug) ?? []
		values.push(entry)
		groups.set(slug, values)
	}
	return Array.from(groups, ([slug, values]) => ({ slug, entries: values }))
}
export function mcpClientCurl(request: McpClientRequest): string {
	const snapshot = checkedRequest(request)
	const quote = (value: string) => `'${value.replace(/'/gu, "'\\''")}'`
	return [
		`curl -X POST ${quote(snapshot.url)}`,
		...Object.entries({
			...snapshot.headers,
			Authorization: 'Bearer <YOUR_API_KEY>',
		}).map(([name, value]) => `  -H ${quote(name + ': ' + value)}`),
		`  --data-raw ${quote(snapshot.bodyText)}`,
	].join(' \\\n')
}
function cancelBody(response: Response): void {
	void response.body?.cancel().catch(() => undefined)
}
/** Abort settles locally even when fetch/read/cancel does not acknowledge cancellation. */
async function waitForAbort<T>(
	work: Promise<T>,
	signal: AbortSignal,
	late?: (value: T) => void
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false
		const abort = () => {
			if (settled) return
			settled = true
			signal.removeEventListener('abort', abort)
			reject(new McpClientError('cancelled'))
		}
		signal.addEventListener('abort', abort, { once: true })
		if (signal.aborted) abort()
		work.then(
			(value) => {
				if (settled) {
					try {
						late?.(value)
					} catch {
						// Late cleanup cannot change an already cancelled operation.
					}
					return
				}
				settled = true
				signal.removeEventListener('abort', abort)
				resolve(value)
			},
			(error: unknown) => {
				if (settled) return
				settled = true
				signal.removeEventListener('abort', abort)
				reject(error)
			}
		)
	})
}
export async function executeMcpClient(
	request: McpClientRequest,
	secretInput: string,
	options: {
		signal?: AbortSignal
		timeoutMs?: number
		fetch?: typeof fetch
	} = {}
): Promise<{
	request: McpClientRequest
	status: number
	elapsedMs: number
	parsed: McpClientParsed
	diagnostic: McpClientDiagnostic
}> {
	const snapshot = checkedRequest(request),
		secret = normalizeMcpClientSecret(secretInput)
	const timeoutMs = options.timeoutMs ?? 30_000
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
		throw new McpClientError('invalid')
	const controller = new AbortController()
	const abort = () => controller.abort()
	options.signal?.addEventListener('abort', abort, { once: true })
	if (options.signal?.aborted) abort()
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, timeoutMs)
	const started = performance.now()
	let status: number | null = null
	let headers: Record<string, string> = {}
	const metadata = (): McpClientDiagnostic => ({
		status,
		elapsedMs: Math.round(performance.now() - started),
		headers,
		bodyText: null,
		bodyKind: 'unavailable',
		truncated: false,
	})
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
	let done = false
	try {
		controller.signal.throwIfAborted()
		const response = await waitForAbort(
			(options.fetch ?? fetch)(snapshot.url, {
				method: 'POST',
				headers: { ...snapshot.headers, Authorization: 'Bearer ' + secret },
				body: snapshot.bodyText,
				signal: controller.signal,
				credentials: 'omit',
				redirect: 'error',
				cache: 'no-store',
				referrerPolicy: 'no-referrer',
			}),
			controller.signal,
			cancelBody
		)
		status = response.status
		headers = mcpClientDiagnosticHeaders(response.headers, secret)
		if (controller.signal.aborted) {
			cancelBody(response)
			controller.signal.throwIfAborted()
		}
		if (Number(response.headers.get('content-length')) > maxResponseBytes) {
			cancelBody(response)
			throw new McpClientError('tooLarge')
		}
		reader = response.body?.getReader()
		const decoder = new TextDecoder('utf-8', { fatal: true })
		let raw = '',
			bytes = 0
		while (reader) {
			const chunk = await waitForAbort(reader.read(), controller.signal)
			controller.signal.throwIfAborted()
			if (chunk.done) {
				done = true
				break
			}
			bytes += chunk.value.byteLength
			if (bytes > maxResponseBytes) throw new McpClientError('tooLarge')
			try {
				raw += decoder.decode(chunk.value, { stream: true })
			} catch {
				throw new McpClientError('invalid')
			}
		}
		try {
			raw += decoder.decode()
		} catch {
			throw new McpClientError('invalid')
		}
		controller.signal.throwIfAborted()
		let parsed: McpClientParsed
		let diagnostic = metadata()
		try {
			const json = safeResponseJson(raw, secret)
			parsed = parsedJsonResponse(json, snapshot)
			diagnostic = { ...diagnostic, ...mcpClientJsonDiagnosticBody(json) }
		} catch (error) {
			if (error instanceof McpClientError) throw error
			parsed = { valid: false, json: null, entries: null, rpcError: false }
			diagnostic = {
				...diagnostic,
				...mcpClientTextDiagnosticBody(raw, secret),
			}
		}
		diagnostic.elapsedMs = Math.round(performance.now() - started)
		return {
			request: snapshot,
			status: response.status,
			elapsedMs: diagnostic.elapsedMs,
			parsed: { ...parsed, valid: response.ok && parsed.valid },
			diagnostic,
		}
	} catch (error) {
		if (controller.signal.aborted)
			throw new McpClientError(timedOut ? 'timeout' : 'cancelled', metadata())
		if (error instanceof McpClientError)
			throw new McpClientError(error.code, metadata())
		throw new McpClientError('network', metadata())
	} finally {
		clearTimeout(timer)
		options.signal?.removeEventListener('abort', abort)
		if (reader) {
			if (!done) void reader.cancel().catch(() => undefined)
			reader.releaseLock()
		}
	}
}
