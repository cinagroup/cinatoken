/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const sensitiveKey =
	/(?:^|_)(?:authorization|api_key|secret|password|credential|cookie|bearer|access_token|refresh_token|session_token|messages|contents|prompt|input_text|image_url|audio_data)(?:_|$)|(?:^|_)token(?:_|$)/u
export function isSensitiveLogKey(key: string): boolean {
	return sensitiveKey.test(
		key
			.replace(/([a-z])([A-Z])/gu, '$1_$2')
			.replace(/-/gu, '_')
			.toLowerCase()
	)
}
export function safeLogText(value: string): string {
	const credentialSafe = value
		.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}/giu, '[redacted]')
		.replace(
			/([?&])([^=&#\s"'\\]{1,128})=([^&#\s"'\\]+)/gu,
			(all, delimiter: string, encodedKey: string) => {
				let key: string
				try {
					key = decodeURIComponent(encodedKey.replace(/\+/gu, ' '))
				} catch {
					return `${delimiter}${encodedKey}=[redacted]`
				}
				return isSensitiveLogKey(key) || /^(?:key|auth)$/iu.test(key)
					? `${delimiter}${encodedKey}=[redacted]`
					: all
			}
		)
	const field = /(["'])([A-Za-z][A-Za-z0-9_-]{0,127})\1\s*:\s*(["'])/gu
	let result = ''
	let cursor = 0
	for (const match of credentialSafe.matchAll(field)) {
		if (match.index < cursor || !isSensitiveLogKey(match[2])) continue
		const valueStart = match.index + match[0].length
		const quote = match[3]
		let valueEnd = valueStart
		while (valueEnd < credentialSafe.length) {
			if (credentialSafe[valueEnd] === '\\') {
				valueEnd += 2
				continue
			}
			if (credentialSafe[valueEnd] === quote) break
			valueEnd += 1
		}
		result += credentialSafe.slice(cursor, valueStart) + '[redacted]'
		if (valueEnd < credentialSafe.length) {
			result += quote
			cursor = valueEnd + 1
		} else {
			cursor = credentialSafe.length
		}
	}
	return result + credentialSafe.slice(cursor)
}
