/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const noControls = (value: string): boolean =>
	!Array.from(value).some((character) => {
		const code = character.charCodeAt(0)
		return code < 32 || code === 127
	})

export const adminPresetIdSchema = z
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

const readText = z.string().max(10_000)
const versionNumber = z.number().int().safe().positive()

/** Explicit server summary only. Legacy systemPrompt/config fields are discarded. */
export const adminPresetSummarySchema = z
	.object({
		id: adminPresetIdSchema,
		workspaceId: adminPresetIdSchema,
		ownerUserId: adminPresetIdSchema,
		slug: z.string().min(1).max(600),
		name: z.string().min(1).max(10_000),
		description: readText.nullable(),
		visibility: z.enum(['private', 'public']),
		status: z.enum(['active', 'archived']),
		designatedVersion: versionNumber,
		latestVersion: versionNumber,
	})
	.refine((value) => value.designatedVersion <= value.latestVersion)
export type AdminPresetSummary = z.infer<typeof adminPresetSummarySchema>

export const adminPresetVersionSummarySchema = z.object({
	id: adminPresetIdSchema,
	version: versionNumber,
	createdAt: z.string().min(1).max(128),
	model: z.string().min(1).max(600).nullable(),
})
export type AdminPresetVersionSummary = z.infer<
	typeof adminPresetVersionSummarySchema
>

export const adminPresetSummariesResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(adminPresetSummarySchema),
	count: z.number().int().safe().nonnegative(),
})
export const adminPresetVersionSummariesResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		presetId: adminPresetIdSchema,
		versions: z.array(adminPresetVersionSummarySchema),
		total: z.number().int().safe().nonnegative(),
	}),
})
export const adminPresetSummaryResponseSchema = z.object({
	success: z.literal(true),
	data: adminPresetSummarySchema,
})

/** Admin writes may change metadata only; owner, slug and version content are immutable here. */
export const adminPresetMetadataPatchSchema = z
	.object({
		name: z.string().trim().min(1).max(128).optional(),
		description: z
			.union([z.string().trim().max(1024), z.null()])
			.transform((value) => value || null)
			.optional(),
		visibility: z.enum(['private', 'public']).optional(),
		status: z.enum(['active', 'archived']).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0)
export type AdminPresetMetadataPatch = z.input<
	typeof adminPresetMetadataPatchSchema
>
export const adminPresetDesignationSchema = versionNumber
