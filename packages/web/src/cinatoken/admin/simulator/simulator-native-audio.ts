/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	MAX_PREVIEW_TEXT_CHARS,
	previewObject,
	previewPayloads,
} from '../playground/browser-domain/native-media'

export function safeAudioPreviewUrl(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 16_384) return null
	try {
		const url = new URL(value)
		return ['http:', 'https:'].includes(url.protocol) &&
			!url.username &&
			!url.password
			? url.href
			: null
	} catch {
		return null
	}
}
/** Native DashScope speech may return an HTTPS URL or SSE base64 audio deltas. */
export function dashScopeSpeechPreview(
	raw: string,
	request: Record<string, unknown>
): { audio: Blob | null; url: string | null } {
	const chunks: Uint8Array<ArrayBuffer>[] = []
	let bytes = 0
	let url: string | null = null
	let format: unknown = previewObject(request.input)?.format
	for (const frame of previewPayloads(raw)) {
		if (frame.code || frame.error) return { audio: null, url: null }
		const audio = previewObject(previewObject(frame.output)?.audio)
		url = safeAudioPreviewUrl(audio?.url) ?? url
		format = audio?.format ?? format
		const data = audio?.data
		if (typeof data !== 'string' || !data) continue
		if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 !== 0)
			return { audio: null, url }
		try {
			const binary = atob(data)
			bytes += binary.length
			if (bytes > MAX_PREVIEW_TEXT_CHARS / 2) return { audio: null, url }
			chunks.push(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
		} catch {
			return { audio: null, url }
		}
	}
	const mime: Record<string, string> = {
		wav: 'audio/wav',
		mp3: 'audio/mpeg',
		opus: 'audio/ogg',
		pcm: 'audio/pcm',
		flac: 'audio/flac',
	}
	const type = typeof format === 'string' ? mime[format] : undefined
	return {
		audio: chunks.length
			? new Blob(chunks, { type: type ?? 'audio/wav' })
			: null,
		url,
	}
}
