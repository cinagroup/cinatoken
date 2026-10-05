import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { routeWebRequest } from '../edge/worker.ts'
import { IMMUTABLE_CACHE, assetCacheControl } from './asset-policy.mjs'
import {
	assertWorkerNoNodeImports,
	webSourceSha256,
} from './build-contract.mjs'
import { WEB_BUILD_INPUT_POLICY } from './build-inputs.mjs'
import {
	createWebWranglerConfig,
	resolveWebAssets,
	resolveWebServer,
} from './gen-web-wrangler.mjs'
import { packageRelease, verifyRelease } from './package-release.mjs'
import { verifySourceArchive } from './source-archive.mjs'
import { verifySourceDelivery } from './source-delivery.mjs'

const OLD = 'static/js/async/account.12345678.js'
const NEW = 'static/js/async/account.87654321.js'
const START = '2026-09-01T00:00:00.000Z'

test('Worker output rejects a retained Node import in an async chunk', (t) => {
	const root = fixture(t)
	const directory = join(root, 'packages/web/dist-server/worker')
	mkdirSync(join(directory, 'async'), { recursive: true })
	writeFileSync(join(directory, 'index.mjs'), 'export const entry = 1;')
	writeFileSync(
		join(directory, 'async/router.mjs'),
		"import { Readable } from 'node:stream'; export { Readable };"
	)
	assert.throws(() => assertWorkerNoNodeImports(directory), /retains a Node/)
	writeFileSync(
		join(directory, 'async/router.mjs'),
		'export const ready = true;'
	)
	assert.doesNotThrow(() => assertWorkerNoNodeImports(directory))
})
function fixture(t) {
	const temporary = realpathSync(tmpdir())
	const root = realpathSync(
		mkdtempSync(join(temporary, 'cinatoken-web-release-'))
	)
	t.after(() => {
		const path = realpathSync(root)
		const rel = relative(temporary, path)
		assert.ok(
			!isAbsolute(rel) &&
				!rel.startsWith(`..${sep}`) &&
				rel !== '..' &&
				rel.startsWith('cinatoken-web-release-')
		)
		rmSync(path, { recursive: true })
	})
	mkdirSync(join(root, 'packages/web/dist'), { recursive: true })
	writeFileSync(join(root, 'LICENSE'), 'AGPLv3 fixture\n')
	writeFileSync(join(root, 'NOTICE.frontend'), 'Upstream attribution fixture\n')
	return root
}
function write(root, path, text) {
	const file = join(root, 'packages/web/dist', path)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, text)
}
function resetBuild(root, version, hash) {
	const dist = join(root, 'packages/web/dist')
	// This helper only removes known files, never a directory tree.
	for (const path of [
		'index.html',
		OLD,
		NEW,
		`${OLD}.LICENSE.txt`,
		'logo.png',
	]) {
		if (existsSync(join(dist, path))) rmSync(join(dist, path))
	}
	write(root, 'index.html', `<html>${version}</html>`)
	write(root, hash, `lazy-${version}`)
	write(root, 'logo.png', `logo-${version}`)
}
function release(root, id, at = START, options = {}) {
	return packageRelease({ root, id, at, ...options })
}
function resign(directory, mutate) {
	const path = join(directory, 'manifest.json')
	const manifest = JSON.parse(readFileSync(path, 'utf8'))
	mutate(manifest)
	const bytes = `${JSON.stringify(manifest, null, 2)}\n`
	writeFileSync(path, bytes)
	writeFileSync(
		join(directory, 'manifest.sha256'),
		`${createHash('sha256').update(bytes).digest('hex')}\n`
	)
}

function writeServers(root, version, contractVersion = 1) {
	if (contractVersion === 2) {
		for (const input of WEB_BUILD_INPUT_POLICY.requiredRoots) {
			const path = join(root, input.path)
			if (input.kind === 'directory') mkdirSync(path, { recursive: true })
			else if (!existsSync(path)) {
				mkdirSync(dirname(path), { recursive: true })
				writeFileSync(
					path,
					input.path.endsWith('package.json')
						? '{"private":true}'
						: 'fixture input\n'
				)
			}
		}
		writeFileSync(
			join(root, 'packages/core/src/fixture.ts'),
			`export const version = '${version}'\n`
		)
	}
	const contract = {
		version: contractVersion,
		buildId: randomUUID(),
		sourceSha256: webSourceSha256(join(root, 'packages/web'), {
			version: contractVersion,
		}),
	}
	write(root, 'build-contract.json', JSON.stringify(contract))
	for (const target of ['node', 'worker']) {
		const directory = join(root, 'packages/web/dist-server', target)
		mkdirSync(directory, { recursive: true })
		writeFileSync(
			join(directory, 'build-contract.json'),
			JSON.stringify(contract)
		)
		writeFileSync(
			join(directory, 'index.mjs'),
			`export const version = '${version}';\n`
		)
		writeFileSync(
			join(directory, 'index.mjs.LICENSE.txt'),
			`Server license ${version}\n`
		)
	}
}

