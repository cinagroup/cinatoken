/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import type {
	ProviderAdminTransport,
	ProviderRequestOptions,
} from '../provider-api'
import { providerIdentitySchema } from '../provider-contracts'
import { PROVIDER_PROTOCOLS } from '../provider-endpoints'

const text = z.string().max(4096)
const count = z.number().int().nonnegative().safe()
const status = z.enum(['added', 'changed', 'removed'])
const fieldKey = z.enum([
	'description',
	...PROVIDER_PROTOCOLS.map((p) => `endpoints.${p}` as const),
])
export const providerKindSchema = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
const choice = z.object({
	kind: providerKindSchema,
	label_en: text,
	label_zh: text,
	vendor_key: text,
	icon_key: text,
})
/** Diff reads must not put URL credentials in the ordinary Query cache. Only keys are written back. */
const endpointValue = z
	.string()
	.nullable()
	.transform((value) => {
		if (value !== null && value.length > 16384) return '[redacted]'
		if (value === null || value === 'bearer' || value === 'query-key')
			return value
		try {
			const url = new URL(
				value.replace(/\{(?:model|action|task_id)\}/gu, 'placeholder')
			)
			if (
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				/sk-[\w-]{8,}/u.test(url.pathname)
			)
				return '[redacted]'
			return value
		} catch {
			return '[redacted]'
		}
	})
const descriptionField = z.object({
	key: z.literal('description'),
	status,
	current: z
		.string()
		.transform((value) =>
			value.length > 16384 ? value.slice(0, 16384) + '…' : value
		)
		.nullable(),
	official: z
		.string()
		.transform((value) =>
			value.length > 16384 ? value.slice(0, 16384) + '…' : value
		)
		.nullable(),
	default_apply: z.boolean(),
})
const endpointField = z
	.object({
		key: fieldKey.exclude(['description']),
		protocol: z.enum(PROVIDER_PROTOCOLS),
		status,
		rows: z
			.array(
				z.object({
					slot: text,
					status,
					current: endpointValue,
					official: endpointValue,
				})
			)
			.min(1)
			.max(100),
		default_apply: z.boolean(),
	})
	.refine((field) => field.key === `endpoints.${field.protocol}`)
export const providerSyncFieldSchema = z.union([
	descriptionField,
	endpointField,
])
const entry = z
	.object({
		provider_id: providerIdentitySchema,
		provider_name: text,
		status: z.enum(['active', 'disabled']),
		routes_count: count,
		active_routes_count: count,
		fields: z.array(providerSyncFieldSchema).min(1).max(7),
	})
	.refine(
		(value) =>
			value.active_routes_count <= value.routes_count &&
			new Set(value.fields.map((f) => f.key)).size === value.fields.length
	)
export const providerSyncReportSchema = z
	.object({
		groups: z.array(choice.extend({ providers: z.array(entry).min(1) })),
		orphans: z.array(
			z.object({
				provider_id: providerIdentitySchema,
				provider_name: text,
				kind: text,
				routes_count: count,
				suggested_kind: providerKindSchema.nullable(),
			})
		),
		kind_choices: z.array(choice),
		providers_with_diff: count,
	})
	.refine((report) => {
		const ids = report.groups.flatMap((group) =>
				group.providers.map((p) => p.provider_id)
			),
			all = [...ids, ...report.orphans.map((p) => p.provider_id)]
		return (
			ids.length === report.providers_with_diff &&
			new Set(all).size === all.length &&
			new Set(report.groups.map((g) => g.kind)).size === report.groups.length &&
			new Set(report.kind_choices.map((c) => c.kind)).size ===
				report.kind_choices.length
		)
	})
export type ProviderSyncReport = z.infer<typeof providerSyncReportSchema>
export type ProviderSyncField = z.infer<typeof providerSyncFieldSchema>
export const providerSyncItemsSchema = z
	.array(
		z
			.object({
				provider_id: providerIdentitySchema,
				fields: z
					.array(fieldKey)
					.min(1)
					.max(7)
					.refine((keys) => new Set(keys).size === keys.length),
			})
			.strict()
	)
	.min(1)
	.max(1000)
	.refine(
		(items) => new Set(items.map((i) => i.provider_id)).size === items.length
	)
export type ProviderSyncItems = z.infer<typeof providerSyncItemsSchema>
const resultSchema = z.object({
	updated: count,
	skipped: count,
	failed: z.array(
		z.object({
			provider_id: providerIdentitySchema,
			message: text.transform(() => 'Provider sync failed'),
		})
	),
})
export type ProviderSyncResult = z.infer<typeof resultSchema>
const finite = z.number().finite()
const instant = z
	.string()
	.max(128)
	.refine((value) => !Number.isNaN(Date.parse(value)))
export const providerQuotaSchema = z
	.object({
		adapter: z.string().min(1).max(255),
		checkedAt: instant,
		state: z.enum(['ok', 'low', 'exhausted', 'unknown']),
		balances: z
			.array(
				z.object({
					currency: z.string().min(1).max(20),
					total: finite,
					granted: finite.optional(),
					paid: finite.optional(),
				})
			)
			.max(100),
		windows: z
			.array(
				z.object({
					id: z.string().min(1).max(255),
					unit: z.enum(['tokens', 'requests', 'currency', 'percent']),
					used: finite.optional(),
					limit: finite.optional(),
					remaining: finite.optional(),
					usedPercent: finite.nonnegative().optional(),
					resetsAt: instant.nullable().optional(),
				})
			)
			.max(100),
	})
	.refine(
		(value) =>
			new Set(value.windows.map((w) => w.id)).size === value.windows.length
	)
export type ProviderQuota = z.infer<typeof providerQuotaSchema>
export function createProviderCompatibilityApi(
	transport: Pick<ProviderAdminTransport, 'send'>
) {
	return {
		async providerSyncReport(options: ProviderRequestOptions = {}) {
			return (
				await transport.send(
					'/api/admin/providers/sync/diff',
					z.object({
						success: z.literal(true),
						data: providerSyncReportSchema,
					}),
					{},
					options
				)
			).data
		},
		async applyProviderSync(
			input: ProviderSyncItems,
			options: ProviderRequestOptions = {}
		) {
			const items = providerSyncItemsSchema.parse(input),
				ids = new Set(items.map((i) => i.provider_id))
			const response = z
				.object({ success: z.literal(true), data: resultSchema })
				.refine(
					({ data }) =>
						data.updated + data.skipped + data.failed.length === items.length &&
						new Set(data.failed.map((f) => f.provider_id)).size ===
							data.failed.length &&
						data.failed.every((f) => ids.has(f.provider_id))
				)
			return (
				await transport.send(
					'/api/admin/providers/sync/apply',
					response,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ items }),
					},
					options
				)
			).data
		},
		async providerQuota(id: string, options: ProviderRequestOptions = {}) {
			return (
				await transport.send(
					'/api/admin/providers/' +
						encodeURIComponent(providerIdentitySchema.parse(id)) +
						'/quota',
					z.object({ success: z.literal(true), data: providerQuotaSchema }),
					{},
					options
				)
			).data
		},
	}
}
