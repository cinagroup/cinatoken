/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const instant = z.iso.datetime({ offset: true })
const sqlUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u

export type McpSyncTime =
	{ status: 'missing' | 'unavailable' } | { status: 'valid'; iso: string }

/** Display-only normalization: a bad historical time must not reject the server. */
export function parseMcpSyncTime(value: string | null): McpSyncTime {
	if (value === null) return { status: 'missing' }
	if (value.length > 80) return { status: 'unavailable' }
	const normalized = sqlUtc.test(value) ? value.replace(' ', 'T') + 'Z' : value
	// Zod checks calendar dates and explicit zones before Date can roll a date forward
	// or interpret a zone-less value in the browser's local timezone.
	if (!instant.safeParse(normalized).success) return { status: 'unavailable' }
	const ms = Date.parse(normalized)
	if (!Number.isFinite(ms)) return { status: 'unavailable' }
	return { status: 'valid', iso: new Date(ms).toISOString() }
}
