/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import {
	WEB_BUILD_INPUT_POLICY,
	inventoryWebBuildInputs,
} from './build-inputs.mjs'

const REQUIRED_FILES = {
	'package.json': '{"private":true,"workspaces":["packages/*"]}\n',
	'package-lock.json': '{"lockfileVersion":3}\n',
	LICENSE: 'AGPL fixture\n',
	'NOTICE.frontend': 'Synthetic frontend attribution\n',
	'.nvmrc': '22\n',
	'.dockerignore': 'node_modules\n.release\n',
	'packages/web/package.json': '{"name":"@cinatoken/web"}\n',
	'packages/web/index.html': '<!doctype html>\n',
	'packages/web/rsbuild.config.ts': 'export default {};\n',
	'packages/web/postcss.config.mjs': 'export default {};\n',
	'packages/web/tsconfig.json': '{}\n',
	'packages/web/tsconfig.app.json': '{}\n',
	'packages/web/tsconfig.node.json': '{}\n',
	'packages/web/src/main.tsx':
		"export { price } from '@octafuse/core/deep/rates';\n",
	'packages/web/edge/worker.ts': 'export default {};\n',
	'packages/web/scripts/tool.mjs': 'export const build = true;\n',
	'packages/core/package.json': '{"name":"@octafuse/core"}\n',
	'packages/core/src/index.ts': "export { price } from './deep/rates';\n",
	'packages/core/src/deep/rates.ts': 'export const price = 1;\n',
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
	'.github/workflows/web-frontend.yml': 'name: synthetic-web-build\n',
}

function write(root, path, bytes) {
	const file = join(root, path)
	fs.mkdirSync(dirname(file), { recursive: true })
	fs.writeFileSync(file, bytes)
	return file
}

function fixture(t) {
	const temporary = fs.realpathSync(tmpdir())
	const root = fs.realpathSync(
		fs.mkdtempSync(join(temporary, 'cinatoken-web-build-inputs-'))
	)
	t.after(() => {
		const path = fs.realpathSync(root)
		const rel = relative(temporary, path)
		assert.ok(
			!isAbsolute(rel) &&
				rel !== '..' &&
				!rel.startsWith(`..${sep}`) &&
				rel.startsWith('cinatoken-web-build-inputs-')
		)
		fs.rmSync(path, { recursive: true })
	})
	for (const [path, bytes] of Object.entries(REQUIRED_FILES))
		write(root, path, bytes)
	return { root, packageRoot: join(root, 'packages/web') }
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex')
}

function forbidOpening(t, paths) {
	const forbidden = new Set(paths.map((path) => resolve(path)))
	const opened = []
	for (const name of ['openSync', 'readFileSync']) {
		const original = fs[name]
		t.mock.method(fs, name, (path, ...args) => {
			if (typeof path === 'string') {
				const normalized = resolve(path)
				opened.push(normalized)
				assert.ok(!forbidden.has(normalized), `Opened excluded input: ${path}`)
			}
			return original(path, ...args)
		})
	}
	return opened
}

