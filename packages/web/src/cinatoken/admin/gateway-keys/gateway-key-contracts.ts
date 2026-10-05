/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { userIdSchema } from '../users/users-contracts'
import { gatewayKeyMetadataReadable } from './gateway-key-metadata'

export const gatewayKeyRevisionSchema = z
	.string()
	.regex(/^sha256:[0-9a-f]{64}$/u)
export const gatewayKeyOwnerIdSchema = userIdSchema.refine(
	(value) => !/[\s/?#\\\p{Cc}]/u.test(value)
)
const ownerId = gatewayKeyOwnerIdSchema
export const gatewayKeyIdSchema = ownerId
	.max(255)
	.refine((value) => !value.startsWith('sk-'))
export const gatewayKeyStatusSchema = z.enum(['active', 'disabled', 'revoked'])
const count = z.number().int().nonnegative().safe()
const amount = z.number().finite().nonnegative()
const instant = z
	.string()
	.max(40)
	.transform((value, context) => {
		const normalized =
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u.test(value)
				? value.replace(' ', 'T') + 'Z'
				: value
		if (
			!z.iso.datetime().safeParse(normalized).success ||
			!Number.isFinite(Date.parse(normalized))
		) {
			context.addIssue({ code: 'custom', message: 'Invalid UTC timestamp' })
			return z.NEVER
		}
		return new Date(normalized).toISOString()
	})
/** Accept only Core's masked previews. Short legacy values disclose no prefix. */
const masked = z
	.string()
	.max(13)
	.refine((value) => {
		return value === 'sk-…' || /^sk-[A-Za-z0-9]{5}…[A-Za-z0-9]{4}$/u.test(value)
	})
	.transform(() => 'sk-…' as const)
const fields = {
	id: gatewayKeyIdSchema,
	key: masked,
	user_id: ownerId,
	workspace_id: ownerId,
	name: z
		.string()
		.max(255)
		.refine((value) => !/\p{Cc}/u.test(value))
		.nullable(),
	user_email: z
		.string()
		.max(320)
		.refine((value) => !/\p{Cc}/u.test(value))
		.nullable(),
	budget_max: z.number().finite().nullable(),
	budget_base: amount,
	budget_spent: amount,
	budget_period: z.enum(['none', 'daily', 'weekly', 'monthly']),
	budget_reset_at: instant.nullable(),
	status: gatewayKeyStatusSchema,
	created_at: instant,
	updated_at: instant,
	profile_revision: gatewayKeyRevisionSchema,
}
const metadataRaw = z.string().max(65_536).nullable()
const metadataPreview = z
	.string()
	.max(1024)
	.nullable()
	.transform((raw, context) => {
		if (raw === null) return null
		try {
			return z
				.object({ field_count: count.max(1000) })
				.strict()
				.parse(JSON.parse(raw) as unknown)
		} catch {
			context.addIssue({ code: 'custom', message: 'Invalid metadata summary' })
			return z.NEVER
		}
	})
/** A raw metadata value never enters an ordinary list or mutation cache. */
export const gatewayKeyRowSchema = z
	.object({
		...fields,
		metadata_preview: metadataPreview,
		metadata_unavailable: z.boolean(),
	})
	.refine((row) => !row.metadata_unavailable || row.metadata_preview === null)
export type GatewayKeyRow = z.infer<typeof gatewayKeyRowSchema>
export const gatewayKeysCapabilitiesSchema = z.object({
	user_detail: z.boolean(),
	request_logs: z.boolean(),
	budget_audit: z.boolean(),
	effective_guardrails: z.boolean(),
	can_write: z.boolean(),
})
export type GatewayKeysCapabilities = z.infer<
	typeof gatewayKeysCapabilitiesSchema
>
export const gatewayKeysListResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(gatewayKeyRowSchema).max(20),
	total: count,
	page: z.number().int().positive().max(1_000_000),
	page_size: z.literal(20),
	capabilities: gatewayKeysCapabilitiesSchema,
})
export type GatewayKeysList = z.infer<typeof gatewayKeysListResponseSchema>
/** Explicit uncached edit read. The raw field is held only by the mounted editor. */
export const gatewayKeyDetailSchema = z
	.object({
		...fields,
		metadata_raw: metadataRaw,
		metadata_unavailable: z.boolean(),
	})
	.refine((row) => !row.metadata_unavailable || row.metadata_raw === null)
	.refine((row) => gatewayKeyMetadataReadable(row.metadata_raw))
export type GatewayKeyDetail = z.infer<typeof gatewayKeyDetailSchema>
export const gatewayKeyDetailResponseSchema = z.object({
	success: z.literal(true),
	data: gatewayKeyDetailSchema,
})
export const gatewayKeyUpdatedResponseSchema = z.object({
	success: z.literal(true),
	data: gatewayKeyRowSchema,
})
export const gatewayKeyCreatedResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		id: gatewayKeyIdSchema,
		key_id: gatewayKeyIdSchema,
		key: z.string().regex(/^sk-[A-Za-z0-9]{32}$/u),
		user_id: ownerId,
		workspace_id: ownerId,
		status: z.literal('active'),
		name: z.string().max(255).nullable(),
		profile_revision: gatewayKeyRevisionSchema,
		owner: z.object({
			email: z.string().max(320),
			external_system: z.string().max(600).nullable(),
			external_user_id: z.string().max(600).nullable(),
		}),
	}),
})
export type GatewayKeyCreated = Omit<
	z.infer<typeof gatewayKeyCreatedResponseSchema>['data'],
	'key'
>
