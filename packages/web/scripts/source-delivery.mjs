/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isHashedAsset, isSourceArchiveAsset } from './asset-policy.mjs'
import { verifySourceArchive } from './source-archive.mjs'

export const SOURCE_INDEX_PATH = 'sources/index.html'
export const SOURCE_CATALOG_PATH = 'sources/index.json'
const DAY = 86_400_000
const ordered = (values) => [...values].sort()
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const escape = (text) =>
	String(text).replace(
		/[&<>"']/g,
		(character) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
				character
			]
	)

export function sourceCatalogBytes(delivery) {
	return Buffer.from(`${JSON.stringify(delivery, null, 2)}\n`)
}

// A stable, script-free URL avoids feeding archive hashes back into Web sources.
export function sourceIndexBytes(delivery) {
	const languages = [
		[
			'en',
			'Frontend source downloads',
			'Current build',
			'Retained builds',
			'Older source coverage is listed in the JSON catalog. Source provenance and platform release acceptance remain pending.',
		],
		[
			'zh',
			'前端源码下载',
			'当前构建',
			'保留构建',
			'历史源码覆盖状态见 JSON 清单。源码来源核对和平台发布验收仍待完成。',
		],
		[
			'ja',
			'フロントエンドのソース',
			'現在のビルド',
			'保持されたビルド',
			'旧ソースの提供状況は JSON 一覧に記載されています。出典確認とプラットフォームのリリース検証は未完了です。',
		],
		[
			'ko',
			'프런트엔드 소스 다운로드',
			'현재 빌드',
			'보관된 빌드',
			'이전 소스 제공 상태는 JSON 목록에 표시됩니다. 출처 확인 및 플랫폼 릴리스 검증은 아직 완료되지 않았습니다.',
		],
	]
	const rows = (archives) =>
		archives
			.map(
				(archive) =>
					`<li><a href="/web-assets/${escape(archive.path)}" download>${escape(archive.buildContract.buildId)}</a><dl><dt>SHA-256</dt><dd><code>${archive.sha256}</code></dd><dt>Source SHA-256</dt><dd><code>${archive.buildContract.sourceSha256}</code></dd><dt>Bytes / files</dt><dd>${archive.bytes} / ${archive.fileCount}</dd></dl></li>`
			)
			.join('')
	const current = delivery.archives.filter(
		(archive) => archive.path === delivery.currentArchive
	)
	const retained = delivery.archives.filter(
		(archive) => archive.path !== delivery.currentArchive
	)
	const sections = languages
		.map(
			([locale, title, currentLabel, retainedLabel, pending]) =>
				`<section lang="${locale}" id="${locale}"><h1>${title}</h1><h2>${currentLabel}</h2><ul>${rows(current)}</ul>${current.length ? '' : '<p>Source archive unavailable / 对应源码待补 / ソース未提供 / 소스 미제공</p>'}<h2>${retainedLabel}</h2><ul>${rows(retained)}</ul><p>${pending}</p></section>`
		)
		.join('\n')
	return Buffer.from(
		`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>cinatoken source downloads</title><style>body{margin:1rem;max-width:70rem}code{overflow-wrap:anywhere}dd{margin-inline-start:1rem}</style></head><body><nav aria-label="Language"><a href="#en">English</a> <a href="#zh">中文</a> <a href="#ja">日本語</a> <a href="#ko">한국어</a></nav><main>${sections}</main><p><a href="/web-assets/${SOURCE_CATALOG_PATH}">JSON: source / asset version mapping</a></p></body></html>\n`
	)
}

