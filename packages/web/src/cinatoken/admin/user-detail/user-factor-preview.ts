/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { parsePricingProfile } from '@octafuse/core/db/pricing-profile'
import {
	type AdminDomainRequestOptions,
	ADMIN_DOMAIN_SUBJECT_HEADER,
	createAdminDomainTransport,
} from '../domain-transport'
import type { UserDetailTransport } from './user-detail-api'
import { userDetailPath } from './user-detail-domain'

const text = z.string()
const number = z.number().finite().nonnegative()
const window = z.object({
	start: text.optional(),
	end: text.optional(),
	days: z.array(z.number().int().min(1).max(7)).optional(),
	catalog_factor: number,
	route_factor: number,
	composite_factor: number,
})
export const userDisplayDiscountSchema = z.object({
	timezone: text,
	kind: z.enum(['flat', 'schedule']),
	schedule_mode: z.enum(['multiply', 'override']),
	route: z.object({ priority: z.number().finite(), weight: number }),
	current: window,
	windows: z.array(window),
	provider_factor: z
		.object({
			base: number,
			effective: number,
			active: z.boolean(),
			starts_at: text.nullable(),
			expires_at: text.nullable(),
		})
		.nullable(),
})
const pricing = z.unknown().transform((raw, context) => {
	if (raw === null) return null
	const parsed = parsePricingProfile(JSON.stringify(raw))
	if (!parsed) {
		context.addIssue({ code: 'custom', message: 'Invalid pricing profile' })
		return z.NEVER
	}
	return parsed
})
const discounts = z.record(text, userDisplayDiscountSchema)
export const userModelPreviewSchema = z
	.object({
		object: z.literal('list'),
		data: z
			.array(
				z.object({
					id: text.min(1),
					object: z.literal('model'),
					owned_by: z.literal('octafuse'),
					model_info: z.object({
						display_name: text.nullable(),
						vendor: text,
						tags: z.array(text),
						route_groups: z.array(text),
						discounts,
						pricing_profile: pricing,
						context_window: number.nullable(),
						max_tokens: number.nullable(),
						input_price: z.number().finite().nullable(),
						output_price: z.number().finite().nullable(),
						input_modalities: z.array(text).nullable(),
						output_modalities: z.array(text).nullable(),
						description: text.nullable(),
						released_at: text.nullable(),
					}),
				})
			)
			.max(40),
		preview: z.object({
			user_charged_factor_mode: z.enum(['multiply', 'min']),
			route_groups: z.array(text),
			kind: z.enum(['llm', 'image', 'audio', 'all']),
			model: text.nullable(),
			truncated: z.boolean(),
			limit: z.literal(40),
		}),
	})
	.superRefine((value, context) => {
		if (new Set(value.data.map((row) => row.id)).size !== value.data.length)
			context.addIssue({ code: 'custom', message: 'Duplicate models' })
	})
export type UserModelPreview = z.infer<typeof userModelPreviewSchema>
export type UserModelPreviewFilters = {
	model: string
	routeGroups: string
	kind: 'llm' | 'image' | 'audio' | 'all'
}
export const defaultUserModelPreviewFilters: UserModelPreviewFilters = {
	model: '',
	routeGroups: 'default,free',
	kind: 'llm',
}
/** Display factors without binary floating-point noise; keep tiny nonzero values visible. */
export function formatUserModelPreviewFactor(
	value: number,
	locale?: string
): string {
	const magnitude = Math.abs(value)
	return new Intl.NumberFormat(locale, {
		maximumSignificantDigits: 15,
		notation:
			magnitude !== 0 && (magnitude < 0.000001 || magnitude >= 1e15)
				? 'scientific'
				: 'standard',
	}).format(value)
}
export function userModelPreviewQuery(
	filters: UserModelPreviewFilters
): URLSearchParams {
	const kind = z.enum(['llm', 'image', 'audio', 'all']).parse(filters.kind)
	const groups = [
		...new Set(
			filters.routeGroups
				.split(',')
				.map((value) => value.trim().toLowerCase())
				.filter(Boolean)
		),
	]
	const result = new URLSearchParams({ route_groups: groups.join(','), kind })
	if (filters.model.trim()) result.set('model', filters.model.trim())
	return result
}
export function createUserFactorReadApi(transport: UserDetailTransport) {
	const verify = createAdminDomainTransport(
		transport,
		'models'
	).verifyAdminDomainSubject
	async function read<T>(
		path: string,
		schema: z.ZodType<T>,
		options: AdminDomainRequestOptions
	): Promise<T> {
		try {
			const subject = await verify(options)
			options.signal?.throwIfAborted()
			return await transport.send(
				path,
				schema,
				{ headers: { [ADMIN_DOMAIN_SUBJECT_HEADER]: subject } },
				options
			)
		} catch (error) {
			throw transport.sanitizeError(error)
		}
	}
	return {
		verifyUserFactorSubject: verify,
		async userModelPricePreview(
			id: string,
			filters: UserModelPreviewFilters,
			options: AdminDomainRequestOptions = {}
		): Promise<UserModelPreview> {
			const query = userModelPreviewQuery(filters)
			const result = await read(
				userDetailPath(id) + '/models?' + query,
				z.object({ success: z.literal(true), data: userModelPreviewSchema }),
				options
			)
			const expectedGroups =
				query.get('route_groups')?.split(',').filter(Boolean) ?? []
			if (
				result.data.preview.kind !== filters.kind ||
				result.data.preview.model !==
					(filters.model.trim().toLowerCase() || null) ||
				JSON.stringify(result.data.preview.route_groups) !==
					JSON.stringify(
						expectedGroups.length ? expectedGroups : ['default', 'free']
					)
			)
				transport.invalidResponse('Preview filters differ')
			return result.data
		},
		async userFactorGroups(
			options: AdminDomainRequestOptions = {}
		): Promise<Map<string, string[]>> {
			const result = await read(
				'/api/admin/routes',
				z.object({
					success: z.literal(true),
					data: z.array(
						z.object({ model_id: text.min(1), route_group: text.nullable() })
					),
				}),
				options
			)
			const groups = new Map<string, Set<string>>()
			for (const row of result.data) {
				const values = groups.get(row.model_id) ?? new Set<string>()
				values.add(row.route_group?.trim().toLowerCase() || 'default')
				groups.set(row.model_id, values)
			}
			return new Map(
				[...groups].map(([id, values]) => [id, [...values].sort()])
			)
		},
	}
}
