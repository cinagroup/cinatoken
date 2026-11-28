/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isHashedAsset } from './asset-policy.mjs'

/** Copy only source-bound documentation output, before stamping the Web build. */
export function copyDocsSite(packageRoot, destination, sourceSha256) {
	const site = resolve(packageRoot, '../docs-site')
	if (!existsSync(join(site, 'package.json'))) return // Historical build fixtures.
	const output = join(site, 'dist')
	const manifest = JSON.parse(
		readFileSync(join(output, 'docs-build.json'), 'utf8')
	)
	if (
		manifest.version !== 1 ||
		manifest.sourceSha256 !== sourceSha256 ||
		!Array.isArray(manifest.files) ||
		manifest.files.length < 18 ||
		new Set(manifest.files).size !== manifest.files.length
	)
		throw new Error('Docs must be built from the same sources as Web')
	for (const file of manifest.files) {
		if (
			!/^(en|zh)\/(?:docs|updates|reference)\/(?:[a-z0-9-]+\/)*index\.html$/.test(
				file
			) &&
			!(file.startsWith('docs-assets/') && isHashedAsset(file)) &&
			!/^reference\/catalog\/(?:models|providers|models-by-vendor\/[a-z0-9_-]+)\.json$/.test(
				file
			) &&
			!['content-sitemap.xml', 'updates.xml'].includes(file)
		)
			throw new Error('Docs output outside the approved static namespaces')
		const target = join(destination, file)
		if (existsSync(target))
			throw new Error('Docs output collides with Web output')
		mkdirSync(dirname(target), { recursive: true })
		copyFileSync(join(output, file), target)
	}
}
