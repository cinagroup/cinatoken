/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ProviderEndpointsState } from '../provider-contracts'
import {
	normalizeProviderEndpoints,
	providerEndpointsHaveCredentials,
	PROVIDER_PROTOCOLS,
	type ProviderProtocol,
} from '../provider-endpoints'

export type ProviderEndpointSource = {
	endpoints: string | null
	endpointsState: ProviderEndpointsState
}
export type ProviderEndpointEntry = {
	protocol: ProviderProtocol
	capability: string
	url: string
}

/** Both search and previews use safe, normalized URLs; unavailable data stays hidden. */
export function summarizeProviderEndpoints(source: ProviderEndpointSource): {
	state: ProviderEndpointsState
	entries: ProviderEndpointEntry[]
} {
	if (source.endpointsState !== 'available')
		return { state: source.endpointsState, entries: [] }
	try {
		const normalized = normalizeProviderEndpoints(source.endpoints)
		if (providerEndpointsHaveCredentials(normalized))
			return { state: 'redacted', entries: [] }
		const entries: ProviderEndpointEntry[] = []
		for (const protocol of PROVIDER_PROTOCOLS) {
			const config = normalized[protocol]
			if (!config) continue
			if (config.base)
				entries.push({ protocol, capability: 'base', url: config.base })
			for (const [capability, url] of Object.entries(config.endpoints ?? {}))
				if (url) entries.push({ protocol, capability, url })
		}
		return { state: 'available', entries }
	} catch {
		return { state: 'invalid', entries: [] }
	}
}

export function providerEndpointSearchTerms(
	source: ProviderEndpointSource
): string[] {
	return summarizeProviderEndpoints(source).entries.flatMap((entry) => [
		entry.protocol,
		entry.capability,
		entry.url,
	])
}
