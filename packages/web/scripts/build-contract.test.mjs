/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import {
	BUILD_CONTRACT_FILE,
	pluginWebBuildContract,
	readBuildContract,
	verifyBuildPair,
	webSourceSha256,
} from './build-contract.mjs'
import { inventoryWebBuildInputs } from './build-inputs.mjs'

const BUILD_ID = '7e8350de-aacf-4c32-ae6e-1d68625ca654'
const SOURCE_SHA = 'a'.repeat(64)
const LEGACY_GOLDEN =
	'eb4f85dec1e6d1d20014cd2fbe28a5f87b18b5c224b05c9e2321c2668f6e2fc3'

function write(root, path, bytes) {
	const file = join(root, path)
	fs.mkdirSync(dirname(file), { recursive: true })
	fs.writeFileSync(file, bytes)
	return file
}

function fixture(t, complete = true) {
	const temporary = fs.realpathSync(tmpdir())
	const root = fs.realpathSync(
		fs.mkdtempSync(join(temporary, 'cinatoken-web-contract-'))
	)
	t.after(() => {
		const path = fs.realpathSync(root)
		const rel = relative(temporary, path)
		assert.ok(
			!isAbsolute(rel) &&
				rel !== '..' &&
				!rel.startsWith(`..${sep}`) &&
				rel.startsWith('cinatoken-web-contract-')
		)
		fs.rmSync(path, { recursive: true })
	})
	fs.mkdirSync(join(root, 'packages/web'), { recursive: true })
	if (complete) {
		for (const path of [
			'package.json',
			'package-lock.json',
			'LICENSE',
			'NOTICE.frontend',
			'.nvmrc',
			'.dockerignore',
			'packages/web/package.json',
			'packages/web/index.html',
			'packages/web/rsbuild.config.ts',
			'packages/web/postcss.config.mjs',
			'packages/web/tsconfig.json',
			'packages/web/tsconfig.app.json',
			'packages/web/tsconfig.node.json',
			'packages/web/src/main.tsx',
			'packages/web/edge/worker.ts',
			'packages/web/scripts/tool.mjs',
			'packages/core/package.json',
			'packages/core/src/deep/price.ts',
			'packages/admin/package.json',
			'packages/admin/lib/model-vendors.json',
			'packages/tool-engines/package.json',
			'packages/proxy/package.json',
			'packages/chain-worker/package.json',
			'Dockerfile.web',
			'Dockerfile.web-ssr',
			'docker/web/public-server.mjs',
			'docker/web/nginx.conf.template',
			'docker/web/admin-proxy.conf',
			'docker/web/entrypoint.sh',
			'scripts/web/source-provenance.mjs',
			'.github/workflows/web-frontend.yml',
		])
			write(root, path, `synthetic input: ${path}\n`)
	}
	return { root, packageRoot: join(root, 'packages/web') }
}

function contract(version = 2, overrides = {}) {
	return { version, buildId: BUILD_ID, sourceSha256: SOURCE_SHA, ...overrides }
}

function writeContract(directory, value) {
	fs.mkdirSync(directory, { recursive: true })
	fs.writeFileSync(join(directory, BUILD_CONTRACT_FILE), JSON.stringify(value))
}

function outputs(root) {
	const browser = join(root, 'packages/web/dist')
	const server = join(root, 'packages/web/dist-server')
	const environments = {
		web: { distPath: browser },
		node: { distPath: join(server, 'node') },
		worker: { distPath: join(server, 'worker') },
	}
	for (const environment of Object.values(environments)) {
		fs.mkdirSync(environment.distPath, { recursive: true })
		fs.writeFileSync(
			join(environment.distPath, 'index.mjs'),
			'export const ready = true;\n'
		)
	}
	return { browser, server, environments }
}

function hooks(packageRoot) {
	const captured = {}
	pluginWebBuildContract(packageRoot).setup({
		onBeforeCreateCompiler(value) {
			captured.compiler = value
		},
		onBeforeBuild(value) {
			captured.before = value
		},
		onAfterBuild(value) {
			captured.after = value
		},
	})
	assert.equal(typeof captured.before, 'function')
	assert.equal(typeof captured.after, 'function')
	return captured
}

function assertUnstamped(environments) {
	for (const environment of Object.values(environments))
		assert.ok(!fs.existsSync(join(environment.distPath, BUILD_CONTRACT_FILE)))
}

