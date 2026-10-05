/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { PublicCatalogApi } from '../catalog-api'
import type { CatalogStatsRange } from '../catalog-contracts'

export const publicQueryDefaults = {
	staleTime: 60_000,
	gcTime: 5 * 60_000,
	retry: false,
	retryOnMount: false,
	refetchOnMount: false,
	refetchOnWindowFocus: false,
} as const

export function publicQuerySignal(
	signal: AbortSignal,
	requestSignal?: AbortSignal
): AbortSignal {
	return requestSignal ? AbortSignal.any([signal, requestSignal]) : signal
}

export function publicModelsQueryOptions(
	api: PublicCatalogApi,
	requestSignal?: AbortSignal,
	chat = false
) {
	// Cancellation controls transport lifetime, not the identity of public catalog data.
	// eslint-disable-next-line @tanstack/query/exhaustive-deps
	return {
		queryKey: ['cinatoken', 'public', chat ? 'chat-models' : 'models'] as const,
		queryFn: ({ signal }: { signal: AbortSignal }) =>
			api.models({}, { signal: publicQuerySignal(signal, requestSignal) }),
		...publicQueryDefaults,
	}
}

export function publicProvidersQueryOptions(
	api: PublicCatalogApi,
	requestSignal?: AbortSignal
) {
	// Cancellation controls transport lifetime, not the identity of public catalog data.
	// eslint-disable-next-line @tanstack/query/exhaustive-deps
	return {
		queryKey: ['cinatoken', 'public', 'providers'] as const,
		queryFn: ({ signal }: { signal: AbortSignal }) =>
			api.providers({ signal: publicQuerySignal(signal, requestSignal) }),
		...publicQueryDefaults,
	}
}

export function publicModelQueryOptions(
	api: PublicCatalogApi,
	vendor: string,
	slug: string,
	requestSignal?: AbortSignal
) {
	// Cancellation controls transport lifetime, not the identity of public catalog data.
	// eslint-disable-next-line @tanstack/query/exhaustive-deps
	return {
		queryKey: ['cinatoken', 'public', 'model', vendor, slug] as const,
		queryFn: ({ signal }: { signal: AbortSignal }) =>
			api.model(vendor, slug, {
				signal: publicQuerySignal(signal, requestSignal),
			}),
		...publicQueryDefaults,
	}
}

export function publicStatsQueryOptions(
	api: PublicCatalogApi,
	range: CatalogStatsRange,
	requestSignal?: AbortSignal
) {
	// Cancellation controls transport lifetime, not the identity of public catalog data.
	// eslint-disable-next-line @tanstack/query/exhaustive-deps
	return {
		queryKey: ['cinatoken', 'public', 'stats', range] as const,
		queryFn: ({ signal }: { signal: AbortSignal }) =>
			api.stats(range, { signal: publicQuerySignal(signal, requestSignal) }),
		...publicQueryDefaults,
	}
}
