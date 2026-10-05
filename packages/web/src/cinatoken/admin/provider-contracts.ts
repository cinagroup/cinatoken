import { z } from 'zod'
import {
	normalizeProviderEndpoints,
	providerEndpointsHaveCredentials,
	PROVIDER_PROTOCOLS,
} from './provider-endpoints'

export const providerIdentitySchema = z
	.string()
	.min(1)
	.max(600)
	.refine(
		(value) =>
			value !== '.' &&
			value !== '..' &&
			value.trim() === value &&
			!Array.from(value).some(
				(character) =>
					character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
			)
	)
const count = z.number().int().nonnegative().safe()
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)))
export const providerStatusSchema = z.enum(['active', 'disabled'])
export const providerSharedChannelSchema = z.enum([
	'openai',
	'anthropic',
	'zhipu',
	'deepseek',
])

/** Only server-masked previews may enter the normal provider Query cache. */
export const providerMaskedKeySchema = z
	.string()
	.refine(
		(value) =>
			value === '(empty)' ||
			value === '***' ||
			/^[\s\S]{3}…[\s\S]{4}$/u.test(value) ||
			/^env:[A-Z][A-Z0-9_]*$/u.test(value) ||
			/^sa:[^@\s{}:]+@[^@\s{}:]+$/u.test(value)
	)
export type ProviderEndpointsState = 'available' | 'redacted' | 'invalid'
const safeEndpoints = z
	.string()
	.nullable()
	.transform(
		(value): { value: string | null; state: ProviderEndpointsState } => {
			try {
				const normalized = normalizeProviderEndpoints(value)
				if (providerEndpointsHaveCredentials(normalized))
					return { value: null, state: 'redacted' }
				return {
					value: Object.keys(normalized).length
						? JSON.stringify(normalized)
						: null,
					state: 'available',
				}
			} catch {
				return { value: null, state: 'invalid' }
			}
		}
	)

/** Zod's object projection discards unknown columns, including encrypted/raw key fields. */
export const adminProviderSchema = z
	.object({
		id: providerIdentitySchema,
		name: z.string().min(1),
		vendor_key: z.string(),
		icon_key: z.string(),
		endpoints: safeEndpoints,
		api_key: providerMaskedKeySchema,
		status: providerStatusSchema,
		description: z.string().nullable(),
		shared_channel_type: providerSharedChannelSchema.nullable().optional(),
		created_at: timestamp,
		has_pending_key: z.boolean(),
		routes_count: count,
		active_routes_count: count,
	})
	.superRefine((row, context) => {
		if (row.active_routes_count > row.routes_count)
			context.addIssue({
				code: 'custom',
				message: 'Provider route counts are inconsistent',
			})
	})
	.transform((row) => ({
		...row,
		endpoints: row.endpoints.value,
		endpointsState: row.endpoints.state,
	}))
export type AdminProvider = z.infer<typeof adminProviderSchema>
export const providerListResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(adminProviderSchema),
	count,
})
export const providerResponseSchema = z.object({
	success: z.literal(true),
	data: adminProviderSchema,
})
export const providerCreatedResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({ id: providerIdentitySchema }),
})
export const providerSuccessSchema = z.object({ success: z.literal(true) })
export const providerRevealResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({ api_key: z.string() }),
})

export const providerCatalogItemSchema = z
	.object({
		id: providerIdentitySchema,
		name: z.string().min(1),
		vendor_key: z.string(),
		icon_key: z.string(),
		vendor_label: z.string(),
		protocols: z.array(z.enum(PROVIDER_PROTOCOLS)),
		endpoints: safeEndpoints,
		description: z.string().nullable(),
	})
	.transform((row) => ({
		...row,
		endpoints: row.endpoints.value,
		endpointsState: row.endpoints.state,
	}))
export type ProviderCatalogItem = z.infer<typeof providerCatalogItemSchema>
export const providerCatalogResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(providerCatalogItemSchema),
	count,
})

/** Partial import errors can contain database/upstream details; retain only the catalog ID. */
export const providerImportResultSchema = z.object({
	created: count,
	updated: z.literal(0),
	skipped_existing: z.array(providerIdentitySchema),
	failed: z.array(
		z.object({
			id: providerIdentitySchema,
			message: z.string().transform(() => 'Provider import failed'),
		})
	),
})
export type ProviderImportResult = z.infer<typeof providerImportResultSchema>
export const providerImportResponseSchema = z.object({
	success: z.literal(true),
	data: providerImportResultSchema,
})

export type ProviderJson =
	| null
	| boolean
	| number
	| string
	| ProviderJson[]
	| { [key: string]: ProviderJson }
export type ProviderJsonObject = { [key: string]: ProviderJson }
/** DashScope returns native JSON, without CinaToken's success/data envelope. */
export function providerJson(value: unknown): ProviderJson {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return value
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (Array.isArray(value)) return value.map((item) => providerJson(item))
	if (typeof value === 'object' && value !== null) {
		const result: ProviderJsonObject = {}
		for (const [key, item] of Object.entries(value)) {
			Object.defineProperty(result, key, {
				value: providerJson(item),
				enumerable: true,
				configurable: true,
				writable: true,
			})
		}
		return result
	}
	throw new Error('Provider resource JSON is invalid')
}
export const providerDashScopeResponseSchema = z
	.record(z.string(), z.unknown())
	.superRefine((value, context) => {
		try {
			providerJson(value)
		} catch {
			context.addIssue({
				code: 'custom',
				message: 'Provider resource JSON is invalid',
			})
		}
	})
	.transform((value) => providerJson(value) as ProviderJsonObject)
export type ProviderDashScopeResource = 'hotwords' | 'voices'

/** Browser use requires root's verified console session; scopes remain server-authoritative. */
export const PROVIDER_OPERATION_PERMISSIONS = {
	read: 'providers.read',
	write: 'providers.write',
	reveal: 'providers.secrets.read',
	dashscope: 'providers.write',
} as const
