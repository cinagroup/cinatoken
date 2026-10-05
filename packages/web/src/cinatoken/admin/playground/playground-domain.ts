/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	AUDIO_SPEECH_BODY_TEMPLATE,
	AUDIO_TRANSCRIPTIONS_BODY_TEMPLATE,
	AUDIO_TRANSCRIPTIONS_FILE_URL_BODY_TEMPLATE,
	DASHSCOPE_MULTIMODAL_ASR_BODY_TEMPLATE,
} from './browser-domain/audio-transcriptions'
import {
	buildDashScopeRealtimeAsrTemplate,
	buildDashScopeRealtimeTtsTemplate,
	buildDashScopeSpeechBodyTemplate,
	isDashScopeRealtimeOperation,
} from './browser-domain/dashscope-realtime-client'
import {
	IMAGE_EDITS_BODY_TEMPLATE,
	IMAGE_GENERATIONS_BODY_TEMPLATE,
	type ImageOperation,
} from './browser-domain/image-generations'
import {
	loadPlaygroundSampleBody,
	type PlaygroundLlmFamily,
	type PlaygroundLlmSampleId,
} from './browser-domain/samples'
import type {
	PlaygroundContext,
	PlaygroundEnvelope,
	PlaygroundKind,
	PlaygroundRoute,
	PlaygroundSearch,
	PlaygroundUploads,
} from './playground-contracts'

export const playgroundPrefix = 'cinatoken.admin.playground.'
export const playgroundKinds: readonly PlaygroundKind[] = [
	'llm',
	'image',
	'audio',
	'rerank',
]
export const toolTemplates = {
	'web-search': { query: 'cinatoken Gateway', count: 5 },
	'web-fetch': { url: 'https://example.com' },
	'web-deep-search': { query: 'cinatoken Gateway architecture', count: 3 },
	'ai-detection': { text: 'This is a sample paragraph for AI-rate detection.' },
}
export function routeKind(
	context: PlaygroundContext,
	route: PlaygroundRoute
): PlaygroundKind {
	return (
		context.models.find((model) => model.id === route.model_id)?.kind ?? 'llm'
	)
}
export function llmFamily(route: PlaygroundRoute): PlaygroundLlmFamily | null {
	if (route.upstream_protocol === 'openai') {
		if (route.upstream_operation === 'responses') return 'openai_responses'
		return ['chat', '*'].includes(route.upstream_operation)
			? 'openai_chat'
			: null
	}
	if (
		route.upstream_protocol === 'anthropic' ||
		route.upstream_protocol === 'gemini'
	)
		return route.upstream_protocol
	return null
}
export function llmSample(
	route: PlaygroundRoute,
	sample: PlaygroundLlmSampleId
): string {
	const family = llmFamily(route)
	return family
		? loadPlaygroundSampleBody(
				family,
				sample,
				`${route.model_id} ${route.provider_model_name}`.toLowerCase()
			)
		: '{}'
}
export function isRealtimeRoute(route: PlaygroundRoute | null): boolean {
	return (
		!!route &&
		route.upstream_protocol === 'dashscope' &&
		isDashScopeRealtimeOperation(route.upstream_operation)
	)
}
export function needsAudioFile(route: PlaygroundRoute | null): boolean {
	if (!route || !route.upstream_operation.startsWith('audio.transcriptions'))
		return false
	if (isRealtimeRoute(route)) return true
	if (
		route.upstream_operation === 'audio.transcriptions.async' ||
		route.adapter === 'dashscope-asr-file-async'
	)
		return false
	return !(
		route.upstream_protocol === 'dashscope' && route.adapter === 'passthrough'
	)
}
export function routeTemplate(
	context: PlaygroundContext,
	route: PlaygroundRoute | null,
	imageOperation: ImageOperation = 'generations'
): string {
	if (!route) return '{}'
	const kind = routeKind(context, route),
		operation = route.upstream_operation
	if (isRealtimeRoute(route))
		return operation.startsWith('audio.speech.')
			? buildDashScopeRealtimeTtsTemplate(route.provider_model_name)
			: buildDashScopeRealtimeAsrTemplate(
					isDashScopeRealtimeOperation(operation) ? operation : undefined
				)
	if (kind === 'image')
		return imageOperation === 'edits'
			? IMAGE_EDITS_BODY_TEMPLATE
			: IMAGE_GENERATIONS_BODY_TEMPLATE
	if (kind === 'audio') {
		if (operation.startsWith('audio.speech'))
			return route.upstream_protocol === 'dashscope'
				? buildDashScopeSpeechBodyTemplate(route.provider_model_name)
				: AUDIO_SPEECH_BODY_TEMPLATE
		if (
			operation === 'audio.transcriptions.async' ||
			route.adapter === 'dashscope-asr-file-async'
		)
			return AUDIO_TRANSCRIPTIONS_FILE_URL_BODY_TEMPLATE
		if (
			route.upstream_protocol === 'dashscope' &&
			route.adapter === 'passthrough'
		)
			return DASHSCOPE_MULTIMODAL_ASR_BODY_TEMPLATE
		return AUDIO_TRANSCRIPTIONS_BODY_TEMPLATE
	}
	if (kind === 'rerank')
		return JSON.stringify(
			{
				query: 'What is the capital of France?',
				documents: [
					'Paris is the capital of France.',
					'Berlin is the capital of Germany.',
					'Madrid is the capital of Spain.',
				],
				top_n: 2,
				return_documents: true,
			},
			null,
			2
		)
	return llmSample(route, 'connectivity')
}
export function selectionTemplate(
	context: PlaygroundContext,
	search: PlaygroundSearch,
	imageOperation: ImageOperation
): string {
	return search.mode === 'tools'
		? JSON.stringify(toolTemplates[search.tool], null, 2)
		: routeTemplate(
				context,
				context.routes.find((route) => route.id === search.routeId) ?? null,
				imageOperation
			)
}
// Whitespace inside JSON strings is meaningful: use parsing rather than replacing all whitespace.
export function bodyIsDirty(body: string, template: string): boolean {
	try {
		return (
			JSON.stringify(JSON.parse(body)) !== JSON.stringify(JSON.parse(template))
		)
	} catch {
		return body.trim() !== template.trim()
	}
}
export function routeMatches(route: PlaygroundRoute, query: string): boolean {
	return [
		route.id,
		route.model_id,
		route.provider_id,
		route.provider_model_name,
		route.model_name,
		route.provider_name,
		route.route_group,
		route.upstream_protocol,
		route.upstream_operation,
		route.pool_name,
		route.route_pool_id,
	]
		.join(' ')
		.toLowerCase()
		.includes(query.trim().toLowerCase())
}
export type PlaygroundInputError =
	| 'errorJson'
	| 'selectNeeded'
	| 'toolsNeedProvider'
	| 'errorLimit'
	| 'fileInvalid'
	| 'uploadsTooLarge'
	| 'referenceImagesRequired'
	| 'audioFileRequired'
	| 'imageOpenaiOnly'
	| 'rerankOpenaiOnly'
	| 'realtimeUnavailable'
	| 'operationUnsupported'
