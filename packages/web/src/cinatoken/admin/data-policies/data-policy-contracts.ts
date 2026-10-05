/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const noControls = (value: string): boolean =>
	!Array.from(value).some((character) => {
		const code = character.charCodeAt(0)
		return code < 32 || code === 127
	})
const boundedText = (maximum: number, minimum = 0) =>
	z.string().min(minimum).max(maximum).refine(noControls)
const identifier = boundedText(600, 1).refine(
	(value) => value.trim() === value && value !== '.' && value !== '..'
)
const dateTime = boundedText(128, 1).refine((value) =>
	Number.isFinite(Date.parse(value))
)
const nullableDateTime = dateTime.nullable()
const fingerprint = boundedText(128).nullable()
const nullableReason = boundedText(2_000).nullable()

export const dataPolicyRouteTargetIdSchema = identifier
export const dataPolicyStatusSchema = z.enum(['verified', 'expired', 'unknown'])
export type DataPolicyStatus = z.infer<typeof dataPolicyStatusSchema>

function credentialFreeHttps(value: string): boolean {
	try {
		const url = new URL(value.trim())
		return url.protocol === 'https:' && !url.username && !url.password
	} catch {
		return false
	}
}

// Evidence URLs and historical retention values are unbounded in D1/Postgres;
// only new writes have a retention cap. Keep reads available for older rows.
const evidenceUrl = z
	.string()
	.min(1)
	.refine(noControls)
	.refine(credentialFreeHttps)
	.nullable()
const storedRetentionDays = z.number().int().min(0).nullable()

const policyFields = z.object({
	route_target_id: identifier,
	subject_fingerprint: fingerprint,
	retention_days: storedRetentionDays,
	training_allowed: z.boolean(),
	zdr_supported: z.boolean(),
	evidence_url: evidenceUrl,
	verified_by: identifier.nullable(),
	verified_at: nullableDateTime,
	expires_at: nullableDateTime,
	status: dataPolicyStatusSchema,
	invalidated_at: nullableDateTime,
	invalidation_reason: nullableReason,
	updated_at: dateTime,
	subject_matches_current: z.boolean(),
	effective_status: dataPolicyStatusSchema,
})
function verifiedProjectionIsConsistent(row: {
	status: DataPolicyStatus
	effective_status: DataPolicyStatus
	subject_fingerprint: string | null
	subject_matches_current: boolean
}): boolean {
	return (
		row.effective_status !== 'verified' ||
		(row.status === 'verified' &&
			row.subject_matches_current &&
			row.subject_fingerprint !== null)
	)
}

export const dataPolicyListRowSchema = policyFields
	.extend({
		// Older servers remain readable; writing requires both explicit hashes.
		current_subject_fingerprint: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.nullable()
			.optional(),
		current_policy_fingerprint: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.nullable()
			.optional(),
		model_id: identifier,
		provider_id: identifier,
		provider_name: boundedText(2_000),
		provider_model_name: boundedText(2_000),
		upstream_protocol: boundedText(128),
		upstream_operation: boundedText(256).nullable(),
		route_group: boundedText(2_000).nullable(),
	})
	.refine(verifiedProjectionIsConsistent)
export type DataPolicyListRow = z.infer<typeof dataPolicyListRowSchema>

export const dataPolicyListResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(dataPolicyListRowSchema),
	canWrite: z.boolean().optional(),
})
/** PUT returns policy fields with blank JOIN labels; callers must reload the list. */
export const dataPolicyUpsertResponseSchema = z.object({
	success: z.literal(true),
	data: policyFields.refine(verifiedProjectionIsConsistent),
})

const policyV2SnapshotSchema = z.object({
	v: z.literal(2),
	route_target_id: identifier,
	subject_fingerprint: fingerprint,
	retention_days: storedRetentionDays,
	training_allowed: z.boolean(),
	zdr_supported: z.boolean(),
	evidence_url: evidenceUrl,
	verified_by: identifier.nullable(),
	verified_at: nullableDateTime,
	expires_at: nullableDateTime,
	status: dataPolicyStatusSchema,
	invalidated_at: nullableDateTime,
	invalidation_reason: nullableReason,
})
const invalidationV2SnapshotSchema = z.object({
	v: z.literal(2),
	event: z.literal('invalidated'),
	reason: boundedText(2_000),
	previous_status: dataPolicyStatusSchema,
	subject_fingerprint: fingerprint,
})
export type DataPolicyAuditSnapshot =
	| z.infer<typeof policyV2SnapshotSchema>
	| z.infer<typeof invalidationV2SnapshotSchema>
	| null

/** Historical audit JSON is untrusted; only known Core v2 fields leave the API layer. */
export const dataPolicyAuditSnapshotSchema = z
	.unknown()
	.transform((value): DataPolicyAuditSnapshot => {
		const invalidation = invalidationV2SnapshotSchema.safeParse(value)
		if (invalidation.success) return invalidation.data
		const policy = policyV2SnapshotSchema.safeParse(value)
		return policy.success ? policy.data : null
	})
export const dataPolicyAuditRowSchema = z.object({
	id: identifier,
	route_target_id: identifier.nullable(),
	actor_id: identifier,
	created_at: dateTime,
	snapshot: dataPolicyAuditSnapshotSchema,
})
export type DataPolicyAudit = z.infer<typeof dataPolicyAuditRowSchema>
export const dataPolicyAuditResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(dataPolicyAuditRowSchema),
})

const evidenceUrlInput = z
	.string()
	.min(1)
	.refine(noControls)
	.refine(credentialFreeHttps)
	.transform((value) => new URL(value.trim()).toString())
	.nullable()
const expiryInput = dateTime
	.transform((value) => new Date(value).toISOString())
	.nullable()
export const dataPolicyUpsertInputSchema = z
	.object({
		status: dataPolicyStatusSchema,
		retention_days: z.number().int().min(0).max(36_500).nullable(),
		training_allowed: z.boolean(),
		zdr_supported: z.boolean(),
		evidence_url: evidenceUrlInput,
		expires_at: expiryInput,
	})
	.strict()
	.superRefine((value, context) => {
		if (value.status !== 'verified') return
		if (
			!value.evidence_url ||
			!value.expires_at ||
			Date.parse(value.expires_at) <= Date.now()
		) {
			context.addIssue({
				code: 'custom',
				message: 'Verified policy requires evidence and a future expiry',
			})
		}
	})
export type DataPolicyUpsertInput = z.input<typeof dataPolicyUpsertInputSchema>
