import { z } from 'zod'

export const sharedKeyChannelSchema = z.enum([
	'openai',
	'anthropic',
	'zhipu',
	'deepseek',
])
export const sharedKeyStatusSchema = z.enum([
	'validating',
	'active',
	'paused',
	'invalid',
	'disabled',
])
const identity = z.string().trim().min(1).max(600)
const amount = z.number().finite().nonnegative()
const currency = z.string().regex(/^[A-Z]{3}$/u)
const timestamp = z.string().nullable()
const masked = z
	.string()
	.max(512)
	.refine(
		(value) =>
			value === '***' ||
			/^.{3}….{4}$/u.test(value) ||
			/^env:[A-Za-z_][A-Za-z0-9_]*$/u.test(value) ||
			/^sa:[A-Za-z0-9_.@+-]+$/u.test(value)
	)
const fingerprint = z
	.string()
	.max(512)
	.refine(
		(value) =>
			value === '***' ||
			/^….{4}$/u.test(value) ||
			/^sa:(?:\*\*\*|….{4})$/u.test(value) ||
			/^env:[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
	)

/** Exact seller projection: plaintext is deliberately forbidden in cached rows. */
export const sharedKeySchema = z
	.object({
		id: identity,
		sellerUserId: identity,
		channelType: sharedKeyChannelSchema,
		apiKeyMasked: masked,
		keyFingerprint: fingerprint,
		label: z.string().nullable(),
		status: sharedKeyStatusSchema,
		sellerPriority: z.number().int().safe(),
		weight: z.number().int().min(1).max(100),
		inputPrice: amount,
		outputPrice: amount,
		cacheReadPrice: amount.nullable(),
		cacheWritePrice: amount.nullable(),
		validatedAt: timestamp,
		lastUsedAt: timestamp,
		lastFailureAt: timestamp,
		failureReason: z.string().nullable(),
		servedInputTokens: z.number().int().nonnegative().safe(),
		servedOutputTokens: z.number().int().nonnegative().safe(),
		earnedTotal: amount,
		earnedTotalExact: z.string().optional(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.strict()

export const sharedKeysResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.array(sharedKeySchema),
		sellerUserId: identity,
		earningsCurrency: currency,
	})
	.strict()
export const sharedKeyChannelsResponseSchema = z
	.object({
		success: z.literal(true),
		data: z
			.object({
				channels: z.array(
					z
						.object({
							channelType: sharedKeyChannelSchema,
							label: z.string(),
							modelsUrl: z.string().url().nullable(),
						})
						.strict()
				),
				limits: z
					.object({
						maxInputPrice: amount,
						maxOutputPrice: amount,
						commissionRate: z.number().min(0).max(0.9),
					})
					.strict(),
				billingCurrency: currency,
			})
			.strict(),
	})
	.strict()
export const sharedKeyResponseSchema = z
	.object({ success: z.literal(true), data: sharedKeySchema })
	.strict()
export const createdSharedKeyResponseSchema = z
	.object({
		success: z.literal(true),
		data: sharedKeySchema
			.extend({
				apiKey: z.string().min(8),
				validation: z.enum(['active', 'validating', 'invalid']),
				validationReason: z.string().nullable(),
			})
			.strict(),
	})
	.strict()

const fields = {
	label: z.string().trim().max(128).nullable().optional(),
	weight: z.number().int().min(1).max(100),
	inputPrice: z.number().finite().positive(),
	outputPrice: z.number().finite().positive(),
	cacheReadPrice: amount.nullable().optional(),
	cacheWritePrice: amount.nullable().optional(),
}
export const createSharedKeyInputSchema = z
	.object({
		...fields,
		channelType: sharedKeyChannelSchema,
		apiKey: z.string().trim().min(8),
	})
	.strict()
export const patchSharedKeyInputSchema = z
	.object({
		...fields,
		weight: fields.weight.optional(),
		inputPrice: fields.inputPrice.optional(),
		outputPrice: fields.outputPrice.optional(),
		status: z.enum(['paused', 'active']).optional(),
	})
	.strict()
	.refine((value) => Object.values(value).some((field) => field !== undefined))

export type SharedKey = z.infer<typeof sharedKeySchema>
export type SharedKeyChannel = z.infer<typeof sharedKeyChannelSchema>
export type SharedKeyStatus = z.infer<typeof sharedKeyStatusSchema>
export type SharedKeyCatalog = z.infer<
	typeof sharedKeyChannelsResponseSchema
>['data']
export type CreateSharedKeyInput = z.input<typeof createSharedKeyInputSchema>
export type PatchSharedKeyInput = z.input<typeof patchSharedKeyInputSchema>
export type SharedKeyCollection = {
	keys: SharedKey[]
	earningsCurrency: string
}
export type CreatedSharedKey = {
	row: SharedKey
	validation: 'active' | 'validating' | 'invalid'
	validationReason: string | null
}
