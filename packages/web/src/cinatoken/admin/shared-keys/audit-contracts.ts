/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { sharedKeyStatusSchema } from '../../shared-key-contracts'
import { safeLogText } from '../request-logs/request-log-domain'
import {
	adminSharedKeyIdSchema,
	adminSharedKeyAuditIdSchema,
} from './shared-key-contracts'
import {
	adminSharedKeyPrioritySchema,
	adminSharedKeyRevisionSchema,
} from './shared-key-input'

export const adminSharedKeyAuditCursorSchema = z
	.string()
	.min(1)
	.max(2048)
	.regex(/^[A-Za-z0-9_-]+$/u)
export const adminSharedKeyAuditTimeSchema = z
	.string()
	.max(27)
	.refine((value) => {
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/u.test(value))
			return false
		const milliseconds = Date.parse(value)
		return (
			Number.isFinite(milliseconds) &&
			new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19)
		)
	})
const snapshot = z
	.object({
		status: sharedKeyStatusSchema,
		sellerPriority: adminSharedKeyPrioritySchema,
		weight: z.number().int().min(1).max(100),
		validated: z.boolean(),
	})
	.strict()
export const adminSharedKeyAuditEntrySchema = z
	.object({
		id: adminSharedKeyAuditIdSchema,
		keyId: adminSharedKeyIdSchema,
		createdAt: adminSharedKeyAuditTimeSchema,
		action: z.enum(['updated', 'disabled', 'restored', 'deleted']),
		changeMask: z.number().int().min(1).max(8),
		actorKind: z.enum(['console', 'api_key']),
		actorId: z
			.string()
			.min(1)
			.max(617)
			.refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
		source: z.enum(['admin_api', 'legacy_admin']),
		reason: z
			.string()
			.min(1)
			.max(600)
			.refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
			.transform((value) => safeLogText(value)),
		before: snapshot,
		after: snapshot.nullable(),
		beforeRevision: adminSharedKeyRevisionSchema,
		afterRevision: adminSharedKeyRevisionSchema.nullable(),
	})
	.refine(
		(entry) =>
			entry.actorId.length <= (entry.actorKind === 'console' ? 617 : 600),
		{ path: ['actorId'], message: 'Invalid audit actor' }
	)
	.refine((entry) => {
		if (entry.action === 'deleted')
			return (
				entry.changeMask === 8 &&
				entry.after === null &&
				entry.afterRevision === null
			)
		if (
			entry.changeMask === 8 ||
			entry.after === null ||
			entry.afterRevision === null
		)
			return false
		const mask =
			(entry.before.status !== entry.after.status ? 1 : 0) |
			(entry.before.sellerPriority !== entry.after.sellerPriority ? 2 : 0) |
			(entry.before.weight !== entry.after.weight ? 4 : 0)
		if (
			mask !== entry.changeMask ||
			entry.before.validated !== entry.after.validated ||
			entry.beforeRevision === entry.afterRevision ||
			(entry.action === 'updated' && entry.before.status !== entry.after.status)
		)
			return false
		if (entry.action === 'disabled')
			return Boolean(entry.changeMask & 1) && entry.after.status === 'disabled'
		if (entry.action === 'restored')
			return (
				Boolean(entry.changeMask & 1) &&
				entry.before.status === 'disabled' &&
				entry.after.status === 'paused'
			)
		return true
	})
	.transform((entry) => ({ ...entry, actorId: safeLogText(entry.actorId) }))
export type AdminSharedKeyAuditEntry = z.infer<
	typeof adminSharedKeyAuditEntrySchema
>
export const adminSharedKeyAuditResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		entries: z.array(adminSharedKeyAuditEntrySchema).max(100),
		next_cursor: adminSharedKeyAuditCursorSchema.nullable(),
		page_size: z.number().int().min(1).max(100),
	}),
})
export type AdminSharedKeyAuditPage = z.infer<
	typeof adminSharedKeyAuditResponseSchema
>['data']
