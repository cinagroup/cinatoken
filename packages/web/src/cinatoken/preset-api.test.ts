import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenApi } from './api'
import type { PresetRequestOptions } from './preset-api'
import type { RequestPreset } from './preset-contracts'

const scope = {
	expectedWorkspaceId: 'organization:团队',
	expectedOwnerUserId: 'owner-1',
}
const row: RequestPreset = {
	id: 'preset-1',
	workspaceId: scope.expectedWorkspaceId,
	ownerUserId: scope.expectedOwnerUserId,
	slug: 'helpful',
	name: 'Helpful',
	description: null,
	visibility: 'private',
	status: 'active',
	designatedVersion: 2,
	latestVersion: 2,
	systemPrompt: '  Private instructions\n',
	config: {
		model: 'model-a',
		tools: [{ type: 'function', function: { name: 'lookup' } }],
	},
	createdAt: '2026-09-27T00:00:00Z',
	updatedAt: '2026-09-27T00:10:00Z',
	versionCreatedAt: '2026-09-27T00:10:00Z',
}
const collection = {
	success: true,
	data: {
		workspaceId: scope.expectedWorkspaceId,
		ownerUserId: scope.expectedOwnerUserId,
		presets: [row],
	},
}
const version = {
	id: 'version-1',
	version: 1,
	systemPrompt: row.systemPrompt,
	config: row.config,
	createdByUserId: null,
	createdAt: row.createdAt,
}
const history = {
	success: true,
	workspaceId: scope.expectedWorkspaceId,
	ownerUserId: scope.expectedOwnerUserId,
	presetId: row.id,
	data: [version],
}
function fixture(body: unknown = collection, status = 200) {
	const calls: { url: string; init: RequestInit }[] = []
	const api = createCinaTokenApi(async (url, init = {}) => {
		calls.push({ url: String(url), init })
		return Response.json(body, { status })
	})
	return { api, calls }
}
const invalid = (error: unknown) =>
	error instanceof CinaTokenApiError && error.code === 'invalid-response'