test('server artifacts are frozen, independently verified and kept outside public assets', (t) => {
	const root = fixture(t)
	resetBuild(root, 'public-v2', OLD)
	writeServers(root, 'server-v2')
	const result = release(root, 'v2')
	assert.equal(result.manifest.schemaVersion, 2)
	assert.equal(result.manifest.serverFiles.length, 6)
	assert.ok(!existsSync(join(result.assets, 'server')))
	assert.equal(
		resolveWebServer(['--release', 'v2'], root),
		'../../.release/web/v2/server/worker/index.mjs'
	)
	const config = createWebWranglerConfig(
		{
			CINATOKEN_WEB_PUBLIC_ENABLED: 'true',
			CINATOKEN_WEB_PUBLIC_ORIGIN: 'https://gateway.example',
		},
		resolveWebAssets(['--release', 'v2'], root),
		resolveWebServer(['--release', 'v2'], root)
	)
	assert.equal(config.no_bundle, true)
	assert.equal(config.main, '../../.release/web/v2/server/worker/index.mjs')
	writeFileSync(join(result.server, 'node/index.mjs'), 'changed server')
	assert.throws(() => verifyRelease(root, 'v2'), /Server inventory/)
})

test('fresh packaging rejects mixed browser, Node and Worker builds before freezing', (t) => {
	const root = fixture(t)
	resetBuild(root, 'a', OLD)
	writeServers(root, 'a')
	const browser = join(root, 'packages/web/dist/build-contract.json')
	const original = readFileSync(browser)
	const mismatch = JSON.parse(original)
	mismatch.buildId = randomUUID()
	writeFileSync(browser, JSON.stringify(mismatch))
	assert.throws(
		() => release(root, 'mixed-browser'),
		/share one build contract/
	)
	assert.equal(existsSync(join(root, '.release/web/mixed-browser')), false)
	writeFileSync(browser, original)
	const worker = join(
		root,
		'packages/web/dist-server/worker/build-contract.json'
	)
	writeFileSync(worker, JSON.stringify(mismatch))
	assert.throws(() => release(root, 'mixed-worker'), /share one build contract/)
	rmSync(worker)
	assert.throws(
		() => release(root, 'missing-worker-contract'),
		/Missing Web build contract/
	)
	assert.equal(
		existsSync(join(root, '.release/web/missing-worker-contract')),
		false
	)
	writeFileSync(worker, original)
	const node = join(root, 'packages/web/dist-server/node/build-contract.json')
	writeFileSync(node, JSON.stringify(mismatch))
	assert.throws(() => release(root, 'mixed-node'), /share one build contract/)
	writeFileSync(node, original)
	writeFileSync(join(root, 'packages/web/rsbuild.config.ts'), 'changed source')
	assert.throws(
		() => release(root, 'stale-source'),
		/sources changed after build/
	)
	assert.equal(existsSync(join(root, '.release/web/stale-source')), false)
})

test('PostCSS build configuration drift requires rebuilding all targets', (t) => {
	const root = fixture(t)
	resetBuild(root, 'a', OLD)
	writeFileSync(
		join(root, 'packages/web/postcss.config.mjs'),
		'export default { plugins: {} }'
	)
	writeServers(root, 'a')
	writeFileSync(
		join(root, 'packages/web/postcss.config.mjs'),
		'export default { plugins: { tailwind: {} } }'
	)
	assert.throws(
		() => release(root, 'stale-postcss'),
		/sources changed after build/
	)
	assert.equal(existsSync(join(root, '.release/web/stale-postcss')), false)
})

test('a stamped browser build cannot silently freeze without server outputs', (t) => {
	const root = fixture(t)
	resetBuild(root, 'partial', OLD)
	write(
		root,
		'build-contract.json',
		JSON.stringify({
			version: 1,
			buildId: randomUUID(),
			sourceSha256: webSourceSha256(join(root, 'packages/web'), { version: 1 }),
		})
	)
	assert.throws(() => release(root, 'partial'), /requires both Node and Worker/)
	assert.equal(existsSync(join(root, '.release/web/partial')), false)
})

test('rollback selects matching old server code and supports legacy releases without injecting a new server', (t) => {
	const root = fixture(t)
	resetBuild(root, 'legacy', OLD)
	release(root, 'legacy')
	writeServers(root, 'server-a')
	resetBuild(root, 'html-a', NEW)
	release(root, 'a', '2026-09-02T00:00:00Z')
	writeServers(root, 'server-b')
	resetBuild(root, 'html-b', 'static/js/async/account.11223344.js')
	release(root, 'b', '2026-09-03T00:00:00Z', { previous: 'a' })
	const restored = release(root, 'restore-a', '2026-09-04T00:00:00Z', {
		previous: 'b',
		currentRelease: 'a',
	})
	assert.equal(
		readFileSync(join(restored.server, 'node/index.mjs'), 'utf8'),
		"export const version = 'server-a';\n"
	)
	assert.equal(
		readFileSync(join(restored.assets, 'index.html'), 'utf8'),
		'<html>html-a</html>'
	)
	assert.ok(
		existsSync(join(restored.assets, 'static/js/async/account.11223344.js'))
	)
	const legacy = release(root, 'restore-legacy', '2026-09-05T00:00:00Z', {
		previous: 'b',
		currentRelease: 'legacy',
	})
	assert.equal(legacy.manifest.schemaVersion, 1)
	assert.equal(legacy.server, null)
	assert.throws(
		() =>
			createWebWranglerConfig(
				{
					CINATOKEN_WEB_PUBLIC_ENABLED: 'true',
					CINATOKEN_WEB_PUBLIC_ORIGIN: 'https://gateway.example',
				},
				'../../.release/web/restore-legacy/assets'
			),
		/verified server artifact/
	)
})

