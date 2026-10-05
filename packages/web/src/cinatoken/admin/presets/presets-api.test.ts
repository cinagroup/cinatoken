/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import {
	adminDomainFixtureAck,
	adminDomainFixtureAuth,
	bindAdminDomainFixtureApi,
} from '../domain-api-test-fixture'
import { reviewAdminDomainUnknown } from '../domain-manual-recovery'
import {
	AdminDomainWriteError,
	type AdminDomainPendingMarker,
} from '../domain-write-recovery'
import { AdminPresetWriteRecovery } from './preset-write-recovery'
import { createAdminPresetsApi } from './presets-api'

const privateText = 'PRIVATE-PRESET-CONTENT'
const summary = {
	id: 'preset/one',
	workspaceId: 'workspace/one',
	ownerUserId: 'user/one',
	slug: 'coding',
	name: 'Coding',
	description: null,
	visibility: 'private',
	status: 'active',
	designatedVersion: 2,
	latestVersion: 3,
} as const
const version = {
	id: 'version/one',
	version: 2,
	createdAt: '2026-09-28T00:00:00.000Z',
	model: 'vendor/model',
} as const
type Call = { path: string; init: RequestInit }

function fixture(
	reply: (call: Call) => Response | Promise<Response>,
	options: {
		acknowledgement?: boolean
		identity?: (call: Call) => Response
	} = {}
) {
	const calls: Call[] = []
	const allCalls: Call[] = []
	const request: typeof fetch = async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		allCalls.push(call)
		const auth = adminDomainFixtureAuth(call.path)
		if (auth !== undefined)
			return options.identity?.(call) ?? Response.json(auth)
		calls.push(call)
		const response = await reply(call)
		if (!response.ok || options.acknowledgement === false) return response
		return Response.json(
			adminDomainFixtureAck(call.path, call.init, await response.json()),
			{ status: response.status, headers: response.headers }
		)
	}
	const transport = createCinaTokenCookieTransport(request)
	const api = createAdminPresetsApi({
		send(path, schema, init, options) {
			return transport.send(path, schema, init, options)
		},
		invalidResponse() {
			throw new CinaTokenApiError(
				'Invalid preset response',
				200,
				'invalid-response'
			)
		},
		sanitizeError(error) {
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'Preset operation could not be confirmed',
					error.status,
					error.code
				)
			return new Error('Preset operation could not be confirmed')
		},
	})
	return {
		api: bindAdminDomainFixtureApi(api, {
			listPresets: 0,
			listPresetVersions: 1,
			patchPreset: 2,
			designatePreset: 2,
		}),
		calls,
		allCalls,
	}
}

const invalid = (error: unknown): boolean =>
	(error instanceof CinaTokenApiError && error.code === 'invalid-response') ||
	(error instanceof AdminDomainWriteError &&
		error.code === 'unknown' &&
		error.status === 200)

test('summary list strips legacy prompt/config and uses same-origin Cookie transport only', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: [
				{
					...summary,
					systemPrompt: privateText,
					config: { secret: privateText },
				},
				{
					...summary,
					id: 'preset/two',
					workspaceId: 'workspace/two',
					ownerUserId: 'user/two',
					slug: 'coding',
					status: 'archived',
				},
			],
			count: 2,
			privateServerField: privateText,
		})
	)
	const rows = await api.listPresets({
		timeoutMs: 500,
		expectedWorkspaceId: privateText,
	} as never)
	assert.equal(rows.length, 2)
	assert.deepEqual(rows[0], summary)
	assert.equal(rows[1]?.workspaceId, 'workspace/two')
	assert.equal(JSON.stringify(rows).includes(privateText), false)
	assert.equal(calls[0]?.path, '/api/admin/presets/summaries')
	assert.equal(calls[0]?.init.credentials, 'same-origin')
	assert.equal(calls[0]?.init.cache, 'no-store')
	assert.equal(calls[0]?.init.method ?? 'GET', 'GET')
	const headers = new Headers(calls[0]?.init.headers)
	assert.equal(headers.get('Accept'), 'application/json')
	for (const name of ['Authorization', 'New-Api-User', 'X-CinaToken-Workspace'])
		assert.equal(headers.get(name), null)
})

