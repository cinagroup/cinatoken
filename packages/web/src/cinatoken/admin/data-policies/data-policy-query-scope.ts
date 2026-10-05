/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { QueryCache } from '@tanstack/react-query'

export function observeDataPolicyFailures(
	cache: QueryCache,
	prefix: readonly unknown[],
	onError: (error: unknown, key: readonly unknown[]) => void
): () => void {
	return cache.subscribe((event) => {
		if (event.type !== 'updated' || event.query.queryKey.length < prefix.length)
			return
		if (
			!event.query.queryKey
				.slice(0, prefix.length)
				.every((part: unknown, index: number) => part === prefix[index])
		)
			return
		if (event.query.state.status === 'error')
			onError(event.query.state.error, event.query.queryKey)
	})
}
