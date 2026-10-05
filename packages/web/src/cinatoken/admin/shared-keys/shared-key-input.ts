/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { AdminSharedKeyInputError } from './shared-key-errors'

export const adminSharedKeyRevisionSchema = z
	.string()
	.regex(/^sha256:[0-9a-f]{64}$/u)
export const adminSharedKeyPrioritySchema = z
	.number()
	.int()
	.min(-2_147_483_648)
	.max(2_147_483_647)
export const adminSharedKeyReasonSchema = z
	.string()
	.refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
	.trim()
	.min(1)
	.max(600)
export const adminSharedKeyConfirmationSchema = z.object({
	reason: adminSharedKeyReasonSchema,
	reviewed: z.boolean().refine((value) => value),
})
export const adminSharedKeyEditSchema = z.object({
	sellerPriority: adminSharedKeyPrioritySchema,
	weight: z.number().int().min(1).max(100),
	reason: adminSharedKeyReasonSchema,
	reviewed: z.boolean().refine((value) => value),
})
export type AdminSharedKeyEditForm = z.input<typeof adminSharedKeyEditSchema>
export type AdminSharedKeyConfirmationForm = z.input<
	typeof adminSharedKeyConfirmationSchema
>
export type AdminSharedKeyProfile = {
	sellerPriority: number
	weight: number
	status: string
	profile_revision: string
}
export type AdminSharedKeyPatch = {
	expected_revision: string
	reason: string
	sellerPriority?: number
	weight?: number
	status?: 'disabled' | 'paused'
}
export const adminSharedKeyPatchSchema = z
	.object({
		expected_revision: adminSharedKeyRevisionSchema,
		reason: adminSharedKeyReasonSchema,
		sellerPriority: adminSharedKeyPrioritySchema.optional(),
		weight: z.number().int().min(1).max(100).optional(),
		status: z.enum(['disabled', 'paused']).optional(),
	})
	.strict()
	.refine(
		(value) =>
			value.sellerPriority !== undefined ||
			value.weight !== undefined ||
			value.status !== undefined
	)
export const adminSharedKeyDeleteSchema = z
	.object({
		expected_revision: adminSharedKeyRevisionSchema,
		reason: adminSharedKeyReasonSchema,
	})
	.strict()
export function adminSharedKeyEditInput(
	row: AdminSharedKeyProfile,
	draft: AdminSharedKeyEditForm
): AdminSharedKeyPatch {
	const value = adminSharedKeyEditSchema.safeParse(draft)
	if (
		!value.success ||
		!adminSharedKeyRevisionSchema.safeParse(row.profile_revision).success
	)
		throw new AdminSharedKeyInputError()
	const input: AdminSharedKeyPatch = {
		expected_revision: row.profile_revision,
		reason: value.data.reason,
	}
	if (value.data.sellerPriority !== row.sellerPriority)
		input.sellerPriority = value.data.sellerPriority
	if (value.data.weight !== row.weight) input.weight = value.data.weight
	if (input.sellerPriority === undefined && input.weight === undefined)
		throw new AdminSharedKeyInputError()
	return input
}
export function adminSharedKeyConfirmationInput(
	row: AdminSharedKeyProfile,
	kind: 'disable' | 'restore' | 'delete',
	draft: AdminSharedKeyConfirmationForm
): AdminSharedKeyPatch {
	const value = adminSharedKeyConfirmationSchema.safeParse(draft)
	if (
		!value.success ||
		!adminSharedKeyRevisionSchema.safeParse(row.profile_revision).success
	)
		throw new AdminSharedKeyInputError()
	if (
		(kind === 'restore' && row.status !== 'disabled') ||
		(kind === 'disable' && row.status === 'disabled')
	)
		throw new AdminSharedKeyInputError()
	const input: AdminSharedKeyPatch = {
		expected_revision: row.profile_revision,
		reason: value.data.reason,
	}
	if (kind !== 'delete')
		input.status = kind === 'disable' ? 'disabled' : 'paused'
	return input
}
