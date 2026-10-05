/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** Bound read-only summary requests without retries; aborting a queued request removes it. */
export function createStickySummaryScheduler(limit = 6) {
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw new Error('invalid concurrency')
	let active = 0
	const waiting: (() => void)[] = []
	return async function schedule<T>(
		signal: AbortSignal,
		run: () => Promise<T>
	): Promise<T> {
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
		await new Promise<void>((resolve, reject) => {
			const abort = () => {
				const index = waiting.indexOf(start)
				if (index >= 0) waiting.splice(index, 1)
				reject(new DOMException('Aborted', 'AbortError'))
			}
			const start = () => {
				signal.removeEventListener('abort', abort)
				active++
				resolve()
			}
			if (active < limit) start()
			else {
				waiting.push(start)
				signal.addEventListener('abort', abort, { once: true })
			}
		})
		try {
			if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
			return await run()
		} finally {
			active--
			waiting.shift()?.()
		}
	}
}
