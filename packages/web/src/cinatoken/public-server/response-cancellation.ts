/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** Service bindings may ignore cancellation. Bound the wait and dispose any late response body. */
export function abortablePublicResponse(
	task: Promise<Response>,
	signal: AbortSignal
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error('Public response cancelled'))
		if (signal.aborted) abort()
		else signal.addEventListener('abort', abort, { once: true })
		task.then(
			(response) => {
				signal.removeEventListener('abort', abort)
				if (signal.aborted) void response.body?.cancel().catch(() => undefined)
				else resolve(response)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort)
				reject(error)
			}
		)
	})
}

/** Even asset bindings may return a body which ignores the request signal. */
export async function readPublicBrowserShell(
	response: Response,
	signal: AbortSignal
): Promise<string> {
	if (!response.body) throw new TypeError('Missing public browser shell')
	const reader = response.body.getReader()
	let cancelled = false
	const cancel = () => {
		if (cancelled) return
		cancelled = true
		void reader.cancel().catch(() => undefined)
	}
	signal.addEventListener('abort', cancel, { once: true })
	let complete = false
	try {
		signal.throwIfAborted()
		const decoder = new TextDecoder('utf-8', { fatal: true })
		const parts: string[] = []
		let bytes = 0
		while (true) {
			const next = await new Promise<ReadableStreamReadResult<Uint8Array>>(
				(resolve, reject) => {
					const abort = () =>
						reject(new Error('Public browser shell cancelled'))
					signal.addEventListener('abort', abort, { once: true })
					if (signal.aborted) abort()
					reader
						.read()
						.then(resolve, reject)
						.finally(() => signal.removeEventListener('abort', abort))
						.catch(() => undefined)
				}
			)
			signal.throwIfAborted()
			if (next.done) break
			if (!(next.value instanceof Uint8Array))
				throw new TypeError('Invalid public browser shell')
			bytes += next.value.byteLength
			if (bytes > 1024 * 1024)
				throw new TypeError('Public browser shell exceeds byte budget')
			parts.push(decoder.decode(next.value, { stream: true }))
		}
		parts.push(decoder.decode())
		complete = true
		return parts.join('')
	} finally {
		signal.removeEventListener('abort', cancel)
		if (!complete) cancel()
		reader.releaseLock()
	}
}
