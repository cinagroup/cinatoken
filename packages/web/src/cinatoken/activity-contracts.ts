import { z } from 'zod'

const count = z.number().int().nonnegative().safe()
const amount = z.number().finite().nonnegative()
const nullableText = z.string().nullable()
const identifier = z.string().min(1)
const currency = z.string().regex(/^[A-Z]{3}$/u)

function hasNoControls(value: string): boolean {
	return Array.from(value).every((character) => {
		const code = character.charCodeAt(0)
		return (
			code >= 32 &&
			!(code >= 127 && code <= 159) &&
			code !== 8232 &&
			code !== 8233
		)
	})
}

function publicText(maximum: number) {
	return z.string().min(1).max(maximum).refine(hasNoControls)
}

const timestamp = z
	.string()
	.min(1)
	.max(64)
	.refine((value) => Number.isFinite(Date.parse(value)))
export const activityWorkspaceIdSchema = identifier
	.max(600)
	.refine(
		(value) =>
			value.trim() === value &&
			Array.from(value).every(
				(character) =>
					character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
			)
	)
const workspace = activityWorkspaceIdSchema

function filter(maximum: number) {
	return z
		.string()
		.trim()
		.max(maximum)
		.refine((value) =>
			Array.from(value).every(
				(character) =>
					character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
			)
		)
		.transform((value) => value || undefined)
		.optional()
}

export const activityRangeSchema = z.enum(['7d', '30d', '90d'])
export const activityStatusSchema = z.enum([
	'success',
	'error',
	'incomplete',
	'cancelled',
])
const filters = {
	range: activityRangeSchema.default('7d'),
	api_key_id: filter(128),
	model_id: filter(256),
	provider_name: filter(200),
	status: z
		.union([activityStatusSchema, z.literal('')])
		.transform((value) => value || undefined)
		.optional(),
}

export const activityFiltersSchema = z.object(filters).strict()
export const activityQuerySchema = z
	.object({
		...filters,
		page: z.number().int().min(1).max(100_000).default(1),
		page_size: z.number().int().min(1).max(100).default(20),
	})
	.strict()

export const activityLogSchema = z
	.object({
		id: identifier,
		apiKeyId: nullableText,
		apiKeyName: nullableText,
		modelId: nullableText,
		modelName: nullableText,
		providerName: nullableText,
		protocol: nullableText,
		operation: nullableText,
		status: z.enum(['success', 'error', 'incomplete', 'cancelled', 'unknown']),
		inputTokens: count,
		outputTokens: count,
		totalTokens: count,
		chargedCost: amount,
		latencyMs: amount.nullable(),
		billingKind: nullableText,
		inputImageCount: count,
		outputImageCount: count,
		audioDurationSeconds: amount.nullable(),
		audioCharacters: count.nullable(),
		createdAt: timestamp,
	})
	.strict()

/** Amounts here are main billing-currency units; only budgetReservedMicros is a micro-unit integer. */
export const activityBudgetSchema = z
	.object({
		status: z.enum(['finite', 'unlimited', 'unavailable']),
		budgetMax: amount.nullable(),
		budgetBase: amount.nullable(),
		budgetSpent: amount.nullable(),
		budgetReserved: amount.nullable(),
		budgetReservedMicros: count.nullable(),
		budgetRemaining: amount.nullable(),
		budgetPeriod: z.string(),
		budgetResetAt: timestamp.nullable(),
	})
	.strict()
	.refine((value) => {
		if (
			value.budgetReserved !==
			(value.budgetReservedMicros === null
				? null
				: value.budgetReservedMicros / 1_000_000)
		)
			return false
		if (value.status === 'finite')
			return (
				value.budgetMax !== null &&
				value.budgetBase !== null &&
				value.budgetSpent !== null &&
				value.budgetReserved !== null &&
				value.budgetRemaining !== null
			)
		if (value.status === 'unlimited')
			return (
				value.budgetMax === null &&
				value.budgetRemaining === null &&
				value.budgetBase !== null &&
				value.budgetSpent !== null &&
				value.budgetReserved !== null
			)
		return value.budgetRemaining === null
	}, 'Budget availability or units are inconsistent')

export const activityGroupSchema = z
	.object({
		id: z.string(),
		name: nullableText,
		requestCount: count,
		successCount: count,
		errorCount: count,
		totalTokens: count,
		chargedCost: amount,
	})
	.strict()

export const activityTimelinePointSchema = z
	.object({
		bucket: timestamp,
		requestCount: count,
		inputTokens: count,
		outputTokens: count,
		cacheReadTokens: count,
		cacheWriteTokens: count,
		totalTokens: count,
		chargedCost: amount,
		avgLatencyMs: amount.nullable(),
	})
	.strict()

export const activityDataSchema = z
	.object({
		workspaceId: workspace,
		billingCurrency: currency,
		range: z
			.object({ id: activityRangeSchema, startAt: timestamp, endAt: timestamp })
			.strict(),
		budget: activityBudgetSchema,
		summary: z
			.object({
				totalRequests: count,
				errorCount: count,
				successCount: count,
				chargedCost: amount,
				meteredCost: amount,
				standardCost: amount,
				inputTokens: count,
				outputTokens: count,
				cacheReadTokens: count,
				cacheWriteTokens: count,
				totalTokens: count,
				avgLatencyMs: amount.nullable(),
			})
			.strict(),
		analytics: z
			.object({
				limit: count,
				models: z.array(activityGroupSchema),
				apiKeys: z.array(activityGroupSchema),
				providers: z.array(activityGroupSchema),
			})
			.strict(),
		timeline: z
			.object({
				granularity: z.enum(['hour', 'day']),
				points: z.array(activityTimelinePointSchema).max(200),
			})
			.strict(),
		keys: z.array(
			z
				.object({ id: identifier, name: nullableText, status: z.string() })
				.strict()
		),
		logs: z.array(activityLogSchema).max(100),
		pagination: z
			.object({
				page: count.min(1).max(100_000),
				pageSize: count.min(1).max(100),
				total: count,
				totalPages: count.min(1),
			})
			.strict(),
	})
	.strict()

