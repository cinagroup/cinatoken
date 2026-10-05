import { z } from 'zod'

export const PRESET_CONFIG_MAX_BYTES = 64 * 1024
export const PRESET_PROMPT_MAX_BYTES = 32 * 1024
export const PRESET_CONFIG_FIELDS = [
	'model',
	'models',
	'provider',
	'tools',
	'tool_choice',
	'parallel_tool_calls',
	'temperature',
	'top_p',
	'top_k',
	'min_p',
	'top_a',
	'frequency_penalty',
	'presence_penalty',
	'repetition_penalty',
	'max_tokens',
	'max_completion_tokens',
	'max_output_tokens',
	'max_tool_calls',
	'stop',
	'stop_sequences',
	'seed',
	'response_format',
	'structured_outputs',
	'reasoning',
	'reasoning_effort',
	'verbosity',
	'logit_bias',
	'logprobs',
	'top_logprobs',
	'modalities',
	'image_config',
	'audio',
	'cache_control',
	'context_management',
	'fallbacks',
	'output_config',
	'plugins',
	'thinking',
	'stop_server_tools_when',
	'text',
	'truncation',
	'route_group',
	'service_tier',
	'speed',
] as const
const transientFields = new Set([
	'messages',
	'input',
	'prompt',
	'stream',
	'system',
	'instructions',
	'preset',
	'background',
	'debug',
	'metadata',
	'previous_response_id',
	'prompt_cache_key',
	'safety_identifier',
	'session_id',
	'store',
	'trace',
	'user',
])
const allowedFields = new Set<string>(PRESET_CONFIG_FIELDS)
const forbiddenFields = new Set([
	'api_key',
	'apikey',
	'authorization',
	'headers',
	'base_url',
	'baseurl',
	'endpoint_url',
	'secret',
	'token',
	'password',
])
export type PresetConfigError =
	| 'jsonObject'
	| 'transient'
	| 'unsupported'
	| 'nestedPreset'
	| 'provider'
	| 'credential'
	| 'depth'
	| 'nodes'
	| 'array'
	| 'jsonValue'
	| 'configBytes'

function object(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function walk(
	value: unknown,
	depth: number,
	state: { nodes: number }
): PresetConfigError | null {
	if (depth > 10) return 'depth'
	state.nodes++
	if (state.nodes > 4096) return 'nodes'
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return null
	if (typeof value === 'number')
		return Number.isFinite(value) ? null : 'jsonValue'
	if (Array.isArray(value)) {
		if (value.length > 512) return 'array'
		for (const item of value) {
			const error = walk(item, depth + 1, state)
			if (error) return error
		}
		return null
	}
	if (!object(value)) return 'jsonValue'
	for (const [key, item] of Object.entries(value)) {
		if (forbiddenFields.has(key.toLowerCase())) return 'credential'
		const error = walk(item, depth + 1, state)
		if (error) return error
	}
	return null
}
function validProvider(value: unknown): boolean {
	if (!object(value)) return false
	const supported = new Set([
		'order',
		'only',
		'ignore',
		'allow_fallbacks',
		'zdr',
		'require_parameters',
		'data_collection',
		'enforce_distillable_text',
		'quantizations',
		'sort',
		'preferred_min_throughput',
		'preferred_max_latency',
		'max_price',
	])
	if (Object.keys(value).some((key) => !supported.has(key))) return false
	for (const key of ['order', 'only', 'ignore']) {
		const names = value[key]
		if (
			names !== undefined &&
			(!Array.isArray(names) ||
				names.length > 32 ||
				names.some(
					(name) =>
						typeof name !== 'string' || !name.trim() || name.length > 120
				))
		)
			return false
	}
	for (const key of [
		'allow_fallbacks',
		'zdr',
		'require_parameters',
		'enforce_distillable_text',
	])
		if (value[key] !== undefined && typeof value[key] !== 'boolean')
			return false
	if (
		value.data_collection !== undefined &&
		value.data_collection !== 'allow' &&
		value.data_collection !== 'deny'
	)
		return false
	if (value.sort !== undefined) {
		const sort = value.sort
		if (typeof sort === 'string') {
			if (!['price', 'throughput', 'latency'].includes(sort)) return false
		} else if (
			!object(sort) ||
			Object.keys(sort).some((key) => key !== 'by' && key !== 'partition') ||
			!['price', 'throughput', 'latency'].includes(String(sort.by)) ||
			!['model', 'none'].includes(String(sort.partition ?? 'model'))
		)
			return false
	}
	if (value.quantizations !== undefined) {
		const names = value.quantizations
		if (
			!Array.isArray(names) ||
			names.length < 1 ||
			names.length > 32 ||
			names.some(
				(name) => typeof name !== 'string' || !name.trim() || name.length > 32
			)
		)
			return false
	}
	if (
		value.max_price !== undefined &&
		(!object(value.max_price) ||
			Object.keys(value.max_price).some(
				(key) => !['prompt', 'completion', 'request', 'image'].includes(key)
			) ||
			Object.values(value.max_price).some(
				(price) =>
					typeof price !== 'number' || !Number.isFinite(price) || price < 0
			))
	)
		return false
	return true
}
/** Mirrors the pure validation contract in Core request-presets; never narrows legal advanced fields. */
export function presetConfigError(value: unknown): PresetConfigError | null {
	if (!object(value)) return 'jsonObject'
	for (const key of Object.keys(value)) {
		if (transientFields.has(key)) return 'transient'
		if (!allowedFields.has(key)) return 'unsupported'
	}
	if (typeof value.model === 'string' && value.model.includes('@preset/'))
		return 'nestedPreset'
	if (value.provider !== undefined && !validProvider(value.provider))
		return 'provider'
	const error = walk(value, 0, { nodes: 0 })
	if (error) return error
	if (
		new TextEncoder().encode(JSON.stringify(value)).byteLength >
		PRESET_CONFIG_MAX_BYTES
	)
		return 'configBytes'
	return null
}
export const presetConfigSchema = z
	.record(z.string(), z.unknown())
	.superRefine((value, context) => {
		const error = presetConfigError(value)
		if (error)
			context.addIssue({
				code: 'custom',
				message: 'cinatoken.presets.validation.' + error,
			})
	})
export const presetIdentitySchema = z
	.string()
	.min(1)
	.max(600)
	.refine(
		(value) =>
			value.trim() === value &&
			!Array.from(value).some(
				(character) =>
					character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
			)
	)
const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u)
export function normalizePresetSlug(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^@preset\//u, '')
}
const prompt = z
	.string()
	.refine(
		(value) =>
			new TextEncoder().encode(value).byteLength <= PRESET_PROMPT_MAX_BYTES,
		'cinatoken.presets.validation.promptBytes'
	)
	.nullable()
