/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	sharedKeyChannelSchema,
	sharedKeyStatusSchema,
} from '../../shared-key-contracts'
import { safeLogText } from '../request-logs/request-log-domain'
import {
	adminSharedKeyPrioritySchema,
	adminSharedKeyRevisionSchema,
} from './shared-key-input'

const validId = (value: string) => {
	if (/[\s/?#\\\p{Cc}\p{Cf}]/u.test(value)) return false
	try {
		encodeURIComponent(value)
		return true
	} catch {
		return false
	}
}
export const adminSharedKeyIdSchema = z.string().min(1).max(255).refine(validId)
export const adminSharedKeyOwnerIdSchema = z
	.string()
	.min(1)
	.max(255)
	.refine(validId)
export const adminSharedKeyCountSchema = z.number().int().nonnegative().safe()
const amount = z.number().finite().nonnegative()
const text = (max: number) =>
	z
		.string()
		.max(max)
		.refine((value) => !/\p{Cc}/u.test(value))
		.transform((value) => safeLogText(value))
export const adminSharedKeyTimeSchema = z
	.string()
	.max(40)
	.transform((value, context) => {
		const normalized =
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u.test(value)
				? value.replace(' ', 'T') + 'Z'
				: value
		const milliseconds = Date.parse(normalized)
		if (
			!z.iso.datetime().safeParse(normalized).success ||
			!Number.isFinite(milliseconds) ||
			new Date(milliseconds).toISOString().slice(0, 19) !==
				normalized.slice(0, 19)
		) {
			context.addIssue({ code: 'custom', message: 'Invalid UTC time' })
			return z.NEVER
		}
		return new Date(milliseconds).toISOString()
	})
export const adminSharedKeyFailureSchema = z.enum([
	'credential_rejected',
	'validation_timeout',
	'validation_unavailable',
	'validation_failed',
	'unsupported_channel',
	'empty_credential',
	'unknown_failure',
])
export const adminSharedKeyCapabilitiesSchema = z
	.object({
		can_write: z.boolean(),
		user_detail: z.boolean(),
		request_logs: z.boolean(),
		can_review_earnings: z.boolean(),
	})
	.strict()
export type AdminSharedKeyCapabilities = z.infer<
	typeof adminSharedKeyCapabilitiesSchema
>
const reference = {
	currentBillingCurrency: z
		.string()
		.regex(/^[A-Z]{3}$/u)
		.nullable(),
	currentBillingCurrencySource: z.enum(['configured', 'missing', 'invalid']),
	currentBillingCurrencyReferenceOnly: z.literal(true),
}
const validReference = (value: {
	currentBillingCurrency: string | null
	currentBillingCurrencySource: string
}) =>
	(value.currentBillingCurrencySource === 'configured') ===
	(value.currentBillingCurrency !== null)
/** Explicit public projection: unknown server properties never enter Query. */
export const adminSharedKeyRowSchema = z.object({
	id: adminSharedKeyIdSchema,
	sellerUserId: adminSharedKeyOwnerIdSchema,
	sellerEmail: text(320).nullable(),
	channelType: sharedKeyChannelSchema,
	label: text(255).nullable(),
	status: sharedKeyStatusSchema,
	sellerPriority: adminSharedKeyPrioritySchema,
	weight: z.number().int().min(1).max(100),
	inputPrice: amount,
	outputPrice: amount,
	cacheReadPrice: amount.nullable(),
	cacheWritePrice: amount.nullable(),
	validatedAt: adminSharedKeyTimeSchema.nullable(),
	lastUsedAt: adminSharedKeyTimeSchema.nullable(),
	lastFailureAt: adminSharedKeyTimeSchema.nullable(),
	createdAt: adminSharedKeyTimeSchema,
	updatedAt: adminSharedKeyTimeSchema,
	servedInputTokens: adminSharedKeyCountSchema,
	servedOutputTokens: adminSharedKeyCountSchema,
	earnedTotal: amount,
	apiKeyMasked: z.literal('••••••••'),
	failureCode: adminSharedKeyFailureSchema.nullable(),
	profile_revision: adminSharedKeyRevisionSchema,
	quoteCurrency: z.null(),
	quoteCurrencyAvailability: z.literal('legacy_unrecorded'),
	quoteUnit: z.literal('per_million_tokens'),
	earningsCurrency: z.literal('USD'),
	earningsAmountUnit: z.literal('major'),
	statisticsBasis: z.enum([
		'legacy_cached_projection',
		'reviewed_credited_usage',
	]),
})
export type AdminSharedKeyRow = z.infer<typeof adminSharedKeyRowSchema>
export const adminSharedKeyOverviewSchema = z.object({
	success: z.literal(true),
	data: z
		.object({
			items: z.array(adminSharedKeyRowSchema).max(100),
			total: adminSharedKeyCountSchema,
			page: z.number().int().min(1).max(1_000_000),
			page_size: z.number().int().min(1).max(100),
			hasMore: z.boolean(),
			...reference,
			capabilities: adminSharedKeyCapabilitiesSchema,
		})
		.refine(validReference),
})
export type AdminSharedKeyOverview = z.infer<
	typeof adminSharedKeyOverviewSchema
>['data']
export const adminSharedKeyDetailSchema = z.object({
	success: z.literal(true),
	data: adminSharedKeyRowSchema
		.extend({
			...reference,
			capabilities: adminSharedKeyCapabilitiesSchema,
		})
		.refine(validReference),
})
export type AdminSharedKeyDetail = z.infer<
	typeof adminSharedKeyDetailSchema
>['data']
export const adminSharedKeyAuditIdSchema = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
export const adminSharedKeyPatchResponseSchema = z.object({
	success: z.literal(true),
	data: z
		.object({
			id: adminSharedKeyIdSchema,
			outcome: z.enum(['applied', 'unchanged']),
			auditId: adminSharedKeyAuditIdSchema.nullable(),
		})
		.refine(
			(value) => (value.outcome === 'applied') === (value.auditId !== null)
		),
})
export const adminSharedKeyDeleteResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		id: adminSharedKeyIdSchema,
		deleted: z.literal(true),
		auditId: adminSharedKeyAuditIdSchema,
	}),
})
export const adminSharedKeyConflictSchema = z.object({
	success: z.literal(false),
	code: z.enum([
		'shared_key_state_conflict',
		'shared_key_earning_history_immutable',
	]),
})
export type AdminSharedKeyConflictCode = z.infer<
	typeof adminSharedKeyConflictSchema
>['code']