test('partial server builds cannot freeze an artifact or enable an unverified public entry', (t) => {
	const root = fixture(t)
	resetBuild(root, 'partial', OLD)
	mkdirSync(join(root, 'packages/web/dist-server/node'), { recursive: true })
	writeFileSync(
		join(root, 'packages/web/dist-server/node/index.mjs'),
		'node only'
	)
	assert.throws(() => release(root, 'partial'), /both Node and Worker/)
	assert.ok(!existsSync(join(root, '.release/web/partial')))
	assert.throws(
		() => createWebWranglerConfig({ CINATOKEN_WEB_PUBLIC_ENABLED: 'true' }),
		/verified server artifact/
	)
	assert.throws(
		() =>
			createWebWranglerConfig({
				CINATOKEN_WEB_PUBLIC_ORIGIN: 'https://user:secret@gateway.example',
			}),
		/trusted HTTPS origin/
	)
})

test('new artifact retains old lazy chunks and licenses, with only current HTML and mutable files', (t) => {
	const root = fixture(t)
	resetBuild(root, 'v1', OLD)
	write(root, `${OLD}.LICENSE.txt`, 'license')
	release(root, 'v1')
	resetBuild(root, 'v2', NEW)
	const result = release(root, 'v2', '2026-09-02T00:00:00Z', { previous: 'v1' })
	assert.equal(
		readFileSync(join(result.assets, 'index.html'), 'utf8'),
		'<html>v2</html>'
	)
	assert.equal(readFileSync(join(result.assets, 'logo.png'), 'utf8'), 'logo-v2')
	assert.equal(
		readFileSync(join(result.assets, 'LICENSE'), 'utf8'),
		'AGPLv3 fixture\n'
	)
	assert.equal(
		readFileSync(join(result.assets, 'NOTICE.frontend'), 'utf8'),
		'Upstream attribution fixture\n'
	)
	assert.equal(readFileSync(join(result.assets, OLD), 'utf8'), 'lazy-v1')
	assert.equal(
		readFileSync(join(result.assets, `${OLD}.LICENSE.txt`), 'utf8'),
		'license'
	)
	assert.equal(
		result.manifest.files.find((f) => f.path === OLD).lastCurrentAt,
		START
	)
	for (const path of ['LICENSE', 'NOTICE.frontend'])
		assert.equal(
			result.manifest.files.find((file) => file.path === path).source,
			'current'
		)
	assert.equal(
		resolveWebAssets(['--release', 'v2'], root),
		'../../.release/web/v2/assets'
	)
})

test('retained asset lifetime is not refreshed by intermediate releases; exact cutoff and configured window apply', (t) => {
	const root = fixture(t)
	resetBuild(root, 'v1', OLD)
	release(root, 'v1')
	resetBuild(root, 'v2', NEW)
	release(root, 'v2', '2026-09-10T00:00:00Z', { previous: 'v1' })
	const boundary = release(root, 'boundary', '2026-09-15T00:00:00Z', {
		previous: 'v2',
	})
	assert.ok(existsSync(join(boundary.assets, OLD)))
	const expired = release(root, 'expired', '2026-09-15T00:00:01Z', {
		previous: 'boundary',
	})
	assert.equal(existsSync(join(expired.assets, OLD)), false)
	const short = release(root, 'short', '2026-09-03T00:00:00Z', {
		previous: 'v1',
		retentionDays: 1,
	})
	assert.equal(existsSync(join(short.assets, OLD)), false)
})

test('explicit rollback restores old current files while preserving new tabs lazy chunks', (t) => {
	const root = fixture(t)
	resetBuild(root, 'v1', OLD)
	release(root, 'v1')
	resetBuild(root, 'v2', NEW)
	release(root, 'v2', '2026-09-02T00:00:00Z', { previous: 'v1' })
	const rollback = release(root, 'rollback', '2026-09-03T00:00:00Z', {
		currentRelease: 'v1',
		previous: 'v2',
	})
	assert.equal(
		readFileSync(join(rollback.assets, 'index.html'), 'utf8'),
		'<html>v1</html>'
	)
	assert.equal(
		readFileSync(join(rollback.assets, 'logo.png'), 'utf8'),
		'logo-v1'
	)
	assert.equal(readFileSync(join(rollback.assets, OLD), 'utf8'), 'lazy-v1')
	assert.equal(readFileSync(join(rollback.assets, NEW), 'utf8'), 'lazy-v2')
	assert.equal(
		rollback.manifest.files.find((f) => f.path === OLD).source,
		'current'
	)
	assert.equal(
		rollback.manifest.files.find((f) => f.path === NEW).source,
		'retained'
	)
})

test('same hash path cannot change bytes, including expired previous paths; equal contents are deduplicated', (t) => {
	const root = fixture(t)
	resetBuild(root, 'v1', OLD)
	release(root, 'v1')
	write(root, OLD, 'changed')
	assert.throws(
		() =>
			release(root, 'collision', '2026-10-01T00:00:00Z', { previous: 'v1' }),
		/Immutable path collision/
	)
	assert.equal(existsSync(join(root, '.release/web/collision')), false)
	write(root, OLD, 'lazy-v1')
	const same = release(root, 'same', '2026-09-02T00:00:00Z', { previous: 'v1' })
	assert.equal(same.manifest.files.filter((f) => f.path === OLD).length, 1)
	assert.equal(
		same.manifest.files.find((f) => f.path === OLD).lastCurrentAt,
		same.manifest.createdAt
	)
})

