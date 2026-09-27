import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildRecoveryStatementDeadlineCandidates, POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE } from './postgres-recovery-statement-deadline.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ordinaryWire = fileURLToPath(new URL('../../../packages/core/src/storage/recovery/postgres-recovery-statement-deadline.wire.test.mjs', import.meta.url));
const scanWire = fileURLToPath(new URL('../../../packages/core/src/storage/recovery/postgres-owned-scan-deadline.wire.test.mjs', import.meta.url));
const oldWire = fileURLToPath(new URL('../../../packages/core/src/storage/recovery/postgres-recovery-owned-scan.wire.test.mjs', import.meta.url));
const oldReentry = fileURLToPath(new URL('../../../packages/core/src/storage/recovery/postgres-recovery-owned-scan-reentry.wire.test.mjs', import.meta.url));

function runWire(artifact, files, pattern, expected) {
  const env = { ...process.env, GATEWAY_POSTGRES_RECOVERY_DRIVER: artifact.path,
    GATEWAY_POSTGRES_FACTORY_INITIALIZES_SESSION: '' };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap',
    '--test-concurrency=1', '--test-name-pattern=' + pattern, ...files],
  { cwd: root, env, encoding: 'utf8', timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true });
  const output = (run.stdout ?? '') + (run.stderr ?? '');
  assert.equal(run.status, 0, output);
  assert.match(output, new RegExp('^# pass ' + expected + '\\s*$', 'm'), output);
  assert.match(output, /^# fail 0\s*$/m, output);
  assert.match(output, /^# cancelled 0\s*$/m, output);
}

test('v312 default-disabled candidate is deterministic and fences ordinary and fixed-scan SQL on all three bundles',
  { timeout: 180_000 }, async t => {
    const first = await buildRecoveryStatementDeadlineCandidates();
    const repeat = await buildRecoveryStatementDeadlineCandidates();
    for (const variant of ['esm', 'cjs', 'cf']) {
      const artifact = first.artifacts[variant];
      assert.equal(artifact.sha256, repeat.artifacts[variant].sha256);
      assert.deepEqual(artifact.inputs, repeat.artifacts[variant].inputs);
      await t.test(variant + ' ordinary statement wire', () => {
        runWire(artifact, [ordinaryWire], '^v312', 10);
        t.diagnostic(variant + ' v312 ordinary wire 10/10; artifact SHA-256 ' + artifact.sha256);
      });
      await t.test(variant + ' v311 fixed-scan regression', () =>
        runWire(artifact, [scanWire], '^v311', 13));
      await t.test(variant + ' v307 no-deadline scan regression', () =>
        runWire(artifact, [oldWire, oldReentry], '^v307', 6));
    }
    assert.equal(POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE,
      'postgres-js-3.4.9-recovery-statement-deadline-v312');
  });
