/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const filter = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.refine((value) => !/\p{Cc}/u.test(value))
		.default('')
export const gatewayKeySearchSchema = z.object({
	page: z.coerce.number().int().min(1).max(1_000_000).catch(1),
	email: filter(320),
	user_id: filter(600).refine((value) => !/[\s/?#\\]/u.test(value)),
	sort: z
		.enum(['created_at', 'budget_spent', 'budget_reset_at'])
		.catch('created_at'),
	order: z.enum(['asc', 'desc']).catch('desc'),
})
export type GatewayKeySearch = z.infer<typeof gatewayKeySearchSchema>
export function validateGatewayKeySearch(value: unknown): GatewayKeySearch {
	return gatewayKeySearchSchema.parse(value)
}
export function validateGatewayKeyRouteSearch(
	value: unknown
): GatewayKeySearch & { invalidFilter?: true } {
	try {
		return validateGatewayKeySearch(value)
	} catch {
		return { ...validateGatewayKeySearch({}), invalidFilter: true }
	}
}
export function gatewayKeysListPath(search: GatewayKeySearch): string {
	const params = new URLSearchParams({
		page: String(search.page),
		page_size: '20',
		sort: search.sort,
		order: search.order,
	})
	if (search.email) params.set('email', search.email)
	if (search.user_id) params.set('user_id', search.user_id)
	return '/api/admin/keys?' + params.toString()
}
