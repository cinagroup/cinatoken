/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { safeLogJson } from './request-log-domain'
import {
	asLogJsonObject,
	formatLogJson,
	isLogJsonNumber,
	parseSafeLogJson,
} from './safe-log-json'

test('raw log JSON retains numeric digits, scale, exponent and negative zero', () => {
	const tokens = [
		'9007199254740993',
		'-9007199254740993',
		'123456789012345678901234567890.123456',
		'123456789012345678901234567890.123457',
		'0.123456789012345678901234567890',
		'1.230000',
		'1E+03',
		'-0',
		'-0.0000',
		'1e400',
		'-1e-400',
	]
	for (const token of tokens) {
		assert.equal(safeLogJson(token), token)
		assert.equal(
			formatLogJson(parseSafeLogJson(`{"value":[${token}]}`), false),
			`{"value":[${token}]}`
		)
	}
})

test('log number tokens remain distinct from numeric strings and ordinary objects', () => {
	const parsed = asLogJsonObject(
		parseSafeLogJson(
			'{"number":9007199254740993,"text":"9007199254740993","object":{"raw":"9007199254740993"}}'
		)
	)
	assert.ok(parsed)
	assert.ok(isLogJsonNumber(parsed.number))
	assert.equal(parsed.number.raw, '9007199254740993')
	assert.equal(asLogJsonObject(parsed.number), null)
	assert.equal(isLogJsonNumber(parsed.object), false)
	assert.equal(formatLogJson(parsed.number), '9007199254740993')
	assert.equal(formatLogJson(parsed.text), '"9007199254740993"')
	assert.equal(
		formatLogJson(parsed.object, false),
		'{"raw":"9007199254740993"}'
	)
	assert.equal(asLogJsonObject([]), null)
	assert.equal(asLogJsonObject(null), null)
})

test('numeric-looking content and escaped quotes in JSON strings are preserved', () => {
	const value = {
		'12345678901234567890': '9007199254740993',
		note: 'quoted "number": 123.000 and slash \\ plus {"value":1e400}',
		nested: [{ value: '0.12345678901234567890' }, true, null, [], {}],
	}
	assert.equal(
		safeLogJson(JSON.stringify(value)),
		JSON.stringify(value, null, 2)
	)
	assert.equal(
		formatLogJson(parseSafeLogJson(JSON.stringify(value)), false),
		JSON.stringify(value)
	)
})

test('native duplicate and escaped key semantics survive exact numeric parsing', () => {
	const raw =
		'{"value":1,"\\u0076alue":9007199254740993,"2":1e400,"1":-0,"__proto__":{"value":1.2300},"constructor":9007199254740995}'
	const result = parseSafeLogJson(raw)
	assert.equal(
		formatLogJson(result, false),
		'{"1":-0,"2":1e400,"value":9007199254740993,"__proto__":{"value":1.2300},"constructor":9007199254740995}'
	)
	const object = asLogJsonObject(result)
	assert.ok(object)
	assert.equal(Object.hasOwn(object, '__proto__'), true)
	assert.equal(Object.getPrototypeOf(object), Object.prototype)
	assert.equal(Object.hasOwn(Object.prototype, 'value'), false)
	assert.equal(
		safeLogJson('{"value":9007199254740993,"value":"9007199254740993"}'),
		'{\n  "value": "9007199254740993"\n}'
	)
})

test('malformed numeric JSON fails closed before numeric tokens can be rewritten', () => {
	for (const raw of [
		'NaN',
		'Infinity',
		'-Infinity',
		'01',
		'+1',
		'.1',
		'1.',
		'1e',
		'1e+',
		'1 2',
		'0x10',
		'{"value":1,}',
		'{"value":1} trailing',
		'{"value":9007199254740993',
	]) {
		assert.throws(() => parseSafeLogJson(raw), SyntaxError)
		assert.equal(safeLogJson(raw), '[redacted: malformed log]')
	}
	assert.equal(
		safeLogJson('{"value":1...[truncated]'),
		'[redacted: truncated log]'
	)
	for (const raw of [null, undefined, '', ' \n\t '])
		assert.equal(safeLogJson(raw), null)
})

test('precise JSON numbers never bypass key or embedded string redaction', () => {
	const result = safeLogJson(
		'{"apiKey":9007199254740993,"authorization":{"value":1e400},"messages":[1.2300],"nested":{"session-token":-0,"usage":9007199254740995},"url":"https://example.test/?access_token=private&count=9007199254740993","note":"Bearer private"}'
	)
	assert.equal(
		result,
		JSON.stringify(
			{
				apiKey: '[redacted]',
				authorization: '[redacted]',
				messages: '[redacted]',
				nested: { 'session-token': '[redacted]', usage: 'NUMERIC' },
				url: 'https://example.test/?access_token=[redacted]&count=9007199254740993',
				note: '[redacted]',
			},
			null,
			2
		).replace('"NUMERIC"', '9007199254740995')
	)
})

test('deep JSON truncates safely at the established depth boundary', () => {
	const raw = '['.repeat(1000) + '9007199254740993' + ']'.repeat(1000)
	assert.equal(
		formatLogJson(parseSafeLogJson(raw), false),
		'['.repeat(17) + '"[redacted: depth limit]"' + ']'.repeat(17)
	)
	const retained = '['.repeat(16) + '9007199254740993' + ']'.repeat(16)
	assert.equal(formatLogJson(parseSafeLogJson(retained), false), retained)
})
