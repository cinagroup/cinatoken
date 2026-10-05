/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	hashKey,
	hydrate,
	type QueryClient,
	type QueryState,
} from '@tanstack/react-query'
import { PublicCatalogError } from '../catalog-api'
import type { PublicSnapshot } from './public-bootstrap'

export function publicSnapshotQueryKey(
	record: PublicSnapshot
): readonly string[] {
	if (record.kind === 'model')
		return ['cinatoken', 'public', 'model', record.vendor, record.slug]
	if (record.kind === 'stats')
		return ['cinatoken', 'public', 'stats', record.range]
	return ['cinatoken', 'public', record.kind]
}

/** Rebuild only typed public states. No errors, credentials or arbitrary query keys are transported. */
export function restorePublicQueries(
	client: QueryClient,
	records: readonly PublicSnapshot[]
): void {
	const queries = records.map((record) => {
		const queryKey = publicSnapshotQueryKey(record)
		const result = record.result
		const error =
			result.status === 'error'
				? new PublicCatalogError(
						result.error.code,
						result.error.status,
						result.error.retryAfter
					)
				: null
		const state: QueryState<unknown, Error> = {
			data: result.status === 'success' ? result.data : undefined,
			dataUpdateCount: result.status === 'success' ? 1 : 0,
			dataUpdatedAt: result.status === 'success' ? result.observedAt : 0,
			error,
			errorUpdateCount: error ? 1 : 0,
			errorUpdatedAt: error ? result.observedAt : 0,
			fetchFailureCount: error ? 1 : 0,
			fetchFailureReason: error,
			fetchMeta: null,
			isInvalidated: false,
			status: result.status,
			fetchStatus: 'idle',
		}
		return {
			queryKey,
			queryHash: hashKey(queryKey),
			state,
			dehydratedAt: result.observedAt,
		}
	})
	hydrate(client, { mutations: [], queries })
}
