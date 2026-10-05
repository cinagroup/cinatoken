/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const utf8 = new TextDecoder('utf-8', { fatal: true })
const byteOrder = (left, right) =>
	Buffer.compare(Buffer.from(left), Buffer.from(right))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function freeze(value) {
	for (const child of Object.values(value)) {
		if (child && typeof child === 'object') freeze(child)
	}
	return Object.freeze(value)
}

const file = (inputPath, role) => ({ path: inputPath, kind: 'file', role })
const directory = (inputPath, role) => ({
	path: inputPath,
	kind: 'directory',
	role,
})

export const WEB_BUILD_INPUT_POLICY = freeze({
	version: 2,
	requiredRoots: [
		directory('packages/web/src', 'web-source'),
		directory('packages/web/edge', 'web-source'),
		directory('packages/web/scripts', 'web-source'),
		directory('packages/core/src', 'shared-core-source'),
		directory('docker/web', 'docker-runtime'),
		directory('scripts/web', 'provenance-tool'),
		file('package.json', 'root-package-manifest'),
		file('package-lock.json', 'root-lockfile'),
		file('LICENSE', 'license-notice'),
		file('NOTICE.frontend', 'license-notice'),
		file('.nvmrc', 'root-build-config'),
		file('packages/web/package.json', 'workspace-package-manifest'),
		file('packages/core/package.json', 'workspace-package-manifest'),
		file('packages/admin/package.json', 'workspace-package-manifest'),
		file('packages/tool-engines/package.json', 'workspace-package-manifest'),
		file('packages/proxy/package.json', 'workspace-package-manifest'),
		file('packages/chain-worker/package.json', 'workspace-package-manifest'),
		file('packages/web/index.html', 'web-build-config'),
		file('packages/web/rsbuild.config.ts', 'web-build-config'),
		file('packages/web/postcss.config.mjs', 'web-build-config'),
		file('packages/web/tsconfig.json', 'web-build-config'),
		file('packages/web/tsconfig.app.json', 'web-build-config'),
		file('packages/web/tsconfig.node.json', 'web-build-config'),
		file('packages/admin/lib/model-vendors.json', 'admin-shared-data'),
		file('Dockerfile.web', 'docker-build-config'),
		file('Dockerfile.web-ssr', 'docker-build-config'),
		file('.dockerignore', 'docker-build-config'),
		file('docker/web/public-server.mjs', 'docker-runtime'),
		file('docker/web/nginx.conf.template', 'docker-runtime'),
		file('docker/web/admin-proxy.conf', 'docker-runtime'),
		file('docker/web/entrypoint.sh', 'docker-runtime'),
		file('.github/workflows/web-frontend.yml', 'ci-config'),
	],
	optionalRoots: [
		directory('packages/web/public', 'web-source'),
		directory('packages/core/scripts', 'core-build-script'),
		file('packages/web/.browserslistrc', 'web-build-config'),
		file('packages/web/.babelrc', 'web-build-config'),
		file('packages/web/babel.config.js', 'web-build-config'),
		file('packages/web/babel.config.mjs', 'web-build-config'),
		file('packages/web/.swcrc', 'web-build-config'),
		file('packages/web/tsconfig.test.json', 'web-build-config'),
		file('packages/web/.prettierrc', 'web-build-config'),
		file('packages/web/eslint.config.js', 'web-build-config'),
		file('packages/web/.node-version', 'web-build-config'),
		file('.editorconfig', 'root-build-config'),
		file('.browserslistrc', 'root-build-config'),
	],
	configurationSelectors: [
		{
			directory: '.',
			patterns: ['^tsconfig(?:\\.[^/]+)?\\.json$'],
			role: 'root-build-config',
		},
		{
			directory: 'packages/core',
			patterns: ['^tsconfig(?:\\.[^/]+)?\\.json$'],
			role: 'core-build-config',
		},
		{
			directory: 'packages/web',
			patterns: ['^tsconfig(?:\\.[^/]+)?\\.json$'],
			role: 'web-build-config',
		},
	],
	workspaceManifests: {
		directory: 'packages',
		selection: 'Every direct package directory containing package.json',
		role: 'workspace-package-manifest',
		interpretation:
			'Includes all current npm workspaces and conservatively includes other direct package manifests. Nested or external workspace layouts require a policy revision.',
	},
	exclusions: {
		directories: [
			'node_modules',
			'.git',
			'dist',
			'dist-server',
			'dist-ssr',
			'dist-edge',
			'build',
			'coverage',
			'vendor',
			'.cache',
			'.tmp',
			'.rsbuild',
			'.wrangler',
			'.vite',
			'.turbo',
			'.next',
			'.output',
			'.aws',
			'.ssh',
		],
		privateDataRootDirectories: [
			'keys',
			'secret',
			'secrets',
			'credentials',
			'private-data',
		],
		privateDirectoryNames: [
			'keys',
			'secret',
			'secrets',
			'credentials',
			'private-data',
		],
		filePatterns: [
			'^\\.env(?:[.-]|rc(?:[.-]|$)|$)',
			'^\\.dev\\.vars(?:[.-]|$)',
			'^\\.(?:npmrc|netrc|pypirc|authinfo|gitconfig|git-credentials)$',
			'\\.(?:pem|key|p8|p12|pfx|jks|keystore)(?:[.-]|$)',
			'^id_(?:rsa|dsa|ecdsa|ed25519)(?:\\.|$)',
			'\\.tsbuildinfo$',
			'^wrangler(?:[.-].*)?\\.jsonc?$',
		],
		sourceExtensionsInPrivateNamedDirectories: [
			'.ts',
			'.tsx',
			'.js',
			'.jsx',
			'.mjs',
			'.cjs',
			'.css',
			'.scss',
			'.html',
			'.sql',
		],
	},
	limits: {
		maxFiles: 10_000,
		maxFileBytes: 64 * 1024 * 1024,
		maxTotalBytes: 512 * 1024 * 1024,
	},
	digest: {
		domain: 'cinatoken:web-build-inputs:v2\0',
		policy: 'SHA256 of UTF-8 JSON.stringify of this deeply frozen policy',
		input:
			'Domain + policySha256 + NUL, then UTF-8-byte-sorted repository-relative POSIX path + NUL + decimal raw byte length + NUL + raw bytes for every file. No encoding or newline normalization.',
	},
	observation:
		'Selected source inputs, not an upstream provenance or ownership claim. Excluded data is filtered before opening. Ordinary files and every ancestor must be free of symbolic links and junctions and remain inside the repository. File identity, size, mtime and ctime are checked before/after each read. Two matching observations establish an observed unchanged boundary, not an atomic repository snapshot or protection against concurrently hostile ancestor renames. Dependencies and environment values are not read.',
})

