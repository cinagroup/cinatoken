/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { checkIndex } from '../../docs-site/scripts/sync-upstream.mjs'

const read = (name) =>
	JSON.parse(
		readFileSync(
			new URL('../../docs-site/src/data/' + name, import.meta.url),
			'utf8'
		)
	)
test('reference snapshots preserve reviewed input hashes, counts and model kinds without publishing deployment fields', () => {
	const manifest = read('catalog/sync-manifest.json'),
		models = read('catalog/models.json'),
		providers = read('catalog/providers.json'),
		kinds = read('catalog/presentation.json').kindByModelId
	for (const input of manifest.inputs) {
		const bytes = readFileSync(
			new URL('../../../' + input.path, import.meta.url)
		)
		assert.equal(
			createHash('sha256').update(bytes).digest('hex'),
			input.sha256,
			input.path
		)
	}
	assert.deepEqual(models.source, manifest.source)
	assert.deepEqual(providers.source, manifest.source)
	assert.equal(models.items.length, 206)
	assert.equal(providers.items.length, 69)
	assert.doesNotMatch(
		JSON.stringify(providers),
		/managed_environment_key|"api_key"|"secret"/
	)
	assert.equal(kinds['gemini-2.5-pro'], 'llm')
	assert.equal(kinds['whisper-1'], 'asr')
	assert.equal(kinds['qwen-audio-3.1-tts-flash'], 'tts')
})
test('attributed upstream records reject identity, title and source substitution and keep complete bilingual routes', () => {
	const upstream = read('updates/upstream-index.json')
	assert.equal(checkIndex(upstream).items.length, 26)
	for (const mutate of [
		(row) => (row.items[0].source = 'cinatoken'),
		(row) => (row.items[0].title.en = 'Copied prose'),
		(row) => (row.items[0].href.zh = 'https://evil.example'),
		(row) => row.inputs.pop(),
	]) {
		const altered = structuredClone(upstream)
		mutate(altered)
		assert.throws(() => checkIndex(altered))
	}
	const { paths } = read('content-routes.json')
	assert.equal(paths.length, 82)
	for (const path of paths) {
		assert.match(path, /^\/(en|zh)\/(docs|updates|reference)\//)
		assert.ok(
			paths.includes(
				path.startsWith('/en/')
					? '/zh/' + path.slice(4)
					: '/en/' + path.slice(4)
			)
		)
	}
	const own = read('updates/cinatoken.json')
	assert.equal(own.items.length, 3)
	assert.ok(
		own.items.every(
			(row) =>
				row.source === 'cinatoken' &&
				row.evidence.startsWith(
					'https://github.com/cinagroup/cinatoken/commit/'
				)
		)
	)
})
