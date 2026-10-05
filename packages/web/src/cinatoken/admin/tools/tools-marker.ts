/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { toolFamilies, validToolTarget } from './tools-domain'

export const toolMarkerSchema = z
	.object({
		version: z.literal(2),
		generation: z.string().uuid(),
		family: z.enum(toolFamilies),
		provider: z.string().max(32),
		operation: z.enum(['save', 'save_activate', 'reveal']),
	})
	.strict()
	.refine((marker) => validToolTarget(marker.family, marker.provider))
export type ToolMarker = z.infer<typeof toolMarkerSchema>
export type ToolMarkerInput = Omit<ToolMarker, 'version' | 'generation'>
export const toolJournalSchema = z
	.object({
		version: z.literal(1),
		phase: z.enum(['pending', 'clearing', 'cleared']),
		marker: toolMarkerSchema,
	})
	.strict()
export type ToolJournal = z.infer<typeof toolJournalSchema>
export function parseToolMarker(raw: string | null): ToolMarker | null {
	if (raw === null || raw.length > 512) return null
	try {
		const parsed = toolMarkerSchema.safeParse(JSON.parse(raw))
		return parsed.success && JSON.stringify(parsed.data) === raw
			? parsed.data
			: null
	} catch {
		return null
	}
}
export function parseToolJournal(raw: string | null): ToolJournal | null {
	if (raw === null || raw.length > 640) return null
	try {
		const parsed = toolJournalSchema.safeParse(JSON.parse(raw))
		return parsed.success && JSON.stringify(parsed.data) === raw
			? parsed.data
			: null
	} catch {
		return null
	}
}
