/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	USER_AUDIT_ACTOR_KINDS,
	USER_AUDIT_ACTOR_TYPES,
	USER_AUDIT_EVENT_TYPES,
	USER_AUDIT_SOURCE_CHANNELS,
} from '@octafuse/core/db/user-audit-catalog'
import { cleanLogDate } from '../request-logs/request-log-domain'

export const auditEventTypes: readonly string[] = USER_AUDIT_EVENT_TYPES
export const auditActorTypes: readonly string[] = USER_AUDIT_ACTOR_TYPES
export const auditActorKinds: readonly string[] = USER_AUDIT_ACTOR_KINDS
export const auditSources: readonly string[] = USER_AUDIT_SOURCE_CHANNELS
export const defaultAuditEvents = auditEventTypes.filter(
	(value) => value !== 'usage_charge'
)

export type AuditLogSearch = {
	page: number
	user_id: string
	api_key_id: string
	user_email: string
	event_type: string[]
	actor_type: string[]
	actor_kind: string[]
	actor_id: string
	reason_code: string[]
	source: string[]
	correlation_id: string
	start_date?: string
	end_date?: string
}

function cleanText(value: unknown, max: number): string {
	return typeof value === 'string' &&
		value.length <= max &&
		!/[\p{Cc}\p{Cf}]/u.test(value)
		? value.trim()
		: ''
}
function cleanTokens(value: unknown): string[] {
	const source = Array.isArray(value) ? value : value == null ? [] : [value]
	return [
		...new Set(
			source
				.filter((part): part is string => typeof part === 'string')
				.flatMap((part) => part.split(','))
				.map((part) => part.trim())
				.filter(
					(part) =>
						part.length > 0 &&
						part.length <= 160 &&
						!/[\p{Cc}\p{Cf}]/u.test(part)
				)
		),
	].slice(0, 100)
}
function validPage(value: unknown): number {
	const page = Number(value)
	return Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000 ? page : 1
}
export function validateAuditLogSearch(
	input: Record<string, unknown>
): AuditLogSearch {
	return {
		page: validPage(input.page),
		user_id: cleanText(input.user_id, 600),
		api_key_id: cleanText(input.api_key_id, 600),
		user_email: cleanText(input.user_email, 320),
		event_type: cleanTokens(input.event_type),
		actor_type: cleanTokens(input.actor_type),
		actor_kind: cleanTokens(input.actor_kind).filter((kind) =>
			auditActorKinds.includes(kind)
		),
		actor_id: cleanText(input.actor_id, 600),
		reason_code: cleanTokens(input.reason_code),
		source: cleanTokens(input.source),
		correlation_id: cleanText(input.correlation_id, 600),
		start_date: cleanLogDate(input.start_date),
		end_date: cleanLogDate(input.end_date),
	}
}

/** Empty arrays mean no restriction. The API accepts repeated values for each multi-select. */
export function auditLogsPath(search: AuditLogSearch): string {
	const safe = validateAuditLogSearch(
		search as unknown as Record<string, unknown>
	)
	if (safe.page !== search.page) throw new TypeError('Invalid audit-log page')
	const params = new URLSearchParams({
		page: String(safe.page),
		page_size: '50',
	})
	for (const key of [
		'user_id',
		'api_key_id',
		'user_email',
		'actor_id',
		'correlation_id',
	] as const) {
		if (safe[key] !== search[key].trim())
			throw new TypeError('Invalid audit-log filter')
		if (safe[key]) params.set(key, safe[key])
	}
	for (const key of [
		'event_type',
		'actor_type',
		'actor_kind',
		'reason_code',
		'source',
	] as const) {
		if (safe[key].length !== search[key].length)
			throw new TypeError('Invalid audit-log selection')
		for (const value of safe[key]) params.append(key, value)
	}
	for (const key of ['start_date', 'end_date'] as const) {
		if (search[key] && safe[key] !== search[key])
			throw new TypeError('Invalid audit-log UTC date')
		if (safe[key]) params.set(key, safe[key])
	}
	return `/api/admin/budget-audit-logs?${params.toString()}`
}

/** Export uses the identical committed filters, without the current list page. */
export function auditLogExportPath(search: AuditLogSearch): string {
	const listPath = auditLogsPath(search)
	const params = new URLSearchParams(listPath.slice(listPath.indexOf('?') + 1))
	params.delete('page')
	params.delete('page_size')
	return `/api/admin/budget-audit-logs/export.csv?${params.toString()}`
}

export function parseAuditActorId(raw: string | null | undefined): {
	kind: string | null
	identifier: string
} {
	if (!raw) return { kind: null, identifier: '' }
	const separator = raw.indexOf(':')
	if (separator < 0) return { kind: null, identifier: raw }
	const kind = raw.slice(0, separator)
	return auditActorKinds.includes(kind)
		? { kind, identifier: raw.slice(separator + 1) }
		: { kind: null, identifier: raw }
}

export function shortAuditId(raw: string | null | undefined): string {
	if (!raw) return '—'
	return raw.length < 14 ? raw : `${raw.slice(0, 8)}…${raw.slice(-4)}`
}
