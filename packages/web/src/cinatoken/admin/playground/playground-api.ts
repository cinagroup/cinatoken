/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	playgroundContextResponseSchema,
	playgroundPreviewResponseSchema,
	type PlaygroundContext,
	type PlaygroundEnvelope,
	type PlaygroundPreview,
	type PlaygroundResponseMeta,
	type PlaygroundUploads,
} from './playground-contracts'

export class PlaygroundError extends Error {
	constructor(
		readonly code:
			| 'access'
			| 'http'
			| 'input'
			| 'invalid-response'
			| 'network'
			| 'timeout'
			| 'cancelled',
		readonly status = 0
	) {
		super('Playground ' + code)
		this.name = 'PlaygroundError'
	}
}
export function abortablePlayground<T>(
	promise: Promise<T>,
	signal: AbortSignal
): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new PlaygroundError('cancelled'))
		if (signal.aborted) abort()
		else signal.addEventListener('abort', abort, { once: true })
		promise.then(
			(value) => {
				signal.removeEventListener('abort', abort)
				if (!signal.aborted) resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort)
				reject(error)
			}
		)
	})
}
export function playgroundFormData(
	envelope: PlaygroundEnvelope,
	uploads: PlaygroundUploads
): FormData {
	if (!('routeId' in envelope)) throw new PlaygroundError('input')
	const form = new FormData()
	form.set('routeId', envelope.routeId)
	form.set('body', JSON.stringify(envelope.body))
	if (envelope.imageOperation)
		form.set('imageOperation', envelope.imageOperation)
	if (envelope.geminiAction) form.set('geminiAction', envelope.geminiAction)
	for (const image of uploads.images ?? [])
		form.append('image', image, image.name)
	if (uploads.audio) form.set('file', uploads.audio, uploads.audio.name)
	return form
}
function wireBody(response: Response): string | null {
	const value = response.headers.get('x-playground-request-body')
	if (!value) return null
	try {
		const decoded = decodeURIComponent(value)
		try {
			return JSON.stringify(JSON.parse(decoded), null, 2)
		} catch {
			return decoded
		}
	} catch {
		return null
	}
}
export type PlaygroundExecuteOptions = {
	signal: AbortSignal
	onMeta: (meta: PlaygroundResponseMeta) => void
	onRaw: (raw: string) => void
	onAudioChunk?: (chunk: ArrayBuffer, contentType: string) => void
}
export function createPlaygroundApi(
	request: typeof fetch = fetch,
	expectedSubject?: string
) {
	async function owned<T>(
		signal: AbortSignal,
		timeoutMs: number,
		operation: (signal: AbortSignal) => Promise<T>
	): Promise<T> {
		if (signal.aborted) throw new PlaygroundError('cancelled')
		const controller = new AbortController(),
			cancel = () => controller.abort()
		signal.addEventListener('abort', cancel, { once: true })
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			controller.abort()
		}, timeoutMs)
		try {
			return await operation(controller.signal)
		} catch (error) {
			if (signal.aborted) throw new PlaygroundError('cancelled')
			if (timedOut) throw new PlaygroundError('timeout')
			if (error instanceof PlaygroundError) throw error
			throw new PlaygroundError('network')
		} finally {
			clearTimeout(timer)
			signal.removeEventListener('abort', cancel)
			controller.abort()
		}
	}
	async function fetchOwned(
		path: string,
		init: RequestInit,
		signal: AbortSignal
	): Promise<Response> {
		const headers = new Headers(init.headers)
		if (expectedSubject)
			headers.set(
				'X-CinaToken-Expected-Console-Subject',
				encodeURIComponent(expectedSubject)
			)
		return abortablePlayground(
			request(path, {
				...init,
				headers,
				signal,
				credentials: 'same-origin',
				cache: 'no-store',
				redirect: 'error',
			}).then((response) => {
				if (signal.aborted) void response.body?.cancel().catch(() => undefined)
				return response
			}),
			signal
		)
	}
	async function jsonResponse(
		response: Response,
		signal: AbortSignal
	): Promise<unknown> {
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined)
			throw new PlaygroundError(
				response.status === 401 || response.status === 403 ? 'access' : 'http',
				response.status
			)
		}
		return abortablePlayground(response.json(), signal)
	}
	return {
		async context(signal: AbortSignal): Promise<PlaygroundContext> {
			return owned(signal, 30_000, async (current) => {
				const parsed = playgroundContextResponseSchema.safeParse(
					await jsonResponse(
						await fetchOwned('/api/admin/playground/context', {}, current),
						current
					)
				)
				if (!parsed.success) throw new PlaygroundError('invalid-response')
				return parsed.data.data
			})
		},
		async preview(
			envelope: PlaygroundEnvelope,
			uploads: PlaygroundUploads,
			signal: AbortSignal
		): Promise<PlaygroundPreview> {
			return owned(signal, 30_000, async (current) => {
				const manifest = {
					images: uploads.images?.map((file) => ({
						name: file.name,
						type: file.type,
						size: file.size,
					})),
					audio: uploads.audio
						? {
								name: uploads.audio.name,
								type: uploads.audio.type,
								size: uploads.audio.size,
							}
						: undefined,
				}
				const hasFiles = Boolean(uploads.audio || uploads.images?.length)
				const response = await fetchOwned(
					'/api/admin/playground/preview',
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							...envelope,
							...('routeId' in envelope && hasFiles
								? { uploadManifest: manifest }
								: {}),
						}),
					},
					current
				)
				const parsed = playgroundPreviewResponseSchema.safeParse(
					await jsonResponse(response, current)
				)
				if (!parsed.success) throw new PlaygroundError('invalid-response')
				return parsed.data.data
			})
		},
		async execute(
			envelope: PlaygroundEnvelope,
			uploads: PlaygroundUploads,
			options: PlaygroundExecuteOptions
		): Promise<{
			raw: string
			meta: PlaygroundResponseMeta
			audio: Blob | null
		}> {
			return owned(options.signal, 300_000, async (signal) => {
				const hasFiles = Boolean(uploads.audio || uploads.images?.length)
				const response = await fetchOwned(
					'/api/admin/playground',
					{
						method: 'POST',
						headers: hasFiles
							? undefined
							: { 'content-type': 'application/json' },
						body: hasFiles
							? playgroundFormData(envelope, uploads)
							: JSON.stringify(envelope),
					},
					signal
				)
				// Upstream authentication errors are results, not Console session revocations.
				if (
					(response.status === 401 || response.status === 403) &&
					!response.headers.get('x-playground-mode')
				) {
					void response.body?.cancel().catch(() => undefined)
					throw new PlaygroundError('access', response.status)
				}
				const meta: PlaygroundResponseMeta = {
					status: response.status,
					latencyMs: response.headers.get('x-playground-latency-ms'),
					upstreamUrl: response.headers.get('x-playground-upstream-url'),
					contentType: response.headers.get('content-type') ?? '',
					wireBody: wireBody(response),
					truncated:
						response.headers.get('x-playground-request-body-truncated') ===
						'true',
					latencyScope: response.headers.get('x-playground-latency-scope'),
					upstreamStatus: response.headers.get('x-playground-upstream-status'),
					outcome: response.headers.get('x-playground-upstream-outcome'),
				}
				options.onMeta(meta)
				const audio =
					response.ok &&
					/^(audio\/|application\/octet-stream)/i.test(meta.contentType)
				if (!response.body) throw new PlaygroundError('invalid-response')
				const reader = response.body.getReader(),
					decoder = new TextDecoder(),
					chunks: ArrayBuffer[] = []
				let raw = '',
					received = 0
				try {
					while (true) {
						const chunk = await abortablePlayground(reader.read(), signal)
						if (chunk.done) break
						received += chunk.value.byteLength
						if (received > (audio ? 64 : 16) * 1024 * 1024)
							throw new PlaygroundError('invalid-response')
						if (audio) {
							const bytes = chunk.value.slice().buffer
							chunks.push(bytes)
							options.onAudioChunk?.(bytes, meta.contentType)
						} else {
							raw += decoder.decode(chunk.value, { stream: true })
							options.onRaw(raw)
						}
					}
					if (!audio) {
						raw += decoder.decode()
						options.onRaw(raw)
					}
					return {
						raw,
						meta,
						audio: audio ? new Blob(chunks, { type: meta.contentType }) : null,
					}
				} finally {
					void reader.cancel().catch(() => undefined)
					reader.releaseLock()
				}
			})
		},
	}
}
export type PlaygroundApi = ReturnType<typeof createPlaygroundApi>
export const playgroundApi = createPlaygroundApi()
