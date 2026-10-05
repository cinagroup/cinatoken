/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
	WEB_BUILD_INPUT_POLICY,
	inventoryWebBuildInputs,
} from './build-inputs.mjs'
import { createSourceArchive, verifySourceArchive } from './source-archive.mjs'

const BUILD_ID = 'aebfd173-3c8d-4e22-930f-b48cf6e199b4'
const MANIFEST = 'SOURCE-MANIFEST.json'
const LONG_PATH =
	'packages/web/src/long-path-segment-one/long-path-segment-two/long-path-segment-three/source with spaces.ts'
const SOURCE_FILES = {
	'package.json': '{"private":true,"workspaces":["packages/*"]}\n',
	'package-lock.json': '{"lockfileVersion":3}\n',
	LICENSE: 'AGPL fixture\n',
	'NOTICE.frontend': 'Synthetic attribution\n',
	'.nvmrc': '22\n',
	'.dockerignore': 'node_modules\n.release\n',
	'packages/web/package.json': '{"name":"@cinatoken/web"}\n',
	'packages/web/index.html': '<!doctype html>\r\n',
	'packages/web/rsbuild.config.ts': 'export default {};\n',
	'packages/web/postcss.config.mjs': 'export default {};\n',
	'packages/web/tsconfig.json': '{}\n',
	'packages/web/tsconfig.app.json': '{}\n',
	'packages/web/tsconfig.node.json': '{}\n',
	'packages/web/src/main.tsx':
		"export { rate } from '@octafuse/core/deep/rates';\n",
	'packages/web/src/模型 with spaces.ts': Buffer.from(
		'\uFEFFexport const 文本 = "完整原始字节";\r\n'
	),
	[LONG_PATH]: 'export const longName = true;\n',
	'packages/web/src/features/keys/editor.tsx':
		'export const keyFeature = true;\n',
	'packages/web/src/features/credentials/client.ts':
		'export const client = true;\n',
	'packages/web/public/logo.bin': Buffer.from([0, 1, 127, 128, 255]),
	'packages/web/edge/worker.ts': 'export default {};\n',
	'packages/web/scripts/build.mjs': 'export const build = true;\n',
	'packages/core/package.json': '{"name":"@octafuse/core"}\n',
	'packages/core/src/index.ts': "export { rate } from './deep/rates';\n",
	'packages/core/src/deep/rates.ts': 'export const rate = 1;\r\n',
	'packages/admin/package.json': '{"name":"@cinatoken/admin"}\n',
	'packages/admin/lib/model-vendors.json': '{"vendors":["fixture"]}\n',
	'packages/tool-engines/package.json': '{"name":"@cinatoken/tool-engines"}\n',
	'packages/proxy/package.json': '{"name":"@cinatoken/proxy"}\n',
	'packages/chain-worker/package.json': '{"name":"@cinatoken/chain-worker"}\n',
	'Dockerfile.web': 'FROM fixture\n',
	'Dockerfile.web-ssr': 'FROM fixture-ssr\n',
	'docker/web/public-server.mjs': 'export const server = true;\n',
	'docker/web/nginx.conf.template': 'server { listen 8080; }\n',
	'docker/web/admin-proxy.conf':
		'location /api { proxy_pass http://fixture; }\n',
	'docker/web/entrypoint.sh': '#!/bin/sh\nexit 0\n',
	'scripts/web/source-provenance.mjs': 'export const provenance = true;\n',
	'.github/workflows/web-frontend.yml': 'name: synthetic-web\n',
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex')
}

