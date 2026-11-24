/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	buildMcpClientRequest,
	executeMcpClient,
	groupMcpClientEntries,
	MCP_CLIENT_METHODS,
	MCP_CLIENT_VERSIONS,
	McpClientError,
	mcpClientBase,
	mcpClientCurl,
	normalizeMcpClientSecret,
	parseMcpClientResponse,
	type McpClientMethod,
	type McpClientRequest,
} from './mcp-client'

const secret = 'sk-' + 'A'.repeat(32)
const maxBytes = 8 * 1024 * 1024
function request(
	method: McpClientMethod = 'tools/list',
	slug = ''
): McpClientRequest {
	return buildMcpClientRequest({
		base: 'https://proxy.example.test',
		slug,
		method,
		version: '2025-06-18',
		id: 17,
	})
}
function envelope(result: unknown, id: number | string | null = 17): string {
	return JSON.stringify({ jsonrpc: '2.0', id, result })
}
function code(expected: McpClientError['code']): (error: unknown) => boolean {
	return (error) => error instanceof McpClientError && error.code === expected
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

test('catalog client builds exactly four readonly methods for aggregate and scoped Proxy endpoints', () => {
	assert.deepEqual(MCP_CLIENT_METHODS, [
		'initialize',
		'tools/list',
		'prompts/list',
		'resources/list',
	])
	for (const version of MCP_CLIENT_VERSIONS)
		for (const slug of ['', 'deep-wiki'])
			for (const method of MCP_CLIENT_METHODS) {
				const built = buildMcpClientRequest({
					base: 'https://proxy.example.test/gateway/',
					slug,
					method,
					version,
					id: 1,
				})
				assert.equal(
					built.url,
					'https://proxy.example.test/gateway/mcp' + (slug ? '/deep-wiki' : '')
				)
				assert.equal(built.method, 'POST')
				assert.equal(built.headers.Authorization, 'Bearer ***')
				assert.equal(built.headers['MCP-Protocol-Version'], version)
				const body = JSON.parse(built.bodyText)
				assert.equal(body.jsonrpc, '2.0')
				assert.equal(body.id, 1)
				assert.equal(body.method, method)
				assert.deepEqual(
					body.params,
					method === 'initialize'
						? {
								protocolVersion: version,
								capabilities: {},
								clientInfo: {
									name: 'cinatoken-web-catalog-test',
									version: '1.0.0',
								},
							}
						: {}
				)
			}
	for (const method of [
		'tools/call',
		'prompts/get',
		'resources/read',
		'notifications/initialized',
		'TOOLS/LIST',
	])
		assert.throws(() => request(method as McpClientMethod), code('invalid'))
})
test('client base and secret validation reject credential-bearing or ambiguous destinations and masked keys', () => {
	assert.equal(
		mcpClientBase(' http://127.0.0.1:8787/// '),
		'http://127.0.0.1:8787'
	)
	for (const base of [
		'file:///tmp',
		'javascript:alert(1)',
		'https://user:secret@proxy.test',
		'https://proxy.test?key=secret',
		'https://proxy.test/#secret',
		'https://proxy.test/mcp',
		'https://proxy.test/mcp/wiki/',
		'https://proxy.test/\npath',
		'x'.repeat(2_049),
	])
		assert.equal(mcpClientBase(base), null)
	assert.equal(normalizeMcpClientSecret('  bearer ' + secret + '  '), secret)
	for (const key of [
		'Bearer ***',
		'sk-***masked',
		'token',
		'sk-key\nCookie: private',
		'sk-' + 'a'.repeat(4_097),
	])
		assert.throws(() => normalizeMcpClientSecret(key), code('invalid'))
	for (const change of [
		{ slug: 'builtin' },
		{ slug: '../wiki' },
		{ id: 0 },
		{ id: 1.5 },
		{ id: Infinity },
		{ version: 'future' },
	])
		assert.throws(
			() =>
				buildMcpClientRequest({
					base: 'https://proxy.test',
					slug: '',
					method: 'initialize',
					version: '2025-06-18',
					id: 1,
					...change,
				}),
			code('invalid')
		)
})
test('RPC successes validate initialize and every method-specific list, including empty catalogs', () => {
	const initialization = {
		protocolVersion: '2025-06-18',
		capabilities: { tools: {} },
		serverInfo: { name: 'CinaToken', version: '1' },
	}
	assert.equal(
		parseMcpClientResponse(envelope(initialization), request('initialize'))
			.valid,
		true
	)
	for (const [method, field, entry] of [
		[
			'tools/list',
			'tools',
			{ name: 'deep-wiki__ask', inputSchema: { type: 'object' } },
		],
		['prompts/list', 'prompts', { name: 'deep-wiki__explain' }],
		[
			'resources/list',
			'resources',
			{ uri: 'octafuse://deep-wiki/docs%3A%2F%2Fintro' },
		],
	] as const) {
		const parsed = parseMcpClientResponse(
			envelope({ [field]: [entry] }),
			request(method)
		)
		assert.equal(parsed.valid, true)
		assert.deepEqual(parsed.entries, [entry])
		assert.equal(parsed.rpcError, false)
		assert.deepEqual(
			parseMcpClientResponse(envelope({ [field]: [] }), request(method))
				.entries,
			[]
		)
	}
	for (const result of [
		{},
		{ ...initialization, protocolVersion: 'future' },
		{ ...initialization, serverInfo: {} },
		{ ...initialization, capabilities: [] },
	])
		assert.equal(
			parseMcpClientResponse(envelope(result), request('initialize')).valid,
			false
		)
})
test('invalid JSON, RPC versions, wrong IDs, mixed result/error and malformed list entries never become successful catalogs', () => {
	for (const raw of [
		'not JSON',
		'data: {}\n\n',
		'null',
		'[]',
		envelope({ tools: [] }, '17'),
		envelope({ tools: [] }, 18),
		envelope({ tools: [] }, null),
		JSON.stringify({ jsonrpc: '1.0', id: 17, result: { tools: [] } }),
		JSON.stringify({
			jsonrpc: '2.0',
			id: 17,
			result: { tools: [] },
			error: { code: -1, message: 'bad' },
		}),
		envelope({ tools: {} }),
		envelope({ tools: [null] }),
		envelope({ tools: [{ name: '' }] }),
		envelope({ tools: [{ name: 1 }] }),
		envelope({ prompts: [] }),
		envelope({ tools: [], nextCursor: 1 }),
		envelope({ tools: Array(25_001).fill({ name: 'x' }) }),
	]) {
		const parsed = parseMcpClientResponse(raw, request())
		assert.equal(parsed.valid, false)
		assert.equal(parsed.entries, null)
		assert.equal(parsed.rpcError, false)
	}
	assert.equal(
		parseMcpClientResponse(envelope({ tools: [] }), {
			id: 17,
			rpcMethod: 'tools/call' as McpClientMethod,
		}).valid,
		false
	)
})
test('RPC error classification requires the matching request ID and an integer code plus message', () => {
	const error = {
		code: -32601,
		message: 'Unsupported method',
		data: { authorization: 'private' },
	}
	const parsed = parseMcpClientResponse(
		JSON.stringify({ jsonrpc: '2.0', id: 17, error }),
		request()
	)
	assert.equal(parsed.valid, false)
	assert.equal(parsed.rpcError, true)
	assert.doesNotMatch(JSON.stringify(parsed.json), /private/u)
	for (const invalid of [
		{ id: 18, error },
		{ id: 17, error: { code: 0.5, message: 'bad' } },
		{ id: 17, error: { code: -1 } },
		{ id: 17, error: null },
	])
		assert.equal(
			parseMcpClientResponse(
				JSON.stringify({ jsonrpc: '2.0', ...invalid }),
				request()
			).rpcError,
			false
		)
})
test('tampered RPC bodies, methods, targets and headers are rejected before fetch and cURL generation', async () => {
	let calls = 0
	const mutations: Array<(value: McpClientRequest) => void> = [
		(value) => {
			value.bodyText = JSON.stringify({
				jsonrpc: '2.0',
				id: 17,
				method: 'tools/call',
				params: { name: 'charged' },
			})
		},
		(value) => {
			value.bodyText = value.bodyText.replace(
				'"params": {}',
				'"params": {"cursor":"custom"}'
			)
		},
		(value) => {
			value.method = 'GET' as 'POST'
		},
		(value) => {
			value.rpcMethod = 'tools/call' as McpClientMethod
		},
		(value) => {
			value.url += '?secret=private'
		},
		(value) => {
			value.slug = 'foreign'
		},
		(value) => {
			value.id++
		},
		(value) => {
			value.headers.Cookie = 'session=private'
		},
		(value) => {
			value.headers.Authorization = 'Bearer ' + secret
		},
		(value) => {
			value.headers['MCP-Protocol-Version'] = 'future'
		},
	]
	for (const mutate of mutations) {
		const built = request()
		mutate(built)
		await assert.rejects(
			executeMcpClient(built, secret, {
				fetch: async () => {
					calls++
					return Response.json({})
				},
			}),
			code('invalid')
		)
		assert.throws(() => mcpClientCurl(built), code('invalid'))
	}
	assert.equal(calls, 0)
})
test('dispatch uses fresh safe headers without cookies or redirects and owns a mutation-proof request snapshot', async () => {
	const original = request(),
		originalBody = original.bodyText
	let calls = 0
	const result = await executeMcpClient(original, 'Bearer ' + secret, {
		fetch: async (url, init) => {
			calls++
			assert.equal(url, 'https://proxy.example.test/mcp')
			assert.equal(init?.method, 'POST')
			assert.equal(init?.body, originalBody)
			assert.equal(init?.credentials, 'omit')
			assert.equal(init?.redirect, 'error')
			assert.equal(init?.cache, 'no-store')
			assert.equal(init?.referrerPolicy, 'no-referrer')
			const headers = new Headers(init?.headers)
			assert.deepEqual(Array.from(headers.keys()).sort(), [
				'accept',
				'authorization',
				'content-type',
				'mcp-protocol-version',
			])
			assert.equal(headers.get('authorization'), 'Bearer ' + secret)
			original.headers.Authorization = 'Bearer tampered'
			original.bodyText = 'tools/call'
			original.id = 999
			return new Response(envelope({ tools: [] }))
		},
	})
	assert.equal(calls, 1)
	assert.equal(result.parsed.valid, true)
	assert.equal(result.request.id, 17)
	assert.equal(result.request.bodyText, originalBody)
	assert.equal(result.request.headers.Authorization, 'Bearer ***')
	assert.notEqual(result.request, original)
	assert.notEqual(result.request.headers, original.headers)
	assert.ok(Object.isFrozen(result.request))
	assert.ok(Object.isFrozen(result.request.headers))
	assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'))
})
test('pre-aborted requests and invalid deadlines never dispatch', async () => {
	const controller = new AbortController()
	controller.abort()
	let calls = 0
	const fetch = async () => {
		calls++
		return new Response(envelope({ tools: [] }))
	}
	await assert.rejects(
		executeMcpClient(request(), secret, { signal: controller.signal, fetch }),
		code('cancelled')
	)
	for (const timeoutMs of [0, -1, 0.5, Infinity, NaN, 120_001])
		await assert.rejects(
			executeMcpClient(request(), secret, { timeoutMs, fetch }),
			code('invalid')
		)
	assert.equal(calls, 0)
})
test(
	'timeout settles even when fetch ignores its signal, without retrying',
	{ timeout: 2_000 },
	async () => {
		let calls = 0
		await assert.rejects(
			executeMcpClient(request(), secret, {
				timeoutMs: 10,
				fetch: () => {
					calls++
					return new Promise<Response>(() => {})
				},
			}),
			code('timeout')
		)
		assert.equal(calls, 1)
	}
)
test(
	'external cancellation settles ignored fetch and cancels a late response without awaiting cleanup',
	{ timeout: 2_000 },
	async () => {
		const late = deferred<Response>(),
			ready = deferred<void>(),
			controller = new AbortController()
		let cancelled = 0
		const pending = executeMcpClient(request(), secret, {
			signal: controller.signal,
			fetch: () => {
				ready.resolve()
				return late.promise
			},
		})
		await ready.promise
		controller.abort('timeout')
		await assert.rejects(pending, code('cancelled'))
		late.resolve(
			new Response(
				new ReadableStream({
					cancel() {
						cancelled++
						return new Promise<void>(() => {})
					},
				})
			)
		)
		await Promise.resolve()
		await Promise.resolve()
		assert.equal(cancelled, 1)
	}
)
test(
	'Stop releases a pending body read even when cancellation acknowledgement never arrives',
	{ timeout: 2_000 },
	async () => {
		const controller = new AbortController()
		let cancelled = 0
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled++
				return new Promise<void>(() => {})
			},
		})
		const pending = executeMcpClient(request(), secret, {
			signal: controller.signal,
			fetch: async () => new Response(body),
		})
		const timer = setTimeout(() => controller.abort(), 5)
		try {
			await assert.rejects(pending, code('cancelled'))
			assert.equal(cancelled, 1)
			assert.equal(body.locked, false)
		} finally {
			clearTimeout(timer)
		}
	}
)
test(
	'the same deadline bounds body reads and cancels the upstream reader',
	{ timeout: 2_000 },
	async () => {
		let cancelled = 0
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled++
				return new Promise<void>(() => {})
			},
		})
		await assert.rejects(
			executeMcpClient(request(), secret, {
				timeoutMs: 10,
				fetch: async () => new Response(body),
			}),
			code('timeout')
		)
		assert.equal(cancelled, 1)
		assert.equal(body.locked, false)
	}
)
test('advertised and streamed body limits cancel without waiting for the source', async () => {
	for (const advertised of [true, false]) {
		let cancelled = 0
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				if (!advertised) controller.enqueue(new Uint8Array(maxBytes + 1))
			},
			cancel() {
				cancelled++
				return new Promise<void>(() => {})
			},
		})
		await assert.rejects(
			executeMcpClient(request(), secret, {
				fetch: async () =>
					new Response(body, {
						headers: advertised
							? { 'Content-Length': String(maxBytes + 1) }
							: {},
					}),
			}),
			(error) => {
				assert.ok(error instanceof McpClientError)
				assert.equal(error.code, 'tooLarge')
				assert.ok(error.diagnostic)
				assert.equal(error.diagnostic.status, 200)
				assert.equal(error.diagnostic.bodyKind, 'unavailable')
				assert.equal(error.diagnostic.bodyText, null)
				return true
			}
		)
		assert.equal(cancelled, 1)
		assert.equal(body.locked, false)
	}
})
test('a JSON body exactly at the byte limit succeeds and split UTF-8 is decoded without duplication', async () => {
	const raw = envelope({ tools: [] }).padEnd(maxBytes, ' ')
	const exact = await executeMcpClient(request(), secret, {
		fetch: async () => new Response(raw),
	})
	assert.equal(exact.parsed.valid, true)
	const encoded = new TextEncoder().encode(
		envelope({ tools: [{ name: 'docs__ask', description: '你好' }] })
	)
	const firstMultibyte = encoded.findIndex((byte) => byte > 127)
	const chunks = [
		encoded.slice(0, firstMultibyte + 1),
		encoded.slice(firstMultibyte + 1, firstMultibyte + 2),
		encoded.slice(firstMultibyte + 2),
	]
	const response = await executeMcpClient(request(), secret, {
		fetch: async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						for (const chunk of chunks) controller.enqueue(chunk)
						controller.close()
					},
				})
			),
	})
	assert.equal(response.parsed.valid, true)
	assert.equal(response.parsed.entries?.[0].description, '你好')
})
test('invalid UTF-8 fails closed and absent response bodies remain empty non-catalog diagnostics', async () => {
	await assert.rejects(
		executeMcpClient(request(), secret, {
			fetch: async () => new Response(new Uint8Array([0xc3])),
		}),
		code('invalid')
	)
	const empty = await executeMcpClient(request(), secret, {
		fetch: async () => new Response(null),
	})
	assert.equal(empty.parsed.valid, false)
	assert.equal(empty.parsed.json, null)
	assert.equal(empty.diagnostic.bodyKind, 'empty')
	assert.equal(empty.diagnostic.bodyText, '')
})
test('response objects redact escaped exact secrets and sensitive fields before they can be retained or grouped', async () => {
	const escapedSecret = Array.from(
		secret,
		(char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')
	).join('')
	const body = envelope({
		tools: [
			{
				name: 'wiki__ask',
				description: secret,
				authorization: 'PRIVATE_AUTH',
				nested: {
					apiKey: 'PRIVATE_KEY',
					url: 'https://upstream.test/?token=PRIVATE_QUERY',
					note: 'Bearer PRIVATE_BEARER',
				},
			},
		],
	}).replaceAll(secret, escapedSecret)
	const result = await executeMcpClient(request(), secret, {
		fetch: async () => new Response(body),
	})
	assert.equal(result.parsed.valid, true)
	const retained = JSON.stringify(result)
	for (const hidden of [
		secret,
		'PRIVATE_AUTH',
		'PRIVATE_KEY',
		'PRIVATE_QUERY',
		'PRIVATE_BEARER',
	])
		assert.equal(retained.includes(hidden), false)
	assert.match(retained, /redacted/u)
	const malformed = await executeMcpClient(request(), secret, {
		fetch: async () => new Response('{"secret":"' + secret),
	})
	assert.equal(malformed.parsed.json, null)
	assert.equal(malformed.parsed.valid, false)
})
test('HTTP failures cannot become catalog successes, while RPC errors remain safe diagnostic responses', async () => {
	const forbidden = await executeMcpClient(request(), secret, {
		fetch: async () => new Response(envelope({ tools: [] }), { status: 403 }),
	})
	assert.equal(forbidden.status, 403)
	assert.equal(forbidden.parsed.valid, false)
	const rpc = await executeMcpClient(request(), secret, {
		fetch: async () =>
			Response.json({
				jsonrpc: '2.0',
				id: 17,
				error: { code: -32601, message: 'Bearer ' + secret },
			}),
	})
	assert.equal(rpc.parsed.rpcError, true)
	assert.equal(rpc.parsed.valid, false)
	assert.doesNotMatch(JSON.stringify(rpc), new RegExp(secret, 'u'))
	let calls = 0
	await assert.rejects(
		executeMcpClient(request(), secret, {
			fetch: async () => {
				calls++
				throw new Error('PRIVATE ' + secret)
			},
		}),
		(error) =>
			error instanceof McpClientError &&
			error.code === 'network' &&
			!error.message.includes(secret) &&
			!error.message.includes('PRIVATE')
	)
	assert.equal(calls, 1)
})
test('bounded response traversal rejects pathological depth without retaining provider JSON', async () => {
	let nested: unknown = 'leaf'
	for (let index = 0; index < 34; index++) nested = { child: nested }
	await assert.rejects(
		executeMcpClient(request(), secret, {
			fetch: async () => new Response(envelope({ tools: [], nested })),
		}),
		code('tooLarge')
	)
	assert.equal(
		parseMcpClientResponse(envelope({ tools: [], nested }), request()).json,
		null
	)
})
test('cURL only contains the verified readonly template and a placeholder credential with shell quoting', () => {
	const built = buildMcpClientRequest({
		base: "https://proxy.test/it's",
		slug: 'deep-wiki',
		method: 'tools/list',
		version: '2025-03-26',
		id: 1,
	})
	const curl = mcpClientCurl(built)
	assert.match(curl, /curl -X POST/u)
	assert.match(curl, /Bearer <YOUR_API_KEY>/u)
	assert.match(curl, /MCP-Protocol-Version: 2025-03-26/u)
	assert.match(curl, /tools\/list/u)
	assert.ok(curl.includes("it'\\''s"))
	assert.doesNotMatch(curl, /Cookie|tools\/call|Bearer \*\*\*/u)
	assert.equal(built.headers.Authorization, 'Bearer ***')
})
test('grouping follows real exposed names and encoded resource namespaces while retaining unknown entries in scope', () => {
	const tools = [
		{ name: 'docs__one' },
		{ name: 'other__two' },
		{ name: 'docs__three' },
		{ name: 'ordinary' },
		{ name: 'builtin__hidden' },
		{ name: 'docs__' },
	]
	const groups = groupMcpClientEntries(tools, 'tools/list', 'fallback')
	assert.deepEqual(
		groups.map((group) => [group.slug, group.entries.length]),
		[
			['docs', 2],
			['other', 1],
			['fallback', 3],
		]
	)
	assert.deepEqual(tools[0], { name: 'docs__one' })
	const resources = [
		{ uri: 'octafuse://docs/' + encodeURIComponent('docs://intro?q=1') },
		{ uri: 'octafuse://other/' + encodeURIComponent('file:///tmp/readme') },
		{ uri: 'https://docs/remote' },
		{ uri: 'octafuse://docs@spoof/path' },
		{ uri: 'octafuse://docs/broken%' },
		{ uri: 'octafuse://docs/unencoded/path' },
	]
	assert.deepEqual(
		groupMcpClientEntries(resources, 'resources/list', 'fallback').map(
			(group) => [group.slug, group.entries.length]
		),
		[
			['docs', 1],
			['other', 1],
			['fallback', 4],
		]
	)
	assert.equal(
		groupMcpClientEntries([{ name: 'ordinary' }], 'prompts/list', 'bad/slug')[0]
			.slug,
		''
	)
	assert.deepEqual(groupMcpClientEntries([], 'resources/list'), [])
})
