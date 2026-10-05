/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isHashedAsset } from './asset-policy.mjs'
import { BUILD_CONTRACT_FILE } from './build-contract.mjs'
import { verifySourceArchive } from './source-archive.mjs'

const MAX_ENTRIES = 32
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const DAY = 86_400_000
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const SHA256 = /^[a-f0-9]{64}$/

function fail(message) {
	throw new Error(`Historical source: ${message}`)
}

function exactKeys(value, keys) {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).sort().join(',') === [...keys].sort().join(',')
	)
}

function relativePath(value) {
	if (
		typeof value !== 'string' ||
		!value ||
		/[\\:\x00-\x1f\x7f]/.test(value) ||
		value.startsWith('/') ||
		value.split('/').some((part) => !part || part === '.' || part === '..')
	)
		fail('unsafe root-relative path')
	return value
}

function entriesList(entries) {
	if (!Array.isArray(entries) || entries.length > MAX_ENTRIES)
		fail('sources must be an array of at most 32 entries')
	const ids = new Set()
	return entries.map((entry) => {
		if (
			!exactKeys(entry, ['releaseId', 'manifestSha256', 'archiveFile']) ||
			typeof entry.releaseId !== 'string' ||
			!RELEASE_ID.test(entry.releaseId) ||
			typeof entry.manifestSha256 !== 'string' ||
			!SHA256.test(entry.manifestSha256) ||
			ids.has(entry.releaseId)
		)
			fail('invalid or duplicate source entry')
		ids.add(entry.releaseId)
		return {
			releaseId: entry.releaseId,
			manifestSha256: entry.manifestSha256,
			archiveFile: relativePath(entry.archiveFile),
		}
	})
}