const deniedNames = WEB_BUILD_INPUT_POLICY.exclusions.filePatterns.map(
	(pattern) => new RegExp(pattern, 'i')
)

function validatePath(inputPath) {
	if (
		!inputPath ||
		/[\\:\0]/.test(inputPath) ||
		inputPath.split('/').some((part) => !part || part === '.' || part === '..')
	) {
		throw new Error('Invalid repository-relative Web build input path')
	}
	return inputPath
}

function exclusion(inputPath, isDirectory) {
	const parts = inputPath.split('/')
	const names = parts.map((part) => part.toLowerCase())
	const policy = WEB_BUILD_INPUT_POLICY.exclusions
	if (names.some((name) => policy.directories.includes(name)))
		return 'excluded-dependency-output-cache-or-private-directory'
	const rootOffset = names[0] === 'packages' ? 2 : 0
	if (policy.privateDataRootDirectories.includes(names[rootOffset]))
		return 'excluded-root-private-data-location'
	if (deniedNames.some((pattern) => pattern.test(parts.at(-1))))
		return 'excluded-env-credential-key-or-generated-file'
	if (!isDirectory) {
		const sourceCode =
			policy.sourceExtensionsInPrivateNamedDirectories.includes(
				path.posix.extname(parts.at(-1)).toLowerCase()
			)
		if (
			!sourceCode &&
			names
				.slice(0, -1)
				.some((name) => policy.privateDirectoryNames.includes(name))
		)
			return 'excluded-private-data-file'
		if (
			!path.posix.extname(parts.at(-1)) &&
			/(?:^|[-_.])(?:secrets?|credentials?|private[-_]?keys?)(?:[-_.]|$)/i.test(
				parts.at(-1)
			)
		)
			return 'excluded-extensionless-private-data'
	}
	return null
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
		let stat
		try {
			stat = fs.lstatSync(cursor)
		} catch (error) {
			if (error.code === 'ENOENT') return false
			throw error
		}
		if (stat.isSymbolicLink())
			throw new Error('Linked Web build input ancestor')
	}
	return true
}

