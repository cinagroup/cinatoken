#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isHashedAsset, isRetainableAsset } from './asset-policy.mjs'
import { verifyBuildPair, webSourceSha256 } from './build-contract.mjs'
import {
	readHistoricalSourceImports,
	verifyHistoricalSourceImports,
} from './historical-source.mjs'
import { createSourceArchive } from './source-archive.mjs'
import {
	SOURCE_CATALOG_PATH,
	SOURCE_INDEX_PATH,
	sourceCatalogBytes,
	sourceIndexBytes,
	verifySourceDelivery,
} from './source-delivery.mjs'

const repositoryRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../..'
)
const DAY = 86_400_000
const MAX_FILES = 10_000
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex')
}

function timestamp(raw) {
	const date = new Date(raw)
	if (!raw || !Number.isFinite(date.getTime()))
		throw new Error('Valid --at timestamp required')
	return date.toISOString()
}

function assertPath(path) {
	if (
		!path ||
		path.startsWith('/') ||
		path.includes('\\') ||
		path
			.split('/')
			.some(
				(part) =>
					!/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..'
			)
	)
		throw new Error(`Unsafe asset path: ${path}`)
}

// Check every existing component; realpath containment alone would admit links.
function safePath(root, target) {
	const base = realpathSync(root)
	const path = resolve(base, target)
	const rel = relative(base, path)
	if (
		isAbsolute(rel) ||
		rel === '..' ||
		rel.startsWith(`..${sep}`) ||
		(path === base && target !== '.')
	) {
		throw new Error('Path must stay inside the workspace')
	}
	let cursor = base
	for (const part of rel.split(sep).filter(Boolean)) {
		cursor = join(cursor, part)
		try {
			if (lstatSync(cursor).isSymbolicLink())
				throw new Error(`Symbolic links are not release inputs: ${cursor}`)
		} catch (error) {
			if (error.code !== 'ENOENT') throw error
		}
	}
	return path
}

function inventory(root) {
	const files = []
	function walk(directory, prefix = '') {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
			(a, b) => a.name.localeCompare(b.name, 'en')
		)) {
			const path = `${prefix}${entry.name}`
			assertPath(path)
			const file = join(directory, entry.name)
			if (entry.isSymbolicLink())
				throw new Error(`Symbolic link asset: ${path}`)
			if (entry.isDirectory()) walk(file, `${path}/`)
			else if (entry.isFile()) {
				files.push(path)
				if (files.length > MAX_FILES)
					throw new Error('Release file count exceeds limit')
			} else throw new Error(`Non-regular asset: ${path}`)
		}
	}
	walk(root)
	if (files.length > MAX_FILES)
		throw new Error('Release file count exceeds limit')
	return files.sort()
}

function releasePath(root, id) {
	if (!RELEASE_ID.test(id))
		throw new Error('Release id must be 1-64 ASCII identifier characters')
	return safePath(root, `.release/web/${id}`)
}

