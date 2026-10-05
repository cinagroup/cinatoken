import assert from 'node:assert/strict'
import test from 'node:test'
import adminPermissions from '../../../../admin/lib/admin-permissions.ts'
import { validateAndNormalizeProviderEndpoints } from '../../../../core/src/provider-endpoints.ts'
import { PROVIDER_OPERATION_PERMISSIONS } from './provider-contracts.ts'
import { normalizeProviderEndpoints } from './provider-endpoints.ts'

const { getAdminAuthorizationDecision } = adminPermissions

test('browser endpoint normalization matches the real Core contract including all protocols and legacy Gemini actions', () => {
	const values = [
		null,
		'',
		{},
		'{"openai":{"base":"https://example.test/v1/"}}',
		{
			openai: {
				base: ' https://example.test/v1/ ',
				endpoints: {
					chat: 'https://example.test/chat',
					embeddings: 'https://example.test/embeddings',
					rerank: 'https://example.test/rerank',
				},
			},
			anthropic: { endpoints: { messages: 'https://example.test/messages' } },
			gemini: {
				base: 'https://example.test/v1beta',
				auth: 'bearer',
				endpoints: {
					'models.generate': 'https://example.test/{model}:{action}',
					generateContent: 'https://legacy.test/{model}:generateContent',
					streamGenerateContent:
						'https://legacy.test/{model}:streamGenerateContent',
				},
			},
			dashscope: {
				base: 'https://example.test/api/v1',
				endpoints: {
					'audio.transcriptions.tasks': 'https://example.test/tasks/{task_id}',
					'audio.realtime.inference': 'wss://example.test/realtime',
					'audio.realtime.session': 'ws://localhost/realtime',
					'audio.hotwords': 'https://example.test/hotwords',
					'audio.voices': 'https://example.test/voices',
				},
			},
		},
		{
			openai: {
				base: 'https://user:secret@example.test/?key=secret',
				ignored: 'not persisted',
			},
		},
		{ gemini: { auth: 'unsupported but empty configs are skipped' } },
	]
	for (const value of values)
		assert.deepEqual(
			normalizeProviderEndpoints(value),
			validateAndNormalizeProviderEndpoints(value)
		)
	for (const value of [
		[],
		'not-json',
		{ unknown: {} },
		{ openai: [] },
		{ openai: { base: 'ftp://example.test' } },
		{ openai: { base: 'https://example.test', auth: 'bearer' } },
		{ openai: { endpoints: { messages: 'https://example.test' } } },
		{
			gemini: {
				endpoints: { 'models.generate': 'https://example.test/{model}' },
			},
		},
		{
			gemini: {
				endpoints: { generateContent: 'https://example.test/no-placeholder' },
			},
		},
		{
			dashscope: {
				endpoints: {
					'audio.transcriptions.tasks': 'https://example.test/tasks',
				},
			},
		},
		{
			dashscope: {
				endpoints: {
					'audio.realtime.session': 'https://example.test/realtime',
				},
			},
		},
	]) {
		assert.throws(() => validateAndNormalizeProviderEndpoints(value))
		assert.throws(() => normalizeProviderEndpoints(value))
	}
})
test('declared provider operations match actual server permissions, including DashScope write and distinct reveal', () => {
	for (const [method, path, permission] of [
		['GET', '/admin/providers', PROVIDER_OPERATION_PERMISSIONS.read],
		[
			'GET',
			'/admin/providers/import/catalog',
			PROVIDER_OPERATION_PERMISSIONS.read,
		],
		[
			'GET',
			'/admin/providers/p/api-key',
			PROVIDER_OPERATION_PERMISSIONS.reveal,
		],
		['POST', '/admin/providers', PROVIDER_OPERATION_PERMISSIONS.write],
		['PATCH', '/admin/providers/p', PROVIDER_OPERATION_PERMISSIONS.write],
		['DELETE', '/admin/providers/p', PROVIDER_OPERATION_PERMISSIONS.write],
		[
			'POST',
			'/admin/providers/p/dashscope/hotwords',
			PROVIDER_OPERATION_PERMISSIONS.dashscope,
		],
	])
		assert.deepEqual(getAdminAuthorizationDecision(method, path), {
			kind: 'permission',
			permission,
		})
})
