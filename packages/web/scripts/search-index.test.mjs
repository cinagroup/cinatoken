/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { finalizeSearch } from '../../docs-site/scripts/finalize-search.mjs'

test('search seals all member bytes into a stable version path and rewrites only generated content pages', (t) => {
	const root = mkdtempSync(join(tmpdir(), 'cinatoken-search-seal-'))
	t.after(() => rmSync(root, { recursive: true }))
	function build(name, content) {
		const dist = join(root, name)
		mkdirSync(join(dist, 'pagefind/fragment'), { recursive: true })
		mkdirSync(join(dist, 'zh/docs'), { recursive: true })
		writeFileSync(
			join(dist, 'pagefind/pagefind.js'),
			'export const search = true'
		)
		writeFileSync(join(dist, 'pagefind/fragment/zh.pf_fragment'), content)
		writeFileSync(
			join(dist, 'zh/docs/index.html'),
			'<div data-search-base="/docs-assets/search/__SEARCH_VERSION__/"></div>'
		)
		return { dist, ...finalizeSearch(dist) }
	}
	const first = build('one', 'first'),
		same = build('two', 'first'),
		changed = build('three', 'second')
	assert.equal(first.digest, same.digest)
	assert.notEqual(first.digest, changed.digest)
	assert.match(
		readFileSync(join(first.dist, 'zh/docs/index.html'), 'utf8'),
		new RegExp(first.digest)
	)
	assert.equal(
		readFileSync(
			join(
				first.dist,
				'docs-assets/search',
				first.digest,
				'fragment/zh.pf_fragment'
			),
			'utf8'
		),
		'first'
	)
	assert.throws(() => finalizeSearch(join(root, 'missing')), /missing/)
})