test('packaging is deterministic for fixed inputs, id, timestamp and retention', (t) => {
	const a = fixture(t)
	const b = fixture(t)
	for (const root of [a, b]) resetBuild(root, 'v1', OLD)
	assert.equal(
		release(a, 'deterministic').manifestSha256,
		release(b, 'deterministic').manifestSha256
	)
})

test('frozen output, traversal ids, timestamps, control files and missing HTML fail safely', (t) => {
	const root = fixture(t)
	resetBuild(root, 'v1', OLD)
	release(root, 'v1')
	assert.throws(() => release(root, 'v1'), /never overwrite/)
	for (const id of ['../escape', 'C:/escape', 'a/b', '', 'a'.repeat(65)])
		assert.throws(() => release(root, id), /Release id/)
	assert.throws(
		() =>
			release(root, 'backwards', '2026-08-31T00:00:00Z', { previous: 'v1' }),
		/precedes/
	)
	assert.throws(
		() =>
			release(root, 'rollback-without-current', START, {
				currentRelease: 'v1',
			}),
		/Rollback requires/
	)
	for (const retentionDays of [0, 91, 1.5])
		assert.throws(
			() => release(root, 'retention', START, { retentionDays }),
			/Retention/
		)
	write(root, '_headers', 'invalid routing control')
	assert.throws(() => release(root, 'headers'), /routing control/)
	rmSync(join(root, 'packages/web/dist/_headers'))
	rmSync(join(root, 'packages/web/dist/index.html'))
	assert.throws(() => release(root, 'missing'), /no index.html/)
})

test('a release requires regular license and attribution files before creating an artifact', (t) => {
	const root = fixture(t)
	resetBuild(root, 'v1', OLD)
	rmSync(join(root, 'NOTICE.frontend'))
	assert.throws(
		() => release(root, 'missing-notice'),
		/Required release notice/
	)
	assert.equal(existsSync(join(root, '.release/web/missing-notice')), false)
	writeFileSync(join(root, 'NOTICE.frontend'), 'Upstream attribution fixture\n')
	rmSync(join(root, 'LICENSE'))
	assert.throws(
		() => release(root, 'missing-license'),
		/Required release notice/
	)
	assert.equal(existsSync(join(root, '.release/web/missing-license')), false)
})

test('asset links and linked release directories are rejected before publication', (t) => {
	const root = fixture(t)
	resetBuild(root, 'v1', OLD)
	const linked = join(root, 'packages/web/dist/linked')
	symlinkSync(
		join(root, 'packages/web/dist/static'),
		linked,
		process.platform === 'win32' ? 'junction' : 'dir'
	)
	assert.throws(() => release(root, 'linked'), /Symbolic link/)
	rmSync(linked)
	release(root, 'v1')
	symlinkSync(
		join(root, '.release/web/v1'),
		join(root, '.release/web/alias'),
		process.platform === 'win32' ? 'junction' : 'dir'
	)
	assert.throws(() => verifyRelease(root, 'alias'), /Symbolic links/)
})

test('verification detects extra/missing/modified files and invalid metadata even with a recomputed manifest digest', (t) => {
	const root = fixture(t)
	resetBuild(root, 'v1', OLD)
	const result = release(root, 'v1')
	writeFileSync(join(result.assets, 'extra.js'), 'extra')
	assert.throws(() => verifyRelease(root, 'v1'), /inventory/)
	rmSync(join(result.assets, 'extra.js'))
	writeFileSync(join(result.assets, OLD), 'wrong!!')
	assert.throws(() => verifyRelease(root, 'v1'), /digest|size/)
	writeFileSync(join(result.assets, OLD), 'lazy-v1')
	resign(result.directory, (manifest) => {
		manifest.files.find((f) => f.path === OLD).path = '../escape.js'
	})
	assert.throws(() => verifyRelease(root, 'v1'), /Unsafe asset path/)
})

test('verification rejects promoting HTML to retained resources or oversized declared files', (t) => {
	const root = fixture(t)
	resetBuild(root, 'v1', OLD)
	const result = release(root, 'v1')
	resign(result.directory, (manifest) => {
		manifest.files.find((f) => f.path === 'index.html').source = 'retained'
	})
	assert.throws(() => verifyRelease(root, 'v1'), /Invalid manifest file/)
	resign(result.directory, (manifest) => {
		manifest.files.find((f) => f.path === 'index.html').source = 'current'
		manifest.files.find((f) => f.path === OLD).bytes = 20 * 1024 * 1024 + 1
	})
	assert.throws(() => verifyRelease(root, 'v1'), /Invalid manifest file/)
})

test('verification rejects routing controls and mismatched release identity; copied directory aliases are explicit', (t) => {
	const root = fixture(t)
	resetBuild(root, 'v1', OLD)
	const result = release(root, 'v1')
	resign(result.directory, (manifest) => {
		manifest.releaseId = 'other'
	})
	assert.throws(() => verifyRelease(root, 'v1'), /Invalid release manifest/)
	assert.equal(
		verifyRelease(root, 'v1', { directoryAlias: true }).manifest.releaseId,
		'other'
	)
	const bytes = Buffer.from('no routing controls')
	writeFileSync(join(result.assets, '_headers'), bytes)
	resign(result.directory, (manifest) => {
		manifest.releaseId = 'v1'
		manifest.files.push({
			path: '_headers',
			source: 'current',
			lastCurrentAt: START,
			bytes: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex'),
		})
		manifest.files.sort((a, b) => (a.path < b.path ? -1 : 1))
	})
	assert.throws(() => verifyRelease(root, 'v1'), /routing control/)
})

