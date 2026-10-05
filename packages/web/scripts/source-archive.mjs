/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import {
	WEB_BUILD_INPUT_POLICY,
	inventoryWebBuildInputs,
} from './build-inputs.mjs'

const BLOCK = 512
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_BUILDING_BYTES = 64 * 1024
const MAX_MEMBERS = WEB_BUILD_INPUT_POLICY.limits.maxFiles + 2
const MAX_TAR_BYTES =
	WEB_BUILD_INPUT_POLICY.limits.maxTotalBytes +
	MAX_MANIFEST_BYTES +
	MAX_BUILDING_BYTES +
	MAX_MEMBERS * BLOCK * 2 +
	BLOCK * 2
const MAX_ARCHIVE_BYTES = MAX_TAR_BYTES + 1024 * 1024
const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255])
const utf8 = new TextDecoder('utf-8', { fatal: true })
const policySha256 = hash(Buffer.from(JSON.stringify(WEB_BUILD_INPUT_POLICY)))
const deniedNames = WEB_BUILD_INPUT_POLICY.exclusions.filePatterns.map(
	(pattern) => new RegExp(pattern, 'i')
)
const BUILDING = Buffer.from(`# Building the declared Web inputs

The source/ directory contains the original bytes of the declared version 2
Web build inputs. SOURCE-MANIFEST.json binds their inventory, input policy and
fingerprint to the supplied build contract. It does not establish upstream
provenance, import dates, per-file ownership or complete license compliance.

Use Node.js 22 and npm. From source/ (the repository root), run explicitly:

\`\`\`sh
npm ci --ignore-scripts
npm run build:web -- --no-env --env-mode production
\`\`\`

Do not automatically run the root postinstall script. Dependencies, environment
files, credentials, private data and generated outputs are intentionally absent.
Install only from the included root lockfile and workspace manifests; supply any
required environment configuration separately. Empty required input directories
listed in the policy may need to be recreated before inventorying an unpacked tree.

This describes the declared Web build inputs, not the entire application's source
or a verified native platform deployment. Archive metadata is deterministic for
the same inputs and build contract; compressed bytes can depend on the zlib version.
A rebuild generates a new build ID and is not promised to be byte-reproducible.
`)

function fail(message) {
	throw new Error(`Source archive: ${message}`)
}

function hash(bytes) {
	return createHash('sha256').update(bytes).digest('hex')
}

function byteOrder(left, right) {
	return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function exactKeys(value, keys) {
	return (
		value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).sort().join(',') === [...keys].sort().join(',')
	)
}

function contract(value) {
	if (
		!exactKeys(value, ['version', 'buildId', 'sourceSha256']) ||
		value.version !== 2 ||
		typeof value.buildId !== 'string' ||
		!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.buildId) ||
		typeof value.sourceSha256 !== 'string' ||
		!/^[0-9a-f]{64}$/.test(value.sourceSha256)
	)
		fail('invalid version 2 build contract')
	return {
		version: 2,
		buildId: value.buildId,
		sourceSha256: value.sourceSha256,
	}
}

function validPath(value) {
	if (
		typeof value !== 'string' ||
		!value ||
		/[\\:\x00-\x1f\x7f]/.test(value) ||
		value.split('/').some((part) => !part || part === '.' || part === '..')
	)
		fail('unsafe member path')
	return value
}

function splitName(memberPath) {
	validPath(memberPath)
	if (Buffer.byteLength(memberPath) <= 100)
		return { name: memberPath, prefix: '' }
	for (
		let index = memberPath.lastIndexOf('/');
		index > 0;
		index = memberPath.lastIndexOf('/', index - 1)
	) {
		const prefix = memberPath.slice(0, index)
		const name = memberPath.slice(index + 1)
		if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100)
			return { name, prefix }
	}
	fail('path cannot be encoded as USTAR name/prefix; PAX is unsupported')
}

function octal(header, offset, length, value) {
	const text = value.toString(8)
	if (!Number.isSafeInteger(value) || value < 0 || text.length >= length)
		fail('USTAR numeric field overflow')
	header.write(text.padStart(length - 1, '0'), offset, length - 1, 'ascii')
}

