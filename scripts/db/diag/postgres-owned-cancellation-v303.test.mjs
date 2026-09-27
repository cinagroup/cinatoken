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
const evidence = 'docs/developers/architecture/implementation-evidence/C03-postgres-owned-cancellation-v302-results.json';
const sources = [
  'scripts/db/diag/postgres-owned-cancellation.mjs',
  'scripts/db/diag/postgres-owned-cancellation.test.mjs',
  'scripts/db/diag/postgres-owned-cancellation-v303.test.mjs',
  recovery + 'postgres-recovery-operation-owner.ts',
  recovery + 'postgres-recovery-operation-owner.test.mjs',
  recovery + 'postgres-recovery-operation-owner.wire.test.mjs',
  recovery + 'postgres-owned-cancellation.wire.test.mjs',
  recovery + 'postgres-owned-cancellation-owner.wire.test.mjs',
];

test('v303 local-only owned cancellation: owner receipts and dual-branch regressions', { timeout: 150000 }, async t => {
  const recorded = JSON.parse(await readFile(join(root,
    'docs/developers/architecture/implementation-evidence/C03-postgres-owned-cancellation-owner-v303-results.json'), 'utf8'));
  const drift = [];
  for (const [name, hash] of Object.entries(recorded.sourceSha256))
    if (sha256(await readFile(join(root, name))) !== hash) drift.push(name);
  if (drift.length) {
    t.diagnostic('Historical v303 evidence remains immutable; current source drift: ' + drift.join(', '));
    t.skip('Superseded by the v304 CF raw.closed-gated candidate harness after intentional source changes');
    return;
  }
  const historical = JSON.parse(await readFile(join(root, evidence), 'utf8'));
  const protectedBefore = { ...historical.protectedInputSha256 };
  assert.equal(Object.keys(protectedBefore).length, 16);
  for (const [name, hash] of Object.entries(protectedBefore))
    assert.equal(sha256(await readFile(join(root, name))), hash, name + ' matches protected v302 input');

  await mkdir(join(root, '.wrangler/staging'), { recursive: true });
  const directory = await mkdtemp(join(root, '.wrangler/staging/postgres-owned-cancel-v303-run-'));
  const report = {
    version: 'v303',
    status: 'INCOMPLETE',
    directory,
    protectedInputSha256: protectedBefore,
    historicalV302SourceDrift: [],
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
      cfArtifactIsCompileOnly: true,
      physicalClosureProvenByCloseEvent: false,
    },
  };
  for (const [name, hash] of Object.entries(historical.sourceSha256))
    if (sha256(await readFile(join(root, name))) !== hash) report.historicalV302SourceDrift.push(name);
  assert.ok(report.historicalV302SourceDrift.length > 0, 'v303 must not silently relabel v302 sources');

  t.after(async () => {
    report.sourceSha256 = {};
    for (const name of sources) report.sourceSha256[name] = sha256(await readFile(join(root, name)));
    await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2));
    for (const [name, hash] of Object.entries(protectedBefore))
      assert.equal(sha256(await readFile(join(root, name))), hash, name + ' untouched');
    t.diagnostic('v303 local-only report: ' + directory);
  });

  const first = await buildOwnedCancellationCandidates();
  const repeat = await buildOwnedCancellationCandidates();
  report.candidate = first;
  report.repeatedDirectory = repeat.directory;
  for (const variant of ['esm', 'cjs', 'cf']) {
    assert.equal(first.artifacts[variant].sha256, repeat.artifacts[variant].sha256, variant + ' deterministic bundle');
    assert.deepEqual(first.artifacts[variant].inputs, repeat.artifacts[variant].inputs, variant + ' pinned inputs');
  }

  async function suite(name, paths, expected, extra = {}) {
    const env = {
      ...process.env,
      GATEWAY_POSTGRES_RECOVERY_DRIVER: '',
      GATEWAY_POSTGRES_FACTORY_INITIALIZES_SESSION: '',
      GATEWAY_POSTGRES_SUPERVISION_MODULE: '',
      ...extra,
    };
    delete env.NODE_TEST_CONTEXT;
    const outcome = await exec(process.execPath,
      ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', ...paths],
      { cwd: root, env, timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true },
    ).then(value => ({ ...value, code: 0 }), error => error);
    const output = (outcome.stdout ?? '') + (outcome.stderr ?? '');
    await writeFile(join(directory, name + '.tap'), output);
    const { pass, fail = 0, skip = 0 } = expected;
    assert.equal(outcome.code, fail ? 1 : 0, name + '\n' + output);
    for (const [label, count] of Object.entries({ tests: pass + fail + skip, pass, fail, skipped: skip })) {
      const key = label === 'skipped' ? 'skipped' : label;
      assert.match(output, new RegExp('^# ' + key + ' ' + count + '\\s*$', 'm'), name + ' ' + key);
    }
    assert.match(output, /^# cancelled 0\s*$/m, name + ' no cancelled tests');
    const durationMs = Number(output.match(/^# duration_ms ([\d.]+)\s*$/m)?.[1]);
    assert.ok(Number.isFinite(durationMs));
    report.tests[name] = { pass, fail, skip, expectedFailure: fail > 0, durationMs };
    return output;
  }

  const ownerAndCancel = [
    recovery + 'postgres-owned-cancellation-owner.wire.test.mjs',
    recovery + 'postgres-owned-cancellation.wire.test.mjs',
  ];
  const lifecycle = ['postgres-transaction-retirement', 'postgres-transaction-reservation',
    'postgres-transaction-completion', 'postgres-write-failure'].map(name => recovery + name + '.wire.test.mjs');
  for (const variant of ['esm', 'cjs']) {
    const candidate = { GATEWAY_POSTGRES_RECOVERY_DRIVER: first.artifacts[variant].path };
    await t.test(variant + ' owner and cancellation wire', () =>
      suite(variant + '-owner-cancel', ownerAndCancel, { pass: 36 }, candidate));
    await t.test(variant + ' original lifecycle regression', () =>
      suite(variant + '-lifecycle', lifecycle, { pass: 60 }, candidate));
    await t.test(variant + ' ordinary cancel remains legacy', () =>
      suite(variant + '-legacy-cancel', [recovery + 'postgres-cancel-observation.wire.test.mjs'], { pass: 2 }, candidate));
  }
  await t.test('source owner, supervisor and unchanged financial SQL', () =>
    suite('source-sql', [recovery + 'postgres-recovery-operation-owner.test.mjs',
      recovery + 'supervise-usage-recovery-postgres.test.mjs', recovery + 'usage-recovery.postgres.test.mjs'],
    { pass: 66 }, {
      GATEWAY_PGLITE_MODULE: process.env.GATEWAY_PGLITE_MODULE || join(root, '.wrangler/staging/pg-schema-v250/package/dist/index.js'),
      GATEWAY_PG_FINANCIAL_BASELINE: '',
    }));
  await t.test('installed cancellation baseline', () =>
    suite('installed-cancel', [recovery + 'postgres-cancel-observation.wire.test.mjs'], { pass: 2 }));
  await t.test('installed onclose negative remains', async () => {
    const output = await suite('installed-onclose',
      [recovery + 'postgres-recovery-operation-owner.wire.test.mjs'], { pass: 2, fail: 1 });
    assert.match(output, /Cannot read properties of null/);
  });
  await t.test('historical v302 harness explicitly skips superseded full evidence', () =>
    suite('historical-v302', ['scripts/db/diag/postgres-owned-cancellation.test.mjs'], { pass: 3, skip: 1 }));
  await t.test('candidate artifact syntax', async () => {
    for (const variant of ['esm', 'cjs', 'cf'])
      await exec(process.execPath, ['--check', first.artifacts[variant].path],
        { cwd: root, timeout: 10000, maxBuffer: 256 * 1024, windowsHide: true });
    report.syntaxChecks = 3;
  });
  await t.test('recovery typecheck', async () => {
    await exec(process.execPath,
      ['node_modules/typescript/bin/tsc', '--project', 'packages/core/tsconfig.recovery-runner-postgres.json', '--noEmit'],
      { cwd: root, timeout: 25000, maxBuffer: 256 * 1024, windowsHide: true });
    report.typecheckExitCode = 0;
  });
  assert.equal(Object.keys(report.tests).length, 10, 'all ten child test suites completed successfully');
  assert.equal(report.syntaxChecks, 3);
  assert.equal(report.typecheckExitCode, 0);
  report.status = 'LOCAL_OWNER_AND_CANCEL_CANDIDATE_PASS_PRODUCTION_DISABLED';
});
