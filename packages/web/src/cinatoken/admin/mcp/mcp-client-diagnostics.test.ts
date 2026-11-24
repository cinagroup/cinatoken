/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	buildMcpClientRequest,
	executeMcpClient,
	McpClientError,
	type McpClientDiagnostic,
} from './mcp-client'
import {
	MCP_CLIENT_DIAGNOSTIC_CHARACTER_LIMIT,
	mcpClientDiagnosticHeaders,
	safeMcpClientDiagnosticText,
} from './mcp-client-diagnostics'

const secret = 'sk-' + 'D'.repeat(32)
const request = buildMcpClientRequest({
	base: 'https://proxy.example.test',
	slug: '',
	method: 'tools/list',
	version: '2025-06-18',
	id: 19,
})
function envelope(result: unknown): string {
	return JSON.stringify({ jsonrpc: '2.0', id: 19, result })
}
function unicodeEscape(value: string): string {
	return Array.from(
		value,
		(character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
	).join('')
}
function percentEscape(value: string): string {
	return Array.from(
		value,
		(character) => '%' + character.charCodeAt(0).toString(16)
	).join('')
}
function noBody(diagnostic: McpClientDiagnostic | undefined): void {
	assert.ok(diagnostic)
	assert.equal(diagnostic.bodyText, null)
	assert.equal(diagnostic.bodyKind, 'unavailable')
	assert.equal(diagnostic.truncated, false)
	assert.ok(Number.isSafeInteger(diagnostic.elapsedMs))
	assert.ok(diagnostic.elapsedMs >= 0)
}
async function rejected(
	work: Promise<unknown>,
	code: McpClientError['code'],
	status: number | null
): Promise<McpClientDiagnostic> {
	let caught: unknown
	try {
		await work
	} catch (error) {
		caught = error
	}
	assert.ok(caught instanceof McpClientError)
	assert.equal(caught.code, code)
	noBody(caught.diagnostic)
	assert.ok(caught.diagnostic)
	assert.equal(caught.diagnostic.status, status)
	assert.doesNotMatch(JSON.stringify(caught), /PRIVATE|sk-DDD/u)
	return caught.diagnostic
}

test('successful diagnostics pretty-print the complete sanitized JSON while retaining safe HTTP metadata', async () => {
	const result = await executeMcpClient(request, secret, {
		fetch: async () =>
			new Response(
				envelope({
					tools: [{ name: 'docs__ask', description: secret }],
					nested: { apiKey: 'PRIVATE_KEY', password: 'PRIVATE_PASSWORD' },
				}),
				{
					headers: {
						'Content-Type': 'application/json',
						'MCP-Protocol-Version': '2025-06-18',
						'Mcp-Session-Id': 'PRIVATE_SESSION',
						'X-Request-Id': 'PRIVATE_REQUEST',
						'X-Arbitrary': 'PRIVATE_UNKNOWN',
						Cookie: 'PRIVATE_COOKIE',
						'Set-Cookie': 'PRIVATE_SET_COOKIE',
						Authorization: 'PRIVATE_AUTHORIZATION',
						Location: 'https://private.example.test/',
					},
				}
			),
	})
	assert.equal(result.parsed.valid, true)
	assert.equal(result.diagnostic.status, 200)
	assert.equal(result.diagnostic.elapsedMs, result.elapsedMs)
	assert.equal(result.diagnostic.bodyKind, 'json')
	assert.equal(result.diagnostic.truncated, false)
	assert.equal(
		result.diagnostic.bodyText,
		JSON.stringify(result.parsed.json, null, 2)
	)
	assert.deepEqual(result.diagnostic.headers, {
		'content-type': 'application/json',
		'mcp-protocol-version': '2025-06-18',
	})
	assert.doesNotMatch(JSON.stringify(result), /PRIVATE|sk-DDD/u)
})

test('403, 429, and 502 responses retain bodies and retry metadata without becoming successful catalogs', async () => {
	for (const status of [403, 429, 502]) {
		const json = status !== 502
		const raw = json
			? envelope({ tools: [], explanation: 'Quota exceeded' })
			: '<html><body>Bad gateway</body></html>'
		const result = await executeMcpClient(request, secret, {
			fetch: async () =>
				new Response(raw, {
					status,
					headers: {
						'Content-Type': json ? 'application/json' : 'text/html',
						'Retry-After': '30',
						'X-RateLimit-Remaining-Requests': '0',
					},
				}),
		})
		assert.equal(result.parsed.valid, false)
		assert.equal(result.diagnostic.status, status)
		assert.equal(result.diagnostic.bodyKind, json ? 'json' : 'text')
		assert.match(
			result.diagnostic.bodyText ?? '',
			/Quota exceeded|Bad gateway/u
		)
		assert.equal(result.diagnostic.headers['retry-after'], '30')
		assert.equal(
			result.diagnostic.headers['x-ratelimit-remaining-requests'],
			'0'
		)
	}
})

test('matching JSON-RPC errors remain inspectable and redact escaped secrets before pretty-printing', async () => {
	const result = await executeMcpClient(request, secret, {
		fetch: async () =>
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 19,
					error: { code: -32601, message: secret },
				}).replaceAll(secret, unicodeEscape(secret))
			),
	})
	assert.equal(result.parsed.rpcError, true)
	assert.equal(result.parsed.valid, false)
	assert.equal(result.diagnostic.bodyKind, 'json')
	assert.match(result.diagnostic.bodyText ?? '', /-32601/u)
	assert.doesNotMatch(JSON.stringify(result), /sk-DDD|\\u0044/u)
})

