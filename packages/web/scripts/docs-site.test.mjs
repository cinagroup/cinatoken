/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import {
	mkdirSync,
	mkdtempSync,
	writeFileSync,
	readFileSync,
	rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { isRetainableAsset } from './asset-policy.mjs'
import { copyDocsSite } from './docs-site.mjs'

function fixture(t, overrides = {}) {
	const root = mkdtempSync(join(tmpdir(), 'cinatoken-docs-'))
	t.after(() => rmSync(root, { recursive: true }))
	function write(path, value) {
		mkdirSync(dirname(join(root, path)), { recursive: true })
		writeFileSync(join(root, path), value)
	}
	const files = ['en', 'zh'].flatMap((locale) =>
		Array.from(
			{ length: 9 },
			(_, i) => `${locale}/docs/page-${String.fromCharCode(97 + i)}/index.html`
		)
	)
	for (const path of files)
		write('docs-site/dist/' + path, '<html>fixture</html>')
	write('docs-site/package.json', '{}')
	write(
		'docs-site/dist/docs-build.json',
		JSON.stringify({
			version: 1,
			sourceSha256: 'fixture-source',
			files,
			...overrides,
		})
	)
	return {
		root,
		packageRoot: join(root, 'web'),
		output: join(root, 'output'),
		files,
	}
}

test('documentation copy binds both locales to Web sources and rejects stale output or namespace takeover', (t) => {
	const f = fixture(t)
	copyDocsSite(f.packageRoot, f.output, 'fixture-source')
	assert.equal(
		readFileSync(join(f.output, f.files[0]), 'utf8'),
		'<html>fixture</html>'
	)
	assert.throws(
		() => copyDocsSite(f.packageRoot, f.output, 'changed-source'),
		/same sources/
	)
	const bad = fixture(t, { files: Array(18).fill('index.html') })
	assert.throws(
		() => copyDocsSite(bad.packageRoot, bad.output, 'fixture-source'),
		/same sources/
	)
	const outside = fixture(t, { files: [...f.files, 'index.html'] })
	assert.throws(
		() => copyDocsSite(outside.packageRoot, outside.output, 'fixture-source'),
		/approved static namespaces/
	)
})

test('only versioned documentation code and style assets join rollback retention', () => {
	for (const path of [
		'docs-assets/static/index.haH-_Vsc.css',
		'docs-assets/static/page.1c3678235202d08b.js',
	])
		assert.ok(isRetainableAsset(path))
	for (const path of [
		'en/docs/index.html',
		'docs-assets/catalog.12345678.json',
		'docs-assets/static/index.css',
		'docs-assets/static/index.ab.html',
	])
		assert.equal(isRetainableAsset(path), false)
})
