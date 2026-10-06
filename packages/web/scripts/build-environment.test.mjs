/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = resolve(
	packageRoot,
	'../../node_modules/@rsbuild/core/bin/rsbuild.js'
)
const helperURL = new URL('./build-environment.mjs', import.meta.url).href

function temporary(fn) {
	const directory = mkdtempSync(join(tmpdir(), 'cinatoken-web-env-'))
	try {
		return fn(directory)
	} finally {
		assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
		rmSync(directory, { recursive: true, force: true })
	}
}

function child(args, env = {}) {
	return spawnSync(process.execPath, args, {
		cwd: packageRoot,
		env: { ...process.env, ...env },
		encoding: 'utf8',
		windowsHide: true,
		timeout: 60000,
		maxBuffer: 8 * 1024 * 1024,
	})
}

function assertRejected(result, canary) {
	assert.equal(result.status, 1, result.error?.message ?? result.stderr)
	assert.match(
		result.stderr,
		/Unapproved Web public environment names: PUBLIC_SECRET_CANARY/
	)
	assert.ok(
		!result.stdout.includes(canary) && !result.stderr.includes(canary),
		'never log the rejected value'
	)
}

test('the managed build rejects an unapproved process PUBLIC variable before compiling', () => {
	temporary((directory) => {
		const canary = `private-${randomUUID()}`
		assertRejected(
			child(
				[
					cli,
					'build',
					'--no-env',
					'--environment',
					'web',
					'--dist-path',
					join(directory, 'dist'),
				],
				{ PUBLIC_SECRET_CANARY: canary }
			),
			canary
		)
		assert.deepEqual(readdirSync(directory), [])
	})
})

test('bare Rsbuild CLI cannot bypass the allowlist through a mode env file', () => {
	temporary((directory) => {
		const canary = `private-${randomUUID()}`
		writeFileSync(
			join(directory, '.env.production.local'),
			`PUBLIC_SECRET_CANARY=${canary}\n`
		)
		assertRejected(
			child([
				cli,
				'build',
				'--env-dir',
				directory,
				'--env-mode',
				'production',
				'--environment',
				'web',
				'--dist-path',
				join(directory, 'dist'),
			]),
			canary
		)
		assert.deepEqual(readdirSync(directory), ['.env.production.local'])
	})
})

test('private mode values reload without contaminating the dev process', () => {
	temporary((directory) => {
		const program = `
			import assert from 'node:assert/strict';
			import { writeFileSync } from 'node:fs';
			import { loadWebBuildEnvironment } from ${JSON.stringify(helperURL)};
			const root = ${JSON.stringify(directory)};
			delete process.env.CINATOKEN_WEB_ADMIN_ORIGIN;
			writeFileSync(root + '/.env', 'CINATOKEN_WEB_ADMIN_ORIGIN=http://127.0.0.1:8001\\n');
			writeFileSync(root + '/.env.development.local', 'CINATOKEN_WEB_ADMIN_ORIGIN=http://127.0.0.1:8002\\n');
			const first = loadWebBuildEnvironment(root, 'development');
			assert.equal(first.values.CINATOKEN_WEB_ADMIN_ORIGIN, 'http://127.0.0.1:8002');
			assert.deepEqual(first.publicVars, {});
			assert.equal(first.filePaths.length, 2);
			assert.equal(process.env.CINATOKEN_WEB_ADMIN_ORIGIN, undefined);
			writeFileSync(root + '/.env.development.local', 'CINATOKEN_WEB_ADMIN_ORIGIN=http://127.0.0.1:8003\\n');
			assert.equal(loadWebBuildEnvironment(root, 'development').values.CINATOKEN_WEB_ADMIN_ORIGIN, 'http://127.0.0.1:8003');
			process.env.CINATOKEN_WEB_ADMIN_ORIGIN = 'http://127.0.0.1:8004';
			assert.equal(loadWebBuildEnvironment(root, 'development').values.CINATOKEN_WEB_ADMIN_ORIGIN, 'http://127.0.0.1:8004');
		`
		const result = child(['--input-type=module', '--eval', program])
		assert.equal(result.status, 0, result.error?.message ?? result.stderr)
	})
})

test('the real Web config never inlines private canaries, including in source maps', () => {
	temporary((directory) => {
		const names = [
			'CINAAUTH_CLIENT_SECRET',
			'CINAAUTH_BRIDGE_SECRET',
			'DATABASE_URL',
			'CLOUDFLARE_API_TOKEN',
			'CINATOKEN_WEB_ADMIN_ORIGIN',
			'CINATOKEN_WEB_PROXY_ORIGIN',
		]
		const canaries = Object.fromEntries(
			names.map((name) => [name, `https://${randomUUID()}.invalid`])
		)
		const entry = join(directory, 'probe.js')
		writeFileSync(
			entry,
			`globalThis.__WEB_ENV_PROBE__ = { environment: import.meta.env, process: process.env, fields: [${names.map((name) => `import.meta.env.${name}, process.env.${name}`).join(', ')}] };`
		)
		const output = join(directory, 'dist')
		const program = `
			import { createRsbuild, loadConfig } from '@rsbuild/core';
			const loaded = await loadConfig({ cwd: ${JSON.stringify(packageRoot)}, envMode: 'production', command: 'build' });
			const config = loaded.content;
			config.environments.web.source.entry = { index: ${JSON.stringify(entry)} };
			config.environments.web.output = { distPath: { root: ${JSON.stringify(output)} }, sourceMap: { js: 'source-map' } };
			const build = await createRsbuild({ cwd: ${JSON.stringify(packageRoot)}, loadEnv: false, config, environment: ['web'] });
			const result = await build.build();
			await result.close();
		`
		const result = child(['--input-type=module', '--eval', program], {
			...canaries,
			NODE_ENV: 'production',
		})
		assert.equal(result.status, 0, result.error?.message ?? result.stderr)
		const files = []
		function visit(current) {
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				const path = join(current, entry.name)
				if (entry.isDirectory()) visit(path)
				else files.push(path)
			}
		}
		visit(output)
		assert.ok(
			files.some((file) => file.endsWith('.map')),
			'scan actual browser source maps'
		)
		assert.ok(
			files.some(
				(file) =>
					file.endsWith('.js') &&
					readFileSync(file, 'utf8').includes('__WEB_ENV_PROBE__')
			),
			'the probe must survive compilation'
		)
		for (const file of files) {
			const bytes = readFileSync(file)
			for (const canary of Object.values(canaries))
				assert.ok(
					!bytes.includes(Buffer.from(canary)),
					`private value leaked into ${file}`
				)
		}
	})
})