function inside(base, target) {
	const relative = path.relative(base, target)
	return (
		!path.isAbsolute(relative) &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`)
	)
}

function rootPath(root) {
	if (typeof root !== 'string' || !root) fail('invalid root')
	const base = path.resolve(root)
	let cursor = base
	while (true) {
		const stat = fs.lstatSync(cursor)
		if (!stat.isDirectory() || stat.isSymbolicLink())
			fail('linked or non-directory root ancestor')
		const parent = path.dirname(cursor)
		if (parent === cursor) break
		cursor = parent
	}
	return fs.realpathSync(base)
}

function checkedPath(base, relative) {
	relativePath(relative)
	let cursor = base
	const parts = relative.split('/')
	for (let index = 0; index < parts.length; index++) {
		cursor = path.join(cursor, parts[index])
		const stat = fs.lstatSync(cursor)
		if (stat.isSymbolicLink()) fail('linked input or ancestor')
		if (index < parts.length - 1 && !stat.isDirectory())
			fail('non-directory input ancestor')
		if (!inside(base, fs.realpathSync(cursor))) fail('input escapes root')
	}
	if (!inside(base, cursor) || cursor === base) fail('input escapes root')
	return cursor
}

function sameFile(before, after) {
	return (
		after.isFile() &&
		!after.isSymbolicLink() &&
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.size === after.size &&
		before.mtimeMs === after.mtimeMs &&
		before.ctimeMs === after.ctimeMs
	)
}

// Fixed-size reads avoid allocating attacker-grown files after the budget check.
// Ancestor and identity observations do not constitute an atomic rename snapshot.
function readOrdinary(base, relative, maxBytes) {
	const file = checkedPath(base, relative)
	const before = fs.lstatSync(file)
	if (
		!before.isFile() ||
		before.isSymbolicLink() ||
		!Number.isSafeInteger(before.size) ||
		before.size < 0 ||
		before.size > maxBytes
	)
		fail('non-ordinary input or size limit exceeded')
	const fd = fs.openSync(file, 'r')
	try {
		if (!sameFile(before, fs.fstatSync(fd))) fail('input changed before read')
		const bytes = Buffer.alloc(before.size)
		let offset = 0
		while (offset < bytes.length) {
			const count = fs.readSync(
				fd,
				bytes,
				offset,
				bytes.length - offset,
				offset
			)
			if (!count) fail('input shortened during read')
			offset += count
		}
		if (fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0)
			fail('input grew during read')
		if (
			!sameFile(before, fs.fstatSync(fd)) ||
			!sameFile(before, fs.lstatSync(checkedPath(base, relative)))
		)
			fail('input changed during read')
		return { bytes, stat: before }
	} finally {
		fs.closeSync(fd)
	}
}

function parseJSON(bytes) {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	} catch {
		fail('invalid UTF-8 JSON')
	}
}

function timestamp(value) {
	if (
		typeof value !== 'string' ||
		!Number.isFinite(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	)
		fail('invalid canonical timestamp')
	return Date.parse(value)
}

function contract(value) {
	if (
		!exactKeys(value, ['version', 'buildId', 'sourceSha256']) ||
		value.version !== 2 ||
		typeof value.buildId !== 'string' ||
		!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.buildId) ||
		typeof value.sourceSha256 !== 'string' ||
		!SHA256.test(value.sourceSha256)
	)
		fail('original release requires a version 2 build contract')
	return {
		version: value.version,
		buildId: value.buildId,
		sourceSha256: value.sourceSha256,
	}
}

function digest(bytes) {
	return createHash('sha256').update(bytes).digest('hex')
}

export function readHistoricalSourceImports(root, configFile) {
	const base = rootPath(root)
	const config = parseJSON(
		readOrdinary(base, configFile, MAX_CONFIG_BYTES).bytes
	)
	if (!exactKeys(config, ['version', 'sources']) || config.version !== 1)
		fail('invalid import config')
	return entriesList(config.sources)
}

export function verifyHistoricalSourceImports(
	root,
	entries,
	{ createdAt, retentionDays, verifyRelease }
) {
	const sources = entriesList(entries)
	const now = timestamp(createdAt)
	if (
		!Number.isInteger(retentionDays) ||
		retentionDays < 1 ||
		retentionDays > 90 ||
		typeof verifyRelease !== 'function'
	)
		fail('invalid retention or release verifier')
	const base = rootPath(root)
	return sources.map((entry) => {
		const directory = `.release/web/${entry.releaseId}`
		const manifestPath = `${directory}/manifest.json`
		const before = readOrdinary(base, manifestPath, MAX_MANIFEST_BYTES)
		if (digest(before.bytes) !== entry.manifestSha256)
			fail('original manifest external pin mismatch')
		const verified = verifyRelease(base, entry.releaseId)
		const after = readOrdinary(base, manifestPath, MAX_MANIFEST_BYTES)
		if (
			!sameFile(before.stat, after.stat) ||
			!before.bytes.equals(after.bytes) ||
			digest(after.bytes) !== entry.manifestSha256
		)
			fail('original manifest changed during release verification')
		const manifest = parseJSON(before.bytes)
		if (
			!verified ||
			JSON.stringify(verified.manifest) !== JSON.stringify(manifest) ||
			verified.manifestSha256 !== entry.manifestSha256 ||
			manifest.releaseId !== entry.releaseId ||
			![2, 3].includes(manifest.schemaVersion)
		)
			fail('original verified release mismatch')
		const originalAt = timestamp(manifest.createdAt)
		if (originalAt > now || now - originalAt > retentionDays * DAY)
			fail('original release is future or expired')
		const originalContract = contract(manifest.buildContract)
		for (const target of ['assets', 'server/node', 'server/worker']) {
			const marker = contract(
				parseJSON(
					readOrdinary(
						base,
						`${directory}/${target}/${BUILD_CONTRACT_FILE}`,
						1024
					).bytes
				)
			)
			if (JSON.stringify(marker) !== JSON.stringify(originalContract))
				fail('original three-target build contract mismatch')
		}
		const archive = readOrdinary(base, entry.archiveFile, MAX_ARCHIVE_BYTES)
		const { descriptor } = verifySourceArchive(archive.bytes, {
			expectedBuildContract: originalContract,
		})
		if (!Array.isArray(manifest.files)) fail('invalid original file inventory')
		const currentAssets = manifest.files
			.filter((file) => file.source === 'current' && isHashedAsset(file.path))
			.map((file) => {
				if (
					typeof file.path !== 'string' ||
					!Number.isSafeInteger(file.bytes) ||
					file.bytes < 0 ||
					typeof file.sha256 !== 'string' ||
					!SHA256.test(file.sha256) ||
					file.lastCurrentAt !== manifest.createdAt
				)
					fail('invalid original current asset')
				return {
					path: file.path,
					bytes: file.bytes,
					sha256: file.sha256,
					lastCurrentAt: file.lastCurrentAt,
				}
			})
		if (currentAssets.length === 0)
			fail('original has no hashed current assets')
		return {
			releaseId: entry.releaseId,
			manifestSha256: entry.manifestSha256,
			createdAt: manifest.createdAt,
			bytes: archive.bytes,
			descriptor,
			currentAssets,
		}
	})
}
