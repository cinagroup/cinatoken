/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

export const userSortSchema = z.enum([
	'budget_spent',
	'budget_max',
	'budget_base',
	'budget_reset_at',
	'created_at',
])
export const userOrderSchema = z.enum(['asc', 'desc'])

export const usersSearchSchema = z.object({
	page: z.coerce.number().int().min(1).max(1_000_000).catch(1),
	email: z.string().trim().max(200).catch(''),
	external_system: z.string().trim().max(200).catch(''),
	external_user_id: z.string().trim().max(200).catch(''),
	status: z.enum(['all', 'active', 'disabled']).catch('all'),
	max_budget: z
		.enum(['all', 'positive', 'zero_or_negative', 'null'])
		.catch('all'),
	sort: userSortSchema.catch('created_at'),
	order: userOrderSchema.catch('desc'),
})
export type UsersSearch = z.infer<typeof usersSearchSchema>

export function validateUsersSearch(value: unknown): UsersSearch {
	return usersSearchSchema.parse(value)
}

export function usersListPath(search: UsersSearch): string {
	const params = new URLSearchParams({
		page: String(search.page),
		page_size: '20',
		sort: search.sort,
		order: search.order,
	})
	if (search.email) params.set('email', search.email)
	if (search.external_system)
		params.set('external_system', search.external_system)
	if (search.external_user_id)
		params.set('external_user_id', search.external_user_id)
	if (search.status !== 'all') params.set('status', search.status)
	if (search.max_budget !== 'all') params.set('max_budget', search.max_budget)
	return `/api/admin/users?${params.toString()}`
}
