/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventoryWebBuildInputs } from '../../web/scripts/build-inputs.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const files = []
function walk(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Docs output must not contain links')
    const name = prefix + entry.name
    if (entry.isDirectory()) walk(join(directory, entry.name), name + '/')
    else files.push(name)
  }
}
walk(dist)
const pages = files.filter((file) => /^(en|zh)\/docs\/(?:[a-z-]+\/)?index\.html$/.test(file))
assert.equal(pages.length, 18, 'Expected all nine guides in both languages')
for (const file of pages) {
  const html = readFileSync(join(dist, file), 'utf8')
  assert.ok(html.includes('CinaToken') && html.includes('<h1'), file)
  assert.ok(html.includes(`https://cinatoken.com/${file.replace(/index\.html$/, '')}`), 'Canonical URL missing')
  assert.doesNotMatch(html, /hm\.baidu\.com|fonts\.googleapis\.com|octafuse\.dev/, 'Unexpected upstream service')
  for (const match of html.matchAll(/(?:href|src)="(\/(?:en|zh)\/docs\/[^"?#]*|\/docs-assets\/[^"?#]+)"/g)) {
    const target = match[1].slice(1)
    assert.ok(files.includes(target.endsWith('/') ? target + 'index.html' : target), `Broken docs link: ${match[1]} in ${file}`)
  }
}
// Only approved namespaces are copied into the Web build. Astro's default root
// locale redirect and sitemap must never replace the existing product routes.
const assets = files.filter((file) => /^docs-assets\/static\/[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{5,64}\.(?:js|css|svg|png|woff2?)$/.test(file))
assert.ok(assets.length > 0, 'No hashed docs assets')
assert.ok(files.filter((file) => file.startsWith('docs-assets/')).every((file) => assets.includes(file)), 'Unversioned docs asset')
const source = inventoryWebBuildInputs(resolve(root, '../web')).sourceSha256
writeFileSync(join(dist, 'docs-build.json'), JSON.stringify({ version: 1, sourceSha256: source, files: [...pages, ...assets].sort() }, null, 2) + '\n')
console.log(`Verified ${pages.length} documentation pages and ${assets.length} hashed assets`)
