/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { verifyBuildPair } from './build-contract.mjs'
import { inventoryWebBuildInputs } from './build-inputs.mjs'
import {
	readHistoricalSourceImports,
	verifyHistoricalSourceImports,
} from './historical-source.mjs'
import { packageRelease, verifyRelease } from './package-release.mjs'
import { createSourceArchive } from './source-archive.mjs'

const START = '2026-09-01T00:00:00.000Z'
const EARLY = '2026-08-31T00:00:00.000Z'
const NEXT = '2026-09-03T00:00:00.000Z'
const OLD = 'static/js/old.11111111.js'
const INHERITED = 'static/js/inherited.22222222.js'
const NEW = 'static/js/new.33333333.js'
const OLD_ID = 'history-v2'
const UUID = '872a3040-55d5-4f40-814e-2d48e3f9f350'
const NEXT_UUID = '8c7d5c31-32a7-4e78-bd32-b35a9baf4a5e'

function sha(bytes) {
	return createHash('sha256').update(bytes).digest('hex')
}
function write(root, path, bytes) {
	const file = join(root, path)
	fs.mkdirSync(dirname(file), { recursive: true })
	fs.writeFileSync(file, bytes)
	return file
}
function resign(directory, edit) {
	const manifest = JSON.parse(
		fs.readFileSync(join(directory, 'manifest.json'), 'utf8')
	)
	edit(manifest)
	const bytes = `${JSON.stringify(manifest, null, 2)}\n`
	fs.writeFileSync(join(directory, 'manifest.json'), bytes)
	fs.writeFileSync(join(directory, 'manifest.sha256'), `${sha(bytes)}\n`)
	return manifest
}
function inventory(directory) {
	const files = []
	function visit(current, prefix) {
		for (const name of fs.readdirSync(current)) {
			const path = prefix ? `${prefix}/${name}` : name
			const file = join(current, name)
			if (fs.lstatSync(file).isDirectory()) visit(file, path)
			else {
				const bytes = fs.readFileSync(file)
				files.push({ path, bytes: bytes.length, sha256: sha(bytes) })
			}
		}
	}
	visit(directory, '')
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
function copiedCLI(root) {
	for (const name of [
		'package-release.mjs',
		'asset-policy.mjs',
		'build-contract.mjs',
		'build-inputs.mjs',
		'source-archive.mjs',
		'source-delivery.mjs',
		'historical-source.mjs',
	])
		write(
			root,
			`packages/web/scripts/${name}`,
			fs.readFileSync(new URL(`./${name}`, import.meta.url))
		)
	return join(root, 'packages/web/scripts/package-release.mjs')
}
function markers(root, directory, contract) {
	for (const path of ['assets', 'server/node', 'server/worker'])
		write(
			root,
			`${directory}/${path}/build-contract.json`,
			JSON.stringify(contract)
		)
	for (const target of ['node', 'worker'])
		write(
			root,
			`${directory}/server/${target}/index.mjs`,
			`export const fixture = '${target}';\n`
		)
}
function fixture(t, { includeInherited = true } = {}) {
	const temporary = fs.realpathSync(tmpdir())
	const root = fs.realpathSync(
		fs.mkdtempSync(join(temporary, 'cinatoken-historical-source-'))
	)
	t.after(() => {
		const target = fs.realpathSync(root)
		const rel = relative(temporary, target)
		assert.ok(
			!isAbsolute(rel) &&
				rel !== '..' &&
				!rel.startsWith(`..${sep}`) &&
				rel.startsWith('cinatoken-historical-source-')
		)
		fs.rmSync(target, { recursive: true })
	})
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
		'packages/web/scripts/build.mjs',
		'packages/core/package.json',
		'packages/core/src/core.ts',
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
		write(root, path, `synthetic historical input: ${path}\n`)
	const contract = {
		version: 2,
		buildId: UUID,
		sourceSha256: inventoryWebBuildInputs(join(root, 'packages/web'))
			.sourceSha256,
	}
	const archive = createSourceArchive(join(root, 'packages/web'), contract)
	const archiveFile = 'imports/history.tar.gz'
	write(root, archiveFile, archive.bytes)
	const releasePath = `.release/web/${OLD_ID}`
	const directory = join(root, releasePath)
	write(root, `${releasePath}/assets/index.html`, '<html>old build</html>')
	write(root, `${releasePath}/assets/${OLD}`, 'old-current-bytes\n')
	if (includeInherited)
		write(
			root,
			`${releasePath}/assets/${INHERITED}`,
			'legacy-inherited-bytes\n'
		)
	for (const name of ['LICENSE', 'NOTICE.frontend'])
		write(
			root,
			`${releasePath}/assets/${name}`,
			fs.readFileSync(join(root, name))
		)
	markers(root, releasePath, contract)
	const files = inventory(join(directory, 'assets')).map((file) => ({
		...file,
		source: file.path === INHERITED ? 'retained' : 'current',
		lastCurrentAt: file.path === INHERITED ? EARLY : START,
	}))
	const manifest = {
		schemaVersion: 2,
		releaseId: OLD_ID,
		createdAt: START,
		retentionDays: 14,
		previousReleaseId: 'legacy-v1',
		currentReleaseId: null,
		files,
		serverFiles: inventory(join(directory, 'server')),
		buildContract: contract,
	}
	const raw = `${JSON.stringify(manifest, null, 2)}\n`
	write(root, `${releasePath}/manifest.json`, raw)
	write(root, `${releasePath}/manifest.sha256`, `${sha(raw)}\n`)
	assert.equal(verifyRelease(root, OLD_ID).manifest.schemaVersion, 2)
	const entry = { releaseId: OLD_ID, manifestSha256: sha(raw), archiveFile }
	return { root, entry, directory, archive, contract }
}
function current(root, path = NEW, bytes = 'new-current-bytes\n') {
	write(
		root,
		'packages/web/src/main.tsx',
		'export const currentBuild = true;\n'
	)
	const buildContract = {
		version: 2,
		buildId: NEXT_UUID,
		sourceSha256: inventoryWebBuildInputs(join(root, 'packages/web'))
			.sourceSha256,
	}
	write(root, 'packages/web/dist/index.html', '<html>new build</html>')
	write(root, `packages/web/dist/${path}`, bytes)
	for (const directory of [
		'packages/web/dist',
		'packages/web/dist-server/node',
		'packages/web/dist-server/worker',
	])
		write(
			root,
			`${directory}/build-contract.json`,
			JSON.stringify(buildContract)
		)
	for (const target of ['node', 'worker'])
		write(
			root,
			`packages/web/dist-server/${target}/index.mjs`,
			'export const newBuild = true;\n'
		)
	return buildContract
}
function verifyImports(root, entries, options = {}) {
	return verifyHistoricalSourceImports(root, entries, {
		createdAt: NEXT,
		retentionDays: 14,
		verifyRelease,
		...options,
	})
}
function rejectPackage(root, entry, options = {}) {
	const id = 'rejected-candidate'
	assert.throws(() =>
		packageRelease({
			root,
			id,
			at: NEXT,
			historicalSources: [entry],
			...options,
		})
	)
	assert.ok(
		!fs.existsSync(join(root, '.release/web', id)),
		'Reject before creating frozen output'
	)
}

test('historical verification binds the original v2 release and only its current hashed assets', (t) => {
	const value = fixture(t)
	const [verified] = verifyImports(value.root, [value.entry])
	assert.equal(verified.releaseId, OLD_ID)
	assert.equal(verified.manifestSha256, value.entry.manifestSha256)
	assert.equal(verified.createdAt, START)
	assert.deepEqual(verified.bytes, value.archive.bytes)
	assert.deepEqual(verified.descriptor, value.archive.descriptor)
	assert.deepEqual(
		verified.currentAssets.map((file) => file.path),
		[OLD]
	)
	assert.equal(verified.currentAssets[0].lastCurrentAt, START)
})

test('candidate imports historical current source while inherited legacy source stays unresolved', (t) => {
	const { root, entry, archive } = fixture(t)
	const build = current(root)
	const result = packageRelease({
		root,
		id: 'imported',
		at: NEXT,
		previous: OLD_ID,
		historicalSources: [entry],
	})
	const delivery = verifyRelease(root, 'imported').manifest.sourceDelivery
	assert.deepEqual(result.manifest.buildContract, build)
	assert.deepEqual(
		delivery.assetSources.find((file) => file.path === OLD),
		{ path: OLD, archives: [archive.descriptor.path], unresolved: false }
	)
	assert.deepEqual(
		delivery.assetSources.find((file) => file.path === INHERITED),
		{ path: INHERITED, archives: [], unresolved: true }
	)
	assert.equal(delivery.coverageComplete, false)
	const imported = delivery.archives.find(
		(item) => item.path === archive.descriptor.path
	)
	assert.equal(imported.source, 'retained')
	assert.equal(imported.lastCurrentAt, START)
	assert.deepEqual(
		fs.readFileSync(join(result.assets, imported.path)),
		archive.bytes
	)
	assert.deepEqual(
		JSON.parse(
			fs.readFileSync(join(result.assets, 'sources/index.json'), 'utf8')
		),
		delivery
	)
	assert.ok(
		fs
			.readFileSync(join(result.assets, 'sources/index.html'), 'utf8')
			.includes(imported.path)
	)
})

test('a subsequent release keeps imported mappings and original TTL without reimport refresh', (t) => {
	const { root, entry, archive } = fixture(t)
	current(root)
	packageRelease({
		root,
		id: 'imported',
		at: NEXT,
		previous: OLD_ID,
		historicalSources: [entry],
	})
	const next = packageRelease({
		root,
		id: 'later',
		at: '2026-09-04',
		previous: 'imported',
		historicalSources: [entry],
	})
	const delivered = next.manifest.sourceDelivery
	assert.equal(
		delivered.archives.filter((item) => item.path === archive.descriptor.path)
			.length,
		1
	)
	assert.equal(
		delivered.archives.find((item) => item.path === archive.descriptor.path)
			.lastCurrentAt,
		START
	)
	assert.equal(
		delivered.assetSources.find((item) => item.path === OLD).unresolved,
		false
	)
	assert.equal(
		next.manifest.files.find((item) => item.path === OLD).lastCurrentAt,
		START
	)
	assert.equal(
		delivered.assetSources.find((item) => item.path === INHERITED).unresolved,
		true
	)
})

test('coverage becomes complete when every final hashed asset has a verified corresponding source', (t) => {
	const { root, entry } = fixture(t, { includeInherited: false })
	current(root)
	const result = packageRelease({
		root,
		id: 'complete',
		at: NEXT,
		previous: OLD_ID,
		historicalSources: [entry],
	})
	assert.equal(result.manifest.sourceDelivery.coverageComplete, true)
	assert.deepEqual(
		result.manifest.sourceDelivery.assetSources.map((file) => [
			file.path,
			file.unresolved,
		]),
		[
			[NEW, false],
			[OLD, false],
		].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
	)
	assert.equal(
		verifyRelease(root, 'complete').manifest.sourceDelivery.coverageComplete,
		true
	)
})

test('P68-style rollback keeps original current build/source bytes while importing older current assets', (t) => {
	const { root, entry, archive } = fixture(t)
	current(root)
	const p68 = packageRelease({
		root,
		id: 'p68',
		at: '2026-09-02',
		previous: OLD_ID,
	})
	write(root, 'packages/web/src/main.tsx', 'different live source after p68\n')
	fs.unlinkSync(join(root, 'packages/core/src/core.ts'))
	const rollback = packageRelease({
		root,
		id: 'rollback',
		at: NEXT,
		previous: 'p68',
		currentRelease: 'p68',
		historicalSources: [entry],
	})
	assert.deepEqual(rollback.manifest.buildContract, p68.manifest.buildContract)
	assert.equal(
		rollback.manifest.sourceDelivery.currentArchive,
		p68.manifest.sourceDelivery.currentArchive
	)
	assert.deepEqual(
		verifyBuildPair(rollback.assets, rollback.server),
		p68.manifest.buildContract
	)
	assert.deepEqual(
		fs.readFileSync(
			join(rollback.assets, rollback.manifest.sourceDelivery.currentArchive)
		),
		fs.readFileSync(
			join(p68.assets, p68.manifest.sourceDelivery.currentArchive)
		)
	)
	assert.deepEqual(
		rollback.manifest.sourceDelivery.assetSources.find(
			(file) => file.path === OLD
		),
		{ path: OLD, archives: [archive.descriptor.path], unresolved: false }
	)
	assert.equal(
		rollback.manifest.sourceDelivery.assetSources.find(
			(file) => file.path === INHERITED
		).unresolved,
		true
	)
})

test('reader and actual CLI use an explicit versioned safe-relative import config', (t) => {
	const { root, entry } = fixture(t)
	const config = 'imports/config.json'
	write(root, config, JSON.stringify({ version: 1, sources: [entry] }))
	assert.deepEqual(readHistoricalSourceImports(root, config), [entry])
	const cli = copiedCLI(root)
	current(root)
	const command = spawnSync(
		process.execPath,
		[
			cli,
			'--id',
			'cli-imported',
			'--at',
			NEXT,
			'--previous',
			OLD_ID,
			'--historical-sources',
			config,
		],
		{ encoding: 'utf8', windowsHide: true }
	)
	assert.equal(command.status, 0, command.stderr || command.stdout)
	assert.equal(
		verifyRelease(
			root,
			'cli-imported'
		).manifest.sourceDelivery.assetSources.find((file) => file.path === OLD)
			.unresolved,
		false
	)
})

test('exact historical TTL cutoff is eligible and one millisecond beyond is rejected', (t) => {
	const { root, entry } = fixture(t)
	assert.equal(
		verifyImports(root, [entry], { createdAt: '2026-09-15T00:00:00.000Z' })
			.length,
		1
	)
	assert.throws(() =>
		verifyImports(root, [entry], { createdAt: '2026-09-15T00:00:00.001Z' })
	)
	current(root)
	rejectPackage(root, entry, {
		at: '2026-09-15T00:00:00.001Z',
		previous: OLD_ID,
	})
})

for (const [name, mutate] of [
	[
		'incorrect external release pin',
		(value) => {
			value.entry.manifestSha256 = 'f'.repeat(64)
		},
	],
	[
		'corrupted archive',
		(value) => {
			const bytes = Buffer.from(value.archive.bytes)
			bytes[0] ^= 1
			write(value.root, value.entry.archiveFile, bytes)
		},
	],
	[
		'archive from another build',
		(value) => {
			const changed = { ...value.contract, buildId: NEXT_UUID }
			write(
				value.root,
				value.entry.archiveFile,
				createSourceArchive(join(value.root, 'packages/web'), changed).bytes
			)
		},
	],
	[
		'nonregular archive path',
		(value) => {
			fs.unlinkSync(join(value.root, value.entry.archiveFile))
			fs.mkdirSync(join(value.root, value.entry.archiveFile))
		},
	],
	[
		'oversized archive',
		(value) =>
			fs.truncateSync(
				join(value.root, value.entry.archiveFile),
				20 * 1024 * 1024 + 1
			),
	],
]) {
	test(`${name} rejects the candidate before mkdir`, (t) => {
		const value = fixture(t)
		mutate(value)
		current(value.root)
		rejectPackage(value.root, value.entry, { previous: OLD_ID })
	})
}

test('a v1 original build cannot acquire an allegedly complete v2 source archive', (t) => {
	const value = fixture(t)
	const legacy = { ...value.contract, version: 1 }
	markers(value.root, `.release/web/${OLD_ID}`, legacy)
	resign(value.directory, (manifest) => {
		manifest.buildContract = legacy
		manifest.files = inventory(join(value.directory, 'assets')).map((file) => ({
			...file,
			source: file.path === INHERITED ? 'retained' : 'current',
			lastCurrentAt: file.path === INHERITED ? EARLY : START,
		}))
		manifest.serverFiles = inventory(join(value.directory, 'server'))
	})
	value.entry.manifestSha256 = sha(
		fs.readFileSync(join(value.directory, 'manifest.json'))
	)
	assert.throws(() => verifyImports(value.root, [value.entry]))
})

test('original release changes during verify callback invalidate the pinned import', (t) => {
	const value = fixture(t)
	let changed = false
	assert.throws(() =>
		verifyImports(value.root, [value.entry], {
			verifyRelease(root, id) {
				const verified = verifyRelease(root, id)
				resign(verified.directory, (manifest) => {
					manifest.changedAfterVerification = true
				})
				changed = true
				return verified
			},
		})
	)
	assert.ok(changed)
})

test('verified callback metadata cannot replace the externally pinned original manifest', (t) => {
	const { root, entry } = fixture(t)
	for (const edit of [
		(value) => {
			value.manifestSha256 = '0'.repeat(64)
		},
		(value) => {
			value.manifest = { ...value.manifest, invented: true }
		},
	]) {
		assert.throws(() =>
			verifyImports(root, [entry], {
				verifyRelease(base, id) {
					const value = verifyRelease(base, id)
					edit(value)
					return value
				},
			})
		)
	}
})

test('one original target marker cannot claim another build even under a correctly repinned release', (t) => {
	const value = fixture(t)
	write(
		value.root,
		`.release/web/${OLD_ID}/server/worker/build-contract.json`,
		JSON.stringify({ ...value.contract, buildId: NEXT_UUID })
	)
	resign(value.directory, (manifest) => {
		manifest.serverFiles = inventory(join(value.directory, 'server'))
	})
	value.entry.manifestSha256 = sha(
		fs.readFileSync(join(value.directory, 'manifest.json'))
	)
	assert.throws(() => verifyImports(value.root, [value.entry]))
	current(value.root)
	rejectPackage(value.root, value.entry, { previous: OLD_ID })
})

test('an import with no eligible final asset is rejected rather than adding an unreferenced archive', (t) => {
	const { root, entry } = fixture(t)
	current(root)
	rejectPackage(root, entry)
})

test('old retained-only bytes cannot satisfy a historical current asset match', (t) => {
	const { root, entry } = fixture(t)
	current(root, INHERITED, 'legacy-inherited-bytes\n')
	rejectPackage(root, entry)
})

test('same hashed path with different final bytes rejects even when history is not previous', (t) => {
	const { root, entry } = fixture(t)
	current(root, OLD, 'different bytes under old hash path\n')
	rejectPackage(root, entry)
})

test('future original release and duplicate import entries reject without output', (t) => {
	const { root, entry } = fixture(t)
	assert.throws(() => verifyImports(root, [entry], { createdAt: EARLY }))
	assert.throws(() => verifyImports(root, [entry, entry]))
	current(root)
	rejectPackage(root, entry, { at: EARLY, previous: OLD_ID })
	rejectPackage(root, entry, {
		previous: OLD_ID,
		historicalSources: [entry, entry],
	})
})

test('config bounded reads reject oversized, invalid UTF-8 and nonordinary files', (t) => {
	const { root } = fixture(t)
	const config = 'imports/bad-config.json'
	for (const bytes of [
		Buffer.alloc(64 * 1024 + 1, 0x20),
		Buffer.from([0xff]),
	]) {
		write(root, config, bytes)
		assert.throws(() => readHistoricalSourceImports(root, config))
	}
	fs.unlinkSync(join(root, config))
	fs.mkdirSync(join(root, config))
	assert.throws(() => readHistoricalSourceImports(root, config))
})

test('ordinary Unicode and space names are accepted without decoding path text', (t) => {
	const { root, entry, archive } = fixture(t)
	const unicode = { ...entry, archiveFile: 'imports/中文 原始%2f源码.tar.gz' }
	write(root, unicode.archiveFile, archive.bytes)
	const config = 'imports/中文 配置.json'
	write(root, config, JSON.stringify({ version: 1, sources: [unicode] }))
	assert.deepEqual(readHistoricalSourceImports(root, config), [unicode])
	assert.deepEqual(verifyImports(root, [unicode])[0].bytes, archive.bytes)
})

test('strict config schema, entry keys, counts and pins fail before release verification', (t) => {
	const { root, entry } = fixture(t)
	for (const config of [
		[entry],
		{ version: 2, sources: [entry] },
		{ version: 1, sources: [entry], extra: true },
		{ version: 1, sources: [{ ...entry, extra: true }] },
		{ version: 1, sources: [{ ...entry, manifestSha256: 'invalid' }] },
		{ version: 1, sources: [entry, entry] },
		{
			version: 1,
			sources: Array.from({ length: 33 }, (_, index) => ({
				...entry,
				releaseId: `unique-${index}`,
			})),
		},
	]) {
		write(root, 'imports/config.json', JSON.stringify(config))
		assert.throws(() =>
			readHistoricalSourceImports(root, 'imports/config.json')
		)
	}
})

for (const unsafe of [
	'../archive.tar.gz',
	'/absolute.tar.gz',
	'C:/archive.tar.gz',
	'imports\\history.tar.gz',
	'imports//history.tar.gz',
	'./imports/history.tar.gz',
]) {
	test(`unsafe import archive path ${unsafe} is rejected`, (t) => {
		const { root, entry } = fixture(t)
		assert.throws(() =>
			verifyImports(root, [{ ...entry, archiveFile: unsafe }])
		)
		assert.throws(() => readHistoricalSourceImports(root, unsafe))
	})
}

test('linked archive ancestor and linked config ancestor are rejected', (t) => {
	const { root, entry } = fixture(t)
	write(
		root,
		'imports/config.json',
		JSON.stringify({ version: 1, sources: [entry] })
	)
	const link = join(root, 'linked-imports')
	fs.symlinkSync(
		join(root, 'imports'),
		link,
		process.platform === 'win32' ? 'junction' : 'dir'
	)
	try {
		assert.throws(() =>
			verifyImports(root, [
				{ ...entry, archiveFile: 'linked-imports/history.tar.gz' },
			])
		)
		assert.throws(() =>
			readHistoricalSourceImports(root, 'linked-imports/config.json')
		)
	} finally {
		fs.unlinkSync(link)
	}
})