// Called before freezing and again by source-free release consumers.
export function verifySourceDelivery(
	delivery,
	{ assets, files, buildContract, createdAt, retentionDays }
) {
	if (
		!delivery ||
		delivery.version !== 1 ||
		!Array.isArray(delivery.archives) ||
		!Array.isArray(delivery.assetSources) ||
		delivery.archives.length > files.length ||
		delivery.assetSources.length > files.length ||
		typeof delivery.coverageComplete !== 'boolean'
	)
		throw new Error('Invalid source delivery metadata')
	const assetFiles = new Map(files.map((file) => [file.path, file]))
	const archives = new Map()
	let totalSourceBytes = 0
	for (const archive of delivery.archives) {
		const file = assetFiles.get(archive.path)
		if (
			!isSourceArchiveAsset(archive.path) ||
			archives.has(archive.path) ||
			!file ||
			(archive.path !== delivery.currentArchive &&
				archive.source !== 'retained') ||
			!equal(
				[archive.bytes, archive.sha256, archive.source, archive.lastCurrentAt],
				[file.bytes, file.sha256, file.source, file.lastCurrentAt]
			)
		)
			throw new Error('Source archive asset binding mismatch')
		const verified = verifySourceArchive(
			readFileSync(join(assets, archive.path)),
			{
				...(archive.path === delivery.currentArchive
					? { expectedBuildContract: buildContract }
					: {}),
			}
		)
		const {
			source: _source,
			lastCurrentAt: _lastCurrentAt,
			...descriptor
		} = archive
		if (!equal(descriptor, verified.descriptor))
			throw new Error('Source archive descriptor mismatch')
		totalSourceBytes += verified.descriptor.totalSourceBytes
		if (totalSourceBytes > 512 * 1024 * 1024)
			throw new Error('Release source archives exceed combined raw byte budget')
		if (
			archive.source === 'retained' &&
			Date.parse(createdAt) - Date.parse(archive.lastCurrentAt) >
				retentionDays * DAY
		)
			throw new Error('Expired source archive')
		archives.set(archive.path, archive)
	}
	if (!equal([...archives.keys()], ordered(archives.keys())))
		throw new Error('Source archives must be sorted and unique')
	if (delivery.currentArchive !== null) {
		if (
			buildContract?.version !== 2 ||
			archives.get(delivery.currentArchive)?.source !== 'current'
		)
			throw new Error('Current source archive requires a matching v2 build')
	} else if (
		archives.size &&
		[...archives.values()].some((archive) => archive.source === 'current')
	) {
		throw new Error('Unbound current source archive')
	}
	if (buildContract?.version === 2 && delivery.currentArchive === null)
		throw new Error('Version 2 build requires corresponding source')
	const paths = []
	// Verified retained archives can remain available without a final browser
	// hash mapping. Their TTL and byte/descriptor bindings above still apply;
	// independent retention never contributes to asset coverage below.
	for (const mapping of delivery.assetSources) {
		const file = assetFiles.get(mapping.path)
		if (
			!file ||
			!isHashedAsset(mapping.path) ||
			!Array.isArray(mapping.archives) ||
			typeof mapping.unresolved !== 'boolean' ||
			!equal(mapping.archives, ordered(new Set(mapping.archives)))
		)
			throw new Error('Invalid source / asset version mapping')
		for (const archive of mapping.archives) {
			if (!archives.has(archive))
				throw new Error('Missing mapped source archive')
		}
		if (mapping.archives.length === 0 && !mapping.unresolved)
			throw new Error('Unavailable source must be marked unresolved')
		if (
			file.source === 'current' &&
			delivery.currentArchive &&
			!mapping.archives.includes(delivery.currentArchive)
		)
			throw new Error('Current asset must map to current source')
		paths.push(mapping.path)
	}
	if (
		!equal(
			paths,
			files.filter((file) => isHashedAsset(file.path)).map((file) => file.path)
		) ||
		delivery.coverageComplete !==
			(Boolean(delivery.currentArchive) &&
				delivery.assetSources.every(
					(mapping) => !mapping.unresolved && mapping.archives.length > 0
				)) ||
		(!delivery.currentArchive && delivery.coverageComplete)
	)
		throw new Error('Source coverage inventory mismatch')
	const expectedSourcePaths = ordered([
		SOURCE_INDEX_PATH,
		SOURCE_CATALOG_PATH,
		...archives.keys(),
	])
	if (
		!equal(
			files
				.filter((file) => file.path.startsWith('sources/'))
				.map((file) => file.path),
			expectedSourcePaths
		)
	)
		throw new Error('Unexpected source namespace asset')
	for (const [path, bytes] of [
		[SOURCE_INDEX_PATH, sourceIndexBytes(delivery)],
		[SOURCE_CATALOG_PATH, sourceCatalogBytes(delivery)],
	]) {
		if (
			assetFiles.get(path)?.source !== 'current' ||
			!readFileSync(join(assets, path)).equals(bytes)
		)
			throw new Error('Public source index does not match verified delivery')
	}
	return delivery
}
