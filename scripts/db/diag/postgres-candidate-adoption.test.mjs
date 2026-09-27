import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import { postgresCandidateAdoption, auditCandidateBundle, auditWranglerCandidate } from './postgres-candidate-adoption.mjs';
import { sourcePins, sha256 } from './postgres-transaction-retirement.mjs';
import { proxyNodeBuildOptions, assertNoWorkspaceExternals } from '../../../packages/proxy/scripts/build.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureRoot = join(root, 'scripts/db/diag/fixtures');
const run = promisify(execFile);
const protectedNames = ['package-lock.json', 'pnpm-lock.yaml', 'node_modules/postgres/package.json',
  'packages/core/package.json', 'packages/core/dist/index.js', 'packages/proxy/package.json', 'packages/proxy/wrangler.jsonc',
  ...Object.values(sourcePins).flatMap(pin => ['node_modules/postgres/' + pin.entry, 'node_modules/postgres/' + pin.entry.replace('index.js', 'connection.js')])];
const fingerprints = async () => Object.fromEntries(await Promise.all(protectedNames.map(async name => [name, sha256(await readFile(join(root, name)))])));
const osEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|pathext|systemroot|windir|temp|tmp|comspec)$/i.test(name)));
const coreOptions = outfile => ({ absWorkingDir: root, entryPoints: [join(root, 'packages/core/src/index.ts')], outfile,
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', metafile: true });

test('candidate adoption guards are explicit and reject metadata bypasses', async () => {
  assert.deepEqual(await postgresCandidateAdoption(), { plugins: [], candidate: null });
  await assert.rejects(postgresCandidateAdoption({ enabled: 'true', target: 'node' }), /boolean/);
  await assert.rejects(postgresCandidateAdoption({ enabled: true }), /target/);
  const valid = { inputs: { 'postgres-evaluation:esm': { imports: [] } },
    outputs: { 'app.mjs': { imports: [], inputs: { 'postgres-evaluation:esm': { bytesInOutput: 100 } } } } };
  const options = { target: 'node', loaded: ['esm'] };
  assert.deepEqual(auditCandidateBundle(valid, options), { target: 'node', variants: ['esm'] });
  assert.throws(() => auditCandidateBundle(valid, { target: 'workers', loaded: ['esm'] }), /Wrong/);
  assert.throws(() => auditCandidateBundle(valid, { ...options, loaded: [] }), /bypassed/);
  const external = structuredClone(valid); external.outputs['app.mjs'].imports.push({ path: 'postgres', external: true });
  assert.throws(() => auditCandidateBundle(external, options), /External/);
  external.outputs['app.mjs'].imports[0].path = 'drizzle-orm/postgres-js';
  assert.throws(() => auditCandidateBundle(external, options), /External/);
  const vendor = structuredClone(valid); vendor.inputs['node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js'] = { imports: [] };
  assert.throws(() => auditCandidateBundle(vendor, options), /Unpatched/);
  const removed = structuredClone(valid); removed.outputs['app.mjs'].inputs = {};
  assert.throws(() => auditCandidateBundle(removed, options), /eliminated/);
  assert.throws(() => auditWranglerCandidate(valid, { artifact: { path: join(root, 'absent.mjs') }, workingDirectory: root }), /did not consume/);
});

test('actual core/proxy build entry adoption and asynchronous app factory wire suite', { timeout: 60000 }, async t => {
  const before = await fingerprints();
  t.after(async () => assert.deepEqual(await fingerprints(), before, 'installed driver, dist, defaults and locks untouched'));
  const parent = join(root, '.wrangler/staging'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'postgres-adoption-v300-'));
  const report = { directory, before, tests: {}, artifacts: {}, boundaries: { deployed: false, nativePostgres: false, workersRuntime: false } };
  t.after(async () => { await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2)); t.diagnostic('adoption report: ' + directory); });
  const pkg = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8'));
  assert.equal(pkg.scripts['build:node-index'], 'esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.js --packages=external --log-level=warning');
  const adopted = await postgresCandidateAdoption({ enabled: true, target: 'node' });
  report.candidate = adopted.candidate;

  const saveBuild = async (name, options) => {
    const result = await build(options);
    await writeFile(join(directory, name + '-meta.json'), JSON.stringify(result.metafile, null, 2));
    const inputs = Object.keys(result.metafile.inputs);
    const inputHashes = Object.fromEntries(await Promise.all(inputs.filter(name => !name.startsWith('postgres-evaluation:'))
      .map(async name => [name, sha256(await readFile(resolve(root, name)))])));
    report.artifacts[name] = { path: options.outfile, sha256: sha256(await readFile(options.outfile)), inputs, inputHashes };
    return result;
  };
  await t.test('default-disabled core build is byte-identical; enabled build contains candidate', async () => {
    const baseline = await saveBuild('core-baseline', coreOptions(join(directory, 'core-baseline.mjs')));
    await saveBuild('core-disabled', { ...coreOptions(join(directory, 'core-disabled.mjs')), plugins: (await postgresCandidateAdoption()).plugins });
    assert.equal(report.artifacts['core-baseline'].sha256, report.artifacts['core-disabled'].sha256);
    assert.ok(Object.values(baseline.metafile.outputs).some(output => output.imports.some(item => item.path === 'postgres' && item.external)));
    await saveBuild('core-enabled', { ...coreOptions(join(directory, 'core-enabled.mjs')), plugins: adopted.plugins });
    await saveBuild('core-repeated', { ...coreOptions(join(directory, 'core-repeated.mjs')), plugins: adopted.plugins });
    assert.equal(report.artifacts['core-enabled'].sha256, report.artifacts['core-repeated'].sha256);
  });
  await t.test('explicit CommonJS/Workers branches and missing audit guard', async () => {
    const cjs = await build({ ...coreOptions(join(directory, 'cjs-selection.cjs')), entryPoints: undefined, format: 'cjs', write: false,
      stdin: { contents: "module.exports = require('postgres')", resolveDir: root }, plugins: adopted.plugins });
    assert.ok(cjs.metafile.inputs['postgres-evaluation:cjs']);
    await assert.rejects(build({ ...coreOptions(join(directory, 'unaudited.mjs')), metafile: false, write: false, plugins: adopted.plugins }), /requires metafile/);
    const workerSelection = await postgresCandidateAdoption({ enabled: true, target: 'workers' });
    const cf = await build({ entryPoints: undefined, write: false, bundle: true, platform: 'neutral', format: 'esm', logLevel: 'silent', metafile: true,
      external: ['node:*', 'cloudflare:sockets'], stdin: { contents: "export { default } from 'postgres'", resolveDir: root }, plugins: workerSelection.plugins });
    assert.ok(cf.metafile.inputs['postgres-evaluation:cf']);
    assert.equal(workerSelection.candidate.artifacts.esm.sha256, adopted.candidate.artifacts.esm.sha256);
    report.repeatedCandidate = workerSelection.candidate.directory;
  });
  await t.test('actual proxy Node options preserve default bytes and honor explicit plugin order', async () => {
    const outputFile = join(directory, 'proxy-default.mjs');
    const defaultOptions = { ...proxyNodeBuildOptions({ outputFile }), absWorkingDir: root, metafile: true, logLevel: 'silent' };
    const baseline = await saveBuild('proxy-default', defaultOptions);
    // Independent pre-refactor options oracle, including its original externalizer behavior.
    const legacy = { entryPoints: [join(root, 'packages/proxy/src/runtime/node.ts')], bundle: true, platform: 'node', format: 'esm',
      outfile: join(directory, 'proxy-legacy.mjs'), absWorkingDir: root, logLevel: 'silent', metafile: true,
      plugins: [{ name: 'legacy-externalizer', setup(b) { b.onResolve({ filter: /^[^./]/ }, args => {
        if (args.kind === 'entry-point' || args.path.startsWith('@octafuse/')) return;
        return { path: args.path, external: true };
      }); } }] };
    await saveBuild('proxy-legacy', legacy);
    assert.equal(report.artifacts['proxy-default'].sha256, report.artifacts['proxy-legacy'].sha256);
    assert.ok(Object.keys(baseline.metafile.inputs).some(name => name.replaceAll('\\', '/').endsWith('packages/core/dist/index.js')));
    const enabledOptions = { ...proxyNodeBuildOptions({ outputFile: join(directory, 'proxy-enabled.mjs'), beforePlugins: adopted.plugins }),
      absWorkingDir: root, logLevel: 'silent', metafile: true };
    await saveBuild('proxy-enabled', enabledOptions);
    assertNoWorkspaceExternals(await readFile(enabledOptions.outfile, 'utf8'));
    await assert.rejects(build({ ...defaultOptions, write: false, plugins: [...defaultOptions.plugins, ...adopted.plugins] }), /bypassed|External/);
    await assert.rejects(build({ ...coreOptions(join(directory, 'unsupported.mjs')), entryPoints: undefined, write: false,
      stdin: { contents: "import x from 'postgres/unsupported'; export default x", resolveDir: root }, plugins: adopted.plugins }), /Unsupported.*subpath/);
  });
  await t.test('fresh staged core feeds full Node proxy without overwriting shared dist', async () => {
    const stagedCoreRoot = { name: 'evaluation-fresh-core-root', setup(b) {
      b.onResolve({ filter: /^@octafuse\/core$/ }, () => ({ path: report.artifacts['core-baseline'].path }));
    } };
    const options = { ...proxyNodeBuildOptions({ outputFile: join(directory, 'proxy-fresh-core.mjs'),
      beforePlugins: [stagedCoreRoot, ...adopted.plugins] }), absWorkingDir: root, logLevel: 'silent', metafile: true };
    const result = await saveBuild('proxy-fresh-core', options);
    const inputPaths = Object.keys(result.metafile.inputs).map(name => resolve(root, name));
    assert.ok(inputPaths.includes(report.artifacts['core-baseline'].path));
    assert.ok(!inputPaths.includes(join(root, 'packages/core/dist/index.js')));
    assertNoWorkspaceExternals(await readFile(options.outfile, 'utf8'));
    report.nodeFreshCoreOverride = 'scratch core build substitutes only @octafuse/core root; production exports unchanged';
  });
  const subprocess = async (name, paths, expected, env = {}) => {
    try {
      const result = await run(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', ...paths],
        { cwd: root, env: { ...osEnv(), ...env }, timeout: 18000, maxBuffer: 512 * 1024, windowsHide: true });
      await writeFile(join(directory, name + '.tap'), result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp('# tests ' + expected + '\\b')); assert.match(result.stdout, /# fail 0\b/);
      report.tests[name] = { pass: expected, fail: 0, durationMs: Number(result.stdout.match(/# duration_ms ([\d.]+)/)?.[1]) };
    } catch (error) {
      await writeFile(join(directory, name + '.tap'), (error.stdout ?? '') + (error.stderr ?? '') + String(error));
      report.tests[name] = { failed: true }; t.diagnostic(error.stdout ?? ''); t.diagnostic(error.stderr ?? ''); throw error;
    }
  };
  await t.test('core public database factory runs all 60 transaction wire cases after real session initialization', async () => {
    const modulePath = pathToFileURL(report.artifacts['core-enabled'].path).href;
    const wrapper = join(directory, 'core-factory.mjs');
    await build({ stdin: { contents: `import { createPostgresDatabaseClient } from ${JSON.stringify(modulePath)};
      export default async options => (await createPostgresDatabaseClient('postgres://synthetic:synthetic@127.0.0.1:' + options.port + '/synthetic', options)).raw;`,
      resolveDir: directory }, bundle: false, platform: 'node', format: 'esm', outfile: wrapper, logLevel: 'silent' });
    await subprocess('core-factory-wire', ['packages/core/src/storage/recovery/postgres-transaction-retirement.wire.test.mjs',
      'packages/core/src/storage/recovery/postgres-transaction-reservation.wire.test.mjs',
      'packages/core/src/storage/recovery/postgres-transaction-completion.wire.test.mjs',
      'packages/core/src/storage/recovery/postgres-write-failure.wire.test.mjs'], 60,
      { GATEWAY_POSTGRES_RECOVERY_DRIVER: wrapper, GATEWAY_POSTGRES_FACTORY_INITIALIZES_SESSION: '1' });
  });
  await t.test('core public initialization retains cleanup/error/no-replay behavior', () => subprocess('core-initialization-wire',
    ['packages/core/src/storage/postgres-initialization-wire.test.mjs'], 7, { PG_INIT_V249_BASELINE: report.artifacts['core-enabled'].path }));

  await t.test('actual Wrangler dry-run consumes CF candidate via explicit alias with no network', { timeout: 20000 }, async () => {
    const configPath = join(fixtureRoot, 'wrangler.postgres-adoption.jsonc');
    const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
    assert.deepEqual(Object.keys(config).sort(), ['$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'preview_urls', 'routes', 'send_metrics'].sort());
    assert.equal(resolve(dirname(configPath), config.main), join(root, 'packages/proxy/src/index.ts'));
    assert.deepEqual(config.routes, []); assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false); assert.equal(config.send_metrics, false);
    const liveConfig = await readFile(join(root, 'packages/proxy/wrangler.jsonc'), 'utf8');
    assert.equal(config.compatibility_date, liveConfig.match(/"compatibility_date"\s*:\s*"([^"]+)"/)[1]);
    assert.deepEqual(config.compatibility_flags, JSON.parse(liveConfig.match(/"compatibility_flags"\s*:\s*(\[[^\]]+\])/)[1]));
    const workerDir = join(directory, 'worker'); await mkdir(workerDir);
    const metafilePath = join(workerDir, 'meta.json');
    const env = { ...osEnv(), WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
      WRANGLER_LOG_PATH: join(workerDir, 'logs'), XDG_CONFIG_HOME: join(workerDir, 'config'), CI: 'true' };
    const artifact = adopted.candidate.artifacts.cf;
    const args = ['--require', join(fixtureRoot, 'offline-build.cjs'), join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'deploy', '--dry-run', '--config', configPath, '--env-file', join(fixtureRoot, 'build-only.env'),
      '--outdir', workerDir, '--metafile', metafilePath, '--alias', 'postgres:' + artifact.path];
    let result;
    try { result = await run(process.execPath, args, { cwd: root, env, timeout: 18000, maxBuffer: 256 * 1024, windowsHide: true }); }
    catch (error) { await writeFile(join(workerDir, 'output.txt'), (error.stdout ?? '') + (error.stderr ?? '') + String(error)); throw error; }
    await writeFile(join(workerDir, 'output.txt'), result.stdout + result.stderr);
    assert.match(result.stdout, /dry-run.*exiting/i); assert.doesNotMatch(result.stdout + result.stderr, /OFFLINE_BUILD_NETWORK_DISABLED/);
    const metadata = JSON.parse(await readFile(metafilePath, 'utf8'));
    // Wrangler's metafile is relative to the config directory, not the process cwd.
    report.worker = auditWranglerCandidate(metadata, { artifact, workingDirectory: dirname(configPath) });
    assert.equal(sha256(await readFile(artifact.path)), artifact.sha256);
    assert.ok(Object.keys(metadata.inputs).some(name => name.replaceAll('\\', '/').endsWith('packages/proxy/src/index.ts')));
    const output = await readFile(join(workerDir, 'index.js'), 'utf8');
    assert.ok(output.includes('cloudflare:sockets')); assert.ok(output.includes('transactionClosed'));
    assert.match(output, /!(connection\d*)\.reserved && onopen\(\1\)/);
    report.worker.sha256 = sha256(output); report.worker.args = args; report.worker.networkGuard = true;
  });
});
