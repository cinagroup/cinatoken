/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { FRONTEND_NOTICE_URL } from './frontend-attribution'

test('the footer notice link points to the unchanged distributed upstream notice', () => {
	const filename = FRONTEND_NOTICE_URL.replace('/web-assets/', '')
	const notice = readFileSync(
		new URL(`../../../../../${filename}`, import.meta.url),
		'utf8'
	)
	assert.ok(
		notice.includes('Frontend design and development by New API contributors.')
	)
	assert.ok(notice.includes('https://github.com/QuantumNous/new-api'))
})
