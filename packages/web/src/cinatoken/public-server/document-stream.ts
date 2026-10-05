/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** Compose the static document around the app stream and own its reader lifetime. */
export function publicDocumentBody(
	stream: ReadableStream<Uint8Array>,
	prefix: Uint8Array,
	suffix: Uint8Array,
	finish: () => void,
	abort: (reason: unknown) => void
): ReadableStream<Uint8Array> {
	const reader = stream.getReader()
	let prefixSent = false
	let closed = false
	function settle(reason?: unknown, cancel = false) {
		if (closed) return
		closed = true
		try {
			const cancellation = cancel ? reader.cancel(reason) : undefined
			if (cancel) abort(reason)
			return cancellation
		} finally {
			try {
				reader.releaseLock()
			} finally {
				finish()
			}
		}
	}
	return new ReadableStream<Uint8Array>({
		async pull(target) {
			if (closed) return
			try {
				if (!prefixSent) {
					prefixSent = true
					target.enqueue(prefix)
					return
				}
				const item = await reader.read()
				if (closed) return
				if (item.done) {
					target.enqueue(suffix)
					settle()
					target.close()
				} else target.enqueue(item.value)
			} catch (error) {
				if (closed) return
				void settle(error, true)?.catch(() => undefined)
				target.error(error)
			}
		},
		cancel(reason) {
			return settle(reason, true)
		},
	})
}
