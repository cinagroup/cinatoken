/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	disposeDashScopeRealtimeClient,
	openDashScopeRealtimeClient,
	stopDashScopeRealtimeClient,
	dashScopeRealtimeAudioContentType,
	type DashScopeRealtimeOperation,
} from '../playground/browser-domain/dashscope-realtime-client'
import type { BuildSimulatorRequestResult } from './endpoint'
import type { ResponseMeta } from './types'

export const SIMULATOR_MAX_RESPONSE_BYTES = 64 * 1024 * 1024
export type SimulatorTransportResult = {
	raw: string
	audio: Blob | null
	meta: ResponseMeta
}
export type SimulatorProgress = (result: SimulatorTransportResult) => void
function meta(url: string): ResponseMeta {
	return {
		status: null,
		latencyMs: null,
		requestUrl: url,
		contentType: null,
		generationId: null,
		outcome: 'running',
	}
}
function redact(value: string, secret: string): string {
	if (!secret) return value
	let safe = value.split(secret).join('[redacted]')
	// Never publish a secret prefix when an untrusted response echoes it across HTTP chunks.
	for (let length = secret.length - 1; length > 0; length--) {
		if (safe.endsWith(secret.slice(0, length))) {
			safe = safe.slice(0, -length) + '[redacted]'
			break
		}
	}
	return safe
}
function containsProxyError(raw: string): boolean {
	const payloads = [
		raw,
		...raw
			.split(/\r?\n/)
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trim()),
	]
	return payloads.some((text) => {
		try {
			const value: unknown = JSON.parse(text)
			if (!value || typeof value !== 'object' || Array.isArray(value))
				return false
			const object = value as Record<string, unknown>
			return (
				!!object.error ||
				object.type === 'response.failed' ||
				object.type === 'error'
			)
		} catch {
			return false
		}
	})
}

/** One explicit Proxy call. Cookie auth, Admin interceptors and automatic retries are deliberately absent. */
export async function executeSimulatorHttp(input: {
	request: BuildSimulatorRequestResult
	secret: string
	signal: AbortSignal
	onProgress: SimulatorProgress
	fetch?: typeof fetch
}): Promise<SimulatorTransportResult> {
	const started = performance.now()
	const result: SimulatorTransportResult = {
		raw: '',
		audio: null,
		meta: meta(input.request.url),
	}
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
	let completed = false
	const cancelReader = () => {
		void reader?.cancel().catch(() => undefined)
	}
	input.signal.addEventListener('abort', cancelReader, { once: true })
	try {
		input.signal.throwIfAborted()
		const response = await (input.fetch ?? fetch)(input.request.url, {
			method: 'POST',
			headers: input.request.headers,
			body: input.request.formData ?? input.request.bodyText,
			credentials: 'omit',
			cache: 'no-store',
			redirect: 'error',
			signal: input.signal,
		})
		if (input.signal.aborted) {
			await response.body?.cancel().catch(() => undefined)
			input.signal.throwIfAborted()
		}
		result.meta = {
			...result.meta,
			status: response.status,
			latencyMs: (performance.now() - started).toFixed(0),
			contentType: response.headers.get('content-type')
				? redact(response.headers.get('content-type') ?? '', input.secret)
				: null,
			generationId: response.headers.get('x-generation-id')
				? redact(response.headers.get('x-generation-id') ?? '', input.secret)
				: null,
		}
		input.onProgress({ ...result, meta: { ...result.meta } })
		const isAudio =
			response.ok &&
			(/^audio\//i.test(result.meta.contentType ?? '') ||
				/application\/octet-stream/i.test(result.meta.contentType ?? ''))
		const chunks: Uint8Array<ArrayBuffer>[] = []
		const decoder = new TextDecoder()
		let size = 0
		reader = response.body?.getReader() ?? null
		if (reader) {
			for (;;) {
				input.signal.throwIfAborted()
				const chunk = await reader.read()
				input.signal.throwIfAborted()
				if (chunk.done) break
				size += chunk.value.byteLength
				if (size > SIMULATOR_MAX_RESPONSE_BYTES)
					throw new Error('response-limit')
				if (isAudio) chunks.push(new Uint8Array(chunk.value))
				else {
					result.raw += decoder.decode(chunk.value, { stream: true })
					input.onProgress({
						...result,
						raw: redact(result.raw, input.secret),
						meta: { ...result.meta },
					})
				}
			}
		}
		if (isAudio)
			result.audio = new Blob(chunks, {
				type: result.meta.contentType ?? 'audio/mpeg',
			})
		else result.raw = redact(result.raw + decoder.decode(), input.secret)
		result.meta.outcome =
			response.ok && !containsProxyError(result.raw) ? 'complete' : 'failed'
		completed = true
	} catch {
		// After dispatch, a network error or cancellation cannot establish that billing did not occur.
		result.meta.outcome = input.signal.aborted ? 'cancelled' : 'unknown'
		result.raw = redact(result.raw, input.secret)
	} finally {
		input.signal.removeEventListener('abort', cancelReader)
		if (reader) {
			if (!completed) await reader.cancel().catch(() => undefined)
			reader.releaseLock()
		}
	}
	return result
}

