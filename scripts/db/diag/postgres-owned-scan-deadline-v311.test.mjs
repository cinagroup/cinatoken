import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildOwnedScanDeadlineCandidates, POSTGRES_OWNED_SCAN_DEADLINE_FENCE } from './postgres-owned-scan-deadline.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const wire = fileURLToPath(new URL('../../../packages/core/src/storage/recovery/postgres-owned-scan-deadline.wire.test.mjs', import.meta.url));
const oldWire = fileURLToPath(new URL('../../../packages/core/src/storage/recovery/postgres-recovery-owned-scan.wire.test.mjs', import.meta.url));
const oldReentry = fileURLToPath(new URL('../../../packages/core/src/storage/recovery/postgres-recovery-owned-scan-reentry.wire.test.mjs', import.meta.url));

test('v311 default-disabled candidate is deterministic and keeps fixed-scan admission on all three bundles',
  { timeout: 180_000 }, async t => {
    const first = await buildOwnedScanDeadlineCandidates();
    const repeat = await buildOwnedScanDeadlineCandidates();
    for (const variant of ['esm', 'cjs', 'cf']) {
      const artifact = first.artifacts[variant];
      assert.equal(artifact.sha256, repeat.artifacts[variant].sha256);
      assert.deepEqual(artifact.inputs, repeat.artifacts[variant].inputs);
      await t.test(variant + ' fixed-scan wire', () => {
        const env = { ...process.env, GATEWAY_POSTGRES_RECOVERY_DRIVER: artifact.path,
          GATEWAY_POSTGRES_FACTORY_INITIALIZES_SESSION: '' };
        delete env.NODE_TEST_CONTEXT;
        const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap',
          '--test-concurrency=1', '--test-name-pattern=^v311', wire],
        { cwd: root, env, encoding: 'utf8', timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true });
        const output = (run.stdout ?? '') + (run.stderr ?? '');
        assert.equal(run.status, 0, variant + '\n' + output);
        assert.match(output, /^# pass 13\s*$/m, variant + '\n' + output);
        assert.match(output, /^# fail 0\s*$/m, variant + '\n' + output);
        assert.match(output, /^# cancelled 0\s*$/m, variant + '\n' + output);
        t.diagnostic(variant + ' v311 wire 13/13; artifact SHA-256 ' + artifact.sha256);
      });
      await t.test(variant + ' v307 no-deadline scan regression', () => {
        const env = { ...process.env, GATEWAY_POSTGRES_RECOVERY_DRIVER: artifact.path,
          GATEWAY_POSTGRES_FACTORY_INITIALIZES_SESSION: '' };
        delete env.NODE_TEST_CONTEXT;
        const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap',
          '--test-concurrency=1', '--test-name-pattern=^v307', oldWire, oldReentry],
        { cwd: root, env, encoding: 'utf8', timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true });
        const output = (run.stdout ?? '') + (run.stderr ?? '');
        assert.equal(run.status, 0, variant + '\n' + output);
        assert.match(output, /^# pass 6\s*$/m, variant + '\n' + output);
        assert.match(output, /^# fail 0\s*$/m, variant + '\n' + output);
      });
    }
    assert.equal(POSTGRES_OWNED_SCAN_DEADLINE_FENCE, 'postgres-js-3.4.9-owned-scan-deadline-v311');
  });
