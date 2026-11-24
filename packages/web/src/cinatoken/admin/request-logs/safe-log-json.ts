/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { isSensitiveLogKey, safeLogText } from './log-redaction'

// A class keeps user-supplied objects from impersonating a numeric token.
class LogJsonNumber {
	constructor(readonly raw: string) {}
}

export type LogJsonValue =
	| string
	| boolean
	| null
	| LogJsonNumber
	| LogJsonValue[]
	| { [key: string]: LogJsonValue }

export function isLogJsonNumber(value: unknown): value is LogJsonNumber {
	return value instanceof LogJsonNumber
}

export function asLogJsonObject(
	value: unknown
): Record<string, LogJsonValue> | null {
	if (!value || typeof value !== 'object') return null
	if (Array.isArray(value) || isLogJsonNumber(value)) return null
	return value as Record<string, LogJsonValue>
}

const jsonTokens =
	/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gu

function redactJson(
	parsed: unknown,
	exact: unknown,
	depth: number
): LogJsonValue {
	if (depth > 16) return '[redacted: depth limit]'
	if (typeof parsed === 'number') return new LogJsonNumber(exact as string)
	if (typeof parsed === 'string') return safeLogText(parsed)
	if (typeof parsed === 'boolean' || parsed === null) return parsed
	if (Array.isArray(parsed)) {
		const exactArray = exact as unknown[]
		return parsed.map((part, index) =>
			redactJson(part, exactArray[index], depth + 1)
		)
	}
	const exactObject = exact as Record<string, unknown>
	return Object.fromEntries(
		Object.entries(parsed as Record<string, unknown>).map(([key, part]) => [
			key,
			isSensitiveLogKey(key)
				? '[redacted]'
				: redactJson(part, exactObject[key], depth + 1),
		])
	)
}

/** Validate with native JSON semantics; keep numeric lexemes outside Number. */
export function parseSafeLogJson(raw: string): LogJsonValue {
	const parsed: unknown = JSON.parse(raw)
	// Strings (including escapes and object keys) are matched as whole tokens.
	// The validated document determines types; the second tree retains digits.
	const exact: unknown = JSON.parse(
		raw.replace(jsonTokens, (token) =>
			token.startsWith('"') ? token : JSON.stringify(token)
		)
	)
	return redactJson(parsed, exact, 0)
}

function serializeJson(
	value: LogJsonValue,
	pretty: boolean,
	depth: number
): string {
	if (isLogJsonNumber(value)) return value.raw
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	const array = Array.isArray(value)
	const parts = array
		? value.map((part) => serializeJson(part, pretty, depth + 1))
		: Object.entries(value).map(
				([key, part]) =>
					`${JSON.stringify(key)}:${pretty ? ' ' : ''}${serializeJson(part, pretty, depth + 1)}`
			)
	const open = array ? '[' : '{'
	const close = array ? ']' : '}'
	if (!parts.length) return open + close
	if (!pretty) return open + parts.join(',') + close
	const indent = '  '.repeat(depth + 1)
	return `${open}\n${indent}${parts.join(`,\n${indent}`)}\n${'  '.repeat(depth)}${close}`
}

export function formatLogJson(value: LogJsonValue, pretty = true): string {
	return serializeJson(value, pretty, 0)
}

/** Malformed fields have no safe structural boundary, so fail closed for display and copy. */
export function safeLogJson(raw: string | null | undefined): string | null {
	if (!raw?.trim()) return null
	try {
		return formatLogJson(parseSafeLogJson(raw))
	} catch {
		return raw.includes('[truncated]')
			? '[redacted: truncated log]'
			: '[redacted: malformed log]'
	}
}