function byteOrder(left, right) {
	return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function write(root, path, bytes) {
	const target = join(root, path)
	fs.mkdirSync(dirname(target), { recursive: true })
	fs.writeFileSync(target, bytes)
	return target
}

function removeFixture(root) {
	const temporary = fs.realpathSync(tmpdir())
	const target = fs.realpathSync(root)
	const rel = relative(temporary, target)
	assert.ok(
		!isAbsolute(rel) &&
			rel !== '..' &&
			!rel.startsWith(`..${sep}`) &&
			rel.startsWith('cinatoken-web-source-archive-')
	)
	fs.rmSync(target, { recursive: true })
}

function fixture(t, reverse = false) {
	const root = fs.realpathSync(
		fs.mkdtempSync(
			join(fs.realpathSync(tmpdir()), 'cinatoken-web-source-archive-')
		)
	)
	t.after(() => {
		if (fs.existsSync(root)) removeFixture(root)
	})
	const entries = Object.entries(SOURCE_FILES)
	if (reverse) entries.reverse()
	for (const [path, bytes] of entries) write(root, path, bytes)
	const packageRoot = join(root, 'packages/web')
	const buildContract = {
		version: 2,
		buildId: BUILD_ID,
		sourceSha256: inventoryWebBuildInputs(packageRoot).sourceSha256,
	}
	return { root, packageRoot, buildContract }
}

function archive(t) {
	const fixtureValue = fixture(t)
	const created = createSourceArchive(
		fixtureValue.packageRoot,
		fixtureValue.buildContract
	)
	return { ...fixtureValue, ...created }
}

// These helpers only decode/reframe standard TAR and gzip bytes; they neither
// call the production verifier nor extract any member to the filesystem.
function field(header, offset, length) {
	const bytes = header.subarray(offset, offset + length)
	const end = bytes.indexOf(0)
	return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8')
}

function members(bytes) {
	const tar = gunzipSync(bytes)
	const result = []
	let offset = 0
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512)
		if (header.every((value) => value === 0)) break
		const prefix = field(header, 345, 155)
		const name = field(header, 0, 100)
		const path = prefix ? `${prefix}/${name}` : name
		const size = Number.parseInt(field(header, 124, 12), 8)
		assert.ok(Number.isSafeInteger(size) && size >= 0)
		assert.ok(offset + 512 + size <= tar.length)
		result.push({
			path,
			header: Buffer.from(header),
			bytes: Buffer.from(tar.subarray(offset + 512, offset + 512 + size)),
		})
		offset += 512 + Math.ceil(size / 512) * 512
	}
	return result
}

function octal(header, offset, width, value) {
	header.write(
		`${value.toString(8).padStart(width - 1, '0')}\0`,
		offset,
		width,
		'ascii'
	)
}

function checksum(header) {
	header.fill(32, 148, 156)
	const sum = header.reduce((total, value) => total + value, 0)
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
}

function rename(member, name) {
	member.path = name
	member.header.fill(0, 0, 100)
	member.header.fill(0, 345, 500)
	assert.ok(
		Buffer.byteLength(name) <= 100,
		'Mutation path must fit one name field'
	)
	member.header.write(name, 0, 100, 'utf8')
	checksum(member.header)
}

function replaceBytes(member, bytes) {
	member.bytes = Buffer.from(bytes)
	octal(member.header, 124, 12, member.bytes.length)
	checksum(member.header)
}

function canonicalGzip(tar, level = 9) {
	const bytes = gzipSync(tar, { level })
	// The archive format fixes XFL/OS; gzipSync still computes real CRC32/ISIZE.
	bytes[8] = 2
	bytes[9] = 255
	return bytes
}

function tarBytes(entries) {
	return Buffer.concat([
		...entries.flatMap((entry) => [
			entry.header,
			entry.bytes,
			Buffer.alloc((512 - (entry.bytes.length % 512)) % 512),
		]),
		Buffer.alloc(1024),
	])
}

function pack(entries) {
	return canonicalGzip(
		tarBytes(
			[...entries].sort((left, right) => byteOrder(left.path, right.path))
		)
	)
}

function sourceMember(entries) {
	return entries.find(
		(entry) => entry.path === 'source/packages/core/src/deep/rates.ts'
	)
}

function editManifest(entries, edit) {
	const entry = entries.find((candidate) => candidate.path === MANIFEST)
	const manifest = JSON.parse(entry.bytes.toString('utf8'))
	edit(manifest)
	replaceBytes(entry, `${JSON.stringify(manifest, null, 2)}\n`)
	return manifest
}

function rebindManifest(manifest, entries) {
	manifest.files.sort((left, right) => byteOrder(left.path, right.path))
	const digest = createHash('sha256')
		.update(manifest.policy.digest.domain)
		.update(`${manifest.policySha256}\0`)
	manifest.totalSourceBytes = 0
	for (const file of manifest.files) {
		const bytes = entries.find(
			(entry) => entry.path === `source/${file.path}`
		).bytes
		digest.update(`${file.path}\0${bytes.length}\0`).update(bytes)
		manifest.totalSourceBytes += bytes.length
	}
	manifest.buildContract.sourceSha256 = digest.digest('hex')
}