export function executeSimulatorRealtime(input: {
	url: string
	operation: DashScopeRealtimeOperation
	secret: string
	initialMessage: string
	audioFile: File | null
	audioInput: 'file' | 'microphone'
	signal: AbortSignal
	onProgress: SimulatorProgress
	open?: typeof openDashScopeRealtimeClient
	dispose?: typeof disposeDashScopeRealtimeClient
	stop?: typeof stopDashScopeRealtimeClient
}): Promise<SimulatorTransportResult> {
	const result: SimulatorTransportResult = {
		raw: '',
		audio: null,
		meta: meta(input.url),
	}
	const started = performance.now()
	return new Promise((resolve) => {
		let opened = false
		let finished = false
		let size = 0
		let socket: WebSocket | null = null
		const chunks: ArrayBuffer[] = []
		const dispose = () => {
			if (socket) (input.dispose ?? disposeDashScopeRealtimeClient)(socket)
		}
		const finish = (outcome: ResponseMeta['outcome']) => {
			if (finished) return
			finished = true
			clearTimeout(timer)
			input.signal.removeEventListener('abort', abort)
			result.meta.outcome = outcome
			if (chunks.length)
				result.audio = new Blob(chunks, {
					type: dashScopeRealtimeAudioContentType(input.initialMessage),
				})
			dispose()
			resolve({ ...result, meta: { ...result.meta } })
		}
		const abort = () => {
			// Send the protocol's finish event before revoking local resources; never promise zero billing.
			if (socket) {
				try {
					;(input.stop ?? stopDashScopeRealtimeClient)(socket)
				} catch {
					/* Disposal below still releases every browser resource. */
				}
			}
			finish('cancelled')
		}
		const timer = setTimeout(() => finish('unknown'), 180_000)
		if (input.signal.aborted) {
			finish('cancelled')
			return
		}
		input.signal.addEventListener('abort', abort, { once: true })
		try {
			socket = (input.open ?? openDashScopeRealtimeClient)({
				url: input.url,
				operation: input.operation,
				apiKey: input.secret,
				initialMessage: input.initialMessage,
				audioFile: input.audioFile,
				audioInput: input.audioInput,
				onOpen: () => {
					if (finished || input.signal.aborted) {
						dispose()
						return
					}
					opened = true
					result.meta = {
						...result.meta,
						status: 101,
						contentType: 'application/x-ndjson',
						latencyMs: (performance.now() - started).toFixed(0),
					}
					input.onProgress({ ...result, meta: { ...result.meta } })
				},
				onMessage: (message) => {
					if (finished || input.signal.aborted) return
					if (typeof message !== 'string') return
					size += message.length * 2
					if (size > SIMULATOR_MAX_RESPONSE_BYTES) {
						finish('unknown')
						return
					}
					result.raw += redact(message, input.secret) + '\n'
					input.onProgress({ ...result, meta: { ...result.meta } })
				},
				onAudioChunk: (chunk) => {
					if (finished || input.signal.aborted) return
					size += chunk.byteLength
					if (size > SIMULATOR_MAX_RESPONSE_BYTES) {
						finish('unknown')
						return
					}
					chunks.push(chunk)
				},
				onError: () => finish(opened ? 'unknown' : 'failed'),
				onClose: (event) => {
					if (finished) return
					// A rejected handshake has no HTTP status available to browser WebSocket clients.
					if (!opened) {
						finish('failed')
						return
					}
					const taskFailure =
						/"(?:event|type)"\s*:\s*"(?:task-failed|error)"/.test(result.raw)
					const terminal =
						/"(?:event|type)"\s*:\s*"(?:task-finished|session\.finished)"/.test(
							result.raw
						)
					if (taskFailure) finish('failed')
					else finish(event.code === 1000 && terminal ? 'complete' : 'unknown')
				},
			})
			if (finished) dispose()
		} catch {
			finish('failed')
		}
	})
}