export const activityGenerationIdSchema = z
	.string()
	.regex(/^gen-[A-Za-z0-9_-]{1,128}$/u)
const origin = publicText(512).refine((value) => {
	try {
		const url = new URL(value)
		return (
			(url.protocol === 'http:' || url.protocol === 'https:') &&
			url.origin === value &&
			!url.username &&
			!url.password
		)
	} catch {
		return false
	}
})

const providerResponse = z
	.object({
		status: z.number().int().min(100).max(599).nullable(),
		endpoint_id: publicText(200).optional(),
		id: publicText(200).optional(),
		is_byok: z.boolean().optional(),
		latency: count.optional(),
		model_permaslug: publicText(200).optional(),
		provider_name: publicText(200).optional(),
		routed_service_tier: z.enum(['flex', 'priority']).optional(),
	})
	.strict()

/** Generation USD snapshots are independent of ActivityData.billingCurrency; null means unknown, never zero. */
export const activityGenerationSchema = z
	.object({
		api_type: z
			.enum([
				'completions',
				'embeddings',
				'rerank',
				'tts',
				'stt',
				'video',
				'image',
			])
			.nullable(),
		app_id: z.null(),
		cache_discount: z.null(),
		cancelled: z.boolean().nullable(),
		created_at: timestamp,
		data_region: z.enum(['global', 'europe', 'us']),
		external_user: z.null(),
		finish_reason: z
			.enum(['tool_calls', 'stop', 'length', 'content_filter', 'error'])
			.nullable(),
		generation_time: count.nullable(),
		http_referer: origin.nullable(),
		id: activityGenerationIdSchema,
		is_byok: z.boolean(),
		latency: amount.nullable(),
		model: publicText(200),
		moderation_latency: z.null(),
		native_finish_reason: publicText(128).nullable(),
		native_tokens_cached: count.nullable(),
		native_tokens_completion: count.nullable(),
		native_tokens_completion_images: count.nullable(),
		native_tokens_prompt: count.nullable(),
		native_tokens_reasoning: count.nullable(),
		num_fetches: z.null(),
		num_input_audio_prompt: z.null(),
		num_media_completion: count.nullable(),
		num_media_prompt: count.nullable(),
		num_search_results: z.null(),
		origin,
		preset_id: z.null(),
		provider_name: publicText(200).nullable(),
		provider_responses: z
			.array(providerResponse)
			.max(32)
			.refine(
				(value) =>
					new TextEncoder().encode(JSON.stringify(value)).byteLength <=
					32 * 1024
			)
			.nullable(),
		request_id: z.null(),
		router: z.null(),
		service_tier: z.enum(['default', 'flex', 'priority']).nullable(),
		session_id: z
			.string()
			.min(1)
			.refine((value) => Array.from(value).length <= 256)
			.nullable(),
		streamed: z.boolean().nullable(),
		tokens_completion: count.nullable(),
		tokens_prompt: count.nullable(),
		total_cost: amount.nullable(),
		upstream_id: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u)
			.nullable(),
		upstream_inference_cost: amount.nullable(),
		usage: amount.nullable(),
		user_agent: publicText(512).nullable(),
		web_search_engine: z.null(),
		workspace_id: publicText(600),
	})
	.strict()
	.refine(
		(value) => value.total_cost === value.usage,
		'USD usage snapshot differs from total cost'
	)

export const activityResponseSchema = z
	.object({ success: z.literal(true), data: activityDataSchema })
	.strict()
export const activityGenerationResponseSchema = z
	.object({ success: z.literal(true), data: activityGenerationSchema })
	.strict()
export const activityCsvExportSchema = z
	.object({
		blob: z.instanceof(Blob),
		filename: z.string(),
		rowCount: count.max(1000),
		total: count,
		truncated: z.boolean(),
		billingCurrency: currency,
		workspaceId: workspace,
	})
	.strict()
	.refine(
		(value) =>
			value.total >= value.rowCount &&
			value.truncated === value.total > value.rowCount
	)

export type ActivityRange = z.infer<typeof activityRangeSchema>
export type ActivityStatus = z.infer<typeof activityStatusSchema>
export type ActivityFilters = z.input<typeof activityFiltersSchema>
export type ActivityQuery = z.input<typeof activityQuerySchema>
export type ActivityLog = z.infer<typeof activityLogSchema>
export type ActivityBudget = z.infer<typeof activityBudgetSchema>
export type ActivityGroup = z.infer<typeof activityGroupSchema>
export type ActivityTimelinePoint = z.infer<typeof activityTimelinePointSchema>
export type ActivityData = z.infer<typeof activityDataSchema>
export type ActivityGeneration = z.infer<typeof activityGenerationSchema>
export type ActivityCsvExport = z.infer<typeof activityCsvExportSchema>