function tarHeader(memberPath, size) {
	const { name, prefix } = splitName(memberPath)
	const header = Buffer.alloc(BLOCK)
	header.write(name, 0, 100, 'utf8')
	octal(header, 100, 8, 0o644)
	octal(header, 108, 8, 0)
	octal(header, 116, 8, 0)
	octal(header, 124, 12, size)
	octal(header, 136, 12, 0)
	header.fill(32, 148, 156)
	header[156] = 48
	header.write('ustar\0', 257, 6, 'ascii')
	header.write('00', 263, 2, 'ascii')
	octal(header, 329, 8, 0)
	octal(header, 337, 8, 0)
	header.write(prefix, 345, 155, 'utf8')
	const checksum = header.reduce((total, byte) => total + byte, 0)
	header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
	header[154] = 0
	header[155] = 32
	return header
}

function readOctal(header, offset, length) {
	const field = header.subarray(offset, offset + length)
	if (
		field[length - 1] !== 0 ||
		!/^[0-7]+$/.test(field.subarray(0, -1).toString('ascii'))
	)
		fail('invalid USTAR numeric field')
	const value = Number.parseInt(field.subarray(0, -1).toString('ascii'), 8)
	if (!Number.isSafeInteger(value)) fail('USTAR numeric field overflow')
	return value
}

function textField(header, offset, length) {
	const field = header.subarray(offset, offset + length)
	const end = field.indexOf(0)
	if (end >= 0 && field.subarray(end).some((byte) => byte !== 0))
		fail('nonzero USTAR string padding')
	return utf8.decode(end < 0 ? field : field.subarray(0, end))
}

const crcTable = Array.from({ length: 256 }, (_, byte) => {
	let value = byte
	for (let bit = 0; bit < 8; bit++)
		value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
	return value >>> 0
})

function crc32(bytes) {
	let value = 0xffffffff
	for (const byte of bytes)
		value = crcTable[(value ^ byte) & 255] ^ (value >>> 8)
	return (value ^ 0xffffffff) >>> 0
}

function gzip(tar) {
	const payload = deflateRawSync(tar, { level: 9 })
	const trailer = Buffer.alloc(8)
	trailer.writeUInt32LE(crc32(tar), 0)
	trailer.writeUInt32LE(tar.length, 4)
	const bytes = Buffer.concat([GZIP_HEADER, payload, trailer])
	if (bytes.length > MAX_ARCHIVE_BYTES)
		fail('compressed archive byte limit exceeded')
	return bytes
}

function gunzip(bytes) {
	if (
		!Buffer.isBuffer(bytes) ||
		bytes.length < 20 ||
		bytes.length > MAX_ARCHIVE_BYTES
	)
		fail('invalid compressed archive size')
	if (!bytes.subarray(0, 10).equals(GZIP_HEADER))
		fail('noncanonical gzip header')
	const payload = bytes.subarray(10, -8)
	let result
	try {
		result = inflateRawSync(payload, {
			info: true,
			maxOutputLength: MAX_TAR_BYTES,
		})
	} catch {
		fail('invalid or oversized compressed payload')
	}
	const tar = result.buffer
	if (result.engine.bytesWritten !== payload.length)
		fail('extra compressed stream or trailing data')
	if (
		bytes.readUInt32LE(bytes.length - 4) !== tar.length ||
		bytes.readUInt32LE(bytes.length - 8) !== crc32(tar)
	)
		fail('gzip checksum or size mismatch')
	return tar
}