export function verifyRelease(root, id, { directoryAlias = false } = {}) {
	const directory = releasePath(root, id)
	const names = readdirSync(directory).sort()
	if (
		JSON.stringify(names) !==
			JSON.stringify(['assets', 'manifest.json', 'manifest.sha256']) &&
		JSON.stringify(names) !==
			JSON.stringify(['assets', 'manifest.json', 'manifest.sha256', 'server'])
	) {
		throw new Error('Release must contain only assets and manifest files')
	}
	for (const name of names)
		safePath(root, relative(root, join(directory, name)))
	for (const name of ['manifest.json', 'manifest.sha256']) {
		if (!lstatSync(join(directory, name)).isFile())
			throw new Error('Manifest must be a regular file')
	}
	if (lstatSync(join(directory, 'manifest.json')).size > 8 * 1024 * 1024)
		throw new Error('Manifest exceeds size limit')
	if (lstatSync(join(directory, 'manifest.sha256')).size !== 65)
		throw new Error('Invalid manifest digest size')
	const bytes = readFileSync(join(directory, 'manifest.json'))
	if (
		readFileSync(join(directory, 'manifest.sha256'), 'utf8') !==
		`${sha256(bytes)}\n`
	) {
		throw new Error('Manifest digest mismatch')
	}
	const manifest = JSON.parse(bytes)
	if (
		![1, 2, 3].includes(manifest.schemaVersion) ||
		!RELEASE_ID.test(manifest.releaseId) ||
		(!directoryAlias && manifest.releaseId !== id) ||
		![manifest.previousReleaseId, manifest.currentReleaseId].every(
			(value) =>
				value === null || (typeof value === 'string' && RELEASE_ID.test(value))
		) ||
		manifest.createdAt !== timestamp(manifest.createdAt) ||
		!Number.isInteger(manifest.retentionDays) ||
		manifest.retentionDays < 1 ||
		manifest.retentionDays > 90 ||
		!Array.isArray(manifest.files) ||
		manifest.files.length > MAX_FILES
	) {
		throw new Error('Invalid release manifest')
	}
	const assets = safePath(root, relative(root, join(directory, 'assets')))
	const actual = inventory(assets)
	let total = 0
	const paths = []
	for (const file of manifest.files) {
		assertPath(file.path)
		if (['_headers', '_redirects'].includes(file.path))
			throw new Error('Release must not supply asset routing control files')
		paths.push(file.path)
		if (
			!['current', 'retained'].includes(file.source) ||
			file.lastCurrentAt !== timestamp(file.lastCurrentAt) ||
			Date.parse(file.lastCurrentAt) > Date.parse(manifest.createdAt) ||
			(file.source === 'current' &&
				file.lastCurrentAt !== manifest.createdAt) ||
			(file.source === 'retained' &&
				(!isRetainableAsset(file.path) ||
					Date.parse(manifest.createdAt) - Date.parse(file.lastCurrentAt) >
						manifest.retentionDays * DAY)) ||
			!Number.isInteger(file.bytes) ||
			file.bytes < 0 ||
			file.bytes > MAX_FILE_BYTES ||
			!/^[a-f0-9]{64}$/.test(file.sha256)
		)
			throw new Error(`Invalid manifest file: ${file.path}`)
		const assetPath = join(assets, file.path)
		if (lstatSync(assetPath).size !== file.bytes)
			throw new Error(`Asset size mismatch: ${file.path}`)
		const content = readFileSync(assetPath)
		if (content.length !== file.bytes || sha256(content) !== file.sha256)
			throw new Error(`Asset digest mismatch: ${file.path}`)
		total += content.length
	}
	if (
		total > MAX_TOTAL_BYTES ||
		new Set(paths).size !== paths.length ||
		JSON.stringify(paths) !== JSON.stringify(actual) ||
		!manifest.files.some(
			(file) => file.path === 'index.html' && file.source === 'current'
		)
	) {
		throw new Error('Manifest inventory does not match release assets')
	}
	let server = null
	if (
		manifest.schemaVersion === 2 ||
		(manifest.schemaVersion === 3 && names.includes('server'))
	) {
		server = safePath(root, relative(root, join(directory, 'server')))
		const serverFiles = serverInventory(server)
		if (JSON.stringify(serverFiles) !== JSON.stringify(manifest.serverFiles))
			throw new Error('Server inventory does not match release manifest')
		if (
			JSON.stringify(verifyBuildPair(assets, server)) !==
			JSON.stringify(manifest.buildContract)
		)
			throw new Error('Release build contract mismatch')
		if (
			total + serverFiles.reduce((sum, file) => sum + file.bytes, 0) >
				MAX_TOTAL_BYTES ||
			paths.length + serverFiles.length > MAX_FILES
		)
			throw new Error('Release exceeds combined server and asset budget')
	} else if (
		names.includes('server') ||
		manifest.serverFiles !== undefined ||
		manifest.buildContract !== undefined
	) {
		throw new Error('Legacy release cannot contain server files')
	}
	if (manifest.schemaVersion === 3) {
		verifySourceDelivery(manifest.sourceDelivery, {
			assets,
			files: manifest.files,
			buildContract: manifest.buildContract,
			createdAt: manifest.createdAt,
			retentionDays: manifest.retentionDays,
		})
	} else if (
		manifest.sourceDelivery !== undefined ||
		manifest.files.some((file) => file.path.startsWith('sources/'))
	) {
		throw new Error('Legacy release cannot claim source delivery')
	}
	return { directory, assets, server, manifest, manifestSha256: sha256(bytes) }
}