test('v2 inventory binds explicit Web, Core, runtime and workspace raw inputs', (t) => {
	const { root, packageRoot } = fixture(t)
	const inventory = inventoryWebBuildInputs(packageRoot)
	assert.equal(WEB_BUILD_INPUT_POLICY.version, 2)
	assert.equal(inventory.version, 2)
	assert.match(inventory.policySha256, /^[0-9a-f]{64}$/)
	assert.match(inventory.sourceSha256, /^[0-9a-f]{64}$/)
	const paths = inventory.files.map((file) => file.path)
	assert.equal(new Set(paths).size, paths.length)
	assert.deepEqual(
		paths,
		[...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
	)
	assert.deepEqual([...paths].sort(), Object.keys(REQUIRED_FILES).sort())
	for (const file of inventory.files) {
		const bytes = fs.readFileSync(join(root, file.path))
		assert.equal(file.bytes, bytes.length)
		assert.equal(file.sha256, sha256(bytes))
		assert.equal(typeof file.role, 'string')
		assert.ok(file.role.length > 0)
		assert.ok(!file.path.includes('\\') && !file.path.startsWith('/'))
	}
	assert.equal(
		inventory.totalBytes,
		inventory.files.reduce((total, file) => total + file.bytes, 0)
	)
	assert.throws(() => {
		WEB_BUILD_INPUT_POLICY.requiredRoots[0].path = 'changed'
	}, TypeError)
	assert.throws(() => {
		WEB_BUILD_INPUT_POLICY.limits.maxFiles = 1
	}, TypeError)
})

for (const [category, path] of [
	['Core direct source', 'packages/core/src/index.ts'],
	['Core deep dependency', 'packages/core/src/deep/rates.ts'],
	['Admin vendor JSON', 'packages/admin/lib/model-vendors.json'],
	['Docker build definition', 'Dockerfile.web-ssr'],
	['Docker context configuration', '.dockerignore'],
	['Docker runtime', 'docker/web/public-server.mjs'],
	['root lockfile', 'package-lock.json'],
	['root workspace manifest', 'package.json'],
	['sibling workspace manifest', 'packages/proxy/package.json'],
]) {
	test(`v2 digest changes when ${category} bytes change`, (t) => {
		const { root, packageRoot } = fixture(t)
		const before = inventoryWebBuildInputs(packageRoot)
		fs.appendFileSync(join(root, path), '\nchanged fixture bytes\n')
		const after = inventoryWebBuildInputs(packageRoot)
		assert.notEqual(after.sourceSha256, before.sourceSha256)
		assert.equal(after.policySha256, before.policySha256)
		const changed = after.files.filter(
			(file, index) => file.sha256 !== before.files[index].sha256
		)
		assert.deepEqual(
			changed.map((file) => file.path),
			[path]
		)
	})
}

test('optional public/configuration inputs are bound when present', (t) => {
	const { root, packageRoot } = fixture(t)
	const before = inventoryWebBuildInputs(packageRoot)
	const paths = [
		'packages/web/public/logo.txt',
		'packages/web/.babelrc',
		'packages/web/.prettierrc',
		'packages/core/tsconfig.build.json',
		'packages/core/scripts/build.mjs',
		'tsconfig.shared.json',
		'.editorconfig',
	]
	for (const path of paths)
		write(root, path, 'synthetic optional build input\n')
	const after = inventoryWebBuildInputs(packageRoot)
	assert.notEqual(after.sourceSha256, before.sourceSha256)
	for (const path of paths)
		assert.ok(after.files.some((file) => file.path === path))
})

test('UTF-8 byte order, raw CRLF and unchanged-byte timestamps are deterministic', (t) => {
	const { root, packageRoot } = fixture(t)
	const names = ['𐀀.ts', '\uE000.ts', '中.ts', 'é.ts', 'a.ts']
	for (const name of names)
		write(root, `packages/web/src/${name}`, 'export const value = 1;\r\n')
	const before = inventoryWebBuildInputs(packageRoot)
	const expected = names
		.map((name) => `packages/web/src/${name}`)
		.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
	assert.notDeepEqual(expected, [...expected].sort())
	assert.deepEqual(
		before.files
			.filter((file) => expected.includes(file.path))
			.map((file) => file.path),
		expected
	)
	const path = 'packages/web/src/a.ts'
	const file = join(root, path)
	fs.utimesSync(file, new Date(0), new Date(0))
	assert.equal(
		inventoryWebBuildInputs(packageRoot).sourceSha256,
		before.sourceSha256
	)
	write(root, path, 'export const value = 1;\n')
	const after = inventoryWebBuildInputs(packageRoot)
	assert.notEqual(after.sourceSha256, before.sourceSha256)
	assert.equal(after.files.find((entry) => entry.path === path).bytes, 24)
})

test('environment, credential, dependency and generated canaries are excluded before opening', (t) => {
	const { root, packageRoot } = fixture(t)
	const before = inventoryWebBuildInputs(packageRoot)
	const paths = [
		'.env',
		'.npmrc',
		'packages/web/src/.env.production',
		'packages/core/src/.dev.vars',
		'packages/web/src/.npmrc',
		'packages/web/src/id_rsa',
		'packages/web/src/certificate.pem',
		'packages/web/src/credentials/config.json',
		'packages/web/keys/private.ts',
		'packages/web/src/.tmp/fixture.ts',
		'packages/core/src/node_modules/fixture/index.ts',
		'packages/web/src/dist/generated.ts',
		'packages/web/dist/index.html',
		'packages/web/dist-server/worker/index.mjs',
		'packages/web/dist-ssr/generated.mjs',
		'packages/web/coverage/report.json',
		'.release/web/canary/manifest.json',
	]
	for (const path of paths) write(root, path, 'SYNTHETIC-NOT-A-REAL-SECRET\n')
	const opened = forbidOpening(
		t,
		paths.map((path) => join(root, path))
	)
	const after = inventoryWebBuildInputs(packageRoot)
	assert.equal(after.sourceSha256, before.sourceSha256)
	assert.deepEqual(after.files, before.files)
	assert.ok(opened.length > 0, 'Read interception must observe included files')
	assert.ok(
		after.excluded.some((entry) => entry.path.endsWith('.env.production'))
	)
	assert.ok(after.excluded.some((entry) => entry.path.endsWith('/.tmp')))
})

test('nested key and credential feature source stays included', (t) => {
	const { root, packageRoot } = fixture(t)
	const paths = [
		'packages/web/src/features/keys/editor.tsx',
		'packages/web/src/features/credentials/client.ts',
		'packages/core/src/credentials/validation.ts',
	]
	for (const path of paths)
		write(root, path, 'export const publicFeature = true;\n')
	const before = inventoryWebBuildInputs(packageRoot)
	for (const path of paths)
		assert.ok(before.files.some((file) => file.path === path))
	fs.appendFileSync(join(root, paths[1]), 'export const changed = true;\n')
	assert.notEqual(
		inventoryWebBuildInputs(packageRoot).sourceSha256,
		before.sourceSha256
	)
})

for (const path of [
	'package-lock.json',
	'packages/core/src',
	'packages/admin/lib/model-vendors.json',
]) {
	test(`missing required input ${path} fails closed`, (t) => {
		const { root, packageRoot } = fixture(t)
		const target = resolve(root, path)
		assert.ok(
			relative(root, target) && !relative(root, target).startsWith('..')
		)
		fs.rmSync(target, { recursive: true })
		assert.throws(
			() => inventoryWebBuildInputs(packageRoot),
			/Missing required Web build input/
		)
	})
}

test('included directory links and linked ancestors fail closed', (t) => {
	const { root, packageRoot } = fixture(t)
	const target = join(root, 'linked-target')
	fs.mkdirSync(target)
	write(root, 'linked-target/source.ts', 'export const linked = true;\n')
	const link = join(root, 'packages/web/src/linked')
	fs.symlinkSync(
		target,
		link,
		process.platform === 'win32' ? 'junction' : 'dir'
	)
	assert.throws(
		() => inventoryWebBuildInputs(packageRoot),
		/Linked Web build input/
	)
	fs.unlinkSync(link)
	const ancestor = join(root, 'alias')
	fs.symlinkSync(
		root,
		ancestor,
		process.platform === 'win32' ? 'junction' : 'dir'
	)
	assert.throws(
		() => inventoryWebBuildInputs(join(ancestor, 'packages/web')),
		/Linked Web build input/
	)
	fs.unlinkSync(ancestor)
})

test('additional workspace manifests are bound and linked workspaces rejected', (t) => {
	const { root, packageRoot } = fixture(t)
	const before = inventoryWebBuildInputs(packageRoot)
	const extra = 'packages/extra-plain/package.json'
	write(root, extra, '{"name":"synthetic-extra-workspace"}\n')
	const after = inventoryWebBuildInputs(packageRoot)
	assert.notEqual(after.sourceSha256, before.sourceSha256)
	assert.equal(
		after.files.find((file) => file.path === extra).role,
		'workspace-package-manifest'
	)
	const target = join(root, 'extra-target')
	write(
		root,
		'extra-target/package.json',
		'{"name":"synthetic-extra-workspace"}\n'
	)
	const link = join(root, 'packages/extra-linked')
	fs.symlinkSync(
		target,
		link,
		process.platform === 'win32' ? 'junction' : 'dir'
	)
	try {
		assert.throws(
			() => inventoryWebBuildInputs(packageRoot),
			/Linked workspace Web build input/
		)
	} finally {
		fs.unlinkSync(link)
	}
})

test('a non-regular included candidate is rejected before opening', (t) => {
	const { root, packageRoot } = fixture(t)
	const file = write(
		root,
		'packages/web/src/non-regular.ts',
		'synthetic candidate\n'
	)
	const original = fs.lstatSync
	t.mock.method(fs, 'lstatSync', (path, ...args) => {
		const stat = original(path, ...args)
		if (resolve(path) !== resolve(file)) return stat
		const nonRegular = Object.create(stat)
		nonRegular.isFile = () => false
		nonRegular.isDirectory = () => false
		return nonRegular
	})
	forbidOpening(t, [file])
	assert.throws(
		() => inventoryWebBuildInputs(packageRoot),
		/Non-regular Web build input/
	)
})

for (const phase of ['before opening', 'after reading']) {
	test(`a candidate changed ${phase} cannot produce an accepted inventory`, (t) => {
		const { root, packageRoot } = fixture(t)
		const target = join(root, 'packages/core/src/deep/rates.ts')
		const originalOpen = fs.openSync
		const originalRead = fs.readFileSync
		let targetDescriptor
		let changed = false
		t.mock.method(fs, 'openSync', (path, ...args) => {
			const selected =
				typeof path === 'string' && resolve(path) === resolve(target)
			if (selected && phase === 'before opening') {
				fs.appendFileSync(target, 'changed before opening\n')
				changed = true
			}
			const descriptor = originalOpen(path, ...args)
			if (selected) targetDescriptor = descriptor
			return descriptor
		})
		t.mock.method(fs, 'readFileSync', (path, ...args) => {
			const bytes = originalRead(path, ...args)
			if (path === targetDescriptor && phase === 'after reading') {
				fs.appendFileSync(target, 'changed after reading\n')
				changed = true
			}
			return bytes
		})
		assert.throws(
			() => inventoryWebBuildInputs(packageRoot),
			/Web build input changed (?:before|during) read/
		)
		assert.ok(
			changed,
			'The fixture must actually change inside the read boundary'
		)
	})
}

test('single-file byte budget rejects sparse oversized input before any source read', (t) => {
	const { root, packageRoot } = fixture(t)
	const file = write(root, 'packages/core/src/oversized.ts', '')
	fs.truncateSync(file, 64 * 1024 * 1024 + 1)
	const opened = forbidOpening(
		t,
		Object.keys(REQUIRED_FILES)
			.map((path) => join(root, path))
			.concat(file)
	)
	assert.throws(
		() => inventoryWebBuildInputs(packageRoot),
		/Exceeds Web build input/
	)
	assert.deepEqual(opened, [])
})

test('aggregate byte budget rejects sparse inputs before any source read', (t) => {
	const { root, packageRoot } = fixture(t)
	const files = []
	for (let index = 0; index < 9; index += 1) {
		const file = write(root, `packages/core/src/large-${index}.ts`, '')
		fs.truncateSync(file, 64 * 1024 * 1024)
		files.push(file)
	}
	const opened = forbidOpening(
		t,
		Object.keys(REQUIRED_FILES)
			.map((path) => join(root, path))
			.concat(files)
	)
	assert.throws(
		() => inventoryWebBuildInputs(packageRoot),
		/Exceeds Web build input/
	)
	assert.deepEqual(opened, [])
})

test('file-count budget rejects a real oversized tree before source reads', (t) => {
	const { root, packageRoot } = fixture(t)
	for (let index = 0; index < 10001; index += 1)
		write(root, `packages/core/src/count/${index}.ts`, '')
	t.mock.method(fs, 'openSync', () => {
		assert.fail('File-count rejection must precede opening source files')
	})
	assert.throws(
		() => inventoryWebBuildInputs(packageRoot),
		/Exceeds Web build input/
	)
})
