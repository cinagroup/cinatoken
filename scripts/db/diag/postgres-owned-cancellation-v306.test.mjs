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
];
const sources = [
  'scripts/db/diag/postgres-owned-cancellation.mjs',
  'scripts/db/diag/postgres-owned-cancellation.test.mjs',
  'scripts/db/diag/postgres-owned-cancellation-v303.test.mjs',
  'scripts/db/diag/postgres-owned-cancellation-v304.test.mjs',
  'scripts/db/diag/postgres-owned-cancellation-v305.test.mjs',
  'scripts/db/diag/postgres-owned-cancellation-v306.test.mjs',
  recovery + 'postgres-recovery-operation-owner.ts',
  recovery + 'postgres-recovery-operation-owner.test.mjs',
  recovery + 'postgres-recovery-operation-owner.wire.test.mjs',
  recovery + 'postgres-owned-cancellation.wire.test.mjs',
  recovery + 'postgres-owned-cancellation-owner.wire.test.mjs',
  recovery + 'postgres-owned-cancellation-cf.wire.test.mjs',
  recovery + 'postgres-owned-cancellation-shutdown.wire.test.mjs',
  recovery + 'postgres-owned-cancellation-shutdown-local.wire.test.mjs',
  recovery + 'postgres-owned-cancellation-cf-direct-shutdown.wire.test.mjs',
];

