/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { routeMessages } from './messages'

test('route UI has complete four-language keys and interpolation sets', () => {
	const en = routeMessages.en
	const variables = (value: string) =>
		[...value.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/gu)]
			.map((match) => match[1])
			.sort()
	assert.ok(Object.keys(en).length > 90)
	for (const language of ['zh', 'ja', 'ko'] as const) {
		const translated = routeMessages[language]
		assert.deepEqual(Object.keys(translated).sort(), Object.keys(en).sort())
		for (const key of Object.keys(en)) {
			assert.ok(translated[key]?.trim(), `${language}:${key}`)
			assert.deepEqual(
				variables(translated[key]!),
				variables(en[key]!),
				`${language}:${key}`
			)
		}
	}
})
