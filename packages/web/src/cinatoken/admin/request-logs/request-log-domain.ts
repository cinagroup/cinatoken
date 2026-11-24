/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	normalizeRequestLogIngressHost,
	normalizeRequestLogModelIdPrefix,
	normalizeRequestLogProviderIds,
} from '@octafuse/core/db/request-log-filters'
import {
	DASHSCOPE_FILE_TRANSCRIPTION_PATH,
	DASHSCOPE_MULTIMODAL_GENERATION_PATH,
	DASHSCOPE_SPEECH_SYNTHESIZER_PATH,
	MINIMAX_IMAGE_GENERATION_PATH,
	MINIMAX_SPEECH_TO_TEXT_PATH,
	MINIMAX_T2A_PATH,
	VOLCENGINE_IMAGE_GENERATIONS_PATH,
} from '@octafuse/core/route-topology'
import type { RequestLog } from './request-log-contracts'
import { requestLogIdSchema } from './request-log-target'

export type RequestLogSearch = {
	page: number
	status: string
	model_id: string
	model_id_prefix?: string
	provider_id: string
	provider_ids?: string
	protocol: string
	route_group: string
	user_id: string
	user_email: string
	api_key_id: string
	ingress_host?: string
	start_date?: string
	end_date?: string
	/** Explicit detail target, never a list filter. */
	request_id?: string
	invalidTarget?: boolean
	/** Invalid scoped input must never become an unfiltered request. */
	invalidFilter?: boolean
	invalidIngressHost?: boolean
	invalidModelPrefix?: boolean
	invalidProviderIds?: true
}
export const emptyRequestLogFilters: RequestLogSearch = {
	page: 1,
	status: '',
	model_id: '',
	model_id_prefix: '',
	provider_id: '',
	provider_ids: '',
	protocol: '',
	route_group: '',
	user_id: '',
	user_email: '',
	api_key_id: '',
	ingress_host: '',
	start_date: '',
	end_date: '',
}
const sqlUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u
const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u
export const requestLogProtocols = [
	'openai',
	'anthropic',
	'gemini',
	'dashscope',
	'minimax',
	'volcengine',
] as const
const protocols = new Set<string>(requestLogProtocols)
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
	const modelPrefix =
		normalizeRequestLogModelIdPrefix(input.model_id_prefix) ?? ''
	const ingressHost = normalizeRequestLogIngressHost(input.ingress_host)
	const providerIds = normalizeRequestLogProviderIds(input.provider_ids)
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
		model_id_prefix: modelPrefix,
		provider_id: clean(input.provider_id, 600),
		provider_ids: providerIds?.join(',') ?? '',
		protocol: protocols.has(protocol) ? protocol : '',
		route_group: clean(input.route_group, 600),
		user_id: userId,
		user_email: clean(input.user_email, 320),
		api_key_id: clean(input.api_key_id, 600),
		ingress_host: ingressHost ?? '',
		start_date: cleanLogDate(input.start_date),
		end_date: cleanLogDate(input.end_date),
		...(requestId ? { request_id: requestId } : {}),
	}
}
/** Keep invalid scope visible and unqueryable so the user can repair it in place. */
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
		let ingressHost: string | undefined
		let modelPrefix: string | undefined
		let providerIds: string[] | undefined
		let invalidIngressHost = false
		let invalidModelPrefix = false
		let invalidProviderIds = false
		try {
			ingressHost = normalizeRequestLogIngressHost(input.ingress_host)
		} catch {
			invalidIngressHost = true
		}
		try {
			modelPrefix = normalizeRequestLogModelIdPrefix(input.model_id_prefix)
		} catch {
			invalidModelPrefix = true
		}
		try {
			providerIds = normalizeRequestLogProviderIds(input.provider_ids)
		} catch {
			invalidProviderIds = true
		}
		if (!invalidIngressHost && !invalidModelPrefix && !invalidProviderIds)
			throw error
		// Retain one extra character so an overlong value stays invalid. A
		// non-text URL value receives a visible invalid placeholder, never ''.
		function invalidValue(value: unknown, max: number): string {
			return typeof value === 'string' ? value.slice(0, max + 1) : ' '
		}
		return {
			...validateRequestLogSearch({
				...input,
				ingress_host: undefined,
				model_id_prefix: undefined,
				provider_ids: undefined,
			}),
			ingress_host: invalidIngressHost
				? invalidValue(input.ingress_host, 255)
				: (ingressHost ?? ''),
			model_id_prefix: invalidModelPrefix
				? invalidValue(input.model_id_prefix, 600)
				: (modelPrefix ?? ''),
			provider_ids: invalidProviderIds
				? invalidValue(input.provider_ids, 6009)
				: (providerIds?.join(',') ?? ''),
			invalidFilter: true,
			...(invalidIngressHost ? { invalidIngressHost: true } : {}),
			...(invalidModelPrefix ? { invalidModelPrefix: true } : {}),
			...(invalidProviderIds ? { invalidProviderIds: true as const } : {}),
		}
	}
}
/** Revalidate all scopes: repairing one must not clear another scope's error. */
export function updateRequestLogScopedFilter(
	search: RequestLogSearch,
	key: 'ingress_host' | 'model_id_prefix' | 'provider_ids',
	value: string
): RequestLogSearch {
	return validateRequestLogRouteSearch({ ...search, [key]: value, page: 1 })
}
export function requestLogsPath(filters: RequestLogSearch): string {
	if (filters.invalidFilter) throw new TypeError('Invalid request-log filter')
	const ingressHost = normalizeRequestLogIngressHost(filters.ingress_host)
	const modelPrefix = normalizeRequestLogModelIdPrefix(filters.model_id_prefix)
	const providerIds = normalizeRequestLogProviderIds(filters.provider_ids)
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
	if (ingressHost !== undefined) params.set('ingress_host', ingressHost)
	if (modelPrefix !== undefined) params.set('model_id_prefix', modelPrefix)
	if (providerIds !== undefined)
		params.set('provider_ids', providerIds.join(','))
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
		const raw = filters[key] ?? ''
		const value = clean(raw, key === 'user_email' ? 320 : 600)
		if (raw.trim() && !value) throw new TypeError('Invalid request-log filter')
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
		if (op === 'audio.speech' || op === 'audio.speech.stream')
			return DASHSCOPE_SPEECH_SYNTHESIZER_PATH
		if (op === 'audio.transcriptions') return '/v1/audio/transcriptions'
		if (
			[
				'audio.transcriptions.multimodal',
				'audio.speech.multimodal',
				'images.generations.multimodal',
			].includes(op)
		)
			return DASHSCOPE_MULTIMODAL_GENERATION_PATH
		if (op === 'audio.transcriptions.async')
			return DASHSCOPE_FILE_TRANSCRIPTION_PATH
	}
	if (p === 'minimax') {
		if (op === 'audio.speech') return MINIMAX_T2A_PATH
		if (op === 'audio.transcriptions') return MINIMAX_SPEECH_TO_TEXT_PATH
		if (op === 'images.generations') return MINIMAX_IMAGE_GENERATION_PATH
	}
	if (p === 'volcengine' && op === 'images.generations')
		return VOLCENGINE_IMAGE_GENERATIONS_PATH
	return op === '*' ? '/*' : `/${op}`
}
export function requestLogTags(
	log: RequestLog,
	catalogKind: 'llm' | 'image' | 'tts' | 'asr' | null = null
): string[] {
	const operation = `${log.request_operation ?? ''} ${log.upstream_operation ?? ''}`
	let kind = 'llm'
	if (
		log.provider_id === 'octafuse-tools' ||
		log.provider_id === 'octafuse-mcp' ||
		log.model_id?.startsWith('tool:') ||
		log.model_id?.startsWith('mcp:')
	)
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

export { isSensitiveLogKey, safeLogText } from './log-redaction'
export { safeLogJson } from './safe-log-json'