test('summary list rejects wrong counts, duplicate IDs and invalid versions', async () => {
	for (const envelope of [
		{ data: [summary], count: 0 },
		{ data: [summary, summary], count: 2 },
		{
			data: [{ ...summary, designatedVersion: 4 }],
			count: 1,
		},
		{ data: [{ ...summary, status: 'other' }], count: 1 },
	])
		await assert.rejects(
			fixture(() =>
				Response.json({ success: true, ...envelope })
			).api.listPresets(),
			invalid
		)
})

test('version summaries bind to requested preset and discard legacy version content', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: {
				presetId: summary.id,
				versions: [
					{
						...version,
						systemPrompt: privateText,
						config: { key: privateText },
						createdByUserId: privateText,
					},
					{ ...version, id: 'version/two', version: 1, model: null },
				],
				total: 2,
			},
		})
	)
	const versions = await api.listPresetVersions(summary.id)
	assert.deepEqual(versions[0], version)
	assert.equal(versions[1]?.model, null)
	assert.equal(JSON.stringify(versions).includes(privateText), false)
	assert.equal(
		calls[0]?.path,
		'/api/admin/presets/preset%2Fone/version-summaries'
	)
	for (const data of [
		{ presetId: 'preset/other', versions: [version], total: 1 },
		{ presetId: summary.id, versions: [version], total: 2 },
		{ presetId: summary.id, versions: [version, version], total: 2 },
		{
			presetId: summary.id,
			versions: [version, { ...version, id: 'version/other' }],
			total: 2,
		},
	])
		await assert.rejects(
			fixture(() =>
				Response.json({ success: true, data })
			).api.listPresetVersions(summary.id),
			invalid
		)
})

test('PATCH sends only normalized metadata to the explicit summary view', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: {
				...summary,
				name: 'New name',
				description: null,
				visibility: 'public',
				systemPrompt: privateText,
				config: { secret: privateText },
			},
		})
	)
	const result = await api.patchPreset(summary.id, {
		name: ' New name ',
		description: ' ',
		visibility: 'public',
	})
	assert.equal(result.name, 'New name')
	assert.equal(JSON.stringify(result).includes(privateText), false)
	assert.equal(calls[0]?.path, '/api/admin/presets/preset%2Fone?view=summary')
	assert.equal(calls[0]?.init.method, 'PATCH')
	assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
		name: 'New name',
		description: null,
		visibility: 'public',
	})
	assert.equal(
		new Headers(calls[0]?.init.headers).get('Content-Type'),
		'application/json'
	)
	for (const patch of [
		{},
		{ ownerUserId: 'user/other' },
		{ workspaceId: 'workspace/other' },
		{ slug: 'other' },
		{ config: { model: 'other' } },
		{ systemPrompt: privateText },
		{ name: 'x'.repeat(129) },
	])
		await assert.rejects(
			api.patchPreset(summary.id, patch as never),
			/operation could not be confirmed/
		)
	assert.equal(calls.length, 1, 'invalid metadata must not reach fetch')
})

test('writes reject unconfirmed identities or versions without replaying the request', async () => {
	for (const data of [
		null,
		{ ...summary, id: 'preset/other', name: 'Changed' },
		{ ...summary, name: 'Unchanged' },
	]) {
		const { api, calls } = fixture(() => Response.json({ success: true, data }))
		await assert.rejects(
			api.patchPreset(summary.id, { name: 'Changed' }),
			invalid
		)
		assert.equal(calls.length, 1)
	}
	for (const data of [
		null,
		{ ...summary, id: 'preset/other', designatedVersion: 1 },
		{ ...summary, designatedVersion: 2 },
	]) {
		const { api, calls } = fixture(() => Response.json({ success: true, data }))
		await assert.rejects(api.designatePreset(summary.id, 1), invalid)
		assert.equal(calls.length, 1)
	}
})

