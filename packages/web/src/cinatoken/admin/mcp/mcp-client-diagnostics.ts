/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { safeLogText } from '../request-logs/request-log-domain'

export const MCP_CLIENT_DIAGNOSTIC_CHARACTER_LIMIT = 262_144
const headerCharacterLimit = 2_048
const diagnosticHeaderNames = [
	'content-type',
	'content-length',
	'content-encoding',
	'content-language',
	'retry-after',
	'mcp-protocol-version',
	'ratelimit',
	'ratelimit-policy',
	'ratelimit-limit',
	'ratelimit-remaining',
	'ratelimit-reset',
	'x-ratelimit-limit',
	'x-ratelimit-remaining',
	'x-ratelimit-reset',
	'x-ratelimit-limit-requests',
	'x-ratelimit-remaining-requests',
	'x-ratelimit-reset-requests',
	'x-ratelimit-limit-tokens',
	'x-ratelimit-remaining-tokens',
	'x-ratelimit-reset-tokens',
] as const

export type McpClientDiagnostic = {
	status: number | null
	elapsedMs: number
	headers: Record<string, string>
	bodyText: string | null
	bodyKind: 'json' | 'text' | 'empty' | 'unavailable'
	truncated: boolean
}
type DiagnosticBody = Pick<
	McpClientDiagnostic,
	'bodyText' | 'bodyKind' | 'truncated'
>

function boundedText(
	value: string,
	limit: number
): { text: string; truncated: boolean } {
	if (value.length <= limit) return { text: value, truncated: false }
	let end = 0
	let count = 0
	for (const character of value) {
		if (count === limit) return { text: value.slice(0, end), truncated: true }
		end += character.length
		count++
	}
	return { text: value, truncated: false }
}

/** Probe ASCII URL/JSON escaping without changing ordinary encoded resource URIs. */
function decodeRedactionProbe(value: string): string {
	return value.replace(
		/\\(?:u([\da-f]{4})|x([\da-f]{2})|(["\\/]))|%([0-7][\da-f])/giu,
		(_all, unicode: string, hex: string, escaped: string, percent: string) => {
			if (escaped) return escaped
			return String.fromCharCode(parseInt(unicode || hex || percent, 16))
		}
	)
}

/** Do not retain direct, JSON-escaped, or URL-encoded echoes of the input secret. */
export function safeMcpClientDiagnosticText(
	value: string,
	secret: string
): string {
	const redact = (text: string) =>
		safeLogText(secret ? text.split(secret).join('[redacted]') : text)
	const direct = redact(value)
	let probe = value
	for (let layer = 0; layer < 4; layer++) {
		const decoded = decodeRedactionProbe(probe)
		if (decoded === probe) {
			// Decoding can turn a character inside a query value into a delimiter.
			// Never expose that normalized text: withhold ambiguous encoded credentials.
			if (probe !== value && redact(probe) !== probe) return '[redacted]'
			return direct
		}
		probe = decoded
	}
	// Ambiguous deeply nested escapes are withheld instead of guessing at their content.
	if (decodeRedactionProbe(probe) !== probe) return '[redacted]'
	return redact(probe) === probe ? direct : '[redacted]'
}

/** Only explicitly named diagnostic headers can leave the transport. */
export function mcpClientDiagnosticHeaders(
	headers: Headers,
	secret: string
): Record<string, string> {
	const result: Record<string, string> = {}
	for (const name of diagnosticHeaderNames) {
		const value = headers.get(name)
		if (value === null) continue
		const bounded = boundedText(
			safeMcpClientDiagnosticText(value, secret),
			headerCharacterLimit
		)
		result[name] = bounded.truncated
			? boundedText(bounded.text, headerCharacterLimit - 1).text + '…'
			: bounded.text
	}
	return result
}

/** The caller has already completed safeResponseJson's bounded redaction traversal. */
export function mcpClientJsonDiagnosticBody(json: unknown): DiagnosticBody {
	const bounded = boundedText(
		JSON.stringify(json, null, 2),
		MCP_CLIENT_DIAGNOSTIC_CHARACTER_LIMIT
	)
	return {
		bodyText: bounded.text,
		bodyKind: 'json',
		truncated: bounded.truncated,
	}
}

export function mcpClientTextDiagnosticBody(
	raw: string,
	secret: string
): DiagnosticBody {
	if (!raw.trim()) return { bodyText: '', bodyKind: 'empty', truncated: false }
	// An incomplete JSON document cannot be safely traversed for escaped sensitive keys.
	if (/^\s*[[{"]/u.test(raw))
		return { bodyText: null, bodyKind: 'unavailable', truncated: false }
	const bounded = boundedText(
		safeMcpClientDiagnosticText(raw, secret),
		MCP_CLIENT_DIAGNOSTIC_CHARACTER_LIMIT
	)
	return {
		bodyText: bounded.text,
		bodyKind: 'text',
		truncated: bounded.truncated,
	}
}
