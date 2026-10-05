/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { DASHSCOPE_MULTIMODAL_GENERATION_PATH } from '@octafuse/core/route-topology'
import type { RequestLog } from './request-log-contracts'
import { requestLogIdSchema } from './request-log-target'

export type RequestLogSearch = {
	page: number
	status: string
	model_id: string
	provider_id: string
	protocol: string
	route_group: string
	user_id: string
	user_email: string
	api_key_id: string
	start_date?: string
	end_date?: string
	/** Explicit detail target, never a list filter. */
	request_id?: string
	invalidTarget?: boolean
}
export const emptyRequestLogFilters: RequestLogSearch = {
	page: 1,
	status: '',
	model_id: '',
	provider_id: '',
	protocol: '',
	route_group: '',
	user_id: '',
	user_email: '',
	api_key_id: '',
	start_date: '',
	end_date: '',
}
const sqlUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u
const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u
const protocols = new Set(['openai', 'anthropic', 'gemini', 'dashscope'])
function clean(value: unknown, max: number): string {
	return typeof value === 'string' &&
		value.length <= max &&
		!/\p{Cc}/u.test(value)
		? value.trim()
		: ''
}
export function cleanLogDate(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined
	if (value === '') return ''
	if (typeof value !== 'string') return undefined
	if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
		const ms = Date.parse(`${value}T00:00:00Z`)
		return Number.isFinite(ms) &&
			new Date(ms).toISOString().slice(0, 10) === value
			? value
			: undefined
	}
	if (!sqlUtc.test(value) && !isoUtc.test(value)) return undefined
	const ms = Date.parse(
		sqlUtc.test(value) ? `${value.replace(' ', 'T')}Z` : value
	)
	if (!Number.isFinite(ms)) return undefined
	const canonical = new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
	if (sqlUtc.test(value) && canonical !== value) return undefined
	if (
		isoUtc.test(value) &&
		new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)
	)
		return undefined
	return canonical
}
export function validateRequestLogSearch(
	input: Record<string, unknown>
): RequestLogSearch {
	const page = Number(input.page)
	const protocol = clean(input.protocol, 80).toLowerCase()
	const userId = clean(input.user_id, 600)
	const requestId =
		input.request_id === undefined || input.request_id === ''
			? undefined
			: requestLogIdSchema.parse(input.request_id)
	if (input.user_id !== undefined && input.user_id !== '' && !userId)
		throw new TypeError('Invalid request-log user ID')
	return {
		page:
			Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000 ? page : 1,
		status: clean(input.status, 80),
		model_id: clean(input.model_id, 600),
		provider_id: clean(input.provider_id, 600),
		protocol: protocols.has(protocol) ? protocol : '',
		route_group: clean(input.route_group, 600),
		user_id: userId,
		user_email: clean(input.user_email, 320),
		api_key_id: clean(input.api_key_id, 600),
		start_date: cleanLogDate(input.start_date),
		end_date: cleanLogDate(input.end_date),
		...(requestId ? { request_id: requestId } : {}),
	}
}
export function validateRequestLogRouteSearch(
	input: Record<string, unknown>
): RequestLogSearch {
	try {
		return validateRequestLogSearch(input)
	} catch (error) {
		if (
			input.request_id !== undefined &&
			input.request_id !== '' &&
			!requestLogIdSchema.safeParse(input.request_id).success
		)
			return { ...emptyRequestLogFilters, invalidTarget: true }
		throw error
	}
}
export function requestLogsPath(filters: RequestLogSearch): string {
	if (
		!Number.isSafeInteger(filters.page) ||
		filters.page < 1 ||
		filters.page > 1_000_000
	)
		throw new TypeError('Invalid request-log page')
	const params = new URLSearchParams({
		page: String(filters.page),
		page_size: '50',
	})
	for (const key of [
		'status',
		'model_id',
		'provider_id',
		'protocol',
		'route_group',
		'user_id',
		'user_email',
		'api_key_id',
	] as const) {
		const value = clean(filters[key], key === 'user_email' ? 320 : 600)
		if (filters[key].trim() && !value)
			throw new TypeError('Invalid request-log filter')
		if (key === 'protocol' && value && !protocols.has(value))
			throw new TypeError('Invalid request-log protocol')
		if (value) params.set(key, value)
	}
	for (const key of ['start_date', 'end_date'] as const) {
		const date = cleanLogDate(filters[key])
		if (filters[key] && date === undefined)
			throw new TypeError('Invalid request-log UTC date')
		if (date) params.set(key, date)
	}
	return `/api/admin/request-logs?${params.toString()}`
}
export function normalizeRouteGroup(value: string | null | undefined): string {
	return value?.trim() || 'default'
}
export function requestLogProtocolPath(
	protocol: string | null | undefined,
	operation: string | null | undefined
): string {
	const p = protocol?.trim().toLowerCase() ?? ''
	const op = operation?.trim() || '*'
	if (!p) return operation?.trim() ?? ''
	if (p === 'gemini') return '/v1beta/models'
	if (p === 'anthropic') return op === '*' ? '/v1/*' : '/v1/messages'
	if (p === 'openai') {
		const paths: Record<string, string> = {
			chat: '/v1/chat/completions',
			responses: '/v1/responses',
			embeddings: '/v1/embeddings',
			rerank: '/v1/rerank',
			'images.generations': '/v1/images/generations',
			'images.edits': '/v1/images/edits',
			'audio.transcriptions': '/v1/audio/transcriptions',
			'audio.speech': '/v1/audio/speech',
		}
		return paths[op] ?? `/v1/${op}`
	}
	if (p === 'dashscope') {
		if (op.includes('.realtime.'))
			return `/v1/dashscope/realtime?model={model}&operation=${encodeURIComponent(op)}`
		if (
			op === 'audio.speech' ||
			op === 'audio.speech.stream' ||
			op === 'audio.speech.multimodal'
		)
			return '/v1/audio/speech'
		if (op === 'audio.transcriptions') return '/v1/audio/transcriptions'
		if (op === 'audio.transcriptions.multimodal')
			return DASHSCOPE_MULTIMODAL_GENERATION_PATH
		if (op === 'audio.transcriptions.async') return '/v1/audio/transcriptions'
	}
	return op === '*' ? '/*' : `/${op}`
}
export function requestLogTags(
	log: RequestLog,
	catalogKind: 'llm' | 'image' | 'tts' | 'asr' | null = null
): string[] {
	const operation = `${log.request_operation ?? ''} ${log.upstream_operation ?? ''}`
	let kind = 'llm'
	if (log.provider_id === 'octafuse-tools' || log.model_id?.startsWith('tool:'))
		kind = 'tool'
	else if (
		log.billing_kind?.startsWith('image_') ||
		operation.includes('images.')
	)
		kind = 'image'
	else if (
		log.billing_kind === 'audio_per_character' ||
		operation.includes('audio.speech')
	)
		kind = 'tts'
	else if (
		log.billing_kind?.startsWith('audio_') ||
		operation.includes('audio.transcriptions')
	)
		kind = 'asr'
	else if (catalogKind) kind = catalogKind
	const tags = [kind]
	if (operation.includes('.realtime.')) tags.push('realtime')
	else if (isStreaming(log)) tags.push('stream')
	if ((log.reasoning_tokens ?? 0) > 0 || log.first_reasoning_token_ms != null)
		tags.push('reasoning')
	if ((log.upstream_failover_count ?? 0) > 0) tags.push('failover')
	return tags
}
export function geminiWireAction(
	raw: string | null | undefined
): string | null {
	if (!raw) return null
	try {
		const value: unknown = JSON.parse(raw)
		if (
			value &&
			typeof value === 'object' &&
			'gemini' in value &&
			value.gemini &&
			typeof value.gemini === 'object' &&
			'action' in value.gemini
		)
			return value.gemini.action === 'generateContent' ||
				value.gemini.action === 'streamGenerateContent'
				? value.gemini.action
				: null
	} catch {
		return null
	}
	return null
}
function streamFromBody(raw: string | null | undefined): boolean | null {
	if (!raw) return null
	try {
		const value: unknown = JSON.parse(raw)
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null
		if ('_gemini_action' in value)
			return value._gemini_action === 'streamGenerateContent'
		if ('stream' in value && typeof value.stream === 'boolean')
			return value.stream
	} catch {
		return null
	}
	return null
}
function isStreaming(log: RequestLog): boolean {
	const action = geminiWireAction(log.route_trace)
	if (action) return action === 'streamGenerateContent'
	return (
		streamFromBody(log.request_body) ??
		streamFromBody(log.upstream_request_body) ??
		false
	)
}
export function logUsage(
	log: RequestLog,
	labels: {
		images: string
		seconds: string
		characters: string
		tokens: string
	}
): string {
	if (log.billing_kind === 'image_per_image') {
		const input = log.input_image_count ?? 0
		const output = log.output_image_count ?? 0
		return `${input > 0 && output > 0 ? `${input}×${output}` : input + output} ${labels.images}`
	}
	if (log.billing_kind === 'audio_per_second')
		return `${log.audio_duration_seconds ?? '—'} ${labels.seconds}`
	if (log.billing_kind === 'audio_per_character')
		return `${log.audio_characters ?? '—'} ${labels.characters}`
	const cache =
		log.cache_read_tokens || log.cache_write_tokens
			? ` · CR ${log.cache_read_tokens} / CW ${log.cache_write_tokens}`
			: ''
	return `${log.input_tokens} / ${log.output_tokens} ${labels.tokens}${cache}`
}

