/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { QueryCache } from '@tanstack/react-query'

/** A failing query in another console domain must not revoke endpoint access. */
export function observeEndpointFailures(
	cache: QueryCache,
	prefix: readonly unknown[],
	notify: (error: unknown) => void
): () => void {
	return cache.subscribe((event) => {
		if (event.type !== 'updated' || event.query.queryKey.length < prefix.length)
			return
		if (
			!event.query.queryKey
				.slice(0, prefix.length)
				.every((value: unknown, index: number) => value === prefix[index])
		)
			return
		if (event.query.state.status === 'error') notify(event.query.state.error)
	})
}
