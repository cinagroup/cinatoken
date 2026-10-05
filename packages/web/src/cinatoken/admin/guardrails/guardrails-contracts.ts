/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const noControls = (value: string): boolean =>
	!Array.from(value).some((character) => {
		const code = character.charCodeAt(0)
		return code < 32 || code === 127
	})

export const adminGuardrailIdSchema = z
	.string()
	.min(1)
	.max(600)
	.refine(
		(value) =>
			value !== '.' &&
			value !== '..' &&
			value.trim() === value &&
			noControls(value)
	)

const versionNumber = z.number().int().safe().positive()

/** Explicit metadata projection. Raw version config is never retained in the Web SDK. */
export const adminGuardrailSummarySchema = z
	.object({
		id: adminGuardrailIdSchema,
		workspaceId: adminGuardrailIdSchema,
		ownerUserId: adminGuardrailIdSchema,
		name: z.string().min(1).max(10_000),
		description: z.string().max(10_000).nullable(),
		status: z.enum(['active', 'archived']),
		isWorkspaceDefault: z.boolean(),
		isAccountDefault: z.boolean(),
		accountScopeKey: z.string().max(600).nullable(),
		designatedVersion: versionNumber,
		latestVersion: versionNumber,
	})
	.refine((value) => value.designatedVersion <= value.latestVersion)
export type AdminGuardrailSummary = z.infer<typeof adminGuardrailSummarySchema>

export const adminGuardrailVersionSummarySchema = z.object({
	id: adminGuardrailIdSchema,
	version: versionNumber,
	createdAt: z.string().min(1).max(128),
})
export type AdminGuardrailVersionSummary = z.infer<
	typeof adminGuardrailVersionSummarySchema
>

export const adminGuardrailSummariesResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(adminGuardrailSummarySchema),
	count: z.number().int().safe().nonnegative(),
	canWrite: z.boolean(),
})
export type AdminGuardrailList = {
	rows: AdminGuardrailSummary[]
	canWrite: boolean
}
export const adminGuardrailVersionSummariesResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		guardrailId: adminGuardrailIdSchema,
		versions: z.array(adminGuardrailVersionSummarySchema),
		total: z.number().int().safe().nonnegative(),
	}),
})
export const adminGuardrailSummaryResponseSchema = z.object({
	success: z.literal(true),
	data: adminGuardrailSummarySchema,
})

export const adminGuardrailAssignmentSchema = z.object({
	id: adminGuardrailIdSchema,
	workspaceId: adminGuardrailIdSchema,
	guardrailId: adminGuardrailIdSchema,
	guardrailName: z.string().max(10_000).nullable().optional(),
	scopeType: z.enum(['user', 'api_key']),
	scopeId: adminGuardrailIdSchema,
	createdByUserId: adminGuardrailIdSchema.nullable().optional(),
	createdAt: z.string().min(1).max(128),
})
export type AdminGuardrailAssignment = z.infer<
	typeof adminGuardrailAssignmentSchema
>
export type AdminGuardrailScopeType = AdminGuardrailAssignment['scopeType']

export const adminGuardrailAssignmentsResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(adminGuardrailAssignmentSchema),
})
export const adminGuardrailAssignmentResponseSchema = z.object({
	success: z.literal(true),
	data: adminGuardrailAssignmentSchema,
})
export const adminGuardrailDeleteAssignmentResponseSchema = z.object({
	success: z.literal(true),
	removed: z.boolean(),
})

export const adminGuardrailStatusSchema = z.enum(['active', 'archived'])
export const adminGuardrailDesignationSchema = versionNumber
export const adminGuardrailScopeSchema = z.object({
	scopeType: z.enum(['user', 'api_key']),
	scopeId: adminGuardrailIdSchema,
})
