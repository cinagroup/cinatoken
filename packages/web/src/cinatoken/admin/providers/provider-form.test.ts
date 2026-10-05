import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AdminProvider } from '../provider-contracts'
import {
	normalizeProviderEndpoints,
	PROVIDER_CAPABILITIES,
	PROVIDER_PROTOCOLS,
	type ProviderEndpoints,
} from '../provider-endpoints'
import {
	draftEndpoints,
	endpointDrafts,
	filterProviders,
	providerFormDefaults,
	providerFormInput,
	providerFormSchema,
	providerMatchesFilter,
} from './provider-form'

const row: AdminProvider = {
	id: 'provider-a',
	name: 'Alpha',
	vendor_key: 'custom',
	icon_key: 'custom',
	endpoints: JSON.stringify({
		openai: { base: 'https://provider.example/v1' },
	}),
	endpointsState: 'available',
	api_key: 'abc…1234',
	status: 'active',
	description: 'Speech account',
	shared_channel_type: null,
	created_at: '2026-09-27T00:00:00.000Z',
	has_pending_key: false,
	routes_count: 2,
	active_routes_count: 1,
}

test('all supported protocol capability URLs survive form editing including dotted paths', () => {
	const configured: ProviderEndpoints = {}
	for (const protocol of PROVIDER_PROTOCOLS) {
		const endpoints = Object.fromEntries(
			PROVIDER_CAPABILITIES[protocol].map((capability) => {
				let url = 'https://provider.example/' + capability
				if (protocol === 'gemini')
					url +=
						'/{model}' + (capability === 'models.generate' ? ':{action}' : '')
				if (capability === 'audio.transcriptions.tasks') url += '/{task_id}'
				if (capability.startsWith('audio.realtime.'))
					url = 'wss://provider.example/' + capability
				return [capability, url]
			})
		)
		configured[protocol] = { base: 'https://provider.example/', endpoints }
	}
	configured.gemini!.auth = 'bearer'
	const expected = normalizeProviderEndpoints(configured)
	const drafts = endpointDrafts(JSON.stringify(expected))
	assert.ok('images_edits' in drafts.openai.endpoints)
	assert.ok('audio_transcriptions_multimodal' in drafts.dashscope.endpoints)
	assert.deepEqual(draftEndpoints(drafts), expected)
})

test('editing other settings preserves unavailable endpoint configuration and blank credentials', () => {
	for (const endpointsState of ['redacted', 'invalid'] as const) {
		const values = providerFormDefaults('edit', {
			...row,
			endpointsState,
			endpoints: null,
		})
		values.description = 'New description'
		const input = providerFormInput(values)
		assert.equal(Object.hasOwn(input, 'endpoints'), false)
		assert.equal(Object.hasOwn(input, 'api_key'), false)
		assert.equal(Object.hasOwn(input, 'id'), false)
		assert.equal(input.description, 'New description')
	}
})

test('explicit replacement and clearing are distinct from preserving endpoints', () => {
	const values = providerFormDefaults('edit', {
		...row,
		endpointsState: 'redacted',
		endpoints: null,
	})
	values.endpointMode = 'replace'
	values.endpoints.gemini.base = 'https://provider.example/v1beta'
	values.endpoints.gemini.auth = 'query-key'
	assert.deepEqual(providerFormInput(values).endpoints, {
		gemini: { base: 'https://provider.example/v1beta', auth: 'query-key' },
	})
	values.endpointMode = 'clear'
	assert.equal(providerFormInput(values).endpoints, null)
})

test('cloning starts disabled with no copied credential or source ID and requires endpoint repair', () => {
	const values = providerFormDefaults('clone', {
		...row,
		endpointsState: 'redacted',
		endpoints: null,
	})
	assert.equal(values.id, '')
	assert.equal(values.status, 'disabled')
	assert.equal(values.api_key, '')
	assert.equal(providerFormSchema.safeParse(values).success, false)
	values.api_key = 'replacement-key'
	assert.equal(providerFormSchema.safeParse(values).success, false)
	values.endpointMode = 'clear'
	assert.equal(providerFormSchema.safeParse(values).success, true)
})

test('shared injection is a supported credential-free create path while empty manual keys are rejected', () => {
	const values = providerFormDefaults('create')
	values.name = 'Shared account'
	assert.equal(providerFormSchema.safeParse(values).success, false)
	values.shared_channel_type = 'deepseek'
	assert.equal(providerFormInput(values).shared_channel_type, 'deepseek')
	assert.equal(Object.hasOwn(providerFormInput(values), 'api_key'), false)
})

test('invalid IDs, URL templates and protocols fail before write submission', () => {
	const values = providerFormDefaults('edit', row)
	values.id = 'bad\u0000id'
	assert.equal(providerFormSchema.safeParse(values).success, false)
	values.id = 'x'.repeat(601)
	assert.equal(providerFormSchema.safeParse(values).success, false)
	values.id = row.id
	values.endpointMode = 'replace'
	values.endpoints.gemini.endpoints.models_generate =
		'https://provider.example/no-placeholders'
	assert.equal(providerFormSchema.safeParse(values).success, false)
	values.endpoints = endpointDrafts(null)
	values.endpoints.openai.base = 'javascript:alert(1)'
	assert.equal(providerFormSchema.safeParse(values).success, false)
})

test('safe filters keep malformed/redacted rows manageable and distinguish pending from disabled', () => {
	const pending = {
		...row,
		id: 'provider-pending',
		name: 'Beta',
		has_pending_key: true,
		status: 'active' as const,
	}
	const invalid = {
		...row,
		id: 'provider-invalid',
		name: 'Gamma',
		api_key: '(empty)',
		status: 'disabled' as const,
		endpointsState: 'invalid' as const,
		endpoints: null,
	}
	const rows = [invalid, pending, row]
	assert.deepEqual(
		filterProviders(rows, { q: ' SPEECH ', filter: 'all' }).map(
			(item) => item.id
		),
		[row.id, pending.id, invalid.id]
	)
	assert.equal(providerMatchesFilter(pending, 'pending'), true)
	assert.equal(providerMatchesFilter(pending, 'disabled'), false)
	assert.equal(providerMatchesFilter(invalid, 'no_key'), true)
	assert.equal(providerMatchesFilter(invalid, 'openai'), false)
	assert.deepEqual(
		filterProviders(rows, { q: '', filter: 'openai' }).map((item) => item.id),
		[row.id, pending.id]
	)
	assert.equal(rows[0], invalid)
})
