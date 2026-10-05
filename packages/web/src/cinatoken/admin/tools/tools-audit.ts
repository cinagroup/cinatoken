/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { safeLogText } from '../request-logs/request-log-domain'
import {
	toolFamilySchema,
	toolProviderSchema,
	toolFieldSchema,
} from './tools-contracts'
import { validToolTarget, type ToolFamily } from './tools-domain'
import {
	toolTime,
	toolToken,
	toolUuid,
	decodeToolCursor,
	validToolVersion,
	type ToolCursor,
} from './tools-token'

const field = z.enum([
	'apiKey',
	'secretId',
	'secretKey',
	'email',
	'metered',
	'standard',
	'charged',
	'region',
	'bizType',
	'billingUnitChars',
	'active',
	'catalog',
	'legacy_migration',
])
const text = (max: number) =>
	z
		.string()
		.min(1)
		.refine(
			(value) => [...value].length <= max && !/[\p{Cc}\p{Cf}]/u.test(value)
		)
export const toolAuditEntry = z
	.object({
		id: toolUuid,
		family: toolFamilySchema,
		provider: toolProviderSchema.nullable(),
		action: z.enum([
			'save',
			'save_activate',
			'activate',
			'legacy_save',
			'reveal',
		]),
		actorKind: z.enum(['console', 'admin_key']),
		actorId: text(617),
		source: z.enum(['admin_api', 'legacy_admin']),
		reason: text(600),
		changedFields: z
			.array(z.object({ provider: toolProviderSchema.nullable(), field }))
			.max(100),
		activeBefore: toolProviderSchema.nullable(),
		activeAfter: toolProviderSchema.nullable(),
		credentials: z
			.array(
				z.object({
					provider: toolProviderSchema,
					field: z.union([toolFieldSchema, z.literal('email')]),
					operation: z.enum(['keep', 'set', 'clear', 'reveal']),
					configuredBefore: z.boolean(),
					configuredAfter: z.boolean(),
				})
			)
			.max(40),
		beforeVersion: toolToken,
		afterVersion: toolToken,
		createdAt: toolTime,
	})
	.refine(
		(value) =>
			[...value.actorId].length <=
				(value.actorKind === 'console' ? 617 : 600) &&
			[
				value.provider,
				value.activeBefore,
				value.activeAfter,
				...value.changedFields.map((row) => row.provider),
				...value.credentials.map((row) => row.provider),
			].every(
				(provider) =>
					provider === null || validToolTarget(value.family, provider)
			) &&
			validToolVersion(value.beforeVersion, value.family) &&
			validToolVersion(value.afterVersion, value.family)
	)
	.transform((value) => ({
		...value,
		actorId: safeLogText(value.actorId),
		reason: safeLogText(value.reason),
	}))
export const toolAuditData = z.object({
	entries: z.array(toolAuditEntry).max(20),
	next_cursor: toolToken.nullable(),
})
export const toolAuditSchema = z.object({
	success: z.literal(true),
	data: toolAuditData,
})
export type ToolAuditPage = z.infer<typeof toolAuditData>
export function validToolAuditPage(
	page: ToolAuditPage,
	family: ToolFamily,
	incoming: ToolCursor | null
): boolean {
	let boundary = incoming ? incoming.created_at + '|' + incoming.id : null
	for (const entry of page.entries) {
		const tuple = entry.createdAt + '|' + entry.id
		if (entry.family !== family || (boundary !== null && tuple >= boundary))
			return false
		boundary = tuple
	}
	if (new Set(page.entries.map((row) => row.id)).size !== page.entries.length)
		return false
	if (page.next_cursor === null) return true
	if (page.entries.length !== 20) return false
	const next = decodeToolCursor(page.next_cursor, family),
		last = page.entries.at(-1)
	return (
		next !== null && next.created_at === last?.createdAt && next.id === last.id
	)
}
