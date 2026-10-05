import type { QueryCache } from '@tanstack/react-query'
import type { ModelListContext } from '../model-contracts'

/** A retained 5xx cache is useful for recovery, but cannot prove the currency is still current. */
export function confirmedModelCurrency(
	data: ModelListContext | undefined,
	error: unknown,
	hidden: boolean
): string | null {
	if (hidden || error) return null
	return data?.billingCurrency ?? null
}

/** Only failures from the full current console/model namespace can clear this domain. */
export function observeModelFailures(
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