test('explicit v1 retains the historical raw-byte golden algorithm', (t) => {
	const { root, packageRoot } = fixture(t, false)
	for (const [path, bytes] of Object.entries({
		'package.json': '{"private":true}\n',
		'package-lock.json': '{"lockfileVersion":3}\n',
		'packages/web/package.json': '{"name":"@cinatoken/web"}\n',
		'packages/web/src/main.tsx': 'export const fixture = 1;\r\n',
		'packages/web/edge/worker.ts': 'export default {};\n',
		'packages/web/scripts/tool.mjs': 'export const build = true;\n',
		'packages/web/public/logo.txt': 'logo\n',
		'packages/web/index.html': '<!doctype html>\n',
		'packages/web/rsbuild.config.ts': 'export default {};\n',
		'packages/web/tsconfig.json': '{}\n',
		'packages/web/.browserslistrc': 'defaults\n',
		'.browserslistrc': 'last 1 chrome version\n',
	}))
		write(root, path, bytes)
	assert.equal(webSourceSha256(packageRoot, { version: 1 }), LEGACY_GOLDEN)
	write(
		root,
		'packages/core/src/deep/price.ts',
		'export const oldHashMissesThis = true;\n'
	)
	write(
		root,
		'packages/admin/lib/model-vendors.json',
		'{"oldHashMissesThis":true}\n'
	)
	write(
		root,
		'docker/web/public-server.mjs',
		'export const oldHashMissesThis = true;\n'
	)
	write(root, 'packages/proxy/package.json', '{"oldHashMissesThis":true}\n')
	assert.equal(webSourceSha256(packageRoot, { version: 1 }), LEGACY_GOLDEN)
	assert.throws(
		() => webSourceSha256(packageRoot),
		/Missing required Web build input/
	)
})

test('default and explicit v2 use the complete inventory while v1 stays scoped historically', (t) => {
	const { root, packageRoot } = fixture(t)
	const before = webSourceSha256(packageRoot)
	const legacy = webSourceSha256(packageRoot, { version: 1 })
	assert.equal(before, inventoryWebBuildInputs(packageRoot).sourceSha256)
	assert.equal(before, webSourceSha256(packageRoot, { version: 2 }))
	let previous = before
	for (const path of [
		'packages/core/src/deep/price.ts',
		'packages/admin/lib/model-vendors.json',
		'docker/web/public-server.mjs',
		'packages/proxy/package.json',
		'.dockerignore',
	]) {
		fs.appendFileSync(join(root, path), 'changed shared input\n')
		const current = webSourceSha256(packageRoot)
		assert.notEqual(current, previous, `Changed contract input: ${path}`)
		assert.equal(webSourceSha256(packageRoot, { version: 1 }), legacy)
		previous = current
	}
	for (const version of [0, 3, '2', null, true])
		assert.throws(() => webSourceSha256(packageRoot, { version }), /version/i)
})

for (const version of [1, 2]) {
	test(`historical/read contract version ${version} has identical strict keys`, (t) => {
		const { root } = fixture(t, false)
		const value = contract(version)
		writeContract(root, {
			sourceSha256: value.sourceSha256,
			version,
			buildId: value.buildId,
		})
		assert.deepEqual(readBuildContract(root), value)
		writeContract(root, { ...value, extra: 'unexpected' })
		assert.throws(() => readBuildContract(root), /Invalid Web build contract/)
	})
}

test('contract reading rejects invalid versions, fields and malformed identities', (t) => {
	const { root } = fixture(t, false)
	const invalid = [
		null,
		[],
		contract(0),
		contract(3),
		contract('2'),
		contract(null),
		contract(2, { buildId: 'not-a-uuid' }),
		contract(2, { sourceSha256: 'short' }),
		{ version: 2, buildId: BUILD_ID },
		{ ...contract(), sourceRequirementComplete: true },
	]
	for (const value of invalid) {
		writeContract(root, value)
		assert.throws(() => readBuildContract(root), /Invalid Web build contract/)
	}
	fs.writeFileSync(join(root, BUILD_CONTRACT_FILE), '{broken json')
	assert.throws(() => readBuildContract(root), SyntaxError)
})

test('contract reading rejects absent, oversized and non-file markers', (t) => {
	const { root } = fixture(t, false)
	assert.throws(() => readBuildContract(root), /Missing Web build contract/)
	const marker = join(root, BUILD_CONTRACT_FILE)
	fs.writeFileSync(marker, ' '.repeat(1025))
	assert.throws(
		() => readBuildContract(root),
		/Invalid Web build contract file/
	)
	fs.unlinkSync(marker)
	fs.mkdirSync(marker)
	assert.throws(
		() => readBuildContract(root),
		/Invalid Web build contract file/
	)
})

