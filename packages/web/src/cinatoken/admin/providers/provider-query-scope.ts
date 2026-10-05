import type { QueryCache } from '@tanstack/react-query'

/** Unrelated or shorter cache keys must never revoke a console domain. */
export function observeProviderFailures(
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