function assertArchiveError(operation) {
	assert.throws(operation, /Source archive:/)
}

test('archive binds exact original bytes, shared inputs and independently recalculated metadata', (t) => {
	const result = archive(t)
	assert.ok(Buffer.isBuffer(result.bytes))
	const entries = members(result.bytes)
	const paths = entries.map((entry) => entry.path)
	assert.deepEqual(paths, [...paths].sort(byteOrder))
	assert.deepEqual(
		paths,
		[
			'BUILDING.md',
			MANIFEST,
			...Object.keys(SOURCE_FILES).map((path) => `source/${path}`),
		].sort(byteOrder)
	)
	const manifest = JSON.parse(
		entries.find((entry) => entry.path === MANIFEST).bytes.toString('utf8')
	)
	assert.deepEqual(result.manifest, manifest)
	assert.deepEqual(
		Object.keys(manifest).sort(),
		[
			'schemaVersion',
			'buildContract',
			'policy',
			'policySha256',
			'files',
			'totalSourceBytes',
		].sort()
	)
	assert.equal(manifest.schemaVersion, 1)
	assert.deepEqual(manifest.buildContract, result.buildContract)
	assert.deepEqual(manifest.policy, WEB_BUILD_INPUT_POLICY)
	assert.equal(
		manifest.policySha256,
		sha256(Buffer.from(JSON.stringify(manifest.policy)))
	)
	assert.deepEqual(
		manifest.files.map((entry) => entry.path),
		Object.keys(SOURCE_FILES).sort(byteOrder)
	)
	const digest = createHash('sha256')
		.update(manifest.policy.digest.domain)
		.update(`${manifest.policySha256}\0`)
	let total = 0
	for (const file of manifest.files) {
		const bytes = entries.find(
			(entry) => entry.path === `source/${file.path}`
		).bytes
		assert.deepEqual(bytes, Buffer.from(SOURCE_FILES[file.path]))
		assert.equal(file.bytes, bytes.length)
		assert.equal(file.sha256, sha256(bytes))
		assert.ok(typeof file.role === 'string' && file.role.length > 0)
		digest.update(`${file.path}\0${bytes.length}\0`).update(bytes)
		total += bytes.length
	}
	assert.equal(manifest.totalSourceBytes, total)
	assert.equal(digest.digest('hex'), result.buildContract.sourceSha256)
	assert.deepEqual(result.descriptor, {
		path: `sources/web.${sha256(result.bytes)}.tar.gz`,
		bytes: result.bytes.length,
		sha256: sha256(result.bytes),
		buildContract: result.buildContract,
		inputPolicySha256: manifest.policySha256,
		fileCount: manifest.files.length,
		totalSourceBytes: total,
	})
	const verified = verifySourceArchive(result.bytes, {
		expectedBuildContract: result.buildContract,
	})
	assert.deepEqual(verified.descriptor, result.descriptor)
	assert.deepEqual(verified.manifest, result.manifest)
})

test('standard USTAR headers, UTF-8 prefix paths and gzip framing are canonical', (t) => {
	const result = archive(t)
	assert.deepEqual(
		[...result.bytes.subarray(0, 10)],
		[31, 139, 8, 0, 0, 0, 0, 0, 2, 255]
	)
	const entries = members(result.bytes)
	for (const entry of entries) {
		assert.equal(field(entry.header, 100, 8), '0000644')
		for (const [offset, length] of [
			[108, 8],
			[116, 8],
			[136, 12],
			[329, 8],
			[337, 8],
		])
			assert.equal(Number.parseInt(field(entry.header, offset, length), 8), 0)
		assert.equal(entry.header[156], '0'.charCodeAt(0))
		assert.equal(field(entry.header, 257, 6), 'ustar')
		assert.equal(entry.header.subarray(263, 265).toString('ascii'), '00')
		assert.equal(field(entry.header, 265, 32), '')
		assert.equal(field(entry.header, 297, 32), '')
		const header = Buffer.from(entry.header)
		header.fill(32, 148, 156)
		assert.equal(
			Number.parseInt(field(entry.header, 148, 8), 8),
			header.reduce((sum, value) => sum + value, 0)
		)
	}
	assert.ok(
		field(
			entries.find((entry) => entry.path === `source/${LONG_PATH}`).header,
			345,
			155
		).length > 0
	)
	assert.deepEqual(gunzipSync(result.bytes).subarray(-1024), Buffer.alloc(1024))
})