function serverInventory(server) {
	const paths = inventory(server)
	if (
		!paths.includes('node/index.mjs') ||
		!paths.includes('worker/index.mjs') ||
		paths.some((path) => !/^(node|worker)\//.test(path))
	)
		throw new Error('Server build requires both Node and Worker entries')
	return paths.map((path) => {
		const file = join(server, path)
		const bytes = lstatSync(file).size
		if (bytes > MAX_FILE_BYTES)
			throw new Error('Server file exceeds size limit')
		return { path, bytes, sha256: sha256(readFileSync(file)) }
	})
}

export function packageRelease({
	root = repositoryRoot,
	id,
	at,
	previous,
	currentRelease,
	retentionDays = 14,
	historicalSources = [],
}) {
	const createdAt = timestamp(at)
	if (currentRelease && !previous)
		throw new Error(
			'Rollback requires --previous to retain the currently published resources'
		)
	if (
		!Number.isInteger(retentionDays) ||
		retentionDays < 1 ||
		retentionDays > 90
	)
		throw new Error('Retention must be 1-90 days')
	const target = releasePath(root, id)
	if (existsSync(target))
		throw new Error(
			'Release output already exists; never overwrite a frozen artifact'
		)
	const prior = previous ? verifyRelease(root, previous) : null
	const rollback = currentRelease ? verifyRelease(root, currentRelease) : null
	for (const input of [prior, rollback].filter(Boolean)) {
		if (Date.parse(input.manifest.createdAt) > Date.parse(createdAt))
			throw new Error('Release timestamp precedes an input artifact')
	}
	const historicalImports = verifyHistoricalSourceImports(
		root,
		historicalSources,
		{ createdAt, retentionDays, verifyRelease }
	)
	const current = rollback?.assets ?? safePath(root, 'packages/web/dist')
	const currentPaths = rollback
		? rollback.manifest.files
				.filter(
					(file) =>
						file.source === 'current' && !file.path.startsWith('sources/')
				)
				.map((file) => file.path)
		: inventory(current)
	if (!currentPaths.includes('index.html'))
		throw new Error('Current build has no index.html')
	const plan = new Map()
	let total = 0
	function add(path, from, source, lastCurrentAt) {
		assertPath(path)
		if (['_headers', '_redirects'].includes(path))
			throw new Error('Build must not supply asset routing control files')
		const file = join(from, path)
		const bytes = lstatSync(file).size
		if (bytes > MAX_FILE_BYTES) throw new Error(`Asset too large: ${path}`)
		const digest = sha256(readFileSync(file))
		const existing = plan.get(path)
		if (existing) {
			if (existing.sha256 !== digest)
				throw new Error(`Immutable path collision: ${path}`)
			return
		}
		total += bytes
		if (total > MAX_TOTAL_BYTES || plan.size >= MAX_FILES)
			throw new Error('Release exceeds asset budget')
		plan.set(path, {
			path,
			bytes,
			sha256: digest,
			source,
			lastCurrentAt,
			from: file,
		})
	}
	for (const path of currentPaths) {
		if (path.startsWith('sources/'))
			throw new Error('Build must not supply the source delivery namespace')
		add(path, current, 'current', createdAt)
	}
	// Ship the repository's license and upstream attribution with the same
	// verified asset set consumed by both Worker and Docker releases.
	for (const path of ['LICENSE', 'NOTICE.frontend']) {
		const notice = join(root, path)
		if (!existsSync(notice) || !lstatSync(notice).isFile())
			throw new Error(`Required release notice missing: ${path}`)
		if (!plan.has(path)) add(path, root, 'current', createdAt)
	}
	if (prior) {
		for (const file of prior.manifest.files) {
			// Compare any shared hashed path even after expiry: never change its bytes.
			if (!isHashedAsset(file.path)) continue
			if (
				plan.has(file.path) ||
				Date.parse(createdAt) - Date.parse(file.lastCurrentAt) <=
					retentionDays * DAY
			) {
				add(file.path, prior.assets, 'retained', file.lastCurrentAt)
			}
		}
	}
	const builtServer = join(root, 'packages/web/dist-server')
	const serverSource = rollback
		? rollback.server
		: existsSync(builtServer)
			? safePath(root, 'packages/web/dist-server')
			: null
	const serverFiles = serverSource ? serverInventory(serverSource) : null
	if (
		!rollback &&
		!serverSource &&
		existsSync(join(current, 'build-contract.json'))
	)
		throw new Error(
			'Stamped browser build requires both Node and Worker builds'
		)
	const buildContract = serverSource
		? verifyBuildPair(current, serverSource)
		: null
	if (
		!rollback &&
		buildContract &&
		buildContract.sourceSha256 !==
			webSourceSha256(join(root, 'packages/web'), {
				version: buildContract.version,
			})
	)
		throw new Error(
			'Web sources changed after build; rebuild all three targets'
		)
	function addBytes(
		path,
		content,
		source = 'current',
		lastCurrentAt = createdAt
	) {
		assertPath(path)
		if (plan.has(path) || content.length > MAX_FILE_BYTES)
			throw new Error('Invalid generated source asset')
		total += content.length
		if (total > MAX_TOTAL_BYTES || plan.size >= MAX_FILES)
			throw new Error('Release exceeds asset budget')
		plan.set(path, {
			path,
			bytes: content.length,
			sha256: sha256(content),
			source,
			lastCurrentAt,
			content,
		})
	}
	// A historical source can prove only an original current hashed asset with
	// identical bytes in this candidate, never its inherited retained inventory.
	const importedAssetSources = new Map()
	for (const imported of historicalImports) {
		let referenced = 0
		for (const original of imported.currentAssets) {
			const file = plan.get(original.path)
			if (!file) continue
			if (file.bytes !== original.bytes || file.sha256 !== original.sha256)
				throw new Error(
					'Historical immutable asset collision: ' + original.path
				)
			const bindings = importedAssetSources.get(original.path) ?? []
			bindings.push(imported.descriptor.path)
			importedAssetSources.set(original.path, bindings)
			referenced += 1
		}
		if (referenced === 0)
			throw new Error(
				'Historical source archive has no matching current assets'
			)
	}
	let sourceDelivery = null
	if (
		(!rollback && buildContract?.version === 2) ||
		rollback?.manifest.schemaVersion === 3 ||
		prior?.manifest.schemaVersion === 3 ||
		historicalImports.length > 0
	) {
		const descriptors = new Map()
		let currentArchive = null
		if (!rollback && buildContract?.version === 2) {
			const archive = createSourceArchive(
				join(root, 'packages/web'),
				buildContract
			)
			addBytes(archive.descriptor.path, archive.bytes)
			currentArchive = archive.descriptor.path
			descriptors.set(currentArchive, {
				...archive.descriptor,
				source: 'current',
				lastCurrentAt: createdAt,
			})
		} else if (rollback?.manifest.sourceDelivery?.currentArchive) {
			currentArchive = rollback.manifest.sourceDelivery.currentArchive
			const descriptor = rollback.manifest.sourceDelivery.archives.find(
				(item) => item.path === currentArchive
			)
			add(currentArchive, rollback.assets, 'current', createdAt)
			descriptors.set(currentArchive, {
				...descriptor,
				source: 'current',
				lastCurrentAt: createdAt,
			})
		}
		const inputDeliveries = [rollback, prior].filter(
			(input) => input?.manifest.sourceDelivery
		)
		const available = new Map()
		for (const input of inputDeliveries) {
			for (const descriptor of input.manifest.sourceDelivery.archives) {
				if (
					Date.parse(createdAt) - Date.parse(descriptor.lastCurrentAt) >
					retentionDays * DAY
				)
					continue
				const existing = available.get(descriptor.path)
				if (
					!existing ||
					descriptor.lastCurrentAt > existing.descriptor.lastCurrentAt
				)
					available.set(descriptor.path, { descriptor, assets: input.assets })
			}
		}
		for (const imported of historicalImports) {
			const descriptor = {
				...imported.descriptor,
				source: 'retained',
				lastCurrentAt: imported.createdAt,
			}
			const existing = available.get(descriptor.path)
			if (
				!existing ||
				descriptor.lastCurrentAt > existing.descriptor.lastCurrentAt
			)
				available.set(descriptor.path, { descriptor, content: imported.bytes })
		}
		function includeArchive(archivePath) {
			if (descriptors.has(archivePath)) return
			const item = available.get(archivePath)
			if (!item) throw new Error('Mapped source archive is unavailable')
			if (item.content)
				addBytes(
					archivePath,
					item.content,
					'retained',
					item.descriptor.lastCurrentAt
				)
			else
				add(archivePath, item.assets, 'retained', item.descriptor.lastCurrentAt)
			descriptors.set(archivePath, { ...item.descriptor, source: 'retained' })
		}
		// A published source download has its own retention window. Identical
		// browser hashes may come from different server/source builds, so keeping
		// only archives referenced by the final hash mappings would drop old URLs.
		// Eligibility above keeps the original age; inclusion does not prove any
		// additional asset origin or resolve unknown historical source coverage.
		for (const archivePath of available.keys()) includeArchive(archivePath)
		const assetSources = [...plan.values()]
			.filter((file) => isHashedAsset(file.path))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
			.map((file) => {
				const archivePaths = new Set()
				let unresolved = false
				if (file.source === 'current') {
					if (currentArchive) archivePaths.add(currentArchive)
					else unresolved = true
				}
				const origin = file.source === 'current' ? rollback : prior
				const mapping = origin?.manifest.sourceDelivery?.assetSources.find(
					(item) => item.path === file.path
				)
				if (mapping) {
					unresolved ||= mapping.unresolved
					for (const archivePath of mapping.archives) {
						if (archivePath === currentArchive) archivePaths.add(archivePath)
						else if (available.has(archivePath)) {
							archivePaths.add(archivePath)
							includeArchive(archivePath)
						}
					}
				} else if (file.source === 'retained') unresolved = true
				const proved = importedAssetSources.get(file.path) ?? []
				for (const archivePath of proved) {
					includeArchive(archivePath)
					archivePaths.add(archivePath)
				}
				// Admission above proved a complete original build source for these
				// exact asset bytes; this does not establish every historical origin.
				if (proved.length > 0) unresolved = false
				if (archivePaths.size === 0) unresolved = true
				return {
					path: file.path,
					archives: [...archivePaths].sort(),
					unresolved,
				}
			})
		if (
			[...descriptors.values()].reduce(
				(sum, archive) => sum + archive.totalSourceBytes,
				0
			) >
			512 * 1024 * 1024
		)
			throw new Error('Release source archives exceed combined raw byte budget')
		sourceDelivery = {
			version: 1,
			currentArchive,
			archives: [...descriptors.values()].sort((a, b) =>
				a.path < b.path ? -1 : a.path > b.path ? 1 : 0
			),
			assetSources,
			coverageComplete:
				Boolean(currentArchive) &&
				assetSources.every(
					(mapping) => !mapping.unresolved && mapping.archives.length > 0
				),
		}
		addBytes(SOURCE_INDEX_PATH, sourceIndexBytes(sourceDelivery))
		addBytes(SOURCE_CATALOG_PATH, sourceCatalogBytes(sourceDelivery))
	}
	// Use the same byte ordering as filesystem verification on every platform.
	const files = [...plan.values()].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0
	)
	if (
		serverFiles &&
		(total + serverFiles.reduce((sum, file) => sum + file.bytes, 0) >
			MAX_TOTAL_BYTES ||
			files.length + serverFiles.length > MAX_FILES)
	)
		throw new Error('Release exceeds combined server and asset budget')
	const manifest = {
		schemaVersion: sourceDelivery ? 3 : serverFiles ? 2 : 1,
		releaseId: id,
		createdAt,
		retentionDays,
		previousReleaseId: prior?.manifest.releaseId ?? null,
		currentReleaseId: rollback?.manifest.releaseId ?? null,
		files: files.map(({ from: _from, content: _content, ...file }) => file),
		...(serverFiles ? { serverFiles, buildContract } : {}),
		...(sourceDelivery ? { sourceDelivery } : {}),
	}
	const assets = join(target, 'assets')
	mkdirSync(dirname(target), { recursive: true })
	// Atomic creation prevents a second publisher from overwriting the same id.
	mkdirSync(target)
	mkdirSync(assets)
	for (const file of files) {
		mkdirSync(dirname(join(assets, file.path)), { recursive: true })
		if (file.content) writeFileSync(join(assets, file.path), file.content)
		else copyFileSync(file.from, join(assets, file.path))
	}
	if (serverFiles) {
		for (const file of serverFiles) {
			const destination = join(target, 'server', file.path)
			mkdirSync(dirname(destination), { recursive: true })
			copyFileSync(join(serverSource, file.path), destination)
		}
	}
	const content = `${JSON.stringify(manifest, null, 2)}\n`
	writeFileSync(join(target, 'manifest.json'), content)
	writeFileSync(join(target, 'manifest.sha256'), `${sha256(content)}\n`)
	return verifyRelease(root, id)
}

