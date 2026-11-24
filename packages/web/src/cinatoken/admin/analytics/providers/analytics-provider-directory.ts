/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { queryOptions } from '@tanstack/react-query'
import { CinaTokenApiError } from '../../../api'
import { configAccessIdentityKey } from '../../config/config-access-recovery'
import type { ProvidersApi } from '../../provider-api'

export type AnalyticsProviderEntry = {
	id: string
	name: string
	kind?: string
	kind_labels?: { en: string; zh: string }
}
export type AnalyticsProviderDirectory =
	| { status: 'ready'; providers: ReadonlyMap<string, AnalyticsProviderEntry> }
	| { status: 'loading' | 'unavailable' }
export type AnalyticsProviderDirectoryInput = {
	api?: Pick<ProvidersApi, 'providerList'>
	subject?: string
	scopeKey: string
	reconciliationKey: string
	enabled: boolean
}
type DirectoryRead = {
	directory: AnalyticsProviderDirectory
	identityInvalid: boolean
}
const unavailable: AnalyticsProviderDirectory = { status: 'unavailable' }
const loading: AnalyticsProviderDirectory = { status: 'loading' }
const apiIds = new WeakMap<object, number>()
let nextApiId = 0
function apiIdentity(api: object | undefined): number {
	if (!api) return 0
	let id = apiIds.get(api)
	if (id === undefined) {
		id = ++nextApiId
		apiIds.set(api, id)
	}
	return id
}

/** The existing providerList boundary validates the complete collection first. */
export async function readAnalyticsProviderDirectory(
	api: Pick<ProvidersApi, 'providerList'>,
	subject: string,
	signal: AbortSignal
): Promise<AnalyticsProviderDirectory> {
	signal.throwIfAborted()
	const rows = await api.providerList({
		expectedConsoleSubject: subject,
		signal,
	})
	signal.throwIfAborted()
	const providers = new Map<string, AnalyticsProviderEntry>()
	for (const row of rows) {
		const entry: AnalyticsProviderEntry = { id: row.id, name: row.name }
		if (row.kind !== undefined) entry.kind = row.kind
		if (row.kind_labels !== undefined)
			entry.kind_labels = {
				en: row.kind_labels.en,
				zh: row.kind_labels.zh,
			}
		providers.set(entry.id, entry)
	}
	return { status: 'ready', providers }
}

export function analyticsProviderDirectoryQueryOptions(
	input: AnalyticsProviderDirectoryInput,
	instanceKey = ''
) {
	const api = input.api
	const subject = input.subject
	const enabled = input.enabled && api !== undefined && Boolean(subject)
	const options = queryOptions({
		queryKey: [
			'cinatoken',
			'admin',
			input.scopeKey,
			'analyticsProviderDirectory',
			input.reconciliationKey,
			subject ?? null,
			apiIdentity(api),
			enabled,
			instanceKey,
		] as const,
		enabled,
		queryFn: async ({ signal }): Promise<DirectoryRead> => {
			if (!enabled || !api || !subject)
				return { directory: unavailable, identityInvalid: false }
			try {
				return {
					directory: await readAnalyticsProviderDirectory(api, subject, signal),
					identityInvalid: false,
				}
			} catch (error) {
				// An ignored abort must not replace a newer identity's directory or recheck it.
				signal.throwIfAborted()
				return {
					directory: unavailable,
					identityInvalid:
						error instanceof CinaTokenApiError &&
						error.code === 'http' &&
						error.status === 401,
				}
			}
		},
		retry: false,
		gcTime: 0,
		staleTime: 0,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	})
	return { ...options, enabled }
}

export function visibleAnalyticsProviderDirectory(input: {
	enabled: boolean
	isFetching: boolean
	isPending: boolean
	error: unknown
	data?: DirectoryRead
}): AnalyticsProviderDirectory {
	if (!input.enabled) return unavailable
	if (input.isFetching || input.isPending) return loading
	if (input.error) return unavailable
	return input.data?.directory ?? unavailable
}

/** Portal epochs change during revalidation; the denied principal remains the same. */
export class AnalyticsProviderDirectoryRechecks {
	private readonly checked = new Set<string>()
	reserve(reconciliationKey: string, subject: string): boolean {
		const key = JSON.stringify([
			configAccessIdentityKey(reconciliationKey),
			subject,
		])
		if (this.checked.has(key)) return false
		this.checked.add(key)
		return true
	}
}