test('identical source bytes archive identically across roots, creation order and timestamps', (t) => {
	const first = fixture(t)
	const second = fixture(t, true)
	for (const path of Object.keys(SOURCE_FILES))
		fs.utimesSync(join(second.root, path), new Date(0), new Date(0))
	const left = createSourceArchive(first.packageRoot, first.buildContract)
	const right = createSourceArchive(second.packageRoot, second.buildContract)
	assert.deepEqual(left.bytes, right.bytes)
	assert.deepEqual(left.descriptor, right.descriptor)
})

test('synthetic secrets and generated outputs are excluded without opening them', (t) => {
	const { root, packageRoot, buildContract } = fixture(t)
	const baseline = createSourceArchive(packageRoot, buildContract)
	const paths = [
		'.env',
		'.npmrc',
		'packages/web/src/.env.production',
		'packages/core/src/certificate.pem',
		'packages/web/src/credentials/private.json',
		'packages/web/keys/private.ts',
		'packages/web/src/.tmp/generated.ts',
		'packages/core/src/node_modules/dependency.ts',
		'packages/web/dist/index.html',
		'packages/web/dist-server/worker/index.mjs',
		'.release/web/old/sources/archive.tar.gz',
	]
	const excluded = new Set(
		paths.map((path) =>
			resolve(write(root, path, 'SYNTHETIC-EXCLUDED-CANARY\n'))
		)
	)
	for (const name of ['openSync', 'readFileSync']) {
		const original = fs[name]
		t.mock.method(fs, name, (path, ...args) => {
			if (typeof path === 'string')
				assert.ok(
					!excluded.has(resolve(path)),
					`Opened excluded canary: ${path}`
				)
			return original(path, ...args)
		})
	}
	const result = createSourceArchive(packageRoot, buildContract)
	assert.deepEqual(result.bytes, baseline.bytes)
	assert.ok(
		!gunzipSync(result.bytes).includes(Buffer.from('SYNTHETIC-EXCLUDED-CANARY'))
	)
	assert.ok(
		result.manifest.files.some((file) => file.path.endsWith('/keys/editor.tsx'))
	)
	assert.ok(
		result.manifest.files.some((file) =>
			file.path.endsWith('/credentials/client.ts')
		)
	)
})

for (const path of [
	'packages/core/src/deep/rates.ts',
	'packages/admin/lib/model-vendors.json',
	'docker/web/public-server.mjs',
	'.dockerignore',
]) {
	test(`creator rejects build/source drift in ${path}`, (t) => {
		const { root, packageRoot, buildContract } = fixture(t)
		fs.appendFileSync(join(root, path), 'changed since build\n')
		assertArchiveError(() => createSourceArchive(packageRoot, buildContract))
	})
}

test('only strict complete version 2 contracts can create new archives', (t) => {
	const { packageRoot, buildContract } = fixture(t)
	for (const invalid of [
		{ ...buildContract, version: 1 },
		{ ...buildContract, version: 3 },
		{ ...buildContract, version: '2' },
		{ ...buildContract, extra: true },
		{ ...buildContract, buildId: 'invalid' },
		{ ...buildContract, sourceSha256: 'short' },
	])
		assertArchiveError(() => createSourceArchive(packageRoot, invalid))
})

test('source changes during archive creation cannot return a successful descriptor', (t) => {
	const { root, packageRoot, buildContract } = fixture(t)
	const target = resolve(root, 'packages/core/src/deep/rates.ts')
	const originalOpen = fs.openSync
	const originalRead = fs.readFileSync
	const originalReadSync = fs.readSync
	let targetDescriptor
	let opens = 0
	let changed = false
	function afterRead(descriptor) {
		if (descriptor === targetDescriptor && opens === 2 && !changed) {
			changed = true
			fs.appendFileSync(target, 'actually changed while packaging\n')
		}
	}
	t.mock.method(fs, 'openSync', (path, ...args) => {
		const descriptor = originalOpen(path, ...args)
		if (typeof path === 'string' && resolve(path) === target) {
			opens += 1
			targetDescriptor = descriptor
		}
		return descriptor
	})
	t.mock.method(fs, 'readFileSync', (path, ...args) => {
		const bytes = originalRead(path, ...args)
		afterRead(path)
		return bytes
	})
	t.mock.method(fs, 'readSync', (descriptor, ...args) => {
		const bytesRead = originalReadSync(descriptor, ...args)
		afterRead(descriptor)
		return bytesRead
	})
	assertArchiveError(() => createSourceArchive(packageRoot, buildContract))
	assert.ok(
		changed,
		'Actual fixture source must change inside archive creation'
	)
})

