/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	cleanLogDate,
	safeLogJson,
	safeLogText,
} from '../request-logs/request-log-domain'
import type { AuditLog } from './audit-log-contracts'

const budgetFields = new Set([
	'budget_spent',
	'budget_max',
	'budget_base',
	'budget_period',
	'budget_reset_at',
])
const sensitiveField =
	/(?:^|[._])(?:authorization|api_key|secret|password|credential|cookie|bearer|access_token|refresh_token|session_token|messages|contents|prompt|input_text|image_url|audio_data)(?:[._]|$)/iu

export type AuditSnapshotField<T> =
	{ kind: 'missing' } | { kind: 'null' } | { kind: 'value'; value: T }

function objectFromJson(
	raw: string | null | undefined
): Record<string, unknown> | null {
	if (!raw?.trim()) return null
	try {
		const value: unknown = JSON.parse(raw)
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}
function own(
	object: Record<string, unknown> | null,
	key: string
): AuditSnapshotField<unknown> {
	if (!object || !Object.hasOwn(object, key)) return { kind: 'missing' }
	const value = object[key]
	return value === null ? { kind: 'null' } : { kind: 'value', value }
}
function prefer<T>(
	one: AuditSnapshotField<T>,
	other: AuditSnapshotField<T>
): AuditSnapshotField<T> {
	return one.kind === 'missing' ? other : one
}
function finiteNumber(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null
	if (
		typeof value === 'string' &&
		/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(value)
	) {
		const parsed = Number(value)
		return Number.isFinite(parsed) ? parsed : null
	}
	return null
}
function moneyField(
	one: AuditSnapshotField<unknown>,
	other: AuditSnapshotField<unknown>,
	derived: number | null | undefined,
	allowNull: boolean
): AuditSnapshotField<number> {
	const selected = prefer(one, other)
	if (selected.kind === 'missing') return selected
	if (selected.kind === 'null')
		return allowNull ? selected : { kind: 'missing' }
	if (allowNull && selected.value === 'null') return { kind: 'null' }
	const sourceValue = finiteNumber(selected.value)
	if (sourceValue === null) return { kind: 'missing' }
	const value = finiteNumber(derived) ?? sourceValue
	return value === null ? { kind: 'missing' } : { kind: 'value', value }
}
function stringField(
	one: AuditSnapshotField<unknown>,
	other: AuditSnapshotField<unknown>
): AuditSnapshotField<string> {
	const selected = prefer(one, other)
	if (selected.kind !== 'value') return selected
	return typeof selected.value === 'string'
		? { kind: 'value', value: selected.value }
		: { kind: 'missing' }
}
function payloadField(
	item: AuditLog,
	key:
		| 'before_budget_period'
		| 'after_budget_period'
		| 'before_budget_reset_at'
		| 'after_budget_reset_at',
	payload: Record<string, unknown> | null
): AuditSnapshotField<unknown> {
	if (Object.hasOwn(item, key)) {
		const value = item[key]
		if (value === null) return { kind: 'null' }
		if (value !== undefined) return { kind: 'value', value }
	}
	return own(payload, key)
}
export function auditDisplay(item: AuditLog) {
	const before = objectFromJson(item.before_user_snapshot)
	const after = objectFromJson(item.after_user_snapshot)
	const payload = objectFromJson(item.change_payload)
	const extras = (
		key:
			'reason_text' | 'reason_code' | 'actor_id' | 'source' | 'correlation_id'
	) => {
		const primary = item[key]
		return typeof primary === 'string'
			? primary
			: typeof payload?.[key] === 'string'
				? (payload[key] as string)
				: null
	}
	const beforeSpent = moneyField(
		own(before, 'budget_spent'),
		own(after, 'budget_spent'),
		item.before_spent,
		false
	)
	const afterSpent = moneyField(
		own(after, 'budget_spent'),
		own(before, 'budget_spent'),
		item.after_spent,
		false
	)
	return {
		beforeSpent,
		afterSpent,
		deltaSpent:
			beforeSpent.kind === 'value' &&
			afterSpent.kind === 'value' &&
			item.delta_spent != null
				? ({ kind: 'value', value: item.delta_spent } as const)
				: ({ kind: 'missing' } as const),
		beforeMax: moneyField(
			own(before, 'budget_max'),
			own(after, 'budget_max'),
			item.before_budget_max,
			true
		),
		afterMax: moneyField(
			own(after, 'budget_max'),
			own(before, 'budget_max'),
			item.after_budget_max,
			true
		),
		beforeBase: moneyField(
			own(before, 'budget_base'),
			own(after, 'budget_base'),
			item.before_budget_base,
			false
		),
		afterBase: moneyField(
			own(after, 'budget_base'),
			own(before, 'budget_base'),
			item.after_budget_base,
			false
		),
		beforePeriod: stringField(
			prefer(
				own(before, 'budget_period'),
				payloadField(item, 'before_budget_period', payload)
			),
			prefer(
				own(after, 'budget_period'),
				payloadField(item, 'after_budget_period', payload)
			)
		),
		afterPeriod: stringField(
			prefer(
				own(after, 'budget_period'),
				payloadField(item, 'after_budget_period', payload)
			),
			prefer(
				own(before, 'budget_period'),
				payloadField(item, 'before_budget_period', payload)
			)
		),
		beforeReset: stringField(
			prefer(
				own(before, 'budget_reset_at'),
				payloadField(item, 'before_budget_reset_at', payload)
			),
			prefer(
				own(after, 'budget_reset_at'),
				payloadField(item, 'after_budget_reset_at', payload)
			)
		),
		afterReset: stringField(
			prefer(
				own(after, 'budget_reset_at'),
				payloadField(item, 'after_budget_reset_at', payload)
			),
			prefer(
				own(before, 'budget_reset_at'),
				payloadField(item, 'before_budget_reset_at', payload)
			)
		),
		reasonCode: extras('reason_code'),
		reasonText: extras('reason_text'),
		actorId: extras('actor_id'),
		source: extras('source'),
		correlationId: extras('correlation_id'),
	}
}

export type AuditDiff = {
	group: 'snapshot' | 'payload'
	field: string
	before: string
	after: string
}
function displayValue(
	value: unknown,
	field: string,
	missing: string,
	nullValue: string
): string {
	if (value === undefined) return missing
	if (value === null) return nullValue
	if (sensitiveField.test(field)) return '[redacted]'
	if (typeof value === 'string') return safeLogText(value)
	if (typeof value === 'number' || typeof value === 'boolean')
		return String(value)
	return safeLogJson(JSON.stringify(value)) ?? missing
}
function addDiff(
	rows: AuditDiff[],
	group: AuditDiff['group'],
	field: string,
	before: unknown,
	after: unknown,
	missing: string,
	nullValue: string
): void {
	const b = displayValue(before, field, missing, nullValue)
	const a = displayValue(after, field, missing, nullValue)
	if (b !== a) rows.push({ group, field, before: b, after: a })
}
export function auditDiffs(
	item: AuditLog,
	missing: string,
	nullValue: string
): AuditDiff[] {
	const before = objectFromJson(item.before_user_snapshot)
	const after = objectFromJson(item.after_user_snapshot)
	const payload = objectFromJson(item.change_payload)
	let changed: unknown = null
	try {
		changed = item.changed_fields ? JSON.parse(item.changed_fields) : null
	} catch {
		// Fall back to the key union for older audit rows.
	}
	const keys =
		Array.isArray(changed) &&
		changed.every((key) => typeof key === 'string') &&
		changed.length
			? (changed as string[])
			: [
					...new Set([
						...Object.keys(before ?? {}),
						...Object.keys(after ?? {}),
					]),
				]
	const rows: AuditDiff[] = []
	for (const key of keys) {
		if (key === 'id' || budgetFields.has(key)) continue
		addDiff(
			rows,
			'snapshot',
			key,
			before?.[key],
			after?.[key],
			missing,
			nullValue
		)
	}
	if (payload) {
		for (const [key, value] of Object.entries(payload)) {
			if (
				key.startsWith('before_budget_') ||
				key.startsWith('after_budget_') ||
				[
					'actor_id',
					'reason_code',
					'reason_text',
					'source',
					'correlation_id',
					'metadata_patch_keys',
				].includes(key)
			)
				continue
			if (
				value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				('from' in value || 'to' in value)
			) {
				const pair = value as Record<string, unknown>
				addDiff(rows, 'payload', key, pair.from, pair.to, missing, nullValue)
			} else if (
				key.startsWith('before_') &&
				Object.hasOwn(payload, `after_${key.slice(7)}`)
			) {
				addDiff(
					rows,
					'payload',
					key.slice(7),
					value,
					payload[`after_${key.slice(7)}`],
					missing,
					nullValue
				)
			} else if (!key.startsWith('after_')) {
				addDiff(rows, 'payload', key, undefined, value, missing, nullValue)
			}
		}
	}
	return rows
}

export function auditTime(
	value: string | null | undefined,
	timezone: string | null,
	locale: string
): string {
	if (!value) return '—'
	const normalized = cleanLogDate(value)
	if (!normalized || normalized === '') return '—'
	const ms = Date.parse(
		normalized.includes(' ') ? `${normalized.replace(' ', 'T')}Z` : normalized
	)
	if (!Number.isFinite(ms)) return '—'
	try {
		return new Intl.DateTimeFormat(locale, {
			timeZone: timezone ?? 'UTC',
			dateStyle: 'medium',
			timeStyle: 'medium',
		}).format(ms)
	} catch {
		return new Date(ms).toISOString()
	}
}