function tarMembers(tar) {
	if (
		tar.length < BLOCK * 2 ||
		tar.length % BLOCK ||
		tar.length > MAX_TAR_BYTES
	)
		fail('invalid tar length')
	const members = new Map()
	let offset = 0
	let previous = ''
	while (offset < tar.length) {
		const header = tar.subarray(offset, offset + BLOCK)
		if (header.every((byte) => byte === 0)) {
			if (
				offset !== tar.length - BLOCK * 2 ||
				tar.subarray(offset).some((byte) => byte !== 0)
			)
				fail('abnormal tar end or trailing data')
			return members
		}
		if (members.size >= MAX_MEMBERS) fail('member count limit exceeded')
		if (header[156] !== 48)
			fail('non-ordinary member or unsupported tar extension')
		const name = textField(header, 0, 100)
		const prefix = textField(header, 345, 155)
		const memberPath = validPath(prefix ? `${prefix}/${name}` : name)
		if (members.has(memberPath)) fail('duplicate member')
		if (previous && byteOrder(previous, memberPath) >= 0)
			fail('members are not UTF-8 byte sorted')
		const size = readOctal(header, 124, 12)
		const sizeLimit =
			memberPath === 'SOURCE-MANIFEST.json'
				? MAX_MANIFEST_BYTES
				: memberPath === 'BUILDING.md'
					? MAX_BUILDING_BYTES
					: WEB_BUILD_INPUT_POLICY.limits.maxFileBytes
		if (size > sizeLimit) fail('member byte limit exceeded')
		if (!header.equals(tarHeader(memberPath, size)))
			fail('USTAR header or checksum mismatch')
		const start = offset + BLOCK
		const end = start + size
		const next = start + Math.ceil(size / BLOCK) * BLOCK
		if (end > tar.length - BLOCK * 2 || next > tar.length - BLOCK * 2)
			fail('member declared length exceeds tar')
		if (tar.subarray(end, next).some((byte) => byte !== 0))
			fail('nonzero member padding')
		members.set(memberPath, tar.subarray(start, end))
		previous = memberPath
		offset = next
	}
	fail('missing tar end blocks')
}

function selectedRole(inputPath) {
	validPath(inputPath)
	const parts = inputPath.split('/')
	const names = parts.map((part) => part.toLowerCase())
	const exclusions = WEB_BUILD_INPUT_POLICY.exclusions
	const rootOffset = names[0] === 'packages' ? 2 : 0
	if (
		names.some((name) => exclusions.directories.includes(name)) ||
		exclusions.privateDataRootDirectories.includes(names[rootOffset]) ||
		deniedNames.some((pattern) => pattern.test(parts.at(-1)))
	)
		fail('excluded source input')
	const extension = path.posix.extname(parts.at(-1)).toLowerCase()
	if (
		(!exclusions.sourceExtensionsInPrivateNamedDirectories.includes(
			extension
		) &&
			names
				.slice(0, -1)
				.some((name) => exclusions.privateDirectoryNames.includes(name))) ||
		(!extension &&
			/(?:^|[-_.])(?:secrets?|credentials?|private[-_]?keys?)(?:[-_.]|$)/i.test(
				parts.at(-1)
			))
	)
		fail('excluded private source input')
	for (const root of [
		...WEB_BUILD_INPUT_POLICY.requiredRoots,
		...WEB_BUILD_INPUT_POLICY.optionalRoots,
	]) {
		if (
			root.kind === 'file'
				? inputPath === root.path
				: inputPath.startsWith(`${root.path}/`)
		)
			return root.role
	}
	for (const selector of WEB_BUILD_INPUT_POLICY.configurationSelectors) {
		const parent = path.posix.dirname(inputPath)
		if (
			parent === selector.directory &&
			selector.patterns.some((pattern) =>
				new RegExp(pattern).test(parts.at(-1))
			)
		)
			return selector.role
	}
	if (/^packages\/[^/]+\/package\.json$/.test(inputPath))
		return WEB_BUILD_INPUT_POLICY.workspaceManifests.role
	fail('source path is outside the declared policy')
}

function sourceDigest(files, bytesFor) {
	const digest = createHash('sha256')
	digest
		.update(WEB_BUILD_INPUT_POLICY.digest.domain)
		.update(`${policySha256}\0`)
	for (const file of files)
		digest.update(`${file.path}\0${file.bytes}\0`).update(bytesFor(file))
	return digest.digest('hex')
}

function manifestBytes(manifest) {
	return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
}

