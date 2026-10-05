/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAdminToolsApi } from './tools-api'
import { toolEditorPayload, toolEditorDefaults } from './tools-editor-form'
import { ToolSubjectError, toolWriteUnknown } from './tools-errors'
import {
	fixtureDetail,
	fixtureOverview,
	fixtureAuth,
	fixtureSubject,
	fixtureAuditId,
	fixtureResponse,
	fixtureAudit,
} from './tools-fixtures'

const options = { expectedConsoleSubject: fixtureSubject }
function client(
	reply: (path: string, init: RequestInit) => Response | Promise<Response>
) {
	const calls: Array<{ path: string; init: RequestInit }> = []
	const api = createAdminToolsApi(async (input, init = {}) => {
		const path = String(input)
		calls.push({ path, init })
		return reply(path, init)
	})
	return { api, calls }
}
function payload() {
	const detail = fixtureDetail(),
		values = toolEditorDefaults(detail)
	values.reason = 'Operator checked engine'
	return toolEditorPayload(detail, values, 'save', false)
}
function preflightResponse(path: string): Response | null {
	if (path === '/api/auth/check')
		return new Response(JSON.stringify(fixtureAuth))
	if (path.endsWith('/detail')) return fixtureResponse(fixtureDetail())
	return null
}
test('ordinary overview/detail/audit do not fetch or return credential secrets', async () => {
	const { api, calls } = client((path) => {
		if (path.endsWith('overview'))
			return fixtureResponse({
				...fixtureOverview(),
				catalog: { apiKey: 'private' },
			})
		if (path.includes('/audit?')) return fixtureResponse(fixtureAudit())
		return fixtureResponse({ ...fixtureDetail(), value: 'private' })
	})
	assert.equal(
		JSON.stringify(await api.adminToolsOverview()).includes('private'),
		false
	)
	assert.equal(
		JSON.stringify(await api.adminToolDetail('web-search', 'bocha')).includes(
			'private'
		),
		false
	)
	await api.adminToolAudit('web-search', null)
	assert.equal(
		calls.every(
			(call) =>
				(call.init.method ?? 'GET') === 'GET' &&
				call.init.cache === 'no-store' &&
				call.init.credentials === 'same-origin' &&
				call.init.redirect === 'error'
		),
		true
	)
})
test('save binds fresh exact Console identity twice, current capabilities and encoded header', async () => {
	const { api, calls } = client((path) => {
		if (path === '/api/auth/check')
			return new Response(JSON.stringify(fixtureAuth))
		if (path.endsWith('/detail')) return fixtureResponse(fixtureDetail())
		return fixtureResponse({
			outcome: 'applied',
			auditId: fixtureAuditId,
			detail: fixtureDetail(),
		})
	})
	const result = await api.saveAdminTool(fixtureDetail(), payload(), options)
	assert.equal(result.outcome, 'applied')
	assert.deepEqual(
		calls.map((call) => call.path),
		[
			'/api/auth/check',
			'/api/admin/config/tools/web-search/providers/bocha/detail',
			'/api/auth/check',
			'/api/admin/config/tools/web-search/providers/bocha/save',
		]
	)
	assert.equal(
		new Headers(calls[3].init.headers).get(
			'X-CinaToken-Expected-Console-Subject'
		),
		encodeURIComponent(fixtureSubject)
	)
	assert.equal(
		JSON.parse(String(calls[3].init.body)).expected_version,
		fixtureDetail().version
	)
	assert.equal(calls[3].init.cache, 'no-store')
	assert.equal(calls[3].init.credentials, 'same-origin')
	assert.equal(calls[3].init.redirect, 'error')
})
test('subject mismatch, Bearer or degraded identity dispatch zero Tools writes', async () => {
	for (const auth of [
		{ ...fixtureAuth, subject: 'other' },
		{ ...fixtureAuth, principalType: 'api_key' },
		{ ...fixtureAuth, verification: 'degraded' },
		{ ...fixtureAuth, authenticated: false },
	]) {
		const { api, calls } = client(() => new Response(JSON.stringify(auth)))
		await assert.rejects(
			api.saveAdminTool(fixtureDetail(), payload(), options),
			ToolSubjectError
		)
		assert.equal(
			calls.some((call) => call.init.method === 'POST'),
			false
		)
	}
})
test('current capability revocation and malformed exact target reject before POST', async () => {
	for (const detail of [
		{
			...fixtureDetail(),
			capabilities: { ...fixtureDetail().capabilities, can_write: false },
		},
		{ ...fixtureDetail(), provider: 'jina' },
	]) {
		const { api, calls } = client((path) =>
			path === '/api/auth/check'
				? new Response(JSON.stringify(fixtureAuth))
				: fixtureResponse(detail)
		)
		await assert.rejects(api.saveAdminTool(fixtureDetail(), payload(), options))
		assert.equal(
			calls.some((call) => call.init.method === 'POST'),
			false
		)
	}
})
test('cancelled preflight ignores late auth and never posts', async () => {
	let deliver: (value: Response) => void = () => undefined
	const deferred = new Promise<Response>((resolve) => {
			deliver = resolve
		}),
		abort = new AbortController(),
		{ api, calls } = client(() => deferred)
	const pending = api.saveAdminTool(fixtureDetail(), payload(), {
		...options,
		signal: abort.signal,
	})
	abort.abort()
	deliver(new Response(JSON.stringify(fixtureAuth)))
	await assert.rejects(pending)
	assert.equal(calls.length, 1)
})
test('save malformed mutation UUID and contradictory outcome stay unknown; 409 does not retry', async () => {
	for (const response of [
		fixtureResponse({
			outcome: 'applied',
			auditId: 'audit-1',
			detail: fixtureDetail(),
		}),
		fixtureResponse({
			outcome: 'unchanged',
			auditId: fixtureAuditId,
			detail: fixtureDetail(),
		}),
		fixtureResponse({}, 409),
	]) {
		const { api, calls } = client((path) => preflightResponse(path) ?? response)
		let failure: unknown
		try {
			await api.saveAdminTool(fixtureDetail(), payload(), options)
		} catch (error) {
			failure = error
		}
		assert.ok(failure)
		assert.equal(toolWriteUnknown(failure), response.status === 200)
		assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1)
	}
})
test('reveal is explicit audited POST, local bounded payload and exact family/field/version', async () => {
	const secret = 'local-fixture-value',
		{ api, calls } = client(
			(path) =>
				preflightResponse(path) ??
				fixtureResponse({
					family: 'web-search',
					provider: 'bocha',
					field: 'apiKey',
					value: secret,
					version: fixtureDetail().version,
					auditId: fixtureAuditId,
					expiresInSeconds: 60,
				})
		)
	const value = await api.revealAdminTool(
		fixtureDetail(),
		{
			field: 'apiKey',
			expected_version: fixtureDetail().version,
			reason: 'Investigate credential',
		},
		options
	)
	assert.equal(value.value, secret)
	assert.equal(calls.at(-1)?.init.method, 'POST')
	assert.ok(calls.at(-1)?.path.endsWith('/reveal'))
	const invalid = client(
		(path) =>
			preflightResponse(path) ??
			fixtureResponse({ ...value, field: 'secretKey' })
	)
	await assert.rejects(
		invalid.api.revealAdminTool(
			fixtureDetail(),
			{
				field: 'apiKey',
				expected_version: fixtureDetail().version,
				reason: 'Investigate',
			},
			options
		)
	)
})
test('server error messages containing secrets are discarded, including business 2xx unknown', async () => {
	const { api } = client(
		() =>
			new Response(
				JSON.stringify({ success: false, message: 'raw-private-value' }),
				{ status: 200 }
			)
	)
	let failure: unknown
	try {
		await api.adminToolsOverview()
	} catch (error) {
		failure = error
	}
	assert.equal(String(failure).includes('raw-private'), false)
	assert.equal(toolWriteUnknown(failure), true)
})
test('reveal capability is independent of configuration write capability', async () => {
	const detail = fixtureDetail()
	detail.capabilities.can_write = false
	const { api, calls } = client((path) => {
		if (path === '/api/auth/check')
			return new Response(JSON.stringify(fixtureAuth))
		if (path.endsWith('/detail')) return fixtureResponse(detail)
		return fixtureResponse({
			family: detail.family,
			provider: detail.provider,
			field: 'apiKey',
			value: 'fictional-readable-value',
			version: detail.version,
			auditId: fixtureAuditId,
			expiresInSeconds: 60,
		})
	})
	assert.equal(
		(
			await api.revealAdminTool(
				detail,
				{
					field: 'apiKey',
					expected_version: detail.version,
					reason: 'Read for investigation',
				},
				options
			)
		).value,
		'fictional-readable-value'
	)
	assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1)
	assert.ok(calls.at(-1)?.path.endsWith('/reveal'))
})
test('raw reveal payload enforces the server UTF16 limit and malformed success remains unknown', async () => {
	for (const value of ['😀'.repeat(2049), 'secret\u200bhidden', ' padded ']) {
		const { api, calls } = client(
			(path) =>
				preflightResponse(path) ??
				fixtureResponse({
					family: 'web-search',
					provider: 'bocha',
					field: 'apiKey',
					value,
					version: fixtureDetail().version,
					auditId: fixtureAuditId,
					expiresInSeconds: 60,
				})
		)
		let failure: unknown
		try {
			await api.revealAdminTool(
				fixtureDetail(),
				{
					field: 'apiKey',
					expected_version: fixtureDetail().version,
					reason: 'Read for investigation',
				},
				options
			)
		} catch (error) {
			failure = error
		}
		assert.ok(failure)
		assert.equal(toolWriteUnknown(failure), true)
		assert.equal(String(failure).includes(value), false)
		assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1)
	}
})
test('server subject mismatch rejects the Cookie race without reflecting a subject or retrying', async () => {
	const { api, calls } = client(
		(path) =>
			preflightResponse(path) ??
			new Response(
				JSON.stringify({
					success: false,
					code: 'console_subject_mismatch',
					message: 'private subject',
				}),
				{ status: 403 }
			)
	)
	await assert.rejects(
		api.saveAdminTool(fixtureDetail(), payload(), options),
		ToolSubjectError
	)
	assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1)
})
