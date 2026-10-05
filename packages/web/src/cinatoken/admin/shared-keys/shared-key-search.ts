/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	sharedKeyChannelSchema,
	sharedKeyStatusSchema,
} from '../../shared-key-contracts'
import { adminSharedKeyOwnerIdSchema } from './shared-key-contracts'

const filter = (max: number) =>
	z
		.string()
		.max(max)
		.refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
		.trim()
		.default('')
export const adminSharedKeySearchSchema = z
	.object({
		page: z.coerce.number().int().min(1).max(1_000_000).default(1),
		status: z.union([sharedKeyStatusSchema, z.literal('')]).default(''),
		channelType: z.union([sharedKeyChannelSchema, z.literal('')]).default(''),
		seller_user_id: z
			.union([adminSharedKeyOwnerIdSchema, z.literal('')])
			.default(''),
		search: filter(200),
	})
	.strict()
export type AdminSharedKeySearch = z.infer<typeof adminSharedKeySearchSchema>
export function validateAdminSharedKeySearch(
	value: unknown
): AdminSharedKeySearch {
	return adminSharedKeySearchSchema.parse(value)
}
export function validateAdminSharedKeyRouteSearch(
	value: unknown
): AdminSharedKeySearch & { invalidFilter?: true } {
	try {
		return validateAdminSharedKeySearch(value)
	} catch {
		return { ...validateAdminSharedKeySearch({}), invalidFilter: true }
	}
}
export function adminSharedKeyListPath(search: AdminSharedKeySearch): string {
	const checked = validateAdminSharedKeySearch(search)
	const params = new URLSearchParams({
		page: String(checked.page),
		page_size: '20',
	})
	for (const field of [
		'status',
		'channelType',
		'seller_user_id',
		'search',
	] as const)
		if (checked[field]) params.set(field, checked[field])
	return '/api/admin/shared-keys/overview?' + params.toString()
}