test('public Presets transport sends cookie-only no-store requests with the encoded workspace precondition', async () => {
	const { api, calls } = fixture()
	assert.deepEqual((await api.presetCollection(scope)).presets, [row])
	assert.equal(calls[0].url, '/api/user/presets')
	assert.equal(calls[0].init.credentials, 'same-origin')
	assert.equal(calls[0].init.cache, 'no-store')
	const headers = new Headers(calls[0].init.headers)
	assert.equal(
		headers.get('X-CinaToken-Workspace'),
		encodeURIComponent(scope.expectedWorkspaceId)
	)
	for (const key of ['Authorization', 'X-User-Id', 'X-API-Key'])
		assert.equal(headers.has(key), false)
})
test('empty collections and histories validate both owner and workspace independently of row membership', async () => {
	assert.deepEqual(
		(
			await fixture({
				...collection,
				data: { ...collection.data, presets: [] },
			}).api.presetCollection(scope)
		).presets,
		[]
	)
	await assert.rejects(
		fixture({
			...collection,
			data: { ...collection.data, ownerUserId: 'other', presets: [] },
		}).api.presetCollection(scope),
		invalid
	)
	await assert.rejects(
		fixture({
			...collection,
			data: { ...collection.data, workspaceId: 'other', presets: [] },
		}).api.presetCollection(scope),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'workspace-mismatch'
	)
	await assert.rejects(
		fixture({ ...history, presetId: 'other', data: [] }).api.presetVersions(
			row.id,
			scope
		),
		invalid
	)
	await assert.rejects(
		fixture({ ...history, ownerUserId: 'other', data: [] }).api.presetVersions(
			row.id,
			scope
		),
		invalid
	)
	assert.deepEqual(
		(await fixture({ ...history, data: [] }).api.presetVersions(row.id, scope))
			.data,
		[]
	)
})
test('foreign rows, duplicate IDs/slugs, unsafe configuration and duplicate versions never enter validated data', async () => {
	for (const presets of [
		[{ ...row, ownerUserId: 'other' }],
		[row, row],
		[row, { ...row, id: 'preset-2' }],
		[{ ...row, config: { tools: [{ Authorization: 'private-value' }] } }],
	])
		await assert.rejects(
			fixture({
				...collection,
				data: { ...collection.data, presets },
			}).api.presetCollection(scope),
			invalid
		)
	for (const data of [
		[version, version],
		[version, { ...version, id: 'version-2' }],
	])
		await assert.rejects(
			fixture({ ...history, data }).api.presetVersions(row.id, scope),
			invalid
		)
})
test('saving preserves prompt bytes and advanced configuration and confirms the new version is immediately active', async () => {
	const input = {
		slug: ' @preset/Helpful ',
		name: row.name,
		description: null,
		visibility: 'private' as const,
		systemPrompt: row.systemPrompt,
		config: row.config!,
	}
	const { api, calls } = fixture({ success: true, data: row }, 201)
	const saved = await api.savePresetVersion(input, scope)
	assert.equal(saved.designatedVersion, saved.latestVersion)
	assert.equal(saved.designatedVersion, 2)
	assert.equal(calls[0].init.method, 'POST')
	assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
		...input,
		slug: 'helpful',
	})
	for (const data of [
		{ ...row, designatedVersion: 1 },
		{ ...row, status: 'archived' },
		{ ...row, slug: 'another' },
	])
		await assert.rejects(
			fixture({ success: true, data }).api.savePresetVersion(input, scope),
			invalid
		)
})
test('metadata and historic designation use actual PATCH/POST semantics; DELETE archives without a response DTO', async () => {
	const renamed = { ...row, name: 'Renamed', visibility: 'public' }
	const metadata = fixture({ success: true, data: renamed })
	await metadata.api.updatePresetMetadata(
		row.id,
		{ name: 'Renamed', visibility: 'public' },
		scope
	)
	assert.equal(metadata.calls[0].init.method, 'PATCH')
	assert.equal(metadata.calls[0].url, '/api/user/presets/preset-1')
	const designation = fixture({
		success: true,
		data: { ...row, designatedVersion: 1 },
	})
	assert.equal(
		(await designation.api.designatePresetVersion(row.id, 1, scope))
			.latestVersion,
		2
	)
	assert.deepEqual(JSON.parse(String(designation.calls[0].init.body)), {
		version: 1,
	})
	assert.equal(designation.calls[0].url, '/api/user/presets/preset-1/designate')
	await assert.rejects(
		fixture({ success: true, data: row }).api.designatePresetVersion(
			row.id,
			1,
			scope
		),
		invalid
	)
	const archive = fixture({ success: true })
	assert.equal(await archive.api.archivePreset(row.id, scope), undefined)
	assert.equal(archive.calls[0].init.method, 'DELETE')
})
test('invalid scope and input fail before network writes', async () => {
	const { api, calls } = fixture()
	await assert.rejects(
		api.presetCollection({ ...scope, expectedWorkspaceId: '' })
	)
	await assert.rejects(
		api.presetCollection({ ...scope, expectedOwnerUserId: '' })
	)
	await assert.rejects(
		api.savePresetVersion(
			{ slug: 'bad/', systemPrompt: null, config: {} },
			scope
		)
	)
	await assert.rejects(
		api.savePresetVersion(
			{ slug: 'good', systemPrompt: null, config: { stream: true } },
			scope
		)
	)
	await assert.rejects(api.designatePresetVersion(row.id, 1.5, scope))
	await assert.rejects(api.updatePresetMetadata(row.id, {}, scope))
	assert.equal(calls.length, 0)
})
test('unconfirmed writes preserve typed status and safe conflict code while discarding echoed private configuration', async () => {
	const privateText = 'private-system-prompt-and-configuration'
	for (const [status, code] of [
		[409, 'workspace_mismatch'],
		[409, 'something_unknown'],
		[403, 'permission'],
		[500, null],
	] as const) {
		const { api, calls } = fixture(
			{ success: false, message: privateText, code },
			status
		)
		await assert.rejects(
			api.savePresetVersion(
				{ slug: 'good', systemPrompt: privateText, config: {} },
				scope
			),
			(error: unknown) => {
				assert.ok(error instanceof CinaTokenApiError)
				assert.equal(error.status, status)
				assert.equal(error.message.includes(privateText), false)
				assert.equal(
					error.code,
					code === 'workspace_mismatch' ? 'workspace-mismatch' : 'http'
				)
				return true
			}
		)
		assert.equal(calls.length, 1, 'writes must never retry automatically')
	}
})
test('all Presets read/write paths honor request cancellation', async () => {
	const operations: ((
		api: ReturnType<typeof createCinaTokenApi>,
		options: PresetRequestOptions
	) => Promise<unknown>)[] = [
		(api, options) => api.presetCollection(options),
		(api, options) => api.presetVersions(row.id, options),
		(api, options) =>
			api.savePresetVersion(
				{ slug: 'good', systemPrompt: row.systemPrompt, config: {} },
				options
			),
		(api, options) =>
			api.updatePresetMetadata(row.id, { name: 'Updated' }, options),
		(api, options) => api.designatePresetVersion(row.id, 1, options),
		(api, options) => api.archivePreset(row.id, options),
	]
	for (const operation of operations) {
		const controller = new AbortController()
		const api = createCinaTokenApi(async (_url, init) => {
			await new Promise((_, reject) =>
				init?.signal?.addEventListener('abort', () =>
					reject(new DOMException('Private upstream value', 'AbortError'))
				)
			)
			return Response.json(collection)
		})
		const request = operation(api, { ...scope, signal: controller.signal })
		controller.abort()
		await assert.rejects(
			request,
			(error: unknown) =>
				error instanceof CinaTokenApiError &&
				error.code === 'cancelled' &&
				!error.message.includes('Private')
		)
	}
})