function entries(absolute) {
	return fs
		.readdirSync(absolute, { withFileTypes: true, encoding: 'buffer' })
		.map((entry) => ({ entry, name: utf8.decode(entry.name) }))
		.sort((left, right) => byteOrder(left.name, right.name))
}

export function inventoryWebBuildInputs(packageRoot) {
	if (typeof packageRoot !== 'string' || !packageRoot)
		throw new Error('Web package root is required')
	const absolutePackage = path.resolve(packageRoot)
	const root = path.resolve(absolutePackage, '../..')
	if (absolutePackage !== path.join(root, 'packages/web'))
		throw new Error('Web package root must be repository packages/web')
	if (!plainAncestors(absolutePackage))
		throw new Error('Missing required Web build input: packages/web')
	const repository = fs.realpathSync(root)
	const candidates = new Map()
	const excluded = new Map()
	let totalBytes = 0
	const exclude = (inputPath, reason) => {
		excluded.set(`${inputPath}\0${reason}`, { path: inputPath, reason })
	}

	function sourcePath(inputPath) {
		validatePath(inputPath)
		const absolute = path.resolve(root, inputPath)
		if (!inside(root, absolute)) throw new Error('Escaped Web build input path')
		return absolute
	}

	function inspect(inputPath) {
		const absolute = sourcePath(inputPath)
		if (!plainAncestors(absolute)) return null
		if (!inside(repository, fs.realpathSync(absolute)))
			throw new Error('Escaped Web build input real path')
		const stat = fs.lstatSync(absolute)
		if (stat.isSymbolicLink()) throw new Error('Linked Web build input')
		return { absolute, stat }
	}

	function select(inputPath, role, expectedKind, required) {
		const reason = exclusion(inputPath, expectedKind === 'directory')
		if (reason) {
			if (required)
				throw new Error('Required Web build input excluded by policy')
			exclude(inputPath, reason)
			return
		}
		const candidate = inspect(inputPath)
		if (!candidate) {
			if (required)
				throw new Error(`Missing required Web build input: ${inputPath}`)
			exclude(inputPath, 'optional-input-missing')
			return
		}
		const { absolute, stat } = candidate
		if (!stat.isFile() && !stat.isDirectory())
			throw new Error('Non-regular Web build input')
		if (
			(expectedKind === 'directory' && !stat.isDirectory()) ||
			(expectedKind === 'file' && !stat.isFile())
		)
			throw new Error(`Wrong kind of Web build input: ${inputPath}`)
		if (stat.isDirectory()) {
			for (const { entry, name } of entries(absolute)) {
				const childPath = validatePath(`${inputPath}/${name}`)
				const denied = exclusion(childPath, entry.isDirectory())
				if (denied) exclude(childPath, denied)
				else
					select(
						childPath,
						role,
						entry.isDirectory() ? 'directory' : null,
						true
					)
			}
			return
		}
		if (candidates.has(inputPath)) return
		if (
			!Number.isSafeInteger(stat.size) ||
			stat.size < 0 ||
			stat.size > WEB_BUILD_INPUT_POLICY.limits.maxFileBytes
		)
			throw new Error('Exceeds Web build input file byte limit')
		totalBytes += stat.size
		if (totalBytes > WEB_BUILD_INPUT_POLICY.limits.maxTotalBytes)
			throw new Error('Exceeds Web build input total byte limit')
		if (candidates.size >= WEB_BUILD_INPUT_POLICY.limits.maxFiles)
			throw new Error('Exceeds Web build input file count limit')
		candidates.set(inputPath, { absolute, stat, role })
	}

	for (const input of WEB_BUILD_INPUT_POLICY.requiredRoots)
		select(input.path, input.role, input.kind, true)
	for (const input of WEB_BUILD_INPUT_POLICY.optionalRoots)
		select(input.path, input.role, input.kind, false)
	for (const selector of WEB_BUILD_INPUT_POLICY.configurationSelectors) {
		const directoryPath =
			selector.directory === '.' ? root : sourcePath(selector.directory)
		if (!plainAncestors(directoryPath)) continue
		if (!inside(repository, fs.realpathSync(directoryPath)))
			throw new Error('Escaped Web configuration directory')
		for (const { entry, name } of entries(directoryPath)) {
			const inputPath =
				selector.directory === '.' ? name : `${selector.directory}/${name}`
			const reason = exclusion(inputPath, entry.isDirectory())
			if (reason) exclude(inputPath, reason)
			else if (
				selector.patterns.some((pattern) => new RegExp(pattern).test(name))
			)
				select(inputPath, selector.role, 'file', true)
		}
	}
	for (const { entry, name } of entries(sourcePath('packages'))) {
		const inputPath = `packages/${name}`
		const reason = exclusion(inputPath, entry.isDirectory())
		if (reason) exclude(inputPath, reason)
		else if (entry.isSymbolicLink())
			throw new Error('Linked workspace Web build input')
		else if (entry.isDirectory())
			select(
				`${inputPath}/package.json`,
				WEB_BUILD_INPUT_POLICY.workspaceManifests.role,
				'file',
				false
			)
	}

	const policySha256 = sha256(
		Buffer.from(JSON.stringify(WEB_BUILD_INPUT_POLICY))
	)
	const digest = createHash('sha256')
	digest
		.update(WEB_BUILD_INPUT_POLICY.digest.domain)
		.update(`${policySha256}\0`)
	const files = []
	for (const inputPath of [...candidates.keys()].sort(byteOrder)) {
		const { absolute, stat, role } = candidates.get(inputPath)
		if (!plainAncestors(absolute))
			throw new Error('Web build input disappeared')
		if (!inside(repository, fs.realpathSync(absolute)))
			throw new Error('Escaped Web build input before read')
		const fd = fs.openSync(
			absolute,
			fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
		)
		try {
			const opened = fs.fstatSync(fd)
			if (
				!opened.isFile() ||
				opened.dev !== stat.dev ||
				opened.ino !== stat.ino ||
				opened.size !== stat.size ||
				opened.mtimeMs !== stat.mtimeMs ||
				opened.ctimeMs !== stat.ctimeMs
			)
				throw new Error('Web build input changed before read')
			const bytes = fs.readFileSync(fd)
			const after = fs.fstatSync(fd)
			if (!plainAncestors(absolute))
				throw new Error('Web build input disappeared during read')
			const named = fs.lstatSync(absolute)
			if (
				!after.isFile() ||
				!named.isFile() ||
				named.isSymbolicLink() ||
				!inside(repository, fs.realpathSync(absolute)) ||
				[after, named].some(
					(value) =>
						value.dev !== opened.dev ||
						value.ino !== opened.ino ||
						value.size !== opened.size ||
						value.mtimeMs !== opened.mtimeMs ||
						value.ctimeMs !== opened.ctimeMs
				) ||
				bytes.length !== opened.size
			)
				throw new Error('Web build input changed during read')
			digest.update(`${inputPath}\0${bytes.length}\0`).update(bytes)
			files.push({
				path: inputPath,
				bytes: bytes.length,
				sha256: sha256(bytes),
				role,
			})
		} finally {
			fs.closeSync(fd)
		}
	}
	return {
		version: 2,
		policySha256,
		sourceSha256: digest.digest('hex'),
		files,
		excluded: [...excluded.values()].sort(
			(left, right) =>
				byteOrder(left.path, right.path) || byteOrder(left.reason, right.reason)
		),
		totalBytes,
		observation: WEB_BUILD_INPUT_POLICY.observation,
	}
}