function validateManifest(raw, members) {
	let value
	try {
		value = JSON.parse(utf8.decode(raw))
	} catch {
		fail('invalid source manifest JSON')
	}
	if (
		!exactKeys(value, [
			'schemaVersion',
			'buildContract',
			'policy',
			'policySha256',
			'files',
			'totalSourceBytes',
		]) ||
		value.schemaVersion !== 1 ||
		value.policySha256 !== policySha256 ||
		JSON.stringify(value.policy) !== JSON.stringify(WEB_BUILD_INPUT_POLICY) ||
		!Array.isArray(value.files) ||
		value.files.length > WEB_BUILD_INPUT_POLICY.limits.maxFiles
	)
		fail('invalid manifest schema, policy or inventory')
	const buildContract = contract(value.buildContract)
	let previous = ''
	let totalSourceBytes = 0
	const files = value.files.map((file) => {
		if (!exactKeys(file, ['path', 'bytes', 'sha256', 'role']))
			fail('invalid inventory entry')
		const inputPath = validPath(file.path)
		if (
			(previous && byteOrder(previous, inputPath) >= 0) ||
			file.role !== selectedRole(inputPath)
		)
			fail('inventory order, duplicate or role mismatch')
		if (
			!Number.isSafeInteger(file.bytes) ||
			file.bytes < 0 ||
			file.bytes > WEB_BUILD_INPUT_POLICY.limits.maxFileBytes ||
			typeof file.sha256 !== 'string' ||
			!/^[0-9a-f]{64}$/.test(file.sha256)
		)
			fail('invalid inventory bytes or hash')
		const bytes = members.get(`source/${inputPath}`)
		if (!bytes || bytes.length !== file.bytes || hash(bytes) !== file.sha256)
			fail('source member missing, bytes or hash mismatch')
		totalSourceBytes += file.bytes
		if (totalSourceBytes > WEB_BUILD_INPUT_POLICY.limits.maxTotalBytes)
			fail('total source byte limit exceeded')
		previous = inputPath
		return {
			path: inputPath,
			bytes: file.bytes,
			sha256: file.sha256,
			role: file.role,
		}
	})
	const paths = new Set(files.map((file) => file.path))
	for (const root of WEB_BUILD_INPUT_POLICY.requiredRoots)
		if (root.kind === 'file' && !paths.has(root.path))
			fail('required source input is missing')
	if (
		members.size !== files.length + 2 ||
		value.totalSourceBytes !== totalSourceBytes ||
		sourceDigest(files, (file) => members.get(`source/${file.path}`)) !==
			buildContract.sourceSha256
	)
		fail('inventory member set, total or build fingerprint mismatch')
	const manifest = {
		schemaVersion: 1,
		buildContract,
		policy: WEB_BUILD_INPUT_POLICY,
		policySha256,
		files,
		totalSourceBytes,
	}
	if (!raw.equals(manifestBytes(manifest))) fail('noncanonical source manifest')
	return manifest
}

function descriptor(bytes, manifest) {
	const sha256 = hash(bytes)
	return {
		path: `sources/web.${sha256}.tar.gz`,
		bytes: bytes.length,
		sha256,
		buildContract: manifest.buildContract,
		inputPolicySha256: manifest.policySha256,
		fileCount: manifest.files.length,
		totalSourceBytes: manifest.totalSourceBytes,
	}
}

/** Verify only bytes and the embedded policy; never extract or read a source tree. */
export function verifySourceArchive(bytes, { expectedBuildContract } = {}) {
	const expected =
		expectedBuildContract === undefined ? null : contract(expectedBuildContract)
	const members = tarMembers(gunzip(bytes))
	const raw = members.get('SOURCE-MANIFEST.json')
	if (!raw || !members.get('BUILDING.md')?.equals(BUILDING))
		fail('missing or changed archive documentation')
	const manifest = validateManifest(raw, members)
	if (
		expected &&
		JSON.stringify(expected) !== JSON.stringify(manifest.buildContract)
	)
		fail('expected build contract mismatch')
	return { descriptor: descriptor(bytes, manifest), manifest }
}