export class PlaygroundInputFailure extends Error {
	constructor(readonly key: PlaygroundInputError) {
		super(key)
	}
}
export function buildPlaygroundInput(
	context: PlaygroundContext,
	search: PlaygroundSearch,
	bodyText: string,
	imageOperation: ImageOperation,
	geminiAction: 'generateContent' | 'streamGenerateContent',
	uploads: PlaygroundUploads,
	audioInput: 'file' | 'microphone',
	preview = false
): PlaygroundEnvelope {
	let body: unknown
	try {
		body = JSON.parse(bodyText)
	} catch {
		throw new PlaygroundInputFailure('errorJson')
	}
	if (!body || typeof body !== 'object' || Array.isArray(body))
		throw new PlaygroundInputFailure('errorJson')
	if (
		new TextEncoder().encode(bodyText).byteLength >
		context.limits.json_body_bytes
	)
		throw new PlaygroundInputFailure('errorLimit')
	if (search.mode === 'tools') {
		if (!search.provider) throw new PlaygroundInputFailure('toolsNeedProvider')
		if (uploads.audio || uploads.images?.length)
			throw new PlaygroundInputFailure('fileInvalid')
		return {
			toolId: search.tool,
			provider: search.provider,
			body: body as Record<string, unknown>,
		}
	}
	const route = context.routes.find((row) => row.id === search.routeId)
	if (!route) throw new PlaygroundInputFailure('selectNeeded')
	const kind = routeKind(context, route)
	const allowed = supportedOperations(route, kind)
	if (!allowed.includes(route.upstream_operation))
		throw new PlaygroundInputFailure('operationUnsupported')
	if (kind === 'image' && route.upstream_protocol !== 'openai')
		throw new PlaygroundInputFailure('imageOpenaiOnly')
	if (kind === 'rerank' && route.upstream_protocol !== 'openai')
		throw new PlaygroundInputFailure('rerankOpenaiOnly')
	if (isRealtimeRoute(route) && !context.realtime_supported && !preview)
		throw new PlaygroundInputFailure('realtimeUnavailable')
	const images = uploads.images ?? []
	if (
		images.length > context.limits.image_count ||
		images.some(
			(file) =>
				file.size === 0 ||
				file.size > context.limits.image_file_bytes ||
				!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type) ||
				!validUploadName(file.name)
		)
	)
		throw new PlaygroundInputFailure('fileInvalid')
	if (
		uploads.audio &&
		(uploads.audio.size === 0 ||
			uploads.audio.size > context.limits.audio_file_bytes ||
			!validAudioUpload(uploads.audio))
	)
		throw new PlaygroundInputFailure('fileInvalid')
	const total =
		images.reduce((sum, file) => sum + file.size, 0) +
		(uploads.audio?.size ?? 0)
	if (
		total > context.limits.image_total_bytes ||
		(total > 0 && total + 4 * 1024 * 1024 > context.limits.multipart_body_bytes)
	)
		throw new PlaygroundInputFailure('uploadsTooLarge')
	if (images.length && !(kind === 'image' && imageOperation === 'edits'))
		throw new PlaygroundInputFailure('fileInvalid')
	if (images.length && uploads.audio)
		throw new PlaygroundInputFailure('fileInvalid')
	if (uploads.audio && !needsAudioFile(route))
		throw new PlaygroundInputFailure('fileInvalid')
	if (
		uploads.audio &&
		route.upstream_protocol === 'dashscope' &&
		!isRealtimeRoute(route) &&
		route.upstream_operation === 'audio.transcriptions.multimodal' &&
		4 * Math.ceil(uploads.audio.size / 3) +
			new TextEncoder().encode(
				`data:${uploads.audio.type || 'application/octet-stream'};base64,`
			).byteLength >
			(context.limits.dashscope_sync_data_url_bytes ?? 10 * 1024 * 1024)
	)
		throw new PlaygroundInputFailure('fileInvalid')
	if (
		!preview &&
		kind === 'image' &&
		imageOperation === 'edits' &&
		!images.length
	)
		throw new PlaygroundInputFailure('referenceImagesRequired')
	if (
		!preview &&
		needsAudioFile(route) &&
		!(isRealtimeRoute(route) && audioInput === 'microphone') &&
		!uploads.audio
	)
		throw new PlaygroundInputFailure('audioFileRequired')
	return {
		routeId: route.id,
		body: body as Record<string, unknown>,
		...(kind === 'image' ? { imageOperation } : {}),
		...(route.upstream_protocol === 'gemini' ? { geminiAction } : {}),
	}
}
function validUploadName(name: string): boolean {
	return !!name && name.length <= 255 && !/[\p{Cc}\p{Cf}]/u.test(name)
}
function validAudioUpload(file: File): boolean {
	return (
		validUploadName(file.name) &&
		(/^audio\/[a-z0-9.+-]+$/i.test(file.type) ||
			['application/ogg', 'video/mp4', 'video/webm'].includes(file.type) ||
			((!file.type || file.type === 'application/octet-stream') &&
				/\.(wav|mp3|mp4|m4a|webm|ogg|oga|opus|flac|aac|pcm|amr|aiff|aif)$/i.test(
					file.name
				)))
	)
}
function supportedOperations(
	route: PlaygroundRoute,
	kind: PlaygroundKind
): string[] {
	if (route.upstream_protocol === 'anthropic') return ['messages', 'chat', '*']
	if (route.upstream_protocol === 'gemini')
		return ['models.generate', 'chat', '*']
	if (route.upstream_protocol === 'dashscope')
		return [
			'audio.transcriptions.multimodal',
			'audio.transcriptions.async',
			'audio.speech',
			'audio.transcriptions.realtime.inference',
			'audio.transcriptions.realtime.session',
			'audio.speech.realtime.inference',
		]
	if (kind === 'image') return ['images.generations', 'images.edits', '*']
	if (kind === 'audio') return ['audio.transcriptions', 'audio.speech']
	if (kind === 'rerank') return ['rerank', '*']
	return ['chat', 'responses', '*']
}
