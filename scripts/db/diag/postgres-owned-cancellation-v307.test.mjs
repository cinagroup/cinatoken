import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOwnedCancellationCandidates } from './postgres-owned-cancellation.mjs';
import { sha256 } from './postgres-transaction-retirement.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const exec = promisify(execFile);
const recovery = 'packages/core/src/storage/recovery/';
const evidenceRoot = 'docs/developers/architecture/implementation-evidence/';
const historicalEvidence = [
  ['v302', evidenceRoot + 'C03-postgres-owned-cancellation-v302-results.json'],
  ['v303', evidenceRoot + 'C03-postgres-owned-cancellation-owner-v303-results.json'],
  ['v304', evidenceRoot + 'C03-postgres-cf-raw-close-gate-v304-results.json'],
  ['v305', evidenceRoot + 'C03-postgres-end-admission-barrier-v305-results.json'],
  ['v306', evidenceRoot + 'C03-postgres-local-shutdown-fence-v306-results.json'],
];
const newSources = [
  'scripts/db/diag/postgres-owned-cancellation-v307.test.mjs',
  recovery + 'usage-recovery-jobs-postgres.ts',
  recovery + 'run-usage-recovery-postgres.ts',
  recovery + 'supervise-usage-recovery-postgres.ts',
  recovery + 'usage-recovery-jobs-postgres-scan.test.mjs',
  recovery + 'postgres-recovery-owned-scan.test.mjs',
  recovery + 'postgres-recovery-owned-scan.wire.test.mjs',
  recovery + 'postgres-recovery-owned-scan-reentry.wire.test.mjs',
  recovery + 'postgres-recovery-owned-scan-reentry-negative.wire.test.mjs',
  recovery + 'postgres-recovery-owned-scan-old-artifact-gate.test.mjs',
  recovery + 'supervise-usage-recovery-postgres.test.mjs',
  recovery + 'usage-recovery.postgres.test.mjs',
  recovery + 'postgres-transaction-retirement.wire.test.mjs',
  recovery + 'postgres-transaction-reservation.wire.test.mjs',
  recovery + 'postgres-transaction-completion.wire.test.mjs',
  recovery + 'postgres-write-failure.wire.test.mjs',
  recovery + 'postgres-cancel-observation.wire.test.mjs',
];