test('verification needs no source tree, filesystem reads or extraction', (t) => {
	const result = archive(t)
	removeFixture(result.root)
	for (const name of [
		'readFileSync',
		'openSync',
		'readdirSync',
		'statSync',
		'lstatSync',
		'realpathSync',
		'writeFileSync',
		'mkdirSync',
	]) {
		t.mock.method(fs, name, () =>
			assert.fail(`Source-free verifier called fs.${name}`)
		)
	}
	const verified = verifySourceArchive(result.bytes, {
		expectedBuildContract: result.buildContract,
	})
	assert.deepEqual(verified.descriptor, result.descriptor)
	assert.deepEqual(verified.manifest, result.manifest)
})

test('a matching externally recompressed legal DEFLATE stream verifies independently', (t) => {
	const result = archive(t)
	const alternative = canonicalGzip(gunzipSync(result.bytes), 1)
	assert.notDeepEqual(alternative, result.bytes)
	const verified = verifySourceArchive(alternative, {
		expectedBuildContract: result.buildContract,
	})
	assert.deepEqual(verified.manifest, result.manifest)
	assert.equal(verified.descriptor.sha256, sha256(alternative))
	assert.equal(verified.descriptor.bytes, alternative.length)
})

test('expected build identity, version and fingerprint must all match', (t) => {
	const result = archive(t)
	for (const expectedBuildContract of [
		{
			...result.buildContract,
			buildId: '9c96646d-e7e3-4e7f-8757-a377c1c9b94b',
		},
		{ ...result.buildContract, sourceSha256: 'b'.repeat(64) },
		{ ...result.buildContract, version: 1 },
		{ ...result.buildContract, unexpected: true },
	])
		assertArchiveError(() =>
			verifySourceArchive(result.bytes, { expectedBuildContract })
		)
})

for (const [name, mutation] of [
	['non-gzip input', () => Buffer.from('not a gzip archive')],
	['truncated gzip footer', (bytes) => bytes.subarray(0, bytes.length - 1)],
	[
		'corrupt gzip CRC32',
		(bytes) => {
			bytes[bytes.length - 8] ^= 1
			return bytes
		},
	],
	[
		'noncanonical gzip header',
		(bytes) => {
			bytes[9] = 3
			return bytes
		},
	],
	['trailing gzip bytes', (bytes) => Buffer.concat([bytes, Buffer.from([1])])],
	['concatenated gzip streams', (bytes) => Buffer.concat([bytes, bytes])],
]) {
	test(`verifier rejects ${name}`, (t) => {
		const result = archive(t)
		assertArchiveError(() =>
			verifySourceArchive(mutation(Buffer.from(result.bytes)))
		)
	})
}

