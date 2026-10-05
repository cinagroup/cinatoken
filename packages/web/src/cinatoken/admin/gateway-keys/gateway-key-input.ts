/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	gatewayKeyRevisionSchema,
	gatewayKeyOwnerIdSchema,
	gatewayKeyStatusSchema,
	type GatewayKeyDetail,
} from './gateway-key-contracts'
import {
	GatewayKeyInputError,
	parseGatewayKeyMetadata,
} from './gateway-key-metadata'

export {
	GatewayKeyInputError,
	parseGatewayKeyMetadata,
} from './gateway-key-metadata'
const text = z
	.string()
	.trim()
	.max(600)
	.refine((value) => !/\p{Cc}/u.test(value))
export const gatewayKeyCreateFormSchema = z
	.object({
		mode: z.enum(['existing', 'external']),
		userId: text,
		email: z.string().trim().max(320),
		externalSystem: text.max(255),
		externalUserId: text,
		name: text.max(255),
		metadata: z.string().max(65_536),
		reason: text.min(1),
	})
	.superRefine((draft, context) => {
		if (
			draft.mode === 'existing' &&
			!gatewayKeyOwnerIdSchema.safeParse(draft.userId).success
		)
			context.addIssue({
				code: 'custom',
				path: ['userId'],
				message: 'userIdRequired',
			})
		if (draft.mode === 'external') {
			for (const field of ['externalSystem', 'externalUserId'] as const)
				if (!draft[field] || /\s/u.test(draft[field]))
					context.addIssue({
						code: 'custom',
						path: [field],
						message: 'externalRequired',
					})
			if (!z.email().safeParse(draft.email).success)
				context.addIssue({
					code: 'custom',
					path: ['email'],
					message: 'emailRequired',
				})
		}
		try {
			parseGatewayKeyMetadata(draft.metadata)
		} catch {
			context.addIssue({
				code: 'custom',
				path: ['metadata'],
				message: 'metadataInvalid',
			})
		}
	})
export type GatewayKeyCreateForm = z.infer<typeof gatewayKeyCreateFormSchema>
export type GatewayKeyCreateInput = {
	user_id?: string
	external_system?: string
	external_user_id?: string
	email?: string
	name: string | null
	metadata: Record<string, unknown> | null
	reason: string
}
export function gatewayKeyCreateInput(
	draft: GatewayKeyCreateForm
): GatewayKeyCreateInput {
	const parsed = gatewayKeyCreateFormSchema.safeParse(draft)
	if (!parsed.success) throw new GatewayKeyInputError()
	const value = parsed.data
	return {
		name: value.name || null,
		metadata: parseGatewayKeyMetadata(value.metadata),
		reason: value.reason,
		...(value.mode === 'existing'
			? { user_id: value.userId }
			: {
					email: value.email,
					external_system: value.externalSystem,
					external_user_id: value.externalUserId,
				}),
	}
}
export const gatewayKeyEditFormSchema = z
	.object({
		name: text.max(255),
		status: gatewayKeyStatusSchema,
		statusConfirmed: z.boolean(),
		metadataMode: z.enum(['unchanged', 'merge', 'replace']),
		metadata: z.string().max(65_536),
		reason: text.min(1),
	})
	.superRefine((draft, context) => {
		if (draft.metadataMode === 'unchanged') return
		try {
			if (
				draft.metadataMode === 'merge' &&
				parseGatewayKeyMetadata(draft.metadata) === null
			)
				throw new GatewayKeyInputError()
			parseGatewayKeyMetadata(draft.metadata)
		} catch {
			context.addIssue({
				code: 'custom',
				path: ['metadata'],
				message: 'metadataInvalid',
			})
		}
	})
export type GatewayKeyEditForm = z.infer<typeof gatewayKeyEditFormSchema>
export type GatewayKeyPatch = {
	expected_revision: string
	name?: string | null
	status?: 'active' | 'disabled' | 'revoked'
	metadata?: Record<string, unknown>
	metadata_replace?: Record<string, unknown> | null
	reason: string
}
export function gatewayKeyEditInput(
	detail: GatewayKeyDetail,
	draft: GatewayKeyEditForm
): GatewayKeyPatch {
	const parsed = gatewayKeyEditFormSchema.safeParse(draft)
	if (
		!parsed.success ||
		!gatewayKeyRevisionSchema.safeParse(detail.profile_revision).success
	)
		throw new GatewayKeyInputError()
	const value = parsed.data
	if (value.status !== detail.status && !value.statusConfirmed)
		throw new GatewayKeyInputError()
	if (detail.metadata_unavailable && value.metadataMode !== 'unchanged')
		throw new GatewayKeyInputError()
	const patch: GatewayKeyPatch = {
		expected_revision: detail.profile_revision,
		name: value.name || null,
		status: value.status,
		reason: value.reason,
	}
	if (value.metadataMode === 'merge')
		patch.metadata = parseGatewayKeyMetadata(value.metadata) ?? undefined
	if (value.metadataMode === 'replace')
		patch.metadata_replace = parseGatewayKeyMetadata(value.metadata)
	return patch
}