test('empty bodies, whitespace, and JSON null are distinct complete non-catalog responses', async () => {
	for (const raw of [null, '', '\n \t', 'null']) {
		const result = await executeMcpClient(request, secret, {
			fetch: async () => new Response(raw),
		})
		assert.equal(result.parsed.valid, false)
		assert.equal(result.diagnostic.bodyKind, raw === 'null' ? 'json' : 'empty')
		assert.equal(result.diagnostic.bodyText, raw === 'null' ? 'null' : '')
		assert.equal(result.diagnostic.truncated, false)
	}
	const noContent = await executeMcpClient(request, secret, {
		fetch: async () => new Response(null, { status: 204 }),
	})
	assert.equal(noContent.diagnostic.status, 204)
	assert.equal(noContent.diagnostic.bodyKind, 'empty')
})

test('plain text and HTML diagnostics redact original, escaped, encoded, and query-string echoes', async () => {
	const raw = [
		'<html>Gateway unavailable</html>',
		secret,
		unicodeEscape(secret),
		percentEscape(secret),
		percentEscape(percentEscape(secret)),
		'https://upstream.test/?%74oken=PRIVATE_QUERY&mode=read',
		'Bearer PRIVATE_BEARER',
		'Error {\\"password\\":\\"PRIVATE_PASSWORD\\"}',
	].join('\n')
	const result = await executeMcpClient(request, secret, {
		fetch: async () => new Response(raw, { status: 502 }),
	})
	assert.equal(result.diagnostic.bodyKind, 'text')
	assert.equal(result.parsed.valid, false)
	assert.equal(result.diagnostic.bodyText, '[redacted]')
	assert.doesNotMatch(
		JSON.stringify(result),
		/PRIVATE|sk-DDD|\\u0044|%44|%25/iu
	)
})

test('invalid JSON is withheld instead of exposing fields that cannot be traversed safely', async () => {
	for (const raw of [
		'{"password":"PRIVATE_PASSWORD",',
		'{"\\u0070assword":"PRIVATE_PASSWORD",',
		'["' + unicodeEscape(secret),
		'"' + unicodeEscape(secret),
	]) {
		const result = await executeMcpClient(request, secret, {
			fetch: async () => new Response(raw, { status: 502 }),
		})
		assert.equal(result.parsed.json, null)
		assert.equal(result.parsed.valid, false)
		noBody(result.diagnostic)
		assert.equal(result.diagnostic.status, 502)
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE|sk-DDD|\\u0044/u)
	}
})