test('v307 local-only fixed recovery-scan owner integration and shutdown regression matrix',
  { timeout: 240000 }, async t => {
    const historical = Object.fromEntries(await Promise.all(historicalEvidence.map(async ([version, path]) =>
      [version, JSON.parse(await readFile(join(root, path), 'utf8'))])));
    const protectedBefore = { ...historical.v302.protectedInputSha256 };
    assert.equal(Object.keys(protectedBefore).length, 16);
    for (const [name, hash] of Object.entries(protectedBefore))
      assert.equal(sha256(await readFile(join(root, name))), hash, name + ' matches protected v302 input');

    await mkdir(join(root, '.wrangler/staging'), { recursive: true });
    const directory = await mkdtemp(join(root, '.wrangler/staging/postgres-owned-cancel-v307-run-'));
    const sources = [...new Set([...Object.keys(historical.v306.sourceSha256), ...newSources])].sort();
    const report = {
      version: 'v307',
      status: 'INCOMPLETE',
      directory,
      protectedInputSha256: protectedBefore,
      historicalSourceDrift: {},
      tests: {},
      boundaries: {
        productionActivated: false,
        workersRuntimeTests: 0,
        nativePostgresTests: 0,
        remoteSqlCalls: 0,
        cloudManagementCalls: 0,
        deployments: 0,
        modelCalls: 0,
        kmsCalls: 0,
        cfArtifactTestsUseNodeLoopbackOrProcessLocalSocketHook: true,
        physicalClosureProvenByPolyfillCloseEvent: false,
        controlledScanCatalogNodeVerified: false,
        ownedScanMockNodeVerified: false,
        ownedScanWireNodeVerified: false,
        ownedScanNegativeWireNodeVerified: false,
        oldArtifactScanFenceNodeVerified: false,
      },
    };
    for (const [version] of historicalEvidence) {
      const drift = [];
      for (const [name, hash] of Object.entries(historical[version].sourceSha256))
        if (sha256(await readFile(join(root, name))) !== hash) drift.push(name);
      assert.ok(drift.length > 0, version + ' sources must not be relabeled');
      report.historicalSourceDrift[version] = drift;
    }
    const sourceBefore = {};
    for (const name of sources) sourceBefore[name] = sha256(await readFile(join(root, name)));
    t.after(async () => {
      report.sourceSha256 = {};
      for (const name of sources) report.sourceSha256[name] = sha256(await readFile(join(root, name)));
      report.sourceDriftDuringRun = sources.filter(name => report.sourceSha256[name] !== sourceBefore[name]);
      await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2));
      for (const [name, hash] of Object.entries(protectedBefore))
        assert.equal(sha256(await readFile(join(root, name))), hash, name + ' untouched');
      assert.deepEqual(report.sourceDriftDuringRun, [], 'v307 source/test inputs stable throughout the run');
      t.diagnostic('v307 local-only report: ' + directory);
    });

    const first = await buildOwnedCancellationCandidates();
    const repeat = await buildOwnedCancellationCandidates();
    report.candidate = first;
    report.repeatedDirectory = repeat.directory;
    for (const variant of ['esm', 'cjs', 'cf']) {
      assert.equal(first.artifacts[variant].sha256, repeat.artifacts[variant].sha256,
        variant + ' deterministic bundle');
      assert.deepEqual(first.artifacts[variant].inputs, repeat.artifacts[variant].inputs,
        variant + ' pinned inputs');
    }

    async function suite(name, paths, expected, extra = {}, pattern) {
      const env = {
        ...process.env,
        GATEWAY_POSTGRES_RECOVERY_DRIVER: '',
        GATEWAY_POSTGRES_FACTORY_INITIALIZES_SESSION: '',
        GATEWAY_POSTGRES_SUPERVISION_MODULE: '',
        ...extra,
      };
      delete env.NODE_TEST_CONTEXT;
      const outcome = await exec(process.execPath,
        ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
          ...(pattern ? ['--test-name-pattern=' + pattern] : []), ...paths],
        { cwd: root, env, timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true },
      ).then(value => ({ ...value, code: 0 }), error => error);
      const output = (outcome.stdout ?? '') + (outcome.stderr ?? '');
      await writeFile(join(directory, name + '.tap'), output);
      const { pass, fail = 0, skip = 0 } = expected;
      assert.equal(outcome.code, fail ? 1 : 0, name + '\n' + output);
      for (const [label, count] of Object.entries({ tests: pass + fail + skip, pass, fail, skipped: skip }))
        assert.match(output, new RegExp('^# ' + label + ' ' + count + '\\s*$', 'm'), name + ' ' + label);
      assert.match(output, /^# cancelled 0\s*$/m, name + ' no cancelled tests');
      const durationMs = Number(output.match(/^# duration_ms ([\d.]+)\s*$/m)?.[1]);
      assert.ok(Number.isFinite(durationMs), name + ' duration');
      report.tests[name] = { pass, fail, skip, expectedFailure: fail > 0, durationMs };
      return output;
    }

    const ownerAndCancel = [
      recovery + 'postgres-owned-cancellation-owner.wire.test.mjs',
      recovery + 'postgres-owned-cancellation.wire.test.mjs',
    ];
    const lifecycle = ['postgres-transaction-retirement', 'postgres-transaction-reservation',
      'postgres-transaction-completion', 'postgres-write-failure']
      .map(name => recovery + name + '.wire.test.mjs');
    const localShutdown = [recovery + 'postgres-owned-cancellation-shutdown-local.wire.test.mjs'];
    const localSource = await readFile(join(root, localShutdown[0]), 'utf8');
    const localCount = localSource.match(/^test\('local shutdown /gm)?.length ?? 0;
    const cfOnlyCount = localSource.match(/^test\('CF /gm)?.length ?? 0;
    assert.ok(localCount >= 15, 'v306 local shutdown cases retained');
    assert.ok(cfOnlyCount >= 1, 'v306 CF raw-close case retained');
    assert.equal(localCount + cfOnlyCount, localSource.match(/^test\(/gm)?.length ?? 0,
      'all local shutdown cases match an explicit filter');
    report.localShutdownTestsPerVariant = localCount;
    report.cfOnlyShutdownTests = cfOnlyCount;
    const cfDirect = [recovery + 'postgres-owned-cancellation-cf-direct-shutdown.wire.test.mjs'];
    const cfDirectSource = await readFile(join(root, cfDirect[0]), 'utf8');
    const cfDirectCount = cfDirectSource.match(/^test\('CF direct /gm)?.length ?? 0;
    assert.ok(cfDirectCount >= 5, 'v306 CF direct socket cases retained');
    assert.equal(cfDirectCount, cfDirectSource.match(/^test\(/gm)?.length ?? 0,
      'all CF direct cases match the explicit filter');
    report.cfDirectShutdownTests = cfDirectCount;

    const wire = [recovery + 'postgres-recovery-owned-scan.wire.test.mjs'];
    const wireSource = await readFile(join(root, wire[0]), 'utf8');
    const wireCount = wireSource.match(/^test\('v307 wire /gm)?.length ?? 0;
    assert.ok(wireCount >= 4, 'the original four v307 wire cases retained');
    assert.equal(wireCount, wireSource.match(/^test\(/gm)?.length ?? 0,
      'all v307 wire tests match the explicit filter');
    report.ownedScanWireTestsPerVariant = wireCount;
    const reentryWire = [recovery + 'postgres-recovery-owned-scan-reentry.wire.test.mjs'];
    const reentrySource = await readFile(join(root, reentryWire[0]), 'utf8');
    const reentryCount = reentrySource.match(/^test\('v307 fixed scan:/gm)?.length ?? 0;
    assert.ok(reentryCount >= 2, 'both build and serializer reentry cases retained');
    assert.equal(reentryCount, reentrySource.match(/^test\(/gm)?.length ?? 0,
      'all reentry wire tests match the explicit filter');
    report.reentryWireTestsPerVariant = reentryCount;
    const negativeWire = [recovery + 'postgres-recovery-owned-scan-reentry-negative.wire.test.mjs'];
    const negativeSource = await readFile(join(root, negativeWire[0]), 'utf8');
    const negativeCount = negativeSource.match(/^test\('v307 fixed scan negative:/gm)?.length ?? 0;
    assert.ok(negativeCount >= 2, 'both ParameterDescription negative cases retained');
    assert.equal(negativeCount, negativeSource.match(/^test\(/gm)?.length ?? 0,
      'all negative wire tests match the explicit filter');
    report.negativeWireTestsPerVariant = negativeCount;

    for (const variant of ['esm', 'cjs']) {
      const candidate = { GATEWAY_POSTGRES_RECOVERY_DRIVER: first.artifacts[variant].path };
      await t.test(variant + ' owner and cancellation wire', () =>
        suite(variant + '-owner-cancel', ownerAndCancel, { pass: 37 }, candidate));
      await t.test(variant + ' original lifecycle regression', () =>
        suite(variant + '-lifecycle', lifecycle, { pass: 60 }, candidate));
      await t.test(variant + ' ordinary cancel remains legacy', () =>
        suite(variant + '-legacy-cancel', [recovery + 'postgres-cancel-observation.wire.test.mjs'],
          { pass: 2 }, candidate));
      await t.test(variant + ' portable shutdown keeps active SQL owned', () =>
        suite(variant + '-portable-shutdown',
          [recovery + 'postgres-owned-cancellation-shutdown.wire.test.mjs'],
          { pass: 1 }, candidate, '^portable shutdown'));
      await t.test(variant + ' initial and local shutdown fences', () =>
        suite(variant + '-local-shutdown', localShutdown,
          { pass: localCount }, candidate, '^local shutdown'));
      await t.test(variant + ' fixed recovery-scan wire', () =>
        suite(variant + '-owned-scan-wire', wire,
          { pass: wireCount }, candidate, '^v307 wire '));
      await t.test(variant + ' fixed recovery-scan reentry wire', () =>
        suite(variant + '-reentry-wire', reentryWire,
          { pass: reentryCount }, candidate, '^v307 fixed scan:'));
      await t.test(variant + ' fixed recovery-scan negative wire', () =>
        suite(variant + '-negative-wire', negativeWire,
          { pass: negativeCount }, candidate, '^v307 fixed scan negative:'));
    }
    const cf = { GATEWAY_POSTGRES_RECOVERY_DRIVER: first.artifacts.cf.path };
    await t.test('CF synthetic close and raw.closed gate in Node loopback', () =>
      suite('cf-synthetic-close', [recovery + 'postgres-owned-cancellation-cf.wire.test.mjs'],
        { pass: 6 }, cf, '^CF'));
    await t.test('CF shutdown settles queued Query/reserve without late dispatch', () =>
      suite('cf-shutdown', [recovery + 'postgres-owned-cancellation-shutdown.wire.test.mjs'],
        { pass: 4 }, cf, '^shutdown'));
    await t.test('CF portable shutdown keeps active SQL owned', () =>
      suite('cf-portable-shutdown',
        [recovery + 'postgres-owned-cancellation-shutdown.wire.test.mjs'],
        { pass: 1 }, cf, '^portable shutdown'));
    await t.test('CF initial and local shutdown fences in Node loopback', () =>
      suite('cf-local-shutdown', localShutdown, { pass: localCount }, cf, '^local shutdown'));
    await t.test('CF-only raw-closure shutdown in Node loopback', () =>
      suite('cf-only-shutdown', localShutdown, { pass: cfOnlyCount }, cf, '^CF '));
    await t.test('CF direct polyfill socket shutdown with process-local import hook', () =>
      suite('cf-direct-shutdown', cfDirect, { pass: cfDirectCount }, cf, '^CF direct '));
    await t.test('CF fixed recovery-scan wire in Node loopback', () =>
      suite('cf-owned-scan-wire', wire, { pass: wireCount }, cf, '^v307 wire '));
    await t.test('CF fixed recovery-scan reentry wire in Node loopback', () =>
      suite('cf-reentry-wire', reentryWire, { pass: reentryCount }, cf, '^v307 fixed scan:'));
    await t.test('CF fixed recovery-scan negative wire in Node loopback', () =>
      suite('cf-negative-wire', negativeWire, { pass: negativeCount }, cf, '^v307 fixed scan negative:'));
    report.boundaries.ownedScanWireNodeVerified =
      ['esm', 'cjs', 'cf'].every(variant =>
        report.tests[variant + '-owned-scan-wire']?.pass === wireCount &&
        report.tests[variant + '-reentry-wire']?.pass === reentryCount);
    report.boundaries.ownedScanNegativeWireNodeVerified =
      ['esm', 'cjs', 'cf'].every(variant =>
        report.tests[variant + '-negative-wire']?.pass === negativeCount);

    await t.test('SHA-pinned v306 ESM/CJS/CF artifacts rejected before capacity, SQL or socket', () =>
      suite('old-artifact-scan-fence',
        [recovery + 'postgres-recovery-owned-scan-old-artifact-gate.test.mjs'], { pass: 3 }));
    report.boundaries.oldArtifactScanFenceNodeVerified =
      report.tests['old-artifact-scan-fence']?.pass === 3;

    const catalog = [recovery + 'usage-recovery-jobs-postgres-scan.test.mjs'];
    const catalogSource = await readFile(join(root, catalog[0]), 'utf8');
    const catalogCount = catalogSource.match(/^test\(/gm)?.length ?? 0;
    assert.equal(catalogCount, 5, 'five controlled scan catalogue cases explicitly inventoried');
    await t.test('closed read-only recovery scan catalogue', () =>
      suite('catalog', catalog, { pass: catalogCount }));
    report.boundaries.controlledScanCatalogNodeVerified = report.tests.catalog?.pass === catalogCount;
    await t.test('mock owned recovery scan and single observation', () =>
      suite('owned-scan-mock', [recovery + 'postgres-recovery-owned-scan.test.mjs'], { pass: 21 }));
    report.boundaries.ownedScanMockNodeVerified = report.tests['owned-scan-mock']?.pass === 21;
    await t.test('source owner, supervisor, PGlite and unchanged financial SQL', () =>
      suite('source-sql', [recovery + 'postgres-recovery-operation-owner.test.mjs',
        recovery + 'supervise-usage-recovery-postgres.test.mjs',
        recovery + 'usage-recovery.postgres.test.mjs'], { pass: 66 }, {
        GATEWAY_PGLITE_MODULE: process.env.GATEWAY_PGLITE_MODULE ||
          join(root, '.wrangler/staging/pg-schema-v250/package/dist/index.js'),
        GATEWAY_PG_FINANCIAL_BASELINE: '',
      }));
    await t.test('installed cancellation baseline', () =>
      suite('installed-cancel', [recovery + 'postgres-cancel-observation.wire.test.mjs'], { pass: 2 }));
    await t.test('installed onclose negative remains', async () => {
      const output = await suite('installed-onclose',
        [recovery + 'postgres-recovery-operation-owner.wire.test.mjs'], { pass: 2, fail: 1 });
      assert.match(output, /Cannot read properties of null/);
    });
    for (const [version] of historicalEvidence)
      await t.test('historical ' + version + ' harness skipped after source drift', () =>
        suite('historical-' + version,
          ['scripts/db/diag/postgres-owned-cancellation' + (version === 'v302' ? '' : '-' + version) + '.test.mjs'],
          { pass: version === 'v302' ? 3 : 0, skip: 1 }));
    await t.test('candidate artifact syntax', async () => {
      for (const variant of ['esm', 'cjs', 'cf'])
        await exec(process.execPath, ['--check', first.artifacts[variant].path],
          { cwd: root, timeout: 10000, maxBuffer: 256 * 1024, windowsHide: true });
      report.syntaxChecks = 3;
    });
    await t.test('recovery typecheck', async () => {
      await exec(process.execPath,
        ['node_modules/typescript/bin/tsc', '--project',
          'packages/core/tsconfig.recovery-runner-postgres.json', '--noEmit'],
        { cwd: root, timeout: 25000, maxBuffer: 256 * 1024, windowsHide: true });
      report.typecheckExitCode = 0;
    });
    assert.equal(Object.keys(report.tests).length, 36, 'all thirty-six child test suites completed');
    assert.equal(report.syntaxChecks, 3);
    assert.equal(report.typecheckExitCode, 0);
    assert.equal(report.boundaries.controlledScanCatalogNodeVerified, true);
    assert.equal(report.boundaries.ownedScanMockNodeVerified, true);
    assert.equal(report.boundaries.ownedScanWireNodeVerified, true);
    assert.equal(report.boundaries.ownedScanNegativeWireNodeVerified, true);
    assert.equal(report.boundaries.oldArtifactScanFenceNodeVerified, true);
    report.status = 'LOCAL_CONTROLLED_RECOVERY_SCAN_INTEGRATION_CANDIDATE_PASS_PRODUCTION_DISABLED';
  });
