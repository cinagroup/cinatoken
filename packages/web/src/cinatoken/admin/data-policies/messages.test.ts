/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dataPolicyMessages } from './messages'

test('Data Policies messages cover every locale with matching placeholders', () => {
	const keys = Object.keys(dataPolicyMessages.en).sort()
	for (const locale of ['zh', 'ja', 'ko'] as const) {
		assert.deepEqual(Object.keys(dataPolicyMessages[locale]).sort(), keys)
		for (const key of keys) {
			const english = dataPolicyMessages.en[key]!
			const translation = dataPolicyMessages[locale][key]!
			assert.ok(translation.trim(), `${locale}.${key}`)
			const placeholders = (value: string) =>
				[...value.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)]
					.map((match) => match[1])
					.sort()
			assert.deepEqual(
				placeholders(translation),
				placeholders(english),
				`${locale}.${key}`
			)
		}
	}
})