test('JSON and text display caps count Unicode characters and never reduce parsed catalog entries', async () => {
	const tools = Array.from({ length: 1_000 }, (_, index) => ({
		name: 'docs__item_' + index,
		description: '😀'.repeat(280),
	}))
	const result = await executeMcpClient(request, secret, {
		fetch: async () => new Response(envelope({ tools })),
	})
	assert.equal(result.parsed.valid, true)
	assert.equal(result.parsed.entries?.length, tools.length)
	assert.equal(result.parsed.entries?.at(-1)?.name, 'docs__item_999')
	assert.equal(result.diagnostic.truncated, true)
	assert.equal(
		Array.from(result.diagnostic.bodyText ?? '').length,
		MCP_CLIENT_DIAGNOSTIC_CHARACTER_LIMIT
	)
	assert.doesNotMatch(result.diagnostic.bodyText ?? '', /[\uD800-\uDFFF]/u)
	for (const count of [
		MCP_CLIENT_DIAGNOSTIC_CHARACTER_LIMIT,
		MCP_CLIENT_DIAGNOSTIC_CHARACTER_LIMIT + 1,
	]) {
		const text = await executeMcpClient(request, secret, {
			fetch: async () => new Response('😀'.repeat(count)),
		})
		assert.equal(text.diagnostic.bodyKind, 'text')
		assert.equal(
			Array.from(text.diagnostic.bodyText ?? '').length,
			MCP_CLIENT_DIAGNOSTIC_CHARACTER_LIMIT
		)
		assert.doesNotMatch(text.diagnostic.bodyText ?? '', /[\uD800-\uDFFF]/u)
		assert.equal(
			text.diagnostic.truncated,
			count > MCP_CLIENT_DIAGNOSTIC_CHARACTER_LIMIT
		)
	}
})

test('safe header values are redacted before their character cap, and arbitrary header families stay excluded', () => {
	const headers = mcpClientDiagnosticHeaders(
		new Headers({
			'Retry-After': secret + ' after 60',
			'X-RateLimit-Limit': percentEscape(secret),
			'RateLimit-Policy': 'q'.repeat(2_049),
			'MCP-Session-Id': 'PRIVATE_SESSION',
			'X-RateLimit-Secret': 'PRIVATE_NEW_HEADER',
			'Content-Location': 'PRIVATE_LOCATION',
			'Proxy-Authorization': 'PRIVATE_AUTHORIZATION',
			'Set-Cookie': 'PRIVATE_COOKIE',
		}),
		secret
	)
	assert.deepEqual(Object.keys(headers).sort(), [
		'ratelimit-policy',
		'retry-after',
		'x-ratelimit-limit',
	])
	assert.equal(headers['retry-after'], '[redacted] after 60')
	assert.equal(headers['x-ratelimit-limit'], '[redacted]')
	assert.equal(Array.from(headers['ratelimit-policy']).length, 2_048)
	assert.ok(headers['ratelimit-policy'].endsWith('…'))
	assert.doesNotMatch(JSON.stringify(headers), /PRIVATE|sk-DDD|%44/iu)
})

test('redaction probes preserve harmless encoded URIs and withhold overly nested ambiguity', () => {
	const uri = 'octafuse://docs/docs%3A%2F%2Fintro%3Fsection%3Done'
	assert.equal(safeMcpClientDiagnosticText(uri, secret), uri)
	assert.equal(
		safeMcpClientDiagnosticText(
			'https://example.test/?q=hello%20world',
			secret
		),
		'https://example.test/?q=hello%20world'
	)
	let nested = percentEscape(secret)
	for (let index = 0; index < 5; index++) nested = nested.replaceAll('%', '%25')
	assert.equal(safeMcpClientDiagnosticText(nested, secret), '[redacted]')
	for (const url of [
		'https://example.test/?token=first%26PRIVATE_SECOND',
		'https://example.test/?token=first%22PRIVATE_SECOND',
		'https://example.test/?token=first%20PRIVATE_SECOND',
	])
		assert.doesNotMatch(
			safeMcpClientDiagnosticText(url, secret),
			/first|PRIVATE_SECOND/u
		)
})

