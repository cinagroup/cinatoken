import { z } from 'zod'

export const BYOK_MAX_CREDENTIAL_BYTES = 64 * 1024
export const BYOK_MAX_BODY_BYTES = 192 * 1024
export const BYOK_MAX_PROVIDER_KEYS = 100
export const BYOK_MAX_ALLOWLIST_ITEMS = 100

function printable(value: string): boolean {
	return Array.from(value).every((character) => {
		const code = character.charCodeAt(0)
		return code >= 32 && code !== 127
	})
}

function text(maximum: number) {
	return z
		.string()
		.trim()
		.min(1)
		.refine((value) => Array.from(value).length <= maximum && printable(value))
}

export const byokIdSchema = z
	.string()
	.toLowerCase()
	.regex(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
	)

export const byokProviderSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)

const workspaceId = z.string().trim().min(1).max(600).refine(printable)
const name = z
	.string()
	.trim()
	.refine((value) => Array.from(value).length <= 255 && printable(value))
	.transform((value) => value || null)
	.nullable()
const credential = z
	.string()
	.refine(
		(value) =>
			value.trim().length > 0 &&
			new TextEncoder().encode(value).byteLength <= BYOK_MAX_CREDENTIAL_BYTES,
		'Credential must contain between 1 and 65536 bytes'
	)

function allowlist(item: z.ZodType<string, string>, minimum = 0) {
	return z
		.array(item)
		.min(minimum)
		.max(BYOK_MAX_ALLOWLIST_ITEMS)
		.transform((items) => [...new Set(items)])
		.nullable()
}

const allowedModels = allowlist(text(240))
const allowedUsers = allowlist(text(512))
const allowedHashes = allowlist(
	z
		.string()
		.trim()
		.regex(/^[a-f0-9]{64}$/u),
	1
)

type Policy = {
	is_fallback?: boolean
	always_use_for_provider?: boolean
	always_use_for_matching_models?: boolean
}

function validPolicy(value: Policy): boolean {
	if (value.always_use_for_provider && value.always_use_for_matching_models)
		return false
	return !(
		value.is_fallback &&
		(value.always_use_for_provider || value.always_use_for_matching_models)
	)
}

const mutableFields = {
	name: name.optional(),
	key: credential.optional(),
	disabled: z.boolean().optional(),
	is_fallback: z.boolean().optional(),
	always_use_for_provider: z.boolean().optional(),
	always_use_for_matching_models: z.boolean().optional(),
	allowed_models: allowedModels.optional(),
	allowed_user_ids: allowedUsers.optional(),
	allowed_api_key_hashes: allowedHashes.optional(),
}

export const createByokKeyInputSchema = z
	.object({
		...mutableFields,
		key: credential,
		provider: byokProviderSchema,
		workspace_id: workspaceId.optional(),
	})
	.strict()
	.refine(
		validPolicy,
		'Fallback credentials cannot carry shared-capacity policies'
	)

export const patchByokKeyInputSchema = z
	.object(mutableFields)
	.strict()
	.refine(
		(value) => Object.values(value).some((field) => field !== undefined),
		'At least one field is required'
	)
	.refine(
		validPolicy,
		'Fallback credentials cannot carry shared-capacity policies'
	)

/** Public responses contain only the server-generated preview, never reusable credentials. */
export const byokKeySchema = z
	.object({
		id: byokIdSchema,
		workspace_id: workspaceId,
		provider: byokProviderSchema,
		name: z.string().nullable(),
		label: z
			.string()
			.refine(
				(value) =>
					value === '***' || (value.startsWith('...') && value.length === 7),
				'Expected a masked BYOK label'
			),
		disabled: z.boolean(),
		is_fallback: z.boolean(),
		always_use_for_provider: z.boolean(),
		always_use_for_matching_models: z.boolean(),
		sort_order: z.number().int().nonnegative().safe(),
		allowed_models: allowedModels,
		allowed_user_ids: allowedUsers,
		allowed_api_key_hashes: allowedHashes,
		created_at: z.string(),
	})
	.strict()
	.refine(validPolicy, 'Invalid shared-capacity policy')

export const byokListOptionsSchema = z
	.object({
		offset: z.number().int().min(0).max(1_000_000).default(0),
		limit: z.number().int().min(1).max(100).default(50),
		provider: byokProviderSchema.optional(),
	})
	.strict()

export const byokListResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.array(byokKeySchema),
		total: z.number().int().nonnegative().safe(),
		workspaceId,
	})
	.strict()

const reorderItem = z
	.object({ id: byokIdSchema, is_fallback: z.boolean() })
	.strict()

export const reorderByokKeysInputSchema = z
	.object({
		workspace_id: workspaceId.optional(),
		provider: byokProviderSchema,
		keys: z.array(reorderItem).min(1).max(BYOK_MAX_PROVIDER_KEYS),
	})
	.strict()
	.refine(
		(value) =>
			new Set(value.keys.map((key) => key.id)).size === value.keys.length,
		'Ordering must not contain duplicate credentials'
	)
	.refine((value) => {
		let reachedFallback = false
		return value.keys.every((key) => {
			if (reachedFallback && !key.is_fallback) return false
			reachedFallback ||= key.is_fallback
			return true
		})
	}, 'Prioritized credentials must precede fallback credentials')

export const byokKeyResponseSchema = z
	.object({ success: z.literal(true), data: byokKeySchema })
	.strict()

export const byokReorderResponseSchema = z
	.object({
		success: z.literal(true),
		data: z
			.object({
				workspace_id: workspaceId,
				provider: byokProviderSchema,
				keys: z
					.array(
						reorderItem.extend({
							sort_order: z.number().int().nonnegative().safe(),
						})
					)
					.min(1)
					.max(BYOK_MAX_PROVIDER_KEYS),
			})
			.strict(),
	})
	.strict()

export type ByokKey = z.infer<typeof byokKeySchema>
export type ByokListPage = Pick<
	z.infer<typeof byokListResponseSchema>,
	'data' | 'total' | 'workspaceId'
>
export type ByokListOptions = z.input<typeof byokListOptionsSchema>
export type CreateByokKeyInput = z.input<typeof createByokKeyInputSchema>
export type PatchByokKeyInput = z.input<typeof patchByokKeyInputSchema>
export type ReorderByokKeysInput = z.input<typeof reorderByokKeysInputSchema>
export type ByokReorderResult = z.infer<
	typeof byokReorderResponseSchema
>['data']
