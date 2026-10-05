/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createHash, randomUUID } from 'node:crypto'
import {
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { inventoryWebBuildInputs } from './build-inputs.mjs'

export const BUILD_CONTRACT_FILE = 'build-contract.json'

// Preserve the original digest exactly for historical version 1 artifacts.
function legacyWebSourceSha256(packageRoot) {
	const paths = []
	function visit(relativePath) {
		const absolute = join(packageRoot, relativePath)
		if (!existsSync(absolute)) return
		const stat = lstatSync(absolute)
		if (stat.isSymbolicLink()) throw new Error('Linked Web build input')
		if (stat.isDirectory()) {
			for (const name of readdirSync(absolute).sort())
				visit(`${relativePath}/${name}`)
		} else if (stat.isFile()) paths.push(relativePath)
		else throw new Error('Non-regular Web build input')
	}
	for (const path of [
		'src',
		'edge',
		'scripts',
		'public',
		'index.html',
		'package.json',
		'rsbuild.config.ts',
		'postcss.config.mjs',
		'.browserslistrc',
		'.babelrc',
		'babel.config.js',
		'babel.config.mjs',
		'.swcrc',
		'tsconfig.json',
		'tsconfig.app.json',
		'tsconfig.node.json',
		'tsconfig.test.json',
		'../../package.json',
		'../../package-lock.json',
		'../../.browserslistrc',
	])
		visit(path)
	const digest = createHash('sha256')
	for (const path of paths.sort()) {
		const bytes = readFileSync(join(packageRoot, path))
		digest.update(`${path}\0${bytes.length}\0`).update(bytes)
	}
	return digest.digest('hex')
}

// Version 2 includes the shared source and runtime inputs declared by its policy.
export function webSourceSha256(packageRoot, { version = 2 } = {}) {
	if (version === 1) return legacyWebSourceSha256(packageRoot)
	if (version === 2) return inventoryWebBuildInputs(packageRoot).sourceSha256
	throw new Error('Unsupported Web build contract version')
}

function validateContract(value) {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(',') !== 'buildId,sourceSha256,version' ||
		(value.version !== 1 && value.version !== 2) ||
		typeof value.buildId !== 'string' ||
		!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.buildId) ||
		typeof value.sourceSha256 !== 'string' ||
		!/^[0-9a-f]{64}$/.test(value.sourceSha256)
	) {
		throw new Error('Invalid Web build contract')
	}
	return {
		version: value.version,
		buildId: value.buildId,
		sourceSha256: value.sourceSha256,
	}
}

export function readBuildContract(directory) {
	const file = join(directory, BUILD_CONTRACT_FILE)
	if (!existsSync(file)) throw new Error('Missing Web build contract')
	const stat = lstatSync(file)
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024)
		throw new Error('Invalid Web build contract file')
	return validateContract(JSON.parse(readFileSync(file, 'utf8')))
}

export function verifyBuildPair(browserDirectory, serverDirectory) {
	const contract = readBuildContract(browserDirectory)
	for (const target of ['node', 'worker']) {
		if (
			JSON.stringify(readBuildContract(join(serverDirectory, target))) !==
			JSON.stringify(contract)
		) {
			throw new Error(
				'Browser, Node and Worker builds must share one build contract'
			)
		}
	}
	return contract
}

// Worker bundles must not need a Node compatibility layer. Reject a retained
// Node specifier before writing the successful build marker.
export function assertWorkerNoNodeImports(directory) {
	function visit(current) {
		for (const name of readdirSync(current)) {
			const file = join(current, name)
			const stat = lstatSync(file)
			if (stat.isSymbolicLink()) throw new Error('Linked Worker build output')
			if (stat.isDirectory()) visit(file)
			else if (stat.isFile() && /\.[cm]?js$/.test(name)) {
				if (/["']node:[^"']+["']/.test(readFileSync(file, 'utf8')))
					throw new Error('Worker bundle retains a Node module specifier')
			}
		}
	}
	visit(directory)
}

export function pluginWebBuildContract(packageRoot) {
	let contract
	return {
		name: 'cinatoken-web-build-contract',
		setup(api) {
			api.onBeforeCreateCompiler({
				order: 'post',
				handler({ bundlerConfigs }) {
					for (const config of bundlerConfigs) {
						if (config.name !== 'worker') continue
						// Rsbuild removes Worker externals in its default compiler hook.
						// This unused public SSR barrel export must resolve for tree shaking;
						// assertWorkerNoNodeImports rejects it if any Node code survives.
						config.externals = { 'node:stream': 'module node:stream' }
					}
				},
			})
			api.onBeforeBuild(() => {
				contract = {
					version: 2,
					buildId: randomUUID(),
					sourceSha256: webSourceSha256(packageRoot),
				}
			})
			api.onAfterBuild(({ stats, environments }) => {
				if (!contract || !stats || stats.hasErrors())
					throw new Error('Cannot stamp a failed Web build')
				if (
					webSourceSha256(packageRoot, { version: contract.version }) !==
					contract.sourceSha256
				)
					throw new Error('Web sources changed during build')
				// Validate Worker output before writing any successful target marker.
				if (environments.worker)
					assertWorkerNoNodeImports(resolve(environments.worker.distPath))
				for (const environment of Object.values(environments)) {
					const directory = resolve(environment.distPath)
					writeFileSync(
						join(directory, BUILD_CONTRACT_FILE),
						`${JSON.stringify(contract, null, 2)}\n`
					)
				}
			})
		},
	}
}
