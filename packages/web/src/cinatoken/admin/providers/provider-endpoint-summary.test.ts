/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AdminProvider } from '../provider-contracts'
import {
	providerEndpointSearchTerms,
	summarizeProviderEndpoints,
} from './provider-endpoint-summary'
import { filterProviders } from './provider-form'

const source = {
	endpointsState: 'available' as const,
	endpoints: JSON.stringify({
		openai: {
			base: 'https://provider.example/v1',
			endpoints: {
				'audio.transcriptions': 'https://speech.example/transcribe',
			},
		},
		gemini: {
			endpoints: {
				'models.generate': 'https://gemini.example/{model}:{action}',
			},
		},
	}),
}

test('preview and search preserve safe protocol, capability and custom target URLs', () => {
	assert.deepEqual(summarizeProviderEndpoints(source).entries, [
		{
			protocol: 'openai',
			capability: 'base',
			url: 'https://provider.example/v1',
		},
		{
			protocol: 'openai',
			capability: 'audio.transcriptions',
			url: 'https://speech.example/transcribe',
		},
		{
			protocol: 'gemini',
			capability: 'models.generate',
			url: 'https://gemini.example/{model}:{action}',
		},
	])
	const row: AdminProvider = {
		...source,
		id: 'account-a',
		name: 'Account',
		vendor_key: 'custom',
		icon_key: 'custom',
		api_key: '***',
		status: 'active',
		description: 'Internal account',
		created_at: '2026-10-01T00:00:00Z',
		has_pending_key: false,
		routes_count: 1,
		active_routes_count: 1,
	}
	for (const q of [
		'GEMINI',
		'audio.transcriptions',
		'speech.example',
		'internal',
	])
		assert.deepEqual(filterProviders([row], { q, filter: 'all' }), [row])
	assert.deepEqual(
		filterProviders([row], { q: 'unrelated', filter: 'all' }),
		[]
	)
	assert.deepEqual(
		filterProviders([row], { q: 'speech.example', filter: 'disabled' }),
		[]
	)
})

test('unavailable and malformed endpoints cannot leak through a preview or search', () => {
	for (const endpointsState of ['redacted', 'invalid'] as const) {
		const input = { ...source, endpointsState }
		assert.deepEqual(summarizeProviderEndpoints(input), {
			state: endpointsState,
			entries: [],
		})
		assert.deepEqual(providerEndpointSearchTerms(input), [])
	}
	assert.deepEqual(
		summarizeProviderEndpoints({ ...source, endpoints: 'bad' }),
		{
			state: 'invalid',
			entries: [],
		}
	)
	assert.deepEqual(summarizeProviderEndpoints({ ...source, endpoints: null }), {
		state: 'available',
		entries: [],
	})
})

test('even a forged available state cannot expose endpoint credential values', () => {
	for (const base of [
		'https://user:private-secret@provider.example/v1',
		'https://provider.example/v1?api_key=private-secret',
		'https://provider.example/v1?X-Goog-Api-Key=private-secret',
	]) {
		const input = { ...source, endpoints: JSON.stringify({ openai: { base } }) }
		assert.deepEqual(summarizeProviderEndpoints(input), {
			state: 'redacted',
			entries: [],
		})
		assert.deepEqual(providerEndpointSearchTerms(input), [])
	}
})