for (const [name, mutation] of [
	[
		'header checksum damage',
		(entries) => {
			sourceMember(entries).header[0] ^= 1
		},
	],
	[
		'symbolic-link member',
		(entries) => {
			const entry = sourceMember(entries)
			entry.header[156] = 50
			entry.header.write('../../target', 157)
			checksum(entry.header)
		},
	],
	[
		'hard-link member',
		(entries) => {
			const entry = sourceMember(entries)
			entry.header[156] = 49
			entry.header.write('source/package.json', 157)
			checksum(entry.header)
		},
	],
	[
		'PAX extension member',
		(entries) => {
			const entry = sourceMember(entries)
			entry.header[156] = 120
			checksum(entry.header)
		},
	],
	[
		'traversal member',
		(entries) => rename(sourceMember(entries), 'source/../../escape.ts'),
	],
	[
		'absolute member',
		(entries) => rename(sourceMember(entries), '/absolute.ts'),
	],
	[
		'backslash member',
		(entries) => rename(sourceMember(entries), 'source/packages\\escape.ts'),
	],
	[
		'duplicate member',
		(entries) =>
			entries.push({
				...entries[0],
				header: Buffer.from(entries[0].header),
				bytes: Buffer.from(entries[0].bytes),
			}),
	],
	[
		'unknown source member',
		(entries) => {
			const entry = {
				...sourceMember(entries),
				header: Buffer.from(sourceMember(entries).header),
			}
			rename(entry, 'source/packages/web/src/unknown.ts')
			entries.push(entry)
		},
	],
	[
		'missing source member',
		(entries) => entries.splice(entries.indexOf(sourceMember(entries)), 1),
	],
	[
		'missing manifest',
		(entries) =>
			entries.splice(
				entries.findIndex((entry) => entry.path === MANIFEST),
				1
			),
	],
	[
		'missing build instructions',
		(entries) =>
			entries.splice(
				entries.findIndex((entry) => entry.path === 'BUILDING.md'),
				1
			),
	],
	[
		'changed build instructions',
		(entries) =>
			replaceBytes(
				entries.find((entry) => entry.path === 'BUILDING.md'),
				'tampered instructions\n'
			),
	],
	[
		'oversized declared file bounds',
		(entries) => {
			const entry = sourceMember(entries)
			octal(entry.header, 124, 12, 64 * 1024 * 1024 + 1)
			checksum(entry.header)
		},
	],
	[
		'within-budget declared length exceeding TAR data',
		(entries) => {
			const entry = entries.at(-1)
			octal(entry.header, 124, 12, 16 * 1024 * 1024)
			checksum(entry.header)
		},
	],
	[
		'nonzero source header timestamp',
		(entries) => {
			const entry = sourceMember(entries)
			octal(entry.header, 136, 12, 1)
			checksum(entry.header)
		},
	],
	[
		'source bytes tampering',
		(entries) => {
			sourceMember(entries).bytes[0] ^= 1
		},
	],
]) {
	test(`verifier rejects ${name} in a correctly recompressed archive`, (t) => {
		const result = archive(t)
		const entries = members(result.bytes)
		mutation(entries)
		assertArchiveError(() => verifySourceArchive(pack(entries)))
	})
}

test('verifier rejects unsorted members even when headers and checksums are valid', (t) => {
	const result = archive(t)
	const entries = members(result.bytes)
	const first = entries[2]
	entries[2] = entries[3]
	entries[3] = first
	assertArchiveError(() =>
		verifySourceArchive(canonicalGzip(tarBytes(entries)))
	)
})

for (const [name, mutation] of [
	['one terminal zero block', (tar) => tar.subarray(0, tar.length - 512)],
	['truncated TAR header', (tar) => tar.subarray(0, 500)],
	[
		'extra trailing zero block',
		(tar) => Buffer.concat([tar, Buffer.alloc(512)]),
	],
	[
		'nonzero TAR trailer',
		(tar) => {
			tar[tar.length - 1] = 1
			return tar
		},
	],
	[
		'nonzero payload padding',
		(tar) => {
			const size = Number.parseInt(field(tar.subarray(0, 512), 124, 12), 8)
			assert.ok(size % 512 !== 0)
			tar[512 + size] = 1
			return tar
		},
	],
]) {
	test(`verifier rejects ${name}`, (t) => {
		const result = archive(t)
		assertArchiveError(() =>
			verifySourceArchive(canonicalGzip(mutation(gunzipSync(result.bytes))))
		)
	})
}

for (const [name, mutation] of [
	[
		'unknown manifest field',
		(manifest) => {
			manifest.sourceRequirementComplete = true
		},
	],
	[
		'wrong schema',
		(manifest) => {
			manifest.schemaVersion = 2
		},
	],
	[
		'modified policy',
		(manifest) => {
			manifest.policy.limits.maxFiles += 1
		},
	],
	[
		'wrong policy digest',
		(manifest) => {
			manifest.policySha256 = 'c'.repeat(64)
		},
	],
	[
		'wrong total byte count',
		(manifest) => {
			manifest.totalSourceBytes += 1
		},
	],
	[
		'wrong per-file byte count',
		(manifest) => {
			manifest.files[0].bytes += 1
		},
	],
	[
		'wrong per-file digest',
		(manifest) => {
			manifest.files[0].sha256 = 'd'.repeat(64)
		},
	],
	[
		'unknown file metadata field',
		(manifest) => {
			manifest.files[0].extra = true
		},
	],
	[
		'wrong path role',
		(manifest) => {
			manifest.files.find(
				(file) => file.path === 'packages/core/src/deep/rates.ts'
			).role = 'web-source'
		},
	],
	[
		'wrong contract fingerprint',
		(manifest) => {
			manifest.buildContract.sourceSha256 = 'e'.repeat(64)
		},
	],
]) {
	test(`verifier rejects ${name} with valid gzip and TAR framing`, (t) => {
		const result = archive(t)
		const entries = members(result.bytes)
		editManifest(entries, mutation)
		assertArchiveError(() => verifySourceArchive(pack(entries)))
	})
}

