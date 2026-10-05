/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { safeLogText } from '../request-logs/request-log-domain'
import { toolFamilies, toolProviders, validToolTarget } from './tools-domain'
import { toolToken, validToolVersion } from './tools-token'

export const toolFamilySchema = z.enum(toolFamilies)
export const toolProviderSchema = z.enum([
	'bocha',
	'tavily',
	'cleversee',
	'tencent_wsa',
	'firecrawl',
	'jina',
	'tencent_tms',
])
export const toolFieldSchema = z.enum(['apiKey', 'secretId', 'secretKey'])
export const toolMoney = z
	.number()
	.finite()
	.min(0)
	.max(Number.MAX_SAFE_INTEGER / 1_000_000)
	.refine((value) => Number.isSafeInteger(Math.round(value * 1_000_000)))
export const toolPricesSchema = z.object({
	metered: toolMoney,
	standard: toolMoney,
	charged: toolMoney,
})
export const toolCapabilitiesSchema = z.object({
	can_write: z.boolean(),
	can_reveal: z.boolean(),
	can_playground: z.boolean(),
	can_invocations: z.boolean(),
})
export const toolCurrencySchema = z
	.object({
		value: z.enum(['USD', 'CNY']).nullable(),
		source: z.enum(['configured', 'missing', 'invalid', 'unsupported']),
	})
	.refine((value) => {
		if (value.source === 'configured') return value.value !== null
		if (value.source === 'missing') return value.value === 'USD'
		return value.value === null
	})
export const toolProviderSummarySchema = z
	.object({
		provider: toolProviderSchema,
		implemented: z.boolean(),
		entrySource: z.enum(['catalog', 'legacy', 'default', 'unavailable']),
		configured: z.boolean(),
		credentials: z
			.array(
				z.object({
					field: toolFieldSchema,
					required: z.boolean(),
					configured: z.boolean(),
				})
			)
			.max(2),
		prices: toolPricesSchema.nullable(),
		priceSource: z.enum(['configured', 'legacy', 'default', 'unavailable']),
		unit: z.enum(['request', 'chars']),
		billingUnitChars: z
			.number()
			.int()
			.min(1)
			.max(Number.MAX_SAFE_INTEGER)
			.nullable(),
		isLossPricing: z.boolean().nullable(),
	})
	.refine((value) =>
		value.prices === null
			? value.isLossPricing === null
			: value.isLossPricing === value.prices.charged < value.prices.metered
	)
export const toolFamilyStateSchema = z
	.object({
		family: toolFamilySchema,
		version: toolToken,
		source: z.enum(['catalog', 'legacy', 'missing', 'invalid']),
		catalogState: z.enum([
			'missing',
			'empty',
			'valid',
			'invalid',
			'unsupported_fields',
		]),
		savedActive: toolProviderSchema.nullable(),
		activeState: z.enum([
			'configured',
			'missing',
			'invalid',
			'ignored_without_catalog',
		]),
		effectiveProvider: toolProviderSchema.nullable(),
		configurationReady: z.boolean(),
		configurationIssue: z.enum([
			'none',
			'missing_credentials',
			'invalid_provider',
			'invalid_catalog',
			'not_implemented',
			'invalid_prices',
			'invalid_billing_unit',
		]),
		editable: z.boolean(),
		editBlockedCode: z
			.enum(['invalid_source', 'unsupported_source', 'invalid_currency'])
			.nullable(),
	})
	.refine(
		(value) =>
			validToolVersion(value.version, value.family) &&
			value.configurationReady === (value.configurationIssue === 'none') &&
			[value.savedActive, value.effectiveProvider].every(
				(provider) =>
					provider === null || validToolTarget(value.family, provider)
			)
	)
export function validToolConfiguration(
	family: z.infer<typeof toolFamilySchema>,
	value: z.infer<typeof toolProviderSummarySchema>
): boolean {
	const fields =
		family === 'ai-detection' ? ['secretId', 'secretKey'] : ['apiKey']
	return (
		validToolTarget(family, value.provider) &&
		value.credentials.length === fields.length &&
		fields.every((field) =>
			value.credentials.some((row) => row.field === field && row.required)
		) &&
		(family === 'ai-detection'
			? value.unit === 'chars'
			: value.unit === 'request' && value.billingUnitChars === null)
	)
}
const familySummary = toolFamilyStateSchema
	.and(z.object({ providers: z.array(toolProviderSummarySchema).max(4) }))
	.refine(
		(value) =>
			value.providers.length === toolProviders[value.family].length &&
			new Set(value.providers.map((row) => row.provider)).size ===
				value.providers.length &&
			value.providers.every((row) => validToolConfiguration(value.family, row))
	)
export const toolOverviewData = z
	.object({
		billingCurrency: toolCurrencySchema,
		families: z.array(familySummary).length(4),
		capabilities: toolCapabilitiesSchema,
	})
	.refine(
		(value) => new Set(value.families.map((row) => row.family)).size === 4
	)
const setting = (max: number) =>
	z
		.object({
			value: z
				.string()
				.refine(
					(value) => [...value].length <= max && !/[\p{Cc}\p{Cf}]/u.test(value)
				)
				.transform((value) => safeLogText(value))
				.nullable(),
			availability: z.enum(['available', 'redacted', 'invalid']),
			source: z.enum(['configured', 'default', 'missing']),
		})
		.refine((value) =>
			value.availability === 'available'
				? value.value !== null
				: value.value === null
		)
export const toolDetailData = z
	.object({
		family: toolFamilySchema,
		provider: toolProviderSchema,
		version: toolToken,
		billingCurrency: toolCurrencySchema,
		familyState: toolFamilyStateSchema,
		configuration: toolProviderSummarySchema,
		settings: z
			.object({ region: setting(64), bizType: setting(255) })
			.nullable(),
		capabilities: toolCapabilitiesSchema,
	})
	.refine(
		(value) =>
			value.familyState.family === value.family &&
			value.version === value.familyState.version &&
			value.configuration.provider === value.provider &&
			validToolConfiguration(value.family, value.configuration) &&
			(value.family === 'ai-detection'
				? value.settings !== null
				: value.settings === null)
	)
export const toolOverviewSchema = z.object({
	success: z.literal(true),
	data: toolOverviewData,
})
export const toolDetailSchema = z.object({
	success: z.literal(true),
	data: toolDetailData,
})
export type ToolOverview = z.infer<typeof toolOverviewData>
export type ToolFamilySummary = ToolOverview['families'][number]
export type ToolDetail = z.infer<typeof toolDetailData>