test('verified merged artifact serves old tab lazy loads across rollout and rollback with GET/HEAD/cache/404 contracts', async (t) => {
	const root = fixture(t)
	resetBuild(root, 'v1', OLD)
	release(root, 'v1')
	resetBuild(root, 'v2', NEW)
	const result = release(root, 'v2', '2026-09-02T00:00:00Z', { previous: 'v1' })
	let adminCalls = 0
	const env = {
		CINATOKEN_WEB_ACCOUNT_ENABLED: 'false',
		CINATOKEN_ADMIN_SERVICE: {
			async fetch() {
				adminCalls++
				return new Response('Next')
			},
		},
		ASSETS: {
			async fetch(request) {
				const path = new URL(request.url).pathname.slice(1)
				const file = join(result.assets, path)
				return existsSync(file)
					? new Response(readFileSync(file), {
							headers: { 'cache-control': 'wrong', etag: 'fixture-etag' },
						})
					: new Response('missing', {
							status: 404,
							headers: { 'cache-control': IMMUTABLE_CACHE },
						})
			},
		},
	}
	for (const method of ['GET', 'HEAD']) {
		const response = await routeWebRequest(
			new Request(`https://example.com/web-assets/${OLD}?v=1`, { method }),
			env
		)
		assert.equal(response.status, 200)
		assert.equal(response.headers.get('cache-control'), IMMUTABLE_CACHE)
		assert.equal(response.headers.get('etag'), 'fixture-etag')
		assert.equal(await response.text(), method === 'HEAD' ? '' : 'lazy-v1')
	}
	for (const [path, expected] of [
		['index.html', 'no-store'],
		['logo.png', 'no-cache'],
		['LICENSE', 'no-cache'],
		['NOTICE.frontend', 'no-cache'],
		['static/js/missing.11111111.js', 'no-store'],
	]) {
		const response = await routeWebRequest(
			new Request(`https://example.com/web-assets/${path}`),
			env
		)
		assert.equal(response.headers.get('cache-control'), expected)
		if (path.includes('missing')) {
			assert.equal(response.status, 404)
			assert.equal(await response.text(), 'missing')
		}
	}
	assert.equal(adminCalls, 0)
	for (const status of [206, 304]) {
		env.ASSETS.fetch = async () =>
			new Response(status === 304 ? null : 'range', {
				status,
				headers: { 'content-range': 'bytes 0-4/7', etag: 'conditional' },
			})
		const response = await routeWebRequest(
			new Request(`https://example.com/web-assets/${OLD}`),
			env
		)
		assert.equal(response.status, status)
		assert.equal(response.headers.get('cache-control'), IMMUTABLE_CACHE)
		assert.equal(response.headers.get('etag'), 'conditional')
		assert.equal(response.headers.get('content-range'), 'bytes 0-4/7')
	}
})

test('cache policy only treats recognized hashed resources as immutable; HTML and errors never cache', () => {
	for (const status of [200, 206, 304]) {
		assert.equal(assetCacheControl(OLD, status), IMMUTABLE_CACHE)
		for (const path of ['index.html', 'index.HTML', 'page.htm'])
			assert.equal(assetCacheControl(path, status), 'no-store')
		for (const path of [
			'logo.png',
			'app.js',
			'static/data.12345678.json',
			'static/js/app.123.js',
		])
			assert.equal(assetCacheControl(path, status), 'no-cache')
	}
	for (const status of [301, 404, 500, 503])
		assert.equal(assetCacheControl(OLD, status), 'no-store')
})

test('v2 builds freeze a matching source archive and script-free public download index', async (t) => {
	const root = fixture(t)
	resetBuild(root, 'source-a', OLD)
	writeServers(root, 'source-a', 2)
	const result = release(root, 'source-a')
	assert.equal(result.manifest.schemaVersion, 3)
	const delivery = result.manifest.sourceDelivery
	assert.equal(delivery.coverageComplete, true)
	assert.equal(delivery.archives.length, 1)
	const archive = delivery.archives[0]
	assert.equal(archive.path, delivery.currentArchive)
	const content = readFileSync(join(result.assets, archive.path))
	assert.deepEqual(
		verifySourceArchive(content).descriptor.buildContract,
		result.manifest.buildContract
	)
	assert.ok(
		delivery.assetSources.every((mapping) =>
			mapping.archives.includes(archive.path)
		)
	)
	const html = readFileSync(join(result.assets, 'sources/index.html'), 'utf8')
	for (const locale of ['en', 'zh', 'ja', 'ko'])
		assert.ok(html.includes(`lang="${locale}"`))
	assert.ok(html.includes(`/web-assets/${archive.path}`))
	assert.doesNotMatch(html, /<script\b/i)
	assert.deepEqual(
		JSON.parse(readFileSync(join(result.assets, 'sources/index.json'), 'utf8')),
		delivery
	)
	const requests = []
	const ASSETS = {
		fetch: async (request) => {
			requests.push(request)
			return new Response(content, {
				headers: { 'content-type': 'application/gzip' },
			})
		},
	}
	for (const method of ['GET', 'HEAD']) {
		const response = await routeWebRequest(
			new Request(
				`https://gateway.example/web-assets/${archive.path}?download=1`,
				{ method }
			),
			{ ASSETS }
		)
		assert.equal(response.status, 200)
		assert.equal(response.headers.get('cache-control'), IMMUTABLE_CACHE)
		assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
		assert.deepEqual(
			Buffer.from(await response.arrayBuffer()),
			method === 'GET' ? content : Buffer.alloc(0)
		)
	}
	assert.ok(
		requests.every(
			(request) =>
				new URL(request.url).pathname === `/${archive.path}` &&
				!new URL(request.url).search
		)
	)
})

