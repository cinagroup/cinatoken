/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { adminEarningReviewInputSchema } from './review-contracts'
import { adminSharedKeyIdSchema } from './shared-key-contracts'

const generation = z.string().uuid()
const governance = z
	.object({
		version: z.literal(2),
		kind: z.literal('governance'),
		generation,
		keyId: adminSharedKeyIdSchema,
		operation: z.enum(['edit', 'disable', 'restore', 'delete']),
	})
	.strict()
const review = adminEarningReviewInputSchema
	.extend({
		version: z.literal(2),
		kind: z.literal('review'),
		generation,
		operation: z.literal('apply-review'),
	})
	.strict()
export const adminSharedKeyMarkerSchema = z.discriminatedUnion('kind', [
	governance,
	review,
])
export type AdminSharedKeyMarker = z.infer<typeof adminSharedKeyMarkerSchema>
export type AdminSharedKeyGovernanceMarker = z.infer<typeof governance>
export type AdminSharedKeyReviewMarker = z.infer<typeof review>
export type AdminSharedKeyMarkerInput =
	| {
			kind: 'governance'
			keyId: string
			operation: AdminSharedKeyGovernanceMarker['operation']
	  }
	| { kind: 'review'; since: string; limit: number; operation: 'apply-review' }
export const adminSharedKeyJournalSchema = z
	.object({
		version: z.literal(1),
		phase: z.enum(['pending', 'clearing', 'cleared']),
		marker: adminSharedKeyMarkerSchema,
	})
	.strict()
export type AdminSharedKeyJournal = z.infer<typeof adminSharedKeyJournalSchema>
export function parseSharedKeyJournal(
	raw: string | null
): AdminSharedKeyJournal | null {
	if (raw === null || raw.length > 1200) return null
	try {
		const parsed = adminSharedKeyJournalSchema.safeParse(JSON.parse(raw))
		if (parsed.success && JSON.stringify(parsed.data) === raw)
			return parsed.data
	} catch {
		/* Invalid journals remain locked. */
	}
	return null
}
export function parseSharedKeyMarker(
	raw: string | null
): AdminSharedKeyMarker | null {
	if (raw === null || raw.length > 1024) return null
	try {
		const parsed = adminSharedKeyMarkerSchema.safeParse(JSON.parse(raw))
		if (parsed.success && JSON.stringify(parsed.data) === raw)
			return parsed.data
	} catch {
		// Legacy and malformed markers remain locked; they are never migrated.
	}
	return null
}
