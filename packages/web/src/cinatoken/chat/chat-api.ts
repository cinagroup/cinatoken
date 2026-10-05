/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	coercePublicChatRequest,
	parsePublicChatResponseText,
	PUBLIC_CHAT_MAX_BODY_BYTES,
	PublicChatSseDecoder,
	type PublicChatRequest,
} from '../../../../core/src/lib/public-chat'

export class PublicChatError extends Error {
	constructor(
		readonly code:
			| 'input'
			| 'http'
			| 'network'
			| 'timeout'
			| 'cancelled'
			| 'invalid-response'
			| 'interrupted',
		readonly status = 0,
		readonly retryAfter: string | null = null
	) {
		super(`Public chat ${code}${status ? ` (${status})` : ''}`)
		this.name = 'PublicChatError'
	}
}

export function chatRetryDelaySeconds(
	value: string | null,
	now = Date.now()
): number | null {
	if (!value || value.length > 128) return null
	if (/^\d{1,5}$/.test(value)) return Number(value)
	if (
		!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
			value
		)
	)
		return null
	const until = Date.parse(value)
	return Number.isFinite(until)
		? Math.max(0, Math.ceil((until - now) / 1000))
		: null
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new PublicChatError('cancelled'))
		if (signal.aborted) abort()
		else signal.addEventListener('abort', abort, { once: true })
		task.then(
			(value) => {
				signal.removeEventListener('abort', abort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort)
				reject(error)
			}
		)
	})
}

export type PublicChatOptions = {
	signal?: AbortSignal
	timeoutMs?: number
	onText: (text: string) => void
}

/** Inference authorization is independent of the browser's Portal/Console session. */
export function createPublicChatApi(request: typeof fetch = fetch) {
	return {
		async send(
			key: string,
			input: PublicChatRequest,
			options: PublicChatOptions
		): Promise<string> {
			const token = key.trim()
			const payload = coercePublicChatRequest(input)
			const timeoutMs = options.timeoutMs ?? 300_000
			if (
				!/^[^\s]{8,512}$/.test(token) ||
				!payload ||
				!Number.isFinite(timeoutMs) ||
				timeoutMs < 1 ||
				timeoutMs > 300_000
			)
				throw new PublicChatError('input')
			const body = JSON.stringify({ ...payload, stream: true })
			if (
				new TextEncoder().encode(body).byteLength > PUBLIC_CHAT_MAX_BODY_BYTES
			)
				throw new PublicChatError('input')
			if (options.signal?.aborted) throw new PublicChatError('cancelled')
			const controller = new AbortController()
			const cancel = () => controller.abort()
			options.signal?.addEventListener('abort', cancel, { once: true })
			let timedOut = false
			const timer = setTimeout(() => {
				timedOut = true
				controller.abort()
			}, timeoutMs)
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
			try {
				const response = await abortable(
					request('/api/public/chat', {
						method: 'POST',
						credentials: 'omit',
						cache: 'no-store',
						redirect: 'error',
						headers: {
							authorization: `Bearer ${token}`,
							'content-type': 'application/json',
							accept: 'text/event-stream',
						},
						body,
						signal: controller.signal,
					}).then((value) => {
						if (controller.signal.aborted)
							void value.body?.cancel().catch(() => undefined)
						return value
					}),
					controller.signal
				)
				if (!response.ok) {
					void response.body?.cancel().catch(() => undefined)
					const retry = response.headers.get('retry-after')
					throw new PublicChatError(
						'http',
						response.status,
						chatRetryDelaySeconds(retry) !== null ? retry : null
					)
				}
				const type = response.headers
					.get('content-type')
					?.split(';')[0]
					?.trim()
					.toLowerCase()
				if (type === 'application/json') {
					const text = parsePublicChatResponseText(
						await abortable(response.json(), controller.signal)
					)
					if (!text || text.length > 1_000_000)
						throw new PublicChatError('invalid-response')
					if (controller.signal.aborted) throw new PublicChatError('cancelled')
					options.onText(text)
					return text
				}
				if (type !== 'text/event-stream' || !response.body)
					throw new PublicChatError('invalid-response')
				reader = response.body.getReader()
				const decoder = new TextDecoder('utf-8', { fatal: true })
				const events = new PublicChatSseDecoder()
				let text = '',
					done = false,
					received = 0
				const apply = (values: ReturnType<PublicChatSseDecoder['push']>) => {
					const previousText = text
					for (const event of values) {
						if (done) break
						if (event.type === 'error') {
							if (controller.signal.aborted)
								throw new PublicChatError('cancelled')
							// Network chunk boundaries must not discard earlier valid text.
							if (text !== previousText) options.onText(text)
							throw new PublicChatError('invalid-response')
						}
						if (event.type === 'done') {
							done = true
							continue
						}
						text += event.text
						if (text.length > 1_000_000)
							throw new PublicChatError('invalid-response')
					}
					if (controller.signal.aborted) throw new PublicChatError('cancelled')
					options.onText(text)
				}
				while (!done) {
					const chunk = await abortable(reader.read(), controller.signal)
					if (chunk.done) {
						apply(events.push(decoder.decode()))
						apply(events.finish())
						break
					}
					received += chunk.value.byteLength
					if (received > 16 * 1024 * 1024)
						throw new PublicChatError('invalid-response')
					apply(events.push(decoder.decode(chunk.value, { stream: true })))
				}
				if (!done) throw new PublicChatError('interrupted')
				if (!text.trim()) throw new PublicChatError('invalid-response')
				return text
			} catch (error) {
				if (options.signal?.aborted) throw new PublicChatError('cancelled')
				if (timedOut) throw new PublicChatError('timeout')
				if (error instanceof PublicChatError) throw error
				throw new PublicChatError('network')
			} finally {
				clearTimeout(timer)
				options.signal?.removeEventListener('abort', cancel)
				controller.abort()
				if (reader) {
					void reader.cancel().catch(() => undefined)
					reader.releaseLock()
				}
			}
		},
	}
}

export type PublicChatApi = ReturnType<typeof createPublicChatApi>