test('legacy retained chunks remain explicitly unresolved instead of acquiring current source', (t) => {
	const root = fixture(t)
	resetBuild(root, 'legacy', OLD)
	writeServers(root, 'legacy')
	release(root, 'legacy')
	resetBuild(root, 'source-b', NEW)
	writeServers(root, 'source-b', 2)
	const next = release(root, 'source-b', '2026-09-02', { previous: 'legacy' })
	const mapping = next.manifest.sourceDelivery.assetSources.find(
		(item) => item.path === OLD
	)
	assert.deepEqual(mapping, { path: OLD, archives: [], unresolved: true })
	assert.equal(next.manifest.sourceDelivery.coverageComplete, false)
	assert.equal(verifyRelease(root, 'legacy').manifest.schemaVersion, 2)
})

test('same-browser releases retain each previous source archive without inventing asset mappings', (t) => {
	const root = fixture(t)
	resetBuild(root, 'same-browser', OLD)
	writeServers(root, 'source-a', 2)
	const a = release(root, 'source-a')
	const original = a.manifest.sourceDelivery.archives[0]
	resetBuild(root, 'same-browser', OLD)
	writeServers(root, 'source-b', 2)
	const b = release(root, 'source-b', '2026-09-02', { previous: 'source-a' })
	assert.deepEqual(
		readFileSync(join(a.assets, OLD)),
		readFileSync(join(b.assets, OLD))
	)
	assert.notEqual(
		a.manifest.sourceDelivery.currentArchive,
		b.manifest.sourceDelivery.currentArchive
	)
	assert.equal(b.manifest.sourceDelivery.archives.length, 2)
	const retained = b.manifest.sourceDelivery.archives.find(
		(item) => item.path === original.path
	)
	assert.deepEqual(retained, { ...original, source: 'retained' })
	assert.deepEqual(
		readFileSync(join(b.assets, original.path)),
		readFileSync(join(a.assets, original.path))
	)
	assert.equal(
		b.manifest.files.find((file) => file.path === original.path).lastCurrentAt,
		START
	)
	assert.equal(
		b.manifest.files.find((file) => file.path === OLD).source,
		'current'
	)
	assert.deepEqual(b.manifest.sourceDelivery.assetSources, [
		{
			path: OLD,
			archives: [b.manifest.sourceDelivery.currentArchive],
			unresolved: false,
		},
	])
	assert.equal(b.manifest.sourceDelivery.coverageComplete, true)
	const current = b.manifest.sourceDelivery.archives.find(
		(item) => item.path === b.manifest.sourceDelivery.currentArchive
	)
	assert.equal(current.source, 'current')
	assert.equal(current.lastCurrentAt, b.manifest.createdAt)
	assert.deepEqual(current.buildContract, b.manifest.buildContract)
	assert.ok(
		readFileSync(join(b.assets, 'sources/index.html'), 'utf8').includes(
			`/web-assets/${original.path}`
		)
	)
	assert.doesNotThrow(() => verifyRelease(root, 'source-b'))
	// Recompose only verified artifacts; unbuilt working-tree source must be ignored.
	writeFileSync(join(root, 'packages/core/src/fixture.ts'), 'unbuilt input\n')
	const restored = release(root, 'source-restored', '2026-09-03', {
		previous: 'source-b',
		currentRelease: 'source-a',
	})
	assert.equal(restored.manifest.sourceDelivery.currentArchive, original.path)
	assert.deepEqual(restored.manifest.buildContract, a.manifest.buildContract)
	assert.equal(restored.manifest.sourceDelivery.archives.length, 2)
	const newer = restored.manifest.sourceDelivery.archives.find(
		(item) => item.path === current.path
	)
	assert.deepEqual(newer, { ...current, source: 'retained' })
	assert.deepEqual(
		readFileSync(join(restored.assets, newer.path)),
		readFileSync(join(b.assets, newer.path))
	)
	assert.deepEqual(restored.manifest.sourceDelivery.assetSources, [
		{ path: OLD, archives: [original.path], unresolved: false },
	])
	assert.doesNotThrow(() => verifyRelease(root, 'source-restored'))
})

