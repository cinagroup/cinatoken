/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import type { ImageOperation } from './browser-domain/image-generations'
import type {
	GeminiContentAction,
	GatewayToolId,
} from './browser-domain/invoke-kind'

const text = z.string().max(4_000)
const id = text
	.min(1)
	.refine((value) => value.trim() === value && !/\p{Cc}/u.test(value))
const protocol = z.enum(['openai', 'anthropic', 'gemini', 'dashscope'])
const positive = z.number().int().positive().safe()
export const playgroundRouteSchema = z.object({
	id,
	model_id: id,
	provider_id: id,
	provider_model_name: text,
	priority: z.number().int().safe(),
	status: text,
	route_group: text,
	upstream_protocol: protocol,
	upstream_operation: text,
	adapter: text.nullable().optional(),
	route_pool_id: text.nullable().optional(),
	pool_name: text.nullable().optional(),
	model_name: text.nullable().optional(),
	provider_name: text.nullable().optional(),
	provider_status: text.optional(),
	surfaces: z
		.array(
			z.object({
				id,
				request_protocol: protocol,
				request_operation: text,
				status: text,
			})
		)
		.max(1_000),
	price_override_preview: z.string().max(100_000).nullable().optional(),
	custom_params_preview: z.string().max(100_000).nullable().optional(),
})
export const playgroundContextSchema = z.object({
	routes: z.array(playgroundRouteSchema).max(50_000),
	models: z
		.array(
			z.object({
				id,
				display_name: text.nullable(),
				kind: z.enum(['llm', 'image', 'audio', 'rerank']),
				input_modalities: z.array(text),
				output_modalities: z.array(text),
			})
		)
		.max(50_000),
	providers: z.array(z.object({ id, name: text, status: text })).max(50_000),
	tools: z
		.array(
			z.object({
				toolId: z.enum([
					'web-search',
					'web-fetch',
					'web-deep-search',
					'ai-detection',
				]),
				catalog_state: z.enum(['available', 'unavailable']),
				providers: z
					.array(
						z.object({
							provider: id,
							available: z.literal(true),
							configured: z.boolean(),
							active: z.boolean(),
						})
					)
					.max(20),
			})
		)
		.max(4),
	billing_currency: z
		.string()
		.regex(/^[A-Z]{3}$/)
		.nullable(),
	realtime_supported: z.boolean(),
	limits: z.object({
		json_body_bytes: positive,
		image_file_bytes: positive,
		image_count: positive,
		image_total_bytes: positive,
		audio_file_bytes: positive,
		dashscope_sync_data_url_bytes: positive.optional(),
		multipart_body_bytes: positive,
		runtime: z.enum(['node', 'cloudflare']),
	}),
	billing: z.literal('none'),
	request_logs: z.literal(false),
	failover: z.literal(false),
})
export const playgroundContextResponseSchema = z.object({
	success: z.literal(true),
	data: playgroundContextSchema,
})
export const playgroundPreviewResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		mode: z.enum(['route', 'tool']),
		upstream_url: z.string().max(16_000),
		request_body_json: z.string().max(150_000),
		preview_only: z.literal(true),
		truncated: z.boolean(),
		uploads: z.unknown().optional(),
		wire_format: z.enum(['json', 'multipart', 'engine-envelope']),
		ready: z.boolean(),
		missing_upload: z.enum(['images', 'audio']).optional(),
		auth_resolution_deferred: z.boolean().optional(),
	}),
})
export type PlaygroundContext = z.infer<typeof playgroundContextSchema>
export type PlaygroundRoute = z.infer<typeof playgroundRouteSchema>
export type PlaygroundModel = PlaygroundContext['models'][number]
export type PlaygroundKind = PlaygroundModel['kind']
export type PlaygroundPreview = z.infer<
	typeof playgroundPreviewResponseSchema
>['data']
export type PlaygroundEnvelope =
	| {
			routeId: string
			body: Record<string, unknown>
			imageOperation?: ImageOperation
			geminiAction?: GeminiContentAction
	  }
	| { toolId: GatewayToolId; provider: string; body: Record<string, unknown> }
export type PlaygroundUploads = {
	images?: readonly File[]
	audio?: File | null
}
export type PlaygroundResponseMeta = {
	status: number
	latencyMs: string | null
	upstreamUrl: string | null
	contentType: string
	wireBody: string | null
	truncated: boolean
	latencyScope?: string | null
	upstreamStatus?: string | null
	outcome?: string | null
}
export type PlaygroundSearch = {
	mode: 'routes' | 'tools'
	routeId: string
	tool: GatewayToolId
	provider: string
}
function safeSearchText(value: unknown): string {
	return typeof value === 'string' &&
		value.length <= 600 &&
		value.trim() === value &&
		!/\p{Cc}/u.test(value)
		? value
		: ''
}
export function validatePlaygroundSearch(
	input: Record<string, unknown>
): PlaygroundSearch {
	const tool = safeSearchText(input.tool)
	const validTool = [
		'web-search',
		'web-fetch',
		'web-deep-search',
		'ai-detection',
	].includes(tool)
	let mode: PlaygroundSearch['mode'] = 'routes'
	if (input.mode !== 'routes' && (input.mode === 'tools' || validTool))
		mode = 'tools'
	return {
		mode,
		routeId: safeSearchText(input.routeId),
		tool: validTool ? (tool as GatewayToolId) : 'ai-detection',
		provider: safeSearchText(input.provider),
	}
}