export const presetSchema = z
	.object({
		id: presetIdentitySchema,
		workspaceId: presetIdentitySchema,
		ownerUserId: presetIdentitySchema,
		slug,
		name: z.string().min(1),
		description: z.string().nullable(),
		visibility: z.enum(['private', 'public']),
		status: z.enum(['active', 'archived']),
		designatedVersion: z.number().int().positive().safe(),
		latestVersion: z.number().int().positive().safe(),
		systemPrompt: prompt,
		config: presetConfigSchema.nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
		versionCreatedAt: z.string(),
	})
	.strict()
	.refine((row) => row.designatedVersion <= row.latestVersion)
export const presetVersionSchema = z
	.object({
		id: presetIdentitySchema,
		version: z.number().int().positive().safe(),
		systemPrompt: prompt,
		config: presetConfigSchema.nullable(),
		createdByUserId: presetIdentitySchema.nullable(),
		createdAt: z.string(),
	})
	.strict()
export const presetCollectionResponseSchema = z
	.object({
		success: z.literal(true),
		data: z
			.object({
				workspaceId: presetIdentitySchema,
				ownerUserId: presetIdentitySchema,
				presets: z.array(presetSchema),
			})
			.strict(),
	})
	.strict()
export const presetResponseSchema = z
	.object({ success: z.literal(true), data: presetSchema })
	.strict()
export const presetVersionsResponseSchema = z
	.object({
		success: z.literal(true),
		workspaceId: presetIdentitySchema,
		presetId: presetIdentitySchema,
		ownerUserId: presetIdentitySchema,
		data: z.array(presetVersionSchema),
	})
	.strict()
export const savePresetVersionInputSchema = z
	.object({
		slug: z.string().transform(normalizePresetSlug).pipe(slug),
		name: z.string().trim().max(128).optional(),
		description: z.string().trim().max(1024).nullable().optional(),
		visibility: z.enum(['private', 'public']).optional(),
		systemPrompt: prompt,
		config: presetConfigSchema,
	})
	.strict()
export const presetMetadataInputSchema = z
	.object({
		name: z.string().trim().min(1).max(128).optional(),
		description: z.string().trim().max(1024).nullable().optional(),
		visibility: z.enum(['private', 'public']).optional(),
		status: z.enum(['active', 'archived']).optional(),
	})
	.strict()
	.refine((value) => Object.values(value).some((item) => item !== undefined))
export type RequestPreset = z.infer<typeof presetSchema>
export type PresetVersion = z.infer<typeof presetVersionSchema>
export type PresetCollection = z.infer<
	typeof presetCollectionResponseSchema
>['data']
export type PresetVersions = z.infer<typeof presetVersionsResponseSchema>
export type SavePresetVersionInput = z.input<
	typeof savePresetVersionInputSchema
>
export type PresetMetadataInput = z.input<typeof presetMetadataInputSchema>
