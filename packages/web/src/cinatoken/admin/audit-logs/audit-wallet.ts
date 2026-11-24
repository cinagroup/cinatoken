/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { AuditLog } from './audit-log-contracts'

export type AuditWalletAmount =
	{ kind: 'missing' | 'invalid' } | { kind: 'value'; micros: bigint }
export type AuditWalletPair = {
	before: AuditWalletAmount
	after: AuditWalletAmount
	equal: boolean
}
export type AuditWallet = Record<
	'granted' | 'spent' | 'balance',
	AuditWalletPair
>
type Snapshot = Record<'granted' | 'spent' | 'balance', AuditWalletAmount>
const scale = 1_000_000n
const maxMicros = BigInt(Number.MAX_SAFE_INTEGER)
// Strings are left intact; JSON.parse still owns syntax, escaping and duplicate-key semantics.
const jsonTokens =
	/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gu

function decimalMicros(value: string, exponentAllowed: boolean): bigint | null {
	if (value.length > 128) return null
	const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(value)
	if (!match || (!exponentAllowed && match[4] !== undefined)) return null
	const fraction = match[3] ?? ''
	const exponent = Number(match[4] ?? 0)
	if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 128) return null
	const coefficient = BigInt(match[2] + fraction)
	const places = 6 - fraction.length + exponent
	let micros: bigint
	if (places >= 0) {
		if (coefficient !== 0n && coefficient.toString().length + places > 16)
			return null
		micros = coefficient * 10n ** BigInt(places)
	} else {
		const divisor = 10n ** BigInt(-places)
		if (coefficient % divisor !== 0n) return null
		micros = coefficient / divisor
	}
	if (micros > maxMicros || (match[1] === '-' && micros !== 0n)) return null
	return micros
}
function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}
function snapshot(raw: string | null | undefined): Snapshot {
	const unavailable = (kind: 'missing' | 'invalid'): Snapshot => ({
		granted: { kind },
		spent: { kind },
		balance: { kind },
	})
	if (raw == null || raw.trim() === '') return unavailable('missing')
	if (raw.length > 262_144) return unavailable('invalid')
	let parsed: Record<string, unknown> | null
	let exact: Record<string, unknown> | null
	try {
		parsed = object(JSON.parse(raw))
		exact = object(
			JSON.parse(
				raw.replace(jsonTokens, (token) =>
					token.startsWith('"') ? token : JSON.stringify(token)
				)
			)
		)
	} catch {
		return unavailable('invalid')
	}
	if (!parsed || !exact) return unavailable('invalid')
	function field(key: string): AuditWalletAmount {
		if (!parsed || !Object.hasOwn(parsed, key) || parsed[key] === null)
			return { kind: 'missing' }
		const original = parsed[key]
		if (typeof original !== 'number' && typeof original !== 'string')
			return { kind: 'invalid' }
		if (typeof original === 'number' && !Number.isFinite(original))
			return { kind: 'invalid' }
		const token = exact?.[key]
		if (typeof token !== 'string') return { kind: 'invalid' }
		const micros = decimalMicros(token, typeof original === 'number')
		return micros === null ? { kind: 'invalid' } : { kind: 'value', micros }
	}
	const granted = field('wallet_granted'),
		spent = field('wallet_spent')
	let balance: AuditWalletAmount = { kind: 'missing' }
	if (granted.kind === 'invalid' || spent.kind === 'invalid')
		balance = { kind: 'invalid' }
	else if (granted.kind === 'value' && spent.kind === 'value')
		balance = { kind: 'value', micros: granted.micros - spent.micros }
	return { granted, spent, balance }
}
/** Each side is historical evidence on its own; never fill a missing side from the other. */
export function auditWallet(
	log: Pick<AuditLog, 'before_user_snapshot' | 'after_user_snapshot'>
): AuditWallet {
	const before = snapshot(log.before_user_snapshot),
		after = snapshot(log.after_user_snapshot)
	function pair(key: keyof Snapshot): AuditWalletPair {
		const b = before[key],
			a = after[key]
		return {
			before: b,
			after: a,
			equal: b.kind === 'value' && a.kind === 'value' && b.micros === a.micros,
		}
	}
	return {
		granted: pair('granted'),
		spent: pair('spent'),
		balance: pair('balance'),
	}
}
/** Format integer units and the exact six-digit fraction without a main-unit Number round trip. */
export function formatAuditWalletMoney(
	micros: bigint,
	currency: string,
	locale: string
): string | null {
	try {
		const absolute = micros < 0n ? -micros : micros
		const whole = absolute / scale
		const fraction = (absolute % scale).toString().padStart(6, '0')
		const formatter = new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
			minimumFractionDigits: 6,
			maximumFractionDigits: 6,
		})
		let integer: bigint | number = whole
		if (micros < 0n) integer = -whole
		if (micros < 0n && whole === 0n) integer = -0
		// The fraction alone is at most 999999, so this localization cannot lose a micro-unit.
		const localizedFraction = new Intl.NumberFormat(locale, {
			useGrouping: false,
			minimumIntegerDigits: 6,
			maximumFractionDigits: 0,
		}).format(Number(fraction))
		return formatter
			.formatToParts(integer)
			.map((part) =>
				part.type === 'fraction' ? localizedFraction : part.value
			)
			.join('')
	} catch {
		return null
	}
}