test('updating a tampered file checksum cannot bypass the build fingerprint', (t) => {
	const result = archive(t)
	const entries = members(result.bytes)
	const source = sourceMember(entries)
	source.bytes[0] ^= 1
	editManifest(entries, (manifest) => {
		manifest.files.find(
			(file) => file.path === 'packages/core/src/deep/rates.ts'
		).sha256 = sha256(source.bytes)
	})
	assertArchiveError(() => verifySourceArchive(pack(entries)))
})

test('removing source and matching metadata cannot bypass the build fingerprint', (t) => {
	const result = archive(t)
	const entries = members(result.bytes)
	const source = sourceMember(entries)
	entries.splice(entries.indexOf(source), 1)
	editManifest(entries, (manifest) => {
		manifest.files = manifest.files.filter(
			(file) => file.path !== 'packages/core/src/deep/rates.ts'
		)
		manifest.totalSourceBytes -= source.bytes.length
	})
	assertArchiveError(() => verifySourceArchive(pack(entries)))
})

test('duplicate JSON keys cannot masquerade as the canonical manifest', (t) => {
	const result = archive(t)
	const entries = members(result.bytes)
	const entry = entries.find((candidate) => candidate.path === MANIFEST)
	const text = entry.bytes.toString('utf8')
	replaceBytes(
		entry,
		text.replace(
			'"schemaVersion": 1,',
			'"schemaVersion": 1,\n  "schemaVersion": 1,'
		)
	)
	assertArchiveError(() => verifySourceArchive(pack(entries)))
})

test('the expected build contract rejects a fully rehashed alternative archive', (t) => {
	const result = archive(t)
	const entries = members(result.bytes)
	const source = sourceMember(entries)
	source.bytes[0] ^= 1
	const manifest = editManifest(entries, (value) => {
		value.files.find(
			(file) => file.path === 'packages/core/src/deep/rates.ts'
		).sha256 = sha256(source.bytes)
		rebindManifest(value, entries)
	})
	const alternative = pack(entries)
	assert.notEqual(
		manifest.buildContract.sourceSha256,
		result.buildContract.sourceSha256
	)
	assert.deepEqual(verifySourceArchive(alternative).manifest, manifest)
	assertArchiveError(() =>
		verifySourceArchive(alternative, {
			expectedBuildContract: result.buildContract,
		})
	)
})

for (const path of [
	'packages/web/src/.env.production',
	'packages/web/src/.tmp/generated.ts',
]) {
	test(`a rehashed archive cannot introduce excluded input ${path}`, (t) => {
		const result = archive(t)
		const entries = members(result.bytes)
		const injected = {
			...sourceMember(entries),
			header: Buffer.from(sourceMember(entries).header),
		}
		rename(injected, `source/${path}`)
		replaceBytes(injected, 'SYNTHETIC-EXCLUDED-CANARY\n')
		entries.push(injected)
		editManifest(entries, (manifest) => {
			manifest.files.push({
				path,
				bytes: injected.bytes.length,
				sha256: sha256(injected.bytes),
				role: 'web-source',
			})
			rebindManifest(manifest, entries)
		})
		assertArchiveError(() => verifySourceArchive(pack(entries)))
	})
}

test('a rehashed archive cannot omit a required source configuration', (t) => {
	const result = archive(t)
	const entries = members(result.bytes)
	const removed = entries.find((entry) => entry.path === 'source/.dockerignore')
	entries.splice(entries.indexOf(removed), 1)
	editManifest(entries, (manifest) => {
		manifest.files = manifest.files.filter(
			(file) => file.path !== '.dockerignore'
		)
		rebindManifest(manifest, entries)
	})
	assertArchiveError(() => verifySourceArchive(pack(entries)))
})