test('v306 local-only shutdown admission and local-queue fences: owned cancellation and dual-branch regressions',
  { timeout: 240000 }, async t => {
    const recorded = JSON.parse(await readFile(join(root,
      evidenceRoot + 'C03-postgres-local-shutdown-fence-v306-results.json'), 'utf8'));
    const drift = [];
    for (const [name, hash] of Object.entries(recorded.sourceSha256))
      if (sha256(await readFile(join(root, name))) !== hash) drift.push(name);
    if (drift.length) {
      t.diagnostic('Historical v306 evidence remains immutable; current source drift: ' + drift.join(', '));
      t.skip('Superseded by the v307 controlled recovery-scan integration candidate harness');
      return;
    }
    const historical = Object.fromEntries(await Promise.all(historicalEvidence.map(async ([version, path]) =>
      [version, JSON.parse(await readFile(join(root, path), 'utf8'))])));
    const protectedBefore = { ...historical.v302.protectedInputSha256 };
    assert.equal(Object.keys(protectedBefore).length, 16);
    for (const [name, hash] of Object.entries(protectedBefore))
      assert.equal(sha256(await readFile(join(root, name))), hash, name + ' matches protected v302 input');

    await mkdir(join(root, '.wrangler/staging'), { recursive: true });
    const directory = await mkdtemp(join(root, '.wrangler/staging/postgres-owned-cancel-v306-run-'));
    const report = {
      version: 'v306',
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
        cfArtifactIsLoopbackOnly: false,
        cfArtifactTestsUseNodeLoopbackOrProcessLocalSocketHook: true,
        physicalClosureProvenByPolyfillCloseEvent: false,
        queuedQueryAndReserveSettlementAfterPoolEndVerified: false,
        initialAndLocalQueueShutdownFencesNodeVerified: false,
        cfOnlyShutdownNodeVerified: false,
        cfDirectSocketShutdownNodeVerified: false,
      },
    };
    for (const [version] of historicalEvidence) {
      const drift = [];
      for (const [name, hash] of Object.entries(historical[version].sourceSha256))
        if (sha256(await readFile(join(root, name))) !== hash) drift.push(name);
      assert.ok(drift.length > 0, version + ' sources must not be relabeled');
      report.historicalSourceDrift[version] = drift;
    }

    t.after(async () => {
      report.sourceSha256 = {};
      for (const name of sources) report.sourceSha256[name] = sha256(await readFile(join(root, name)));
      await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2));
      for (const [name, hash] of Object.entries(protectedBefore))
        assert.equal(sha256(await readFile(join(root, name))), hash, name + ' untouched');
      t.diagnostic('v306 local-only report: ' + directory);
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
    const localShutdownSource = await readFile(join(root, localShutdown[0]), 'utf8');
    const localShutdownCount = localShutdownSource.match(/^test\('local shutdown /gm)?.length ?? 0;
    const cfOnlyShutdownCount = localShutdownSource.match(/^test\('CF /gm)?.length ?? 0;
    assert.ok(localShutdownCount >= 7, 'local shutdown test inventory must include the original seven cases');
    assert.ok(cfOnlyShutdownCount >= 1, 'CF-only shutdown test inventory must include raw.closed rejection');
    assert.equal(localShutdownCount + cfOnlyShutdownCount, localShutdownSource.match(/^test\(/gm)?.length ?? 0,
      'every direct shutdown test must match the local or CF-only name filter');
    report.localShutdownTestsPerVariant = localShutdownCount;
    report.cfOnlyShutdownTests = cfOnlyShutdownCount;
    const cfDirectShutdown = [recovery + 'postgres-owned-cancellation-cf-direct-shutdown.wire.test.mjs'];
    const cfDirectSource = await readFile(join(root, cfDirectShutdown[0]), 'utf8');
    const cfDirectCount = cfDirectSource.match(/^test\('CF direct /gm)?.length ?? 0;
    assert.ok(cfDirectCount >= 2, 'CF direct socket test inventory must include the original two cases');
    assert.equal(cfDirectCount, cfDirectSource.match(/^test\(/gm)?.length ?? 0,
      'every direct CF socket test must match the CF-only name filter');
    report.cfDirectShutdownTests = cfDirectCount;
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
          { pass: localShutdownCount }, candidate, '^local shutdown'));
    }
    const cf = { GATEWAY_POSTGRES_RECOVERY_DRIVER: first.artifacts.cf.path };
    await t.test('CF synthetic close and raw.closed gate loopback', () =>
      suite('cf-synthetic-close', [recovery + 'postgres-owned-cancellation-cf.wire.test.mjs'],
        { pass: 6 }, cf, '^CF'));
    await t.test('CF shutdown settles queued Query/reserve without late dispatch', async () => {
      await suite('cf-shutdown', [recovery + 'postgres-owned-cancellation-shutdown.wire.test.mjs'],
        { pass: 4 }, cf, '^shutdown');
      report.boundaries.queuedQueryAndReserveSettlementAfterPoolEndVerified = true;
    });
    await t.test('CF portable shutdown keeps active SQL owned', () =>
      suite('cf-portable-shutdown',
        [recovery + 'postgres-owned-cancellation-shutdown.wire.test.mjs'],
        { pass: 1 }, cf, '^portable shutdown'));
    await t.test('CF initial and local shutdown fences in Node loopback', () =>
      suite('cf-local-shutdown', localShutdown,
        { pass: localShutdownCount }, cf, '^local shutdown'));
    await t.test('CF-only raw-closure shutdown cases in Node loopback', () =>
      suite('cf-only-shutdown', localShutdown,
        { pass: cfOnlyShutdownCount }, cf, '^CF '));
    await t.test('CF direct polyfill socket shutdown with a process-local import hook', () =>
      suite('cf-direct-shutdown', cfDirectShutdown,
        { pass: cfDirectCount }, cf, '^CF direct '));
    report.boundaries.initialAndLocalQueueShutdownFencesNodeVerified =
      ['esm', 'cjs', 'cf'].every(variant =>
        report.tests[variant + '-local-shutdown']?.pass === localShutdownCount);
    report.boundaries.cfOnlyShutdownNodeVerified =
      report.tests['cf-only-shutdown']?.pass === cfOnlyShutdownCount;
    report.boundaries.cfDirectSocketShutdownNodeVerified =
      report.tests['cf-direct-shutdown']?.pass === cfDirectCount;
    await t.test('source owner, supervisor and unchanged financial SQL', () =>
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
      await t.test('historical ' + version + ' full harness skipped after source drift', () =>
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
    assert.equal(Object.keys(report.tests).length, 23, 'all twenty-three child test suites completed');
    assert.equal(report.syntaxChecks, 3);
    assert.equal(report.typecheckExitCode, 0);
    report.status = 'LOCAL_INITIAL_AND_LOCAL_QUEUE_SHUTDOWN_FENCES_CANDIDATE_PASS_PRODUCTION_DISABLED';
  });