function inside(root, target) {
	const relative = path.relative(root, target)
	return (
		!path.isAbsolute(relative) &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`)
	)
}

function plainAncestors(absolute) {
	const root = path.parse(absolute).root
	let cursor = root
	for (const part of absolute
		.slice(root.length)
		.split(path.sep)
		.filter(Boolean)) {
		cursor = path.join(cursor, part)
		if (fs.lstatSync(cursor).isSymbolicLink()) fail('linked source ancestor')
	}
}

function identity(left, right) {
	return (
		left.isFile() &&
		!left.isSymbolicLink() &&
		['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(
			(key) => left[key] === right[key]
		)
	)
}

function readSource(root, repository, file) {
	validPath(file.path)
	const absolute = path.resolve(root, file.path)
	if (!inside(root, absolute)) fail('escaped source path')
	plainAncestors(absolute)
	if (!inside(repository, fs.realpathSync(absolute)))
		fail('escaped source real path')
	const before = fs.lstatSync(absolute)
	if (
		!before.isFile() ||
		before.isSymbolicLink() ||
		before.size !== file.bytes ||
		before.size > WEB_BUILD_INPUT_POLICY.limits.maxFileBytes
	)
		fail('source changed before archive read')
	const fd = fs.openSync(
		absolute,
		fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
	)
	try {
		const opened = fs.fstatSync(fd)
		if (!identity(opened, before)) fail('source changed before archive read')
		// Read only the declared size, even if a file grows while it is open.
		const bytes = Buffer.alloc(file.bytes)
		let offset = 0
		while (offset < bytes.length) {
			const count = fs.readSync(
				fd,
				bytes,
				offset,
				bytes.length - offset,
				offset
			)
			if (count === 0) fail('source shortened during archive read')
			offset += count
		}
		if (fs.readSync(fd, Buffer.alloc(1), 0, 1, file.bytes) !== 0)
			fail('source grew during archive read')
		const after = fs.fstatSync(fd)
		plainAncestors(absolute)
		const named = fs.lstatSync(absolute)
		if (
			!identity(after, opened) ||
			!identity(named, opened) ||
			!inside(repository, fs.realpathSync(absolute)) ||
			bytes.length !== file.bytes ||
			hash(bytes) !== file.sha256
		)
			fail('source changed during archive read')
		return bytes
	} finally {
		fs.closeSync(fd)
	}
}

/** Seal two matching inventories around guarded raw reads; not an atomic rename snapshot. */
export function createSourceArchive(packageRoot, buildContract) {
	const expected = contract(buildContract)
	const before = inventoryWebBuildInputs(packageRoot)
	if (
		before.version !== 2 ||
		before.policySha256 !== policySha256 ||
		before.sourceSha256 !== expected.sourceSha256
	)
		fail('build contract does not match current source inputs')
	const root = path.resolve(packageRoot, '../..')
	plainAncestors(root)
	const repository = fs.realpathSync(root)
	const members = new Map([['BUILDING.md', BUILDING]])
	for (const file of before.files) {
		if (selectedRole(file.path) !== file.role) fail('inventory role mismatch')
		splitName(`source/${file.path}`)
		members.set(`source/${file.path}`, readSource(root, repository, file))
	}
	if (
		sourceDigest(before.files, (file) => members.get(`source/${file.path}`)) !==
		expected.sourceSha256
	)
		fail('source fingerprint changed during archive reads')
	const manifest = {
		schemaVersion: 1,
		buildContract: expected,
		policy: WEB_BUILD_INPUT_POLICY,
		policySha256,
		files: before.files,
		totalSourceBytes: before.totalBytes,
	}
	const rawManifest = manifestBytes(manifest)
	if (rawManifest.length > MAX_MANIFEST_BYTES)
		fail('manifest byte limit exceeded')
	members.set('SOURCE-MANIFEST.json', rawManifest)
	const chunks = []
	for (const memberPath of [...members.keys()].sort(byteOrder)) {
		const bytes = members.get(memberPath)
		chunks.push(
			tarHeader(memberPath, bytes.length),
			bytes,
			Buffer.alloc((BLOCK - (bytes.length % BLOCK)) % BLOCK)
		)
	}
	chunks.push(Buffer.alloc(BLOCK * 2))
	const tar = Buffer.concat(chunks)
	if (tar.length > MAX_TAR_BYTES) fail('tar byte limit exceeded')
	const bytes = gzip(tar)
	const after = inventoryWebBuildInputs(packageRoot)
	if (
		after.sourceSha256 !== before.sourceSha256 ||
		after.policySha256 !== before.policySha256 ||
		JSON.stringify(after.files) !== JSON.stringify(before.files) ||
		after.totalBytes !== before.totalBytes
	)
		fail('source inputs changed before archive sealing')
	const verified = verifySourceArchive(bytes, {
		expectedBuildContract: expected,
	})
	return { bytes, ...verified }
}