function parseArgs(argv) {
	const options = {}
	for (let i = 0; i < argv.length; i += 2) {
		const name = argv[i]
		if (
			![
				'--id',
				'--at',
				'--previous',
				'--current-release',
				'--retention-days',
				'--historical-sources',
				'--verify',
				'--verify-artifact',
			].includes(name) ||
			!argv[i + 1]
		) {
			throw new Error(
				'Use --id ID --at ISO [--previous ID] [--current-release ID] [--retention-days N] [--historical-sources FILE], --verify ID, or --verify-artifact DIRECTORY_ALIAS'
			)
		}
		if (options[name] !== undefined)
			throw new Error(`Duplicate argument: ${name}`)
		options[name] = argv[i + 1]
	}
	return options
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const args = parseArgs(process.argv.slice(2))
		if (
			(args['--verify'] || args['--verify-artifact']) &&
			Object.keys(args).length !== 1
		)
			throw new Error(
				'Verification cannot be combined with packaging arguments'
			)
		const result = args['--verify']
			? verifyRelease(repositoryRoot, args['--verify'])
			: args['--verify-artifact']
				? verifyRelease(repositoryRoot, args['--verify-artifact'], {
						directoryAlias: true,
					})
				: packageRelease({
						id: args['--id'],
						at: args['--at'],
						previous: args['--previous'],
						currentRelease: args['--current-release'],
						historicalSources: args['--historical-sources']
							? readHistoricalSourceImports(
									repositoryRoot,
									args['--historical-sources']
								)
							: [],
						retentionDays:
							args['--retention-days'] === undefined
								? 14
								: Number(args['--retention-days']),
					})
		process.stdout.write(
			`${JSON.stringify({ releaseId: result.manifest.releaseId, files: result.manifest.files.length, manifestSha256: result.manifestSha256 })}\n`
		)
	} catch (error) {
		process.stderr.write(`${error.message}\n`)
		process.exitCode = 1
	}
}