test('source archives remain downloadable through their exact cutoff without renewing their age', (t) => {
	const root = fixture(t)
	resetBuild(root, 'same-browser', OLD)
	writeServers(root, 'source-a', 2)
	const a = release(root, 'source-a')
	const original = a.manifest.sourceDelivery.archives[0]
	resetBuild(root, 'same-browser', OLD)
	writeServers(root, 'source-b', 2)
	release(root, 'source-b', '2026-09-02', {
		previous: 'source-a',
		retentionDays: 2,
	})
	const cutoff = release(root, 'source-cutoff', '2026-09-03', {
		previous: 'source-b',
		currentRelease: 'source-b',
		retentionDays: 2,
	})
	assert.equal(
		cutoff.manifest.sourceDelivery.archives.find(
			(item) => item.path === original.path
		)?.lastCurrentAt,
		START
	)
	assert.equal(
		cutoff.manifest.files.find((item) => item.path === original.path)?.source,
		'retained'
	)
	assert.deepEqual(
		readFileSync(join(cutoff.assets, original.path)),
		readFileSync(join(a.assets, original.path))
	)
	const expired = release(root, 'source-expired', '2026-09-03T00:00:00.001Z', {
		previous: 'source-cutoff',
		currentRelease: 'source-cutoff',
		retentionDays: 2,
	})
	assert.equal(
		expired.manifest.sourceDelivery.archives.some(
			(item) => item.path === original.path
		),
		false
	)
	assert.equal(
		expired.manifest.files.some((item) => item.path === original.path),
		false
	)
	assert.equal(existsSync(join(expired.assets, original.path)), false)
	assert.equal(expired.manifest.sourceDelivery.archives.length, 1)
	assert.equal(
		expired.manifest.files.find((item) => item.path === OLD).source,
		'current'
	)
	assert.equal(expired.manifest.sourceDelivery.coverageComplete, true)
	assert.doesNotThrow(() => verifyRelease(root, 'source-expired'))
})

test('a previous source archive with no hashed assets is retained independently of coverage', (t) => {
	const root = fixture(t)
	write(root, 'index.html', '<html>source-only build</html>')
	writeServers(root, 'source-only', 2)
	const original = release(root, 'source-only')
	assert.deepEqual(original.manifest.sourceDelivery.assetSources, [])
	const archive = original.manifest.sourceDelivery.archives[0]
	resetBuild(root, 'next', NEW)
	writeServers(root, 'next', 2)
	const next = release(root, 'next', '2026-09-02', { previous: 'source-only' })
	assert.deepEqual(
		next.manifest.sourceDelivery.archives.find(
			(item) => item.path === archive.path
		),
		{ ...archive, source: 'retained' }
	)
	assert.equal(
		next.manifest.sourceDelivery.assetSources.some((mapping) =>
			mapping.archives.includes(archive.path)
		),
		false
	)
	assert.deepEqual(
		readFileSync(join(next.assets, archive.path)),
		readFileSync(join(original.assets, archive.path))
	)
	assert.doesNotThrow(() => verifyRelease(root, 'next'))
	const delivery = structuredClone(next.manifest.sourceDelivery)
	const files = structuredClone(next.manifest.files)
	const independentlyRetained = delivery.archives.find(
		(item) => item.path === archive.path
	)
	const asset = files.find((item) => item.path === archive.path)
	for (const item of [independentlyRetained, asset]) {
		item.source = 'current'
		item.lastCurrentAt = next.manifest.createdAt
	}
	assert.throws(
		() =>
			verifySourceDelivery(delivery, {
				assets: next.assets,
				files,
				buildContract: next.manifest.buildContract,
				createdAt: next.manifest.createdAt,
				retentionDays: next.manifest.retentionDays,
			}),
		/Source archive asset binding mismatch/
	)
})

test('independently retained source archives do not resolve an unknown legacy asset', (t) => {
	const root = fixture(t)
	resetBuild(root, 'legacy', OLD)
	writeServers(root, 'legacy')
	release(root, 'legacy')
	resetBuild(root, 'same-browser', NEW)
	writeServers(root, 'source-a', 2)
	const a = release(root, 'source-a', '2026-09-02', { previous: 'legacy' })
	resetBuild(root, 'same-browser', NEW)
	writeServers(root, 'source-b', 2)
	const b = release(root, 'source-b', '2026-09-03', { previous: 'source-a' })
	assert.equal(b.manifest.sourceDelivery.archives.length, 2)
	assert.ok(
		b.manifest.sourceDelivery.archives.some(
			(item) =>
				item.path === a.manifest.sourceDelivery.currentArchive &&
				item.source === 'retained'
		)
	)
	assert.deepEqual(
		b.manifest.sourceDelivery.assetSources.find((item) => item.path === OLD),
		{ path: OLD, archives: [], unresolved: true }
	)
	assert.equal(b.manifest.sourceDelivery.coverageComplete, false)
	assert.doesNotThrow(() => verifyRelease(root, 'source-b'))
})

test('retained source archives keep original timestamps and expire with their chunks', (t) => {
	const root = fixture(t)
	resetBuild(root, 'source-a', OLD)
	writeServers(root, 'source-a', 2)
	const a = release(root, 'source-a')
	const original = a.manifest.sourceDelivery.archives[0]
	resetBuild(root, 'source-b', NEW)
	writeServers(root, 'source-b', 2)
	const b = release(root, 'source-b', '2026-09-02', {
		previous: 'source-a',
		retentionDays: 2,
	})
	const retained = b.manifest.sourceDelivery.archives.find(
		(item) => item.path === original.path
	)
	assert.equal(retained.source, 'retained')
	assert.equal(retained.lastCurrentAt, START)
	assert.deepEqual(
		readFileSync(join(b.assets, retained.path)),
		readFileSync(join(a.assets, retained.path))
	)
	const c = release(root, 'source-c', '2026-09-04', {
		previous: 'source-b',
		retentionDays: 2,
	})
	assert.equal(
		c.manifest.files.some(
			(file) => file.path === OLD || file.path === original.path
		),
		false
	)
	assert.equal(c.manifest.sourceDelivery.archives.length, 1)
})

