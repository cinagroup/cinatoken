/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const source = z.enum(['configured', 'missing', 'invalid'])
const timezoneSource = source.or(z.literal('legacy'))
const currencySource = source.or(z.literal('unsupported'))
export const routeStrategyName = z.enum([
	'hash_affinity',
	'weighted_random',
	'weight_priority',
	'weighted_round_robin',
])
export type AdminConfigRouteStrategy = z.infer<typeof routeStrategyName>
export const webhookChannel = z.enum(['wecom', 'feishu'])
export type AdminConfigWebhookChannel = z.infer<typeof webhookChannel>
export const billingCurrencyWrite = z.enum(['USD', 'CNY'])
export type AdminConfigBillingCurrency = z.infer<typeof billingCurrencyWrite>
/** Opaque, non-secret row revision. Migrated rows initially use `legacy`. */
export const configRevisionSchema = z
	.string()
	.regex(
		/^(?:legacy|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
	)
export type AdminConfigRevision = z.infer<typeof configRevisionSchema> | null

/** All objects strip unknown fields, including accidental raw secret additions. */
export const adminConfigOverviewSchema = z.object({
	businessTimezone: z
		.object({
			value: z
				.string()
				.min(1)
				.max(128)
				.regex(/^[A-Za-z0-9_+:/-]+$/),
			source: timezoneSource,
			revision: configRevisionSchema.nullable(),
		})
		.superRefine((field, context) => {
			if (
				(field.source === 'missing' || field.source === 'invalid') &&
				field.value !== 'UTC'
			)
				context.addIssue({
					code: 'custom',
					message: 'Invalid timezone fallback',
				})
		}),
	billingCurrency: z
		.object({
			value: z.string().regex(/^[A-Z]{3}$/),
			source: currencySource,
			revision: configRevisionSchema.nullable(),
		})
		.superRefine((field, context) => {
			if (
				(field.source === 'missing' || field.source === 'invalid') &&
				field.value !== 'USD'
			)
				context.addIssue({
					code: 'custom',
					message: 'Invalid currency fallback',
				})
			if (
				field.source === 'configured' &&
				field.value !== 'USD' &&
				field.value !== 'CNY'
			)
				context.addIssue({
					code: 'custom',
					message: 'Unsupported configured currency',
				})
			if (
				field.source === 'unsupported' &&
				(field.value === 'USD' || field.value === 'CNY')
			)
				context.addIssue({
					code: 'custom',
					message: 'Invalid unsupported currency',
				})
		}),
	routeStrategy: z
		.object({
			value: routeStrategyName,
			source,
			revision: configRevisionSchema.nullable(),
		})
		.superRefine((field, context) => {
			if (field.source !== 'configured' && field.value !== 'hash_affinity')
				context.addIssue({ code: 'custom', message: 'Invalid route fallback' })
		}),
	webhooks: z.object({
		wecom: z.object({
			configured: z.boolean(),
			revision: configRevisionSchema.nullable(),
		}),
		feishu: z.object({
			configured: z.boolean(),
			revision: configRevisionSchema.nullable(),
		}),
	}),
	canWrite: z.boolean(),
	canReveal: z.boolean(),
})
export type AdminConfigOverview = z.infer<typeof adminConfigOverviewSchema>

export const adminConfigOverviewResponseSchema = z.object({
	success: z.literal(true),
	data: adminConfigOverviewSchema,
})
export const adminTimezoneWriteResponseSchema = z.object({
	success: z.literal(true),
	revision: configRevisionSchema,
})
export const billingCurrencyWriteResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		billingCurrency: z.object({
			value: billingCurrencyWrite,
			source: z.literal('configured'),
			revision: configRevisionSchema,
		}),
	}),
})
export const routeStrategyWriteResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		routeStrategy: z.object({
			value: routeStrategyName,
			source: z.literal('configured'),
			revision: configRevisionSchema,
		}),
	}),
})
export const webhookWriteResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		webhook: z.object({
			configured: z.boolean(),
			revision: configRevisionSchema,
		}),
	}),
})
export const webhookRevealResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		channel: webhookChannel,
		value: z.string().max(2048),
	}),
})
export const webhookVerifyResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		channel: webhookChannel,
		matched: z.boolean(),
		configured: z.boolean(),
	}),
})

export class ConfigWebhookInputError extends Error {
	constructor() {
		super(
			'Webhook URL must be an absolute HTTPS URL without credentials or fragment'
		)
		this.name = 'ConfigWebhookInputError'
	}
}

/** Match the server's new-write boundary without including an invalid URL in errors. */
export function normalizeWebhookWrite(
	channel: AdminConfigWebhookChannel,
	value: string
): string {
	if (!webhookChannel.safeParse(channel).success)
		throw new ConfigWebhookInputError()
	if (typeof value !== 'string') throw new ConfigWebhookInputError()
	const candidate = value.trim()
	if (
		!candidate ||
		candidate.length > 2048 ||
		Array.from(candidate).some((character) => {
			const code = character.charCodeAt(0)
			return code < 32 || (code >= 127 && code <= 159)
		})
	)
		throw new ConfigWebhookInputError()
	try {
		const url = new URL(candidate)
		if (
			url.protocol !== 'https:' ||
			url.hostname !==
				(channel === 'wecom' ? 'qyapi.weixin.qq.com' : 'open.feishu.cn') ||
			url.port !== '' ||
			url.username ||
			url.password ||
			url.hash
		)
			throw new ConfigWebhookInputError()
		return candidate
	} catch {
		throw new ConfigWebhookInputError()
	}
}

export class ConfigTimezoneInputError extends Error {
	constructor() {
		super('Business timezone must be an IANA region, Etc zone or UTC')
		this.name = 'ConfigTimezoneInputError'
	}
}

/** Mirrors the server's strict new-write boundary; the server remains authoritative. */
export function normalizeBusinessTimezoneWrite(value: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 128)
		throw new ConfigTimezoneInputError()
	if (
		Array.from(value).some((character) => {
			const code = character.charCodeAt(0)
			return code < 32 || (code >= 127 && code <= 159)
		})
	)
		throw new ConfigTimezoneInputError()
	const candidate = value.trim()
	if (
		candidate !== 'UTC' &&
		!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/u.test(candidate)
	)
		throw new ConfigTimezoneInputError()
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date())
		return candidate
	} catch {
		throw new ConfigTimezoneInputError()
	}
}
