/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export type SimulatorAsyncTask = { id: string; receipt: string }
/** The opaque receipt is only retained in the mounted run owner, never a URL or a cache key. */
export function extractSimulatorAsyncTask(raw: string): {
	raw: string
	task?: SimulatorAsyncTask
} {
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			return { raw: '' }
		const body = parsed as Record<string, unknown>
		const output = body.output as Record<string, unknown> | undefined
		const id = output?.task_id
		const receipt = body.gateway_task_receipt
		delete body.gateway_task_receipt
		const safe = { raw: JSON.stringify(body) }
		if (
			typeof id !== 'string' ||
			!/^[A-Za-z0-9_-]{1,600}$/u.test(id) ||
			typeof receipt !== 'string' ||
			receipt.length > 8192 ||
			!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(receipt)
		)
			return safe
		return { ...safe, task: { id, receipt } }
	} catch {
		// A malformed or truncated response may already contain a complete receipt.
		// Retain no unparsed receipt-bearing text in the public result.
		return { raw: '' }
	}
}
