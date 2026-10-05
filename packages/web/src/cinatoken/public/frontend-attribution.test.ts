/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { NEW_API_FRONTEND_ATTRIBUTION } from './frontend-attribution'

test('shared English attribution exactly matches the required repository NOTICE.frontend text', () => {
	const notice = readFileSync(
		new URL('../../../../../NOTICE.frontend', import.meta.url),
		'utf8'
	)
	const quotedNotices = [...notice.matchAll(/"([^"\r\n]+)"/g)]
	assert.equal(quotedNotices.length, 1)
	assert.equal(NEW_API_FRONTEND_ATTRIBUTION, quotedNotices[0]![1])
})