test('designation sends one numeric version and handles a committed 503 as unknown outcome', async () => {
	const successful = fixture(() =>
		Response.json({
			success: true,
			data: { ...summary, designatedVersion: 1, systemPrompt: privateText },
		})
	)
	assert.equal(
		(await successful.api.designatePreset(summary.id, 1)).designatedVersion,
		1
	)
	assert.equal(successful.calls.length, 1)
	const { api, calls } = fixture(() =>
		Response.json({ success: false, message: privateText }, { status: 503 })
	)
	await assert.rejects(api.designatePreset(summary.id, 1), (error) => {
		assert.equal(error instanceof AdminDomainWriteError, true)
		if (!(error instanceof AdminDomainWriteError)) return false
		assert.equal(error.status, 503)
		assert.equal(error.code, 'unknown')
		assert.equal(error.message.includes(privateText), false)
		return true
	})
	assert.equal(calls.length, 1, 'SDK never replays a designation')
	assert.equal(
		calls[0]?.path,
		'/api/admin/presets/preset%2Fone/designate?view=summary'
	)
	assert.equal(calls[0]?.init.method, 'POST')
	assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { version: 1 })
	const before = calls.length
	await assert.rejects(
		api.designatePreset(summary.id, 0),
		/operation could not be confirmed/
	)
	assert.equal(calls.length, before)
})

test('each Preset write verifies the same subject and portal user immediately before dispatch', async () => {
	const { api, allCalls } = fixture((call) =>
		Response.json({
			success: true,
			data: {
				...summary,
				...(call.init.method === 'PATCH'
					? { name: 'Changed' }
					: { designatedVersion: 1 }),
			},
		})
	)
	await api.patchPreset(summary.id, { name: 'Changed' })
	await api.designatePreset(summary.id, 1)
	assert.deepEqual(
		allCalls.map((call) => call.path),
		[
			'/api/auth/check',
			'/api/user/me',
			'/api/admin/presets/preset%2Fone?view=summary',
			'/api/auth/check',
			'/api/user/me',
			'/api/admin/presets/preset%2Fone/designate?view=summary',
		]
	)
	for (const call of allCalls.filter((value) =>
		value.path.startsWith('/api/admin/')
	))
		assert.equal(
			new Headers(call.init.headers).get(
				'X-CinaToken-Expected-Console-Subject'
			),
			encodeURIComponent('fixture-subject')
		)
	const drift = fixture(
		() => {
			throw new Error('Subject drift must not dispatch a write')
		},
		{
			identity: () =>
				Response.json({
					authenticated: true,
					verification: 'verified',
					principalType: 'console',
					subject: 'different-subject',
				}),
		}
	)
	await assert.rejects(
		drift.api.patchPreset(summary.id, { name: 'Changed' }),
		(error) =>
			error instanceof AdminDomainWriteError && error.code === 'subject'
	)
	assert.equal(drift.calls.length, 0)
	assert.deepEqual(
		drift.allCalls.map((call) => call.path),
		['/api/auth/check']
	)
})

test('bound reads carry the raw Console subject and writes reject a changed row scope', async () => {
	const reading = fixture(() =>
		Response.json({ success: true, data: [summary], count: 1 })
	)
	await reading.api.listPresets({
		expectedConsoleSubject: '控制台/主体',
		expectedUserId: 'fixture-user',
	})
	assert.equal(
		new Headers(reading.calls[0]?.init.headers).get(
			'X-CinaToken-Expected-Console-Subject'
		),
		encodeURIComponent('控制台/主体')
	)
	for (const changed of [
		{ workspaceId: 'workspace/other' },
		{ ownerUserId: 'user/other' },
		{ slug: 'other' },
	]) {
		const writing = fixture(() =>
			Response.json({
				success: true,
				data: { ...summary, name: 'Changed', ...changed },
			})
		)
		await assert.rejects(
			writing.api.patchPreset(
				summary.id,
				{ name: 'Changed' },
				{ expectedPreset: summary }
			),
			invalid
		)
		assert.equal(writing.calls.length, 1)
	}
})

