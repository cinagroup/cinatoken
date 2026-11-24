/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** The transport already caps bodies; keep direct helper callers bounded too. */
export const MAX_PREVIEW_TEXT_CHARS = 16 * 1024 * 1024
export function previewObject(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}
/** Iterate complete payloads without allocating an array for every SSE event. */
export function* previewPayloads(
	raw: string
): Generator<Record<string, unknown>> {
	if (!raw || raw.length > MAX_PREVIEW_TEXT_CHARS) return
	try {
		const parsed = previewObject(JSON.parse(raw) as unknown)
		if (parsed) yield parsed
		return
	} catch {
		/* streamed payloads use event framing */
	}
	const delimiter = /\r?\n\r?\n/gu
	let start = 0
	let match: RegExpExecArray | null
	while ((match = delimiter.exec(raw)) !== null) {
		const event = raw.slice(start, match.index)
		start = match.index + match[0].length
		const payload = event
			.split(/\r?\n/u)
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trimStart())
			.join('\n')
		if (!payload || payload === '[DONE]') continue
		try {
			const parsed = previewObject(JSON.parse(payload) as unknown)
			if (parsed) yield parsed
		} catch {
			/* malformed events remain available as escaped raw text */
		}
	}
}
/** MiniMax SSE's status=2 audio is the complete aggregate, not another delta. */
export function miniMaxSpeechAudioBlob(raw: string): Blob | null {
	let aggregate: string | null = null
	const deltas: string[] = []
	let format: unknown = null
	for (const frame of previewPayloads(raw)) {
		const data = previewObject(frame.data),
			base = previewObject(frame.base_resp)
		if (base?.status_code !== undefined && base.status_code !== 0) return null
		const hex = typeof data?.audio === 'string' ? data.audio.trim() : ''
		if (hex && (!/^[0-9a-f]+$/iu.test(hex) || hex.length % 2 !== 0)) return null
		if (hex) {
			if (data?.status === 2 || data?.status === '2') aggregate = hex
			else deltas.push(hex)
		}
		format = previewObject(frame.extra_info)?.audio_format ?? format
	}
	const hex = aggregate ?? deltas.join('')
	if (!hex || hex.length > MAX_PREVIEW_TEXT_CHARS) return null
	const bytes = new Uint8Array(hex.length / 2)
	for (let index = 0; index < bytes.length; index++)
		bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16)
	const formats: Record<string, string> = {
		wav: 'audio/wav',
		mp3: 'audio/mpeg',
		flac: 'audio/flac',
		opus: 'audio/ogg',
		pcm: 'audio/pcm',
	}
	const type =
		typeof format === 'string' ? formats[format.toLowerCase()] : undefined
	return new Blob([bytes], { type: type ?? 'audio/mpeg' })
}
