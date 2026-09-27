import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { build, version as esbuildVersion } from 'esbuild';
import { postgresCandidateAdoption, auditCandidateBundle, auditWranglerCandidate } from './postgres-candidate-adoption.mjs';
import { buildRetirementCandidates, sourcePins, sha256 } from './postgres-transaction-retirement.mjs';
import { queryPins } from './postgres-owned-cancellation.mjs';
import { proxyNodeBuildOptions, assertNoWorkspaceExternals } from '../../../packages/proxy/scripts/build.mjs';
import { postgresInitializationPeer, assertOneClosedInitialization } from '../../../packages/core/src/test-support/postgres-initialization-peer.mjs';

// The CF artifact is imported only to inspect its factory. Any attempted
// Cloudflare socket is rejected inside this local test process.
const socketModule = 'data:text/javascript,' + encodeURIComponent(
  'export const connect = () => { throw new Error("v308 attempted a Cloudflare socket") }',
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'cloudflare:sockets'
      ? { url: socketModule, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureRoot = join(root, 'scripts/db/diag/fixtures');
const frozen = JSON.parse(await readFile(join(root,
  'docs/developers/architecture/implementation-evidence/C03-postgres-controlled-recovery-scan-v307-results.json'), 'utf8'));
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const osEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(path|pathext|systemroot|windir|temp|tmp|comspec)$/i.test(name)));
const coreOptions = outfile => ({ absWorkingDir: root,
  entryPoints: [join(root, 'packages/core/src/index.ts')], outfile,
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  logLevel: 'silent', metafile: true });

