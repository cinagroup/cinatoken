/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	adminSharedKeyAuditCursorSchema,
	adminSharedKeyAuditTimeSchema,
	type AdminSharedKeyAuditPage,
} from './audit-contracts'
import {
	adminSharedKeyAuditIdSchema,
	adminSharedKeyIdSchema,
} from './shared-key-contracts'

const cursorSchema = z
	.object({
		v: z.literal(1),
		key_id: adminSharedKeyIdSchema,
		created_at: adminSharedKeyAuditTimeSchema,
		id: adminSharedKeyAuditIdSchema,
	})
	.strict()
export type SharedKeyAuditCursor = z.infer<typeof cursorSchema>
export function encodeSharedKeyAuditCursor(
	value: SharedKeyAuditCursor
): string {
	const checked = cursorSchema.parse(value)
	const bytes = new TextEncoder().encode(JSON.stringify(checked))
	return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
		.replace(/\+/gu, '-')
		.replace(/\//gu, '_')
		.replace(/=+$/u, '')
}
export function decodeSharedKeyAuditCursor(
	raw: string,
	keyId: string
): SharedKeyAuditCursor | null {
	if (!adminSharedKeyAuditCursorSchema.safeParse(raw).success) return null
	try {
		const encoded = raw.replace(/-/gu, '+').replace(/_/gu, '/')
		const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
		const value = cursorSchema.parse(
			JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
		)
		if (value.key_id !== keyId || encodeSharedKeyAuditCursor(value) !== raw)
			return null
		return value
	} catch {
		return null
	}
}
function tuple(createdAt: string, id: string): string {
	return (
		createdAt.slice(0, 20) + createdAt.slice(20, -1).padEnd(6, '0') + 'Z|' + id
	)
}
export function validSharedKeyAuditPage(
	page: AdminSharedKeyAuditPage,
	keyId: string,
	incoming: SharedKeyAuditCursor | null
): boolean {
	if (page.page_size !== 20 || page.entries.length > 20) return false
	let boundary = incoming ? tuple(incoming.created_at, incoming.id) : null
	for (const entry of page.entries) {
		const current = tuple(entry.createdAt, entry.id)
		if (entry.keyId !== keyId || (boundary !== null && current >= boundary))
			return false
		boundary = current
	}
	if (
		new Set(page.entries.map((entry) => entry.id)).size !== page.entries.length
	)
		return false
	if (page.entries.length !== 20) return page.next_cursor === null
	if (page.next_cursor === null) return false
	const next = decodeSharedKeyAuditCursor(page.next_cursor, keyId)
	const last = page.entries[page.entries.length - 1]
	return (
		next !== null && next.id === last.id && next.created_at === last.createdAt
	)
}