test('a missing ACK survives new SDK/store instances and GET200 until two fresh reviews and generation CAS', async () => {
	const values = new Map<string, string>()
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value)
		},
		removeItem: (key: string) => {
			values.delete(key)
		},
	}
	const identity = JSON.stringify(['fixture-user', 'fixture-subject', 1])
	const store = new AdminPresetWriteRecovery(storage)
	let marker: AdminDomainPendingMarker | null = null
	const first = fixture(
		() =>
			Response.json({ success: true, data: { ...summary, name: 'Changed' } }),
		{ acknowledgement: false }
	)
	await assert.rejects(
		first.api.patchPreset(
			summary.id,
			{ name: 'Changed' },
			{
				onDispatch: (operation) => {
					marker = store.markPending(identity, 'presets', operation)
				},
			}
		),
		(error) =>
			error instanceof AdminDomainWriteError && error.code === 'unknown'
	)
	assert.equal(first.calls.length, 1)
	const reloaded = new AdminPresetWriteRecovery(storage)
	const second = fixture(() =>
		Response.json({
			success: true,
			data: [{ ...summary, name: 'Changed' }],
			count: 1,
		})
	)
	await second.api.listPresets()
	assert.equal(reloaded.status(identity, 'presets'), 'pending')
	assert.deepEqual(reloaded.marker(identity, 'presets'), marker)
	assert.deepEqual(Object.keys(JSON.parse([...values.values()][0]!)).sort(), [
		'domain',
		'generation',
		'operation',
		'version',
	])
	const options = {
		expectedConsoleSubject: 'fixture-subject',
		expectedUserId: 'fixture-user',
	}
	await reviewAdminDomainUnknown({
		options,
		verify: second.api.verifyAdminDomainSubject,
		observe: second.api.listPresets,
		reviewedExternal: true,
		acceptsUnknown: true,
	})
	assert.equal(
		reloaded.status(identity, 'presets'),
		'pending',
		'protocol alone must not clear a marker'
	)
	assert.deepEqual(
		second.allCalls.slice(1).map((call) => call.path),
		[
			'/api/auth/check',
			'/api/user/me',
			'/api/admin/presets/summaries',
			'/api/auth/check',
			'/api/user/me',
		]
	)
	assert.ok(marker)
	reloaded.acknowledgeUnknown(identity, marker)
	assert.equal(reloaded.status(identity, 'presets'), 'ready')
	assert.equal(
		first.calls.length,
		1,
		'recovery never replays the unknown write'
	)
})

test('storage failure prevents the Preset dispatch after fresh identity checks', async () => {
	const store = new AdminPresetWriteRecovery({
		getItem: () => null,
		setItem: () => {
			throw new Error(privateText)
		},
		removeItem: () => undefined,
	})
	const { api, calls, allCalls } = fixture(() => {
		throw new Error('Storage failure must not dispatch')
	})
	await assert.rejects(
		api.patchPreset(
			summary.id,
			{ name: 'Changed' },
			{
				onDispatch: (operation) => {
					store.markPending(
						JSON.stringify(['fixture-user', 'fixture-subject', 1]),
						'presets',
						operation
					)
				},
			}
		),
		(error) =>
			error instanceof AdminDomainWriteError &&
			error.code === 'storage' &&
			!error.message.includes(privateText)
	)
	assert.equal(calls.length, 0)
	assert.deepEqual(
		allCalls.map((call) => call.path),
		['/api/auth/check', '/api/user/me']
	)
})

test('an aborted Preset owner cannot consume a delayed legal ACK or clear its persisted generation', async () => {
	const values = new Map<string, string>()
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value)
		},
		removeItem: (key: string) => {
			values.delete(key)
		},
	}
	const identity = JSON.stringify(['fixture-user', 'fixture-subject', 1])
	const store = new AdminPresetWriteRecovery(storage)
	let dispatch!: () => void
	const dispatched = new Promise<void>((resolve) => {
		dispatch = resolve
	})
	let release!: () => void
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	const delayed = fixture(async () => {
		dispatch()
		await held
		return Response.json({
			success: true,
			data: { ...summary, name: 'Changed' },
		})
	})
	const abort = new AbortController()
	const writing = delayed.api.patchPreset(
		summary.id,
		{ name: 'Changed' },
		{
			signal: abort.signal,
			onDispatch: (operation) => {
				store.markPending(identity, 'presets', operation)
			},
		}
	)
	const rejected = assert.rejects(writing)
	await dispatched
	const marker = store.marker(identity, 'presets')
	assert.ok(marker)
	assert.equal(store.status(identity, 'presets'), 'pending')
	abort.abort()
	release()
	await rejected
	assert.equal(delayed.calls.length, 1)
	const reloaded = new AdminPresetWriteRecovery(storage)
	assert.deepEqual(reloaded.marker(identity, 'presets'), marker)
	const reading = fixture(() =>
		Response.json({
			success: true,
			data: [{ ...summary, name: 'Changed' }],
			count: 1,
		})
	)
	await reading.api.listPresets()
	assert.deepEqual(reloaded.marker(identity, 'presets'), marker)
	assert.equal(reloaded.status(identity, 'presets'), 'pending')
	assert.equal(
		delayed.calls.length,
		1,
		'an aborted owner never replays a write'
	)
})