test('invalid UTF-8 discards every partial body but keeps the response status and allowed headers', async () => {
	const diagnostic = await rejected(
		executeMcpClient(request, secret, {
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('PRIVATE_PARTIAL'))
							controller.enqueue(new Uint8Array([0xc3]))
							controller.close()
						},
					}),
					{ status: 502, headers: { 'Retry-After': '60' } }
				),
		}),
		'invalid',
		502
	)
	assert.equal(diagnostic.headers['retry-after'], '60')
})

test('advertised limits and excessive JSON depth or node counts keep only HTTP metadata', async () => {
	let nested: unknown = 'PRIVATE_LEAF'
	for (let index = 0; index < 34; index++) nested = { child: nested }
	for (const raw of [
		envelope({ nested }),
		envelope({ nodes: Array(250_001).fill(0) }),
	])
		await rejected(
			executeMcpClient(request, secret, {
				fetch: async () => new Response(raw, { status: 403 }),
			}),
			'tooLarge',
			403
		)
	let cancelled = 0
	const stream = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled++
		},
	})
	const diagnostic = await rejected(
		executeMcpClient(request, secret, {
			fetch: async () =>
				new Response(stream, {
					status: 429,
					headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) },
				}),
		}),
		'tooLarge',
		429
	)
	assert.equal(diagnostic.headers['content-length'], '8388609')
	assert.equal(cancelled, 1)
})

test('body-read failures retain available HTTP diagnostics and never provider exception text', async () => {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('PRIVATE_PARTIAL'))
		},
		pull(controller) {
			controller.error(new Error('PRIVATE ' + secret))
		},
	})
	await rejected(
		executeMcpClient(request, secret, {
			fetch: async () => new Response(stream, { status: 502 }),
		}),
		'network',
		502
	)
	assert.equal(stream.locked, false)
})

test('network errors before headers have an unavailable body and no guessed HTTP status', async () => {
	const diagnostic = await rejected(
		executeMcpClient(request, secret, {
			fetch: async () => {
				throw new Error('PRIVATE ' + secret)
			},
		}),
		'network',
		null
	)
	assert.deepEqual(diagnostic.headers, {})
})

test(
	'timeouts and Stop keep received headers, discard partial bodies, and release ignored reads',
	{ timeout: 2_000 },
	async () => {
		for (const cancel of [false, true]) {
			const controller = new AbortController()
			let cancelled = 0
			const stream = new ReadableStream<Uint8Array>({
				start(source) {
					source.enqueue(new TextEncoder().encode('PRIVATE_PARTIAL'))
				},
				cancel() {
					cancelled++
					return new Promise<void>(() => {})
				},
			})
			const work = executeMcpClient(request, secret, {
				signal: controller.signal,
				timeoutMs: cancel ? 1_000 : 10,
				fetch: async () =>
					new Response(stream, {
						status: 429,
						headers: { 'Retry-After': '30', 'Set-Cookie': 'PRIVATE_COOKIE' },
					}),
			})
			const timer = cancel ? setTimeout(() => controller.abort(), 10) : null
			try {
				const diagnostic = await rejected(
					work,
					cancel ? 'cancelled' : 'timeout',
					429
				)
				assert.equal(diagnostic.headers['retry-after'], '30')
				assert.equal(cancelled, 1)
				assert.equal(stream.locked, false)
			} finally {
				if (timer) clearTimeout(timer)
			}
		}
	}
)

test(
	'deadline before HTTP headers stays status-null and late responses cannot mutate returned diagnostics',
	{ timeout: 2_000 },
	async () => {
		let resolve!: (response: Response) => void
		const late = new Promise<Response>((done) => {
			resolve = done
		})
		const diagnostic = await rejected(
			executeMcpClient(request, secret, { timeoutMs: 10, fetch: () => late }),
			'timeout',
			null
		)
		let cancelled = 0
		resolve(
			new Response(
				new ReadableStream({
					cancel() {
						cancelled++
					},
				}),
				{ status: 502, headers: { 'Retry-After': '60' } }
			)
		)
		await Promise.resolve()
		await Promise.resolve()
		assert.equal(cancelled, 1)
		assert.equal(diagnostic.status, null)
		assert.deepEqual(diagnostic.headers, {})
	}
)