test('rollback copies its historical server and matching source, without rebuilding from live inputs', (t) => {
	const root = fixture(t)
	resetBuild(root, 'source-a', OLD)
	writeServers(root, 'source-a', 2)
	const a = release(root, 'source-a')
	resetBuild(root, 'source-b', NEW)
	writeServers(root, 'source-b', 2)
	const b = release(root, 'source-b', '2026-09-02', { previous: 'source-a' })
	writeFileSync(
		join(root, 'packages/core/src/fixture.ts'),
		'new unbuilt input\n'
	)
	const rollback = release(root, 'source-rollback', '2026-09-03', {
		previous: 'source-b',
		currentRelease: 'source-a',
	})
	assert.deepEqual(rollback.manifest.buildContract, a.manifest.buildContract)
	assert.equal(
		rollback.manifest.sourceDelivery.currentArchive,
		a.manifest.sourceDelivery.currentArchive
	)
	assert.deepEqual(
		readFileSync(join(rollback.server, 'node/index.mjs')),
		readFileSync(join(a.server, 'node/index.mjs'))
	)
	assert.ok(
		rollback.manifest.sourceDelivery.archives.some(
			(item) =>
				item.path === b.manifest.sourceDelivery.currentArchive &&
				item.source === 'retained'
		)
	)
	assert.equal(rollback.manifest.currentReleaseId, 'source-a')
})

test('rollback to a legacy build reports unavailable current source while retaining known new chunks', (t) => {
	const root = fixture(t)
	resetBuild(root, 'legacy', OLD)
	writeServers(root, 'legacy')
	release(root, 'legacy')
	resetBuild(root, 'source-b', NEW)
	writeServers(root, 'source-b', 2)
	release(root, 'source-b', '2026-09-02', { previous: 'legacy' })
	const rollback = release(root, 'rollback-legacy', '2026-09-03', {
		previous: 'source-b',
		currentRelease: 'legacy',
	})
	assert.equal(rollback.manifest.schemaVersion, 3)
	assert.equal(rollback.manifest.sourceDelivery.currentArchive, null)
	assert.equal(rollback.manifest.sourceDelivery.coverageComplete, false)
	assert.equal(rollback.manifest.sourceDelivery.archives.length, 1)
	assert.equal(rollback.manifest.sourceDelivery.archives[0].source, 'retained')
})

test('rollback to an empty legacy shell remains verifiable after all mapped sources expire', (t) => {
	const root = fixture(t)
	write(root, 'index.html', '<html>legacy shell</html>')
	release(root, 'legacy-empty')
	resetBuild(root, 'source-b', NEW)
	writeServers(root, 'source-b', 2)
	release(root, 'source-b', '2026-09-02', { previous: 'legacy-empty' })
	const rollback = release(root, 'rollback-empty', '2026-09-20', {
		previous: 'source-b',
		currentRelease: 'legacy-empty',
	})
	assert.equal(rollback.manifest.schemaVersion, 3)
	assert.equal(rollback.manifest.sourceDelivery.currentArchive, null)
	assert.equal(rollback.manifest.sourceDelivery.coverageComplete, false)
	assert.deepEqual(rollback.manifest.sourceDelivery.archives, [])
	assert.deepEqual(rollback.manifest.sourceDelivery.assetSources, [])
})

for (const [name, mutate] of [
	[
		'current binding',
		(delivery) => {
			delivery.currentArchive = null
		},
	],
	[
		'false completeness',
		(delivery) => {
			delivery.coverageComplete = false
		},
	],
	[
		'missing mapping',
		(delivery) => {
			delivery.assetSources = []
		},
	],
	[
		'missing archive',
		(delivery) => {
			delivery.archives = []
		},
	],
	[
		'wrong archive metadata',
		(delivery) => {
			delivery.archives[0].fileCount += 1
		},
	],
	[
		'unknown mapped archive',
		(delivery) => {
			delivery.assetSources[0].archives = [
				'sources/web.' + '0'.repeat(64) + '.tar.gz',
			]
		},
	],
]) {
	test(`source verification rejects rehashed release metadata with ${name}`, (t) => {
		const root = fixture(t)
		resetBuild(root, 'source-a', OLD)
		writeServers(root, 'source-a', 2)
		const result = release(root, 'source-a')
		resign(result.directory, (manifest) => mutate(manifest.sourceDelivery))
		assert.throws(() => verifyRelease(root, 'source-a'))
	})
}

test('source verification rejects modified public index even with an updated outer manifest digest', (t) => {
	const root = fixture(t)
	resetBuild(root, 'source-a', OLD)
	writeServers(root, 'source-a', 2)
	const result = release(root, 'source-a')
	const replacement = Buffer.from('<html>fake source download</html>')
	writeFileSync(join(result.assets, 'sources/index.html'), replacement)
	resign(result.directory, (manifest) => {
		const file = manifest.files.find(
			(item) => item.path === 'sources/index.html'
		)
		file.bytes = replacement.length
		file.sha256 = createHash('sha256').update(replacement).digest('hex')
	})
	assert.throws(() => verifyRelease(root, 'source-a'), /source index/)
})