const sensitiveKey =
	/(?:^|_)(?:authorization|api_key|secret|password|credential|cookie|bearer|access_token|refresh_token|session_token|messages|contents|prompt|input_text|image_url|audio_data)(?:_|$)|(?:^|_)token(?:_|$)/u
export function isSensitiveLogKey(key: string): boolean {
	return sensitiveKey.test(
		key
			.replace(/([a-z])([A-Z])/gu, '$1_$2')
			.replace(/-/gu, '_')
			.toLowerCase()
	)
}
function redacted(value: unknown, depth: number): unknown {
	if (depth > 16) return '[redacted: depth limit]'
	if (Array.isArray(value))
		return value.map((part) => redacted(part, depth + 1))
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, part]) => {
				return [
					key,
					isSensitiveLogKey(key) ? '[redacted]' : redacted(part, depth + 1),
				]
			})
		)
	}
	if (typeof value === 'string') return safeLogText(value)
	return value
}
export function safeLogText(value: string): string {
	const credentialSafe = value
		.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}/giu, '[redacted]')
		.replace(
			/([?&])([^=&#\s"'\\]{1,128})=([^&#\s"'\\]+)/gu,
			(all, delimiter: string, encodedKey: string) => {
				let key: string
				try {
					key = decodeURIComponent(encodedKey.replace(/\+/gu, ' '))
				} catch {
					return `${delimiter}${encodedKey}=[redacted]`
				}
				return isSensitiveLogKey(key) || /^(?:key|auth)$/iu.test(key)
					? `${delimiter}${encodedKey}=[redacted]`
					: all
			}
		)
	const field = /(["'])([A-Za-z][A-Za-z0-9_-]{0,127})\1\s*:\s*(["'])/gu
	let result = ''
	let cursor = 0
	for (const match of credentialSafe.matchAll(field)) {
		if (match.index < cursor || !isSensitiveLogKey(match[2])) continue
		const valueStart = match.index + match[0].length
		const quote = match[3]
		let valueEnd = valueStart
		while (valueEnd < credentialSafe.length) {
			if (credentialSafe[valueEnd] === '\\') {
				valueEnd += 2
				continue
			}
			if (credentialSafe[valueEnd] === quote) break
			valueEnd += 1
		}
		result += credentialSafe.slice(cursor, valueStart) + '[redacted]'
		if (valueEnd < credentialSafe.length) {
			result += quote
			cursor = valueEnd + 1
		} else {
			cursor = credentialSafe.length
		}
	}
	return result + credentialSafe.slice(cursor)
}
/** Malformed legacy fields have no safe structural boundary, so fail closed for display and copy. */
export function safeLogJson(raw: string | null | undefined): string | null {
	if (!raw?.trim()) return null
	try {
		return JSON.stringify(redacted(JSON.parse(raw) as unknown, 0), null, 2)
	} catch {
		return raw.includes('[truncated]')
			? '[redacted: truncated log]'
			: '[redacted: malformed log]'
	}
}
