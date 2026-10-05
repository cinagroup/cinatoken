import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
	createPublicCatalogApi,
	PublicCatalogError,
	type PublicCatalogApi,
} from './catalog-api'
import type { CatalogStatsRange } from './catalog-contracts'
import type { PublicMessages } from './messages'
import {
	publicModelsQueryOptions,
	publicProvidersQueryOptions,
	publicModelQueryOptions,
	publicStatsQueryOptions,
} from './ssr/public-query-options'

export const publicCatalogApi = createPublicCatalogApi()
export function usePublicText() {
	const { t, i18n } = useTranslation()
	return {
		text: (
			key: keyof PublicMessages,
			values?: Record<string, string | number>
		) => t(`cinatoken.public.${key}`, values),
		locale: i18n.resolvedLanguage || 'en',
	}
}
export function catalogErrorKey(error: unknown): keyof PublicMessages {
	if (!(error instanceof PublicCatalogError)) return 'unavailable'
	if (error.code === 'invalid-response') return 'invalidResponse'
	if (error.code === 'timeout') return 'timeout'
	if (error.code === 'cancelled') return 'cancelled'
	if (error.status === 404) return 'notFound'
	if (error.status === 429) return 'rateLimited'
	return 'unavailable'
}
export function usePublicModels(api: PublicCatalogApi) {
	return useQuery(publicModelsQueryOptions(api))
}
export function usePublicProviders(api: PublicCatalogApi) {
	return useQuery(publicProvidersQueryOptions(api))
}
export function usePublicModel(
	api: PublicCatalogApi,
	vendor: string,
	slug: string
) {
	return useQuery(publicModelQueryOptions(api, vendor, slug))
}
export function usePublicStats(
	api: PublicCatalogApi,
	range: CatalogStatsRange
) {
	return useQuery(publicStatsQueryOptions(api, range))
}
