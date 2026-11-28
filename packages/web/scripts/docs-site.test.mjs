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

test('versioned search assets retain every index member and reject traversal and unversioned paths', () => {
	const version = 'a'.repeat(64)
	for (const path of [
		`docs-assets/search/${version}/pagefind.js`,
		`docs-assets/search/${version}/fragment/zh-cn_abcd.pf_fragment`,
		`docs-assets/search/${version}/wasm.unknown.pagefind`,
	])
		assert.equal(isRetainableAsset(path), true)
	for (const path of [
		'docs-assets/search/pagefind.js',
		`docs-assets/search/${version}/../index.html`,
		`docs-assets/search/${version}/.env`,
	])
		assert.equal(isRetainableAsset(path), false)
})

test('content copy includes versioned search members, reference feeds and XML without admitting private paths', (t) => {
	const extras = [
		`docs-assets/search/${'a'.repeat(64)}/pagefind.js`,
		`docs-assets/search/${'a'.repeat(64)}/fragment/zh.pf_fragment`,
		`docs-assets/search/${'a'.repeat(64)}/wasm.unknown.pagefind`,
		'reference/catalog/models.json',
		'reference/catalog/providers.json',
		'reference/catalog/models-by-vendor/deepseek.json',
		'content-sitemap.xml',
		'updates.xml',
		'zh/updates/index.html',
		'en/reference/catalog/models/index.html',
	]
	const f = fixture(t)
	const manifest = join(f.root, 'docs-site/dist/docs-build.json')
	writeFileSync(
		manifest,
		JSON.stringify({
			version: 1,
			sourceSha256: 'fixture-source',
			files: [...f.files, ...extras],
		})
	)
	for (const path of extras) {
		const file = join(f.root, 'docs-site/dist', path)
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, 'content fixture')
	}
	copyDocsSite(f.packageRoot, f.output, 'fixture-source')
	for (const path of extras)
		assert.equal(readFileSync(join(f.output, path), 'utf8'), 'content fixture')
	for (const path of [
		'reference/catalog/../../.env',
		'docs-assets/search/unversioned/pagefind.js',
		'reference/catalog/private.json',
	]) {
		const bad = fixture(t, { files: [...f.files, path] })
		assert.throws(
			() => copyDocsSite(bad.packageRoot, bad.output, 'fixture-source'),
			/approved static namespaces/
		)
	}
})
