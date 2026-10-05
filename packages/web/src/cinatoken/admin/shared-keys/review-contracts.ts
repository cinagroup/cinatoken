/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { requestLogIdSchema } from '../request-logs/request-log-target'
import { adminSharedKeyCountSchema } from './shared-key-contracts'

export const adminEarningReviewSinceSchema = z
	.string()
	.max(24)
	.refine((value) => {
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value))
			return false
		const milliseconds = Date.parse(value)
		return (
			Number.isFinite(milliseconds) &&
			new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19)
		)
	})
	.transform((value) => new Date(value).toISOString())
export const adminEarningReviewInputSchema = z
	.object({
		since: adminEarningReviewSinceSchema,
		limit: z.number().int().min(1).max(1000),
	})
	.strict()
export type AdminEarningReviewInput = z.input<
	typeof adminEarningReviewInputSchema
>
const dataSchema = z
	.object({
		windowSince: adminEarningReviewSinceSchema,
		scanned: adminSharedKeyCountSchema.max(1000),
		windowTotal: adminSharedKeyCountSchema,
		scanComplete: z.boolean(),
		candidates: adminSharedKeyCountSchema.max(1000),
		reviewRequired: adminSharedKeyCountSchema.max(1000),
		candidateLogIds: z.array(requestLogIdSchema).max(1000),
		reviewOnly: z.literal(true),
		balancesChanged: z.literal(false),
		queued: z.literal(false),
		range: z
			.object({
				since: adminEarningReviewSinceSchema,
				limit: z.number().int().min(1).max(1000),
				page: z.literal(1),
			})
			.strict(),
		reviewScope: z.literal('first_page_since'),
		evidenceRequirement: z.literal('original_price_commission_owner'),
	})
	.refine(
		(value) =>
			value.windowSince === value.range.since &&
			value.scanned <= value.range.limit &&
			value.scanned <= value.windowTotal &&
			value.candidates <= value.scanned &&
			value.reviewRequired === value.candidates &&
			value.candidateLogIds.length === value.candidates &&
			new Set(value.candidateLogIds).size === value.candidateLogIds.length &&
			value.scanComplete === (value.windowTotal === value.scanned)
	)
export const adminEarningReviewResponseSchema = z.discriminatedUnion(
	'success',
	[
		z.object({
			success: z.literal(true),
			dryRun: z.boolean(),
			data: dataSchema,
		}),
		z.object({
			success: z.literal(false),
			dryRun: z.literal(false),
			code: z.enum([
				'historical_earning_evidence_required',
				'historical_earning_scan_incomplete',
			]),
			data: dataSchema,
		}),
	]
)
export type AdminEarningReviewResult = z.infer<
	typeof adminEarningReviewResponseSchema
>
