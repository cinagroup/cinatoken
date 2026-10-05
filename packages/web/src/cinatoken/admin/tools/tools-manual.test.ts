/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAdminToolsApi } from './tools-api'
import {
	fixtureAuth,
	fixtureSubject,
	fixtureOverview,
	fixtureDetail,
	fixtureAudit,
	fixtureResponse,
} from './tools-fixtures'
import { inspectToolRecovery, acknowledgeToolRecovery } from './tools-manual'
import { ToolWriteRecovery } from './tools-recovery'

const identity = JSON.stringify(['user', fixtureSubject, 1]),
	options = { expectedConsoleSubject: fixtureSubject }
function setup(
	change?: (
		path: string,
		count: number
	) => Response | Promise<Response> | undefined
) {
	const values = new Map<string, string>(),
		storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value)
			},
			removeItem: (key: string) => {
				values.delete(key)
			},
		}
	const store = new ToolWriteRecovery(storage, true),
		marker = store.markPending(identity, {
			family: 'web-search',
			provider: 'bocha',
			operation: 'save',
		}),
		calls: string[] = []
	const api = createAdminToolsApi(async (input, init = {}) => {
		const path = String(input)
		calls.push(path)
		assert.notEqual(init.method, 'POST')
		assert.equal(init.cache, 'no-store')
		const result = change?.(path, calls.length)
		if (result) return result
		if (path === '/api/auth/check')
			return new Response(JSON.stringify(fixtureAuth))
		if (path.endsWith('/overview')) return fixtureResponse(fixtureOverview())
		if (path.endsWith('/detail')) return fixtureResponse(fixtureDetail())
		return fixtureResponse(fixtureAudit())
	})
	return { store, marker, calls, api, values, storage }
}
test('manual evidence reads exact provider and family audit then a human ack permits only new review', async () => {
	const f = setup(),
		evidence = await inspectToolRecovery(
			f.api,
			f.store,
			identity,
			f.marker,
			options
		)
	assert.equal(f.store.status(identity), 'pending')
	assert.equal(evidence.detail.provider, 'bocha')
	assert.deepEqual(f.calls, [
		'/api/auth/check',
		'/api/admin/config/tools/overview',
		'/api/admin/config/tools/web-search/providers/bocha/detail',
		'/api/admin/config/tools/web-search/audit?limit=20',
	])
	await assert.rejects(
		acknowledgeToolRecovery(
			f.api,
			f.store,
			identity,
			f.marker,
			evidence,
			false,
			options
		)
	)
	assert.equal(f.store.status(identity), 'pending')
	await acknowledgeToolRecovery(
		f.api,
		f.store,
		identity,
		f.marker,
		evidence,
		true,
		options
	)
	assert.equal(f.store.status(identity), 'ready')
	assert.deepEqual(f.calls.slice(-3), [
		'/api/auth/check',
		'/api/admin/config/tools/overview',
		'/api/auth/check',
	])
	assert.equal(
		[...f.values.values()].some(
			(raw) => raw.includes('reason') || raw.includes('version":"')
		),
		false
	)
})
test('401/403 capability read, false capability, malformed overview or wrong family audit never unlock', async () => {
	for (const mode of ['401', '403', 'caps', 'malformed', 'audit']) {
		const f = setup((path) => {
			if (path.endsWith('/overview')) {
				if (mode === '401' || mode === '403')
					return fixtureResponse({}, Number(mode))
				if (mode === 'caps') {
					const data = fixtureOverview()
					data.capabilities.can_write = false
					return fixtureResponse(data)
				}
				if (mode === 'malformed') return fixtureResponse({})
			}
			if (mode === 'audit' && path.includes('/audit?'))
				return fixtureResponse(fixtureAudit('web-fetch'))
			return undefined
		})
		await assert.rejects(
			inspectToolRecovery(f.api, f.store, identity, f.marker, options)
		)
		assert.equal(
			new ToolWriteRecovery(f.storage, true).status(identity),
			'pending'
		)
	}
})
test('permission or subject loss during final acknowledgement retains generation', async () => {
	let revoked = false
	const f = setup((path) => {
		if (revoked && path.endsWith('/overview')) {
			const data = fixtureOverview()
			data.capabilities.can_write = false
			return fixtureResponse(data)
		}
		return undefined
	})
	const evidence = await inspectToolRecovery(
		f.api,
		f.store,
		identity,
		f.marker,
		options
	)
	revoked = true
	await assert.rejects(
		acknowledgeToolRecovery(
			f.api,
			f.store,
			identity,
			f.marker,
			evidence,
			true,
			options
		)
	)
	assert.deepEqual(f.store.marker(identity), f.marker)
	let authCount = 0
	const other = setup((path) => {
		if (path === '/api/auth/check' && ++authCount === 3)
			return new Response(JSON.stringify({ ...fixtureAuth, subject: 'other' }))
		return undefined
	})
	const second = await inspectToolRecovery(
		other.api,
		other.store,
		identity,
		other.marker,
		options
	)
	await assert.rejects(
		acknowledgeToolRecovery(
			other.api,
			other.store,
			identity,
			other.marker,
			second,
			true,
			options
		)
	)
	assert.equal(other.store.status(identity), 'pending')
})
test('cancel late detail or ack auth cannot revive evidence, read audit or clear pending', async () => {
	let deliver: (value: Response) => void = () => undefined
	const held = new Promise<Response>((resolve) => {
			deliver = resolve
		}),
		f = setup((path) => (path.endsWith('/detail') ? held : undefined)),
		abort = new AbortController()
	const pending = inspectToolRecovery(f.api, f.store, identity, f.marker, {
		...options,
		signal: abort.signal,
	})
	while (!f.calls.some((path) => path.endsWith('/detail')))
		await new Promise((resolve) => setTimeout(resolve, 1))
	abort.abort()
	deliver(fixtureResponse(fixtureDetail()))
	await assert.rejects(pending)
	assert.equal(
		f.calls.some((path) => path.includes('/audit?')),
		false
	)
	assert.equal(f.store.status(identity), 'pending')
	let wait = false,
		finish: (value: Response) => void = () => undefined
	const deferred = new Promise<Response>((resolve) => {
			finish = resolve
		}),
		g = setup((path) =>
			wait && path === '/api/auth/check' ? deferred : undefined
		)
	const evidence = await inspectToolRecovery(
		g.api,
		g.store,
		identity,
		g.marker,
		options
	)
	wait = true
	const cancel = new AbortController(),
		ack = acknowledgeToolRecovery(
			g.api,
			g.store,
			identity,
			g.marker,
			evidence,
			true,
			{ ...options, signal: cancel.signal }
		)
	cancel.abort()
	finish(new Response(JSON.stringify(fixtureAuth)))
	await assert.rejects(ack)
	assert.equal(g.store.status(identity), 'pending')
})
test('captured generation cannot clear a marker changed while reading current evidence', async () => {
	const f = setup(),
		evidence = await inspectToolRecovery(
			f.api,
			f.store,
			identity,
			f.marker,
			options
		)
	f.store.settleKnown(identity, 'definitive-rejection', f.marker)
	const newer = f.store.markPending(identity, {
		family: 'web-fetch',
		provider: 'jina',
		operation: 'save_activate',
	})
	await assert.rejects(
		acknowledgeToolRecovery(
			f.api,
			f.store,
			identity,
			f.marker,
			evidence,
			true,
			options
		)
	)
	assert.deepEqual(f.store.marker(identity), newer)
})