test('all three targets must match version, build ID and source bytes', (t) => {
	const { root } = fixture(t, false)
	const { browser, server, environments } = outputs(root)
	for (const version of [1, 2]) {
		const value = contract(version)
		for (const environment of Object.values(environments))
			writeContract(environment.distPath, value)
		assert.deepEqual(verifyBuildPair(browser, server), value)
		for (const target of ['node', 'worker']) {
			for (const altered of [
				contract(version === 1 ? 2 : 1),
				contract(version, { buildId: '3a8cab9b-134d-429f-b907-de071e2b3300' }),
				contract(version, { sourceSha256: 'b'.repeat(64) }),
			]) {
				writeContract(environments[target].distPath, altered)
				assert.throws(
					() => verifyBuildPair(browser, server),
					/must share one build contract/
				)
				writeContract(environments[target].distPath, value)
			}
		}
	}
})

test('real lifecycle callbacks stamp a stable v2 identity on browser, Node and Worker', (t) => {
	const { packageRoot, root } = fixture(t)
	const { browser, server, environments } = outputs(root)
	const callback = hooks(packageRoot)
	const configurations = [{ name: 'web' }, { name: 'node' }, { name: 'worker' }]
	assert.equal(callback.compiler.order, 'post')
	callback.compiler.handler({ bundlerConfigs: configurations })
	assert.equal(configurations[0].externals, undefined)
	assert.equal(configurations[1].externals, undefined)
	assert.deepEqual(configurations[2].externals, {
		'node:stream': 'module node:stream',
	})
	callback.before()
	callback.after({ stats: { hasErrors: () => false }, environments })
	const value = verifyBuildPair(browser, server)
	assert.equal(value.version, 2)
	assert.match(value.buildId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
	assert.equal(
		value.sourceSha256,
		inventoryWebBuildInputs(packageRoot).sourceSha256
	)
	for (const environment of Object.values(environments))
		assert.deepEqual(readBuildContract(environment.distPath), value)
})

for (const [category, path] of [
	['Core deep source', 'packages/core/src/deep/price.ts'],
	['Admin vendor data', 'packages/admin/lib/model-vendors.json'],
	['runtime source', 'docker/web/public-server.mjs'],
]) {
	test(`lifecycle refuses ${category} drift without writing success stamps`, (t) => {
		const { packageRoot, root } = fixture(t)
		const { environments } = outputs(root)
		const callback = hooks(packageRoot)
		callback.before()
		fs.appendFileSync(join(root, path), 'changed during actual lifecycle\n')
		assert.throws(
			() => callback.after({ stats: { hasErrors: () => false }, environments }),
			/Web sources changed during build/
		)
		assertUnstamped(environments)
	})
}

test('failed or unstarted builds cannot write successful stamps', (t) => {
	const { packageRoot, root } = fixture(t)
	const { environments } = outputs(root)
	const callback = hooks(packageRoot)
	assert.throws(
		() => callback.after({ stats: { hasErrors: () => false }, environments }),
		/Cannot stamp a failed Web build/
	)
	assertUnstamped(environments)
	callback.before()
	for (const stats of [undefined, { hasErrors: () => true }]) {
		assert.throws(
			() => callback.after({ stats, environments }),
			/Cannot stamp a failed Web build/
		)
		assertUnstamped(environments)
	}
})

test('a retained Worker Node import prevents every successful target stamp', (t) => {
	const { packageRoot, root } = fixture(t)
	const { environments } = outputs(root)
	const callback = hooks(packageRoot)
	callback.before()
	write(
		root,
		'packages/web/dist-server/worker/async/stream.mjs',
		"import { Readable } from 'node:stream'; export { Readable };\n"
	)
	assert.throws(
		() => callback.after({ stats: { hasErrors: () => false }, environments }),
		/Worker bundle retains a Node module specifier/
	)
	assertUnstamped(environments)
})

test('new build cycles get fresh IDs and excluded generated bytes do not cause drift', (t) => {
	const { packageRoot, root } = fixture(t)
	const { browser, server, environments } = outputs(root)
	const callback = hooks(packageRoot)
	callback.before()
	write(
		root,
		'packages/web/dist/async/chunk.mjs',
		'export const emitted = true;\n'
	)
	write(root, 'packages/web/src/.tmp/ignored.ts', 'synthetic generated input\n')
	callback.after({ stats: { hasErrors: () => false }, environments })
	const first = verifyBuildPair(browser, server)
	callback.before()
	callback.after({ stats: { hasErrors: () => false }, environments })
	const second = verifyBuildPair(browser, server)
	assert.notEqual(second.buildId, first.buildId)
	assert.equal(second.version, 2)
	assert.equal(second.sourceSha256, first.sourceSha256)
})