test('v308 explicit v307 adoption is isolated, pinned and default-disabled', { timeout: 120000 }, async t => {
  assert.equal(frozen.version, 'v307');
  const protectedBefore = frozen.protectedInputSha256;
  assert.equal(Object.keys(protectedBefore).length, 16);
  for (const [name, hash] of Object.entries(protectedBefore))
    assert.equal(sha256(await readFile(join(root, name))), hash, name + ' remains pinned');
  await mkdir(join(root, '.wrangler/staging'), { recursive: true });
  const directory = await mkdtemp(join(root, '.wrangler/staging/postgres-adoption-v308-'));
  const report = { version: 'v308', directory, status: 'INCOMPLETE', tests: {},
    boundaries: { deployed: false, remoteSql: false, workersRuntime: false,
      nativePostgres: false, fullBundleAliasOnly: true } };
  t.after(async () => {
    for (const [name, hash] of Object.entries(protectedBefore))
      assert.equal(sha256(await readFile(join(root, name))), hash, name + ' untouched');
    await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2));
    t.diagnostic('v308 adoption report: ' + directory);
  });

  let v300Esm;
  await t.test('disabled and historical v300 behavior do not select v307', async () => {
    assert.deepEqual(await postgresCandidateAdoption(), { plugins: [], candidate: null });
    assert.deepEqual(await postgresCandidateAdoption({ enabled: false, target: 'workers', candidateRevision: 'v307' }),
      { plugins: [], candidate: null });
    await assert.rejects(postgresCandidateAdoption({ enabled: 'true', target: 'node' }), /boolean/);
    await assert.rejects(postgresCandidateAdoption({ enabled: true, candidateRevision: 'v307' }), /target/);
    await assert.rejects(postgresCandidateAdoption({ enabled: true, target: 'node', candidateRevision: 'v308' }), /revision/);
    const historical = await postgresCandidateAdoption({ enabled: true, target: 'node' });
    v300Esm = historical.candidate.artifacts.esm;
    const oracle = await buildRetirementCandidates({ lifecycle: 'completed', writeFailure: 'retire' });
    assert.equal(historical.candidate.lifecycle, 'completed');
    assert.equal(historical.candidate.writeFailure, 'retire');
    for (const variant of ['esm', 'cjs', 'cf']) {
      assert.equal(historical.candidate.artifacts[variant].sha256, oracle.artifacts[variant].sha256);
      assert.notEqual(historical.candidate.artifacts[variant].sha256, frozen.artifactSha256[variant]);
    }
    report.tests.defaultV300 = true;
  });

  const node = await postgresCandidateAdoption({ enabled: true, target: 'node', candidateRevision: 'v307' });
  const workers = await postgresCandidateAdoption({ enabled: true, target: 'workers', candidateRevision: 'v307' });
  await t.test('artifact changes and stale v300 substitution fail before a candidate bundle is usable', async () => {
    const changed = await postgresCandidateAdoption({ enabled: true, target: 'node', candidateRevision: 'v307' });
    changed.candidate.artifacts.esm = { ...changed.candidate.artifacts.esm, sha256: '0'.repeat(64) };
    await assert.rejects(build({ absWorkingDir: root, write: false, bundle: true,
      platform: 'node', format: 'esm', logLevel: 'silent', metafile: true,
      stdin: { contents: "export { default } from 'postgres'", resolveDir: root },
      plugins: changed.plugins }), /Candidate artifact changed/);
    const stale = await postgresCandidateAdoption({ enabled: true, target: 'node', candidateRevision: 'v307' });
    stale.candidate.artifacts.esm = { ...v300Esm };
    await assert.rejects(build({ absWorkingDir: root, write: false, bundle: true,
      platform: 'node', format: 'esm', logLevel: 'silent', metafile: true,
      stdin: { contents: "export { default } from 'postgres'", resolveDir: root },
      plugins: stale.plugins }), /Frozen controlled recovery scan artifact changed/);
    report.tests.artifactAndStaleRejection = true;
  });
  await t.test('v307 source pins, frozen artifacts and actual three factories agree', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'node_modules/postgres/package.json'), 'utf8'));
    assert.equal(pkg.version, '3.4.9');
    assert.equal(esbuildVersion, '0.27.3');
    for (const [variant, pin] of Object.entries(sourcePins)) {
      const source = dirname(join(root, 'node_modules/postgres', pin.entry));
      assert.equal(sha256(await readFile(join(source, 'index.js'))), pin.sha256);
      assert.equal(sha256(await readFile(join(source, 'connection.js'))), pin.connection);
      assert.equal(sha256(await readFile(join(source, 'query.js'))), queryPins[variant]);
      const artifact = node.candidate.artifacts[variant];
      assert.equal(artifact.sha256, frozen.artifactSha256[variant]);
      assert.equal(workers.candidate.artifacts[variant].sha256, artifact.sha256);
      assert.equal(sha256(await readFile(artifact.path)), artifact.sha256);
      const factory = (await import(pathToFileURL(artifact.path).href)).default;
      assert.equal(typeof factory, 'function');
      let socketCalls = 0;
      const raw = factory({ host: '127.0.0.1', port: 1, database: 'synthetic',
        username: 'synthetic', password: 'synthetic', ssl: false,
        fetch_types: false, prepare: false, max: 1,
        socket: () => { socketCalls++; throw new Error('v308 unexpected socket'); } });
      assert.equal(raw.ownedCancellation, 'postgres-js-3.4.9-owned-cancel-v302');
      assert.equal(raw.ownedRecoveryScanFence, 'postgres-js-3.4.9-owned-scan-v307');
      assert.equal(socketCalls, 0);
      await raw.end({ timeout: 0 });
    }
    report.artifactSha256 = Object.fromEntries(Object.entries(node.candidate.artifacts)
      .map(([variant, artifact]) => [variant, artifact.sha256]));
    report.tests.pinsAndFactories = true;
  });

  await t.test('Node ESM/CJS selections and actual scratch core/proxy builds stay audited', async () => {
    const baseline = join(directory, 'core-default.mjs');
    const disabled = join(directory, 'core-disabled.mjs');
    const enabled = join(directory, 'core-v307.mjs');
    const repeated = join(directory, 'core-v307-repeat.mjs');
    const baselineBuild = await build(coreOptions(baseline));
    await build({ ...coreOptions(disabled), plugins: (await postgresCandidateAdoption()).plugins });
    assert.equal(sha256(await readFile(baseline)), sha256(await readFile(disabled)));
    assert.ok(Object.values(baselineBuild.metafile.outputs).some(output =>
      output.imports.some(item => item.path === 'postgres' && item.external)));
    const selected = await build({ ...coreOptions(enabled), plugins: node.plugins });
    await build({ ...coreOptions(repeated), plugins: node.plugins });
    assert.equal(sha256(await readFile(enabled)), sha256(await readFile(repeated)));
    assert.deepEqual(auditCandidateBundle(selected.metafile, { target: 'node', loaded: ['esm'] }),
      { target: 'node', variants: ['esm'] });
    await assert.rejects(build({ ...coreOptions(join(directory, 'missing-audit.mjs')),
      metafile: false, write: false, plugins: node.plugins }), /metafile/);

    const cjsPath = join(directory, 'node-cjs.cjs');
    const cjs = await build({ absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs',
      outfile: cjsPath, logLevel: 'silent', metafile: true,
      stdin: { contents: "module.exports = require('postgres')", resolveDir: root }, plugins: node.plugins });
    assert.deepEqual(auditCandidateBundle(cjs.metafile, { target: 'node', loaded: ['cjs'] }),
      { target: 'node', variants: ['cjs'] });
    const cjsFactory = require(cjsPath);
    assert.equal(typeof cjsFactory, 'function');
    const cjsRaw = cjsFactory({ host: '127.0.0.1', port: 1, database: 'synthetic',
      username: 'synthetic', password: 'synthetic', ssl: false, fetch_types: false, max: 1 });
    assert.equal(cjsRaw.ownedRecoveryScanFence, 'postgres-js-3.4.9-owned-scan-v307');
    await cjsRaw.end({ timeout: 0 });

    const proxyDefault = join(directory, 'proxy-default.mjs');
    const proxyDisabled = join(directory, 'proxy-disabled.mjs');
    const proxyEnabled = join(directory, 'proxy-v307.mjs');
    await build({ ...proxyNodeBuildOptions({ outputFile: proxyDefault }), absWorkingDir: root,
      metafile: true, logLevel: 'silent' });
    await build({ ...proxyNodeBuildOptions({ outputFile: proxyDisabled,
      beforePlugins: (await postgresCandidateAdoption()).plugins }), absWorkingDir: root,
      metafile: true, logLevel: 'silent' });
    assert.equal(sha256(await readFile(proxyDefault)), sha256(await readFile(proxyDisabled)));
    const proxy = await build({ ...proxyNodeBuildOptions({ outputFile: proxyEnabled,
      beforePlugins: node.plugins }), absWorkingDir: root, metafile: true, logLevel: 'silent' });
    assert.deepEqual(auditCandidateBundle(proxy.metafile, { target: 'node', loaded: ['esm'] }),
      { target: 'node', variants: ['esm'] });
    assertNoWorkspaceExternals(await readFile(proxyEnabled, 'utf8'));
    await assert.rejects(build({ ...proxyNodeBuildOptions({ outputFile: join(directory, 'proxy-wrong-order.mjs') }),
      absWorkingDir: root, metafile: true, logLevel: 'silent', write: false,
      plugins: [...proxyNodeBuildOptions().plugins, ...node.plugins] }), /bypassed|External/);
    report.nodeBuildSha256 = { defaultCore: sha256(await readFile(baseline)),
      disabledCore: sha256(await readFile(disabled)), v307Core: sha256(await readFile(enabled)),
      defaultProxy: sha256(await readFile(proxyDefault)),
      disabledProxy: sha256(await readFile(proxyDisabled)), v307Proxy: sha256(await readFile(proxyEnabled)) };

    const peer = await postgresInitializationPeer(t, 'success');
    const core = await import(pathToFileURL(enabled).href);
    const value = await core.createPostgresDatabaseClient(peer.url,
      { max: 1, fetch_types: false, connect_timeout: 1 });
    assert.equal(value.raw.ownedCancellation, 'postgres-js-3.4.9-owned-cancel-v302');
    assert.equal(value.raw.ownedRecoveryScanFence, 'postgres-js-3.4.9-owned-scan-v307');
    await value.raw.end({ timeout: 1 });
    await assertOneClosedInitialization(peer);

    // Exercise the adopted core's real factory, not only the standalone driver.
    // The existing four fixed-scan cases use a bounded local protocol peer.
    const wrapper = join(directory, 'core-v307-factory.mjs');
    await build({ stdin: { contents: `import { createPostgresDatabaseClient } from ${JSON.stringify(pathToFileURL(enabled).href)};
      export default async options => (await createPostgresDatabaseClient('postgres://synthetic:synthetic@127.0.0.1:' + options.port + '/synthetic', options)).raw;`,
      resolveDir: directory }, bundle: false, platform: 'node', format: 'esm',
      outfile: wrapper, logLevel: 'silent' });
    const wire = await exec(process.execPath,
      ['--import', 'tsx', '--test', '--test-reporter=tap',
        '--test-name-pattern=^v307 wire ',
        'packages/core/src/storage/recovery/postgres-recovery-owned-scan.wire.test.mjs'],
      { cwd: root, env: { ...osEnv(), GATEWAY_POSTGRES_RECOVERY_DRIVER: wrapper,
        GATEWAY_POSTGRES_FACTORY_INITIALIZES_SESSION: '1' },
      timeout: 18000, maxBuffer: 512 * 1024, windowsHide: true });
    await writeFile(join(directory, 'adopted-core-fixed-scan-wire.tap'), wire.stdout + wire.stderr);
    assert.match(wire.stdout, /^# tests 4\s*$/m);
    assert.match(wire.stdout, /^# pass 4\s*$/m);
    assert.match(wire.stdout, /^# fail 0\s*$/m);
    assert.match(wire.stdout, /^# skipped 0\s*$/m);
    report.tests.adoptedCoreFixedScanWire = { pass: 4, fail: 0 };
    report.tests.nodeBranchesAndActualFactories = true;
  });

  await t.test('Workers CF selection and offline Wrangler alias consume only the pinned artifact',
    { timeout: 30000 }, async () => {
      const cf = await build({ absWorkingDir: root, write: false, bundle: true,
        platform: 'neutral', format: 'esm', logLevel: 'silent', metafile: true,
        external: ['node:*', 'cloudflare:sockets'],
        stdin: { contents: "export { default } from 'postgres'", resolveDir: root },
        plugins: workers.plugins });
      assert.deepEqual(auditCandidateBundle(cf.metafile, { target: 'workers', loaded: ['cf'] }),
        { target: 'workers', variants: ['cf'] });
      const configPath = join(fixtureRoot, 'wrangler.postgres-adoption.jsonc');
      const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
      assert.equal(resolve(dirname(configPath), config.main), join(root, 'packages/proxy/src/index.ts'));
      assert.deepEqual(config.routes, []);
      assert.equal(config.workers_dev, false);
      assert.equal(config.preview_urls, false);
      const workerDir = join(directory, 'worker');
      await mkdir(workerDir);
      const metafilePath = join(workerDir, 'meta.json');
      const artifact = workers.candidate.artifacts.cf;
      const args = ['--require', join(fixtureRoot, 'offline-build.cjs'),
        join(root, 'node_modules/wrangler/bin/wrangler.js'),
        'deploy', '--dry-run', '--config', configPath, '--env-file', join(fixtureRoot, 'build-only.env'),
        '--outdir', workerDir, '--metafile', metafilePath, '--alias', 'postgres:' + artifact.path];
      const env = { ...osEnv(), WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_LOG_PATH: join(workerDir, 'logs'),
        XDG_CONFIG_HOME: join(workerDir, 'config'), CI: 'true' };
      const result = await exec(process.execPath, args,
        { cwd: root, env, timeout: 25000, maxBuffer: 512 * 1024, windowsHide: true });
      assert.match(result.stdout, /dry-run.*exiting/i);
      assert.doesNotMatch(result.stdout + result.stderr, /OFFLINE_BUILD_NETWORK_DISABLED/);
      const metadata = JSON.parse(await readFile(metafilePath, 'utf8'));
      const audit = auditWranglerCandidate(metadata,
        { artifact, workingDirectory: dirname(configPath) });
      assert.equal(audit.variant, 'cf');
      assert.equal(sha256(await readFile(artifact.path)), frozen.artifactSha256.cf);
      const output = await readFile(join(workerDir, 'index.js'), 'utf8');
      assert.ok(output.includes('cloudflare:sockets'));
      assert.ok(output.includes('postgres-js-3.4.9-owned-cancel-v302'));
      assert.ok(output.includes('postgres-js-3.4.9-owned-scan-v307'));
      report.worker = { ...audit, artifactSha256: artifact.sha256,
        outputSha256: sha256(output), offlineGuard: true };
      report.tests.workersOfflineBuild = true;
    });
  report.status = 'EXPLICIT_ADOPTION_BUILD_PASS_PRODUCTION_DISABLED';
});
