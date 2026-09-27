import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildRecoveryLegacyLogGuardBundle } from './postgres-recovery-legacy-log-guard-bundle.mjs';

test('legacy log guard bundle prints exactly one explicit atomic switch transaction', () => {
  const body = readFileSync(new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url), 'utf8');
  const expected = `BEGIN;\nSET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1';\n${body.trimEnd()}\nCOMMIT;\n`;
  const bundle = buildRecoveryLegacyLogGuardBundle();
  assert.equal(bundle, expected);
  assert.match(bundle, /^BEGIN;\nSET LOCAL cinatoken\.recovery_log_guard_activation = 'reviewed-v1';\n/u);
  assert.match(bundle, /\nCOMMIT;\n$/u);
  assert.equal((bundle.match(/^BEGIN;$/gmu) ?? []).length, 1);
  assert.equal((bundle.match(/^COMMIT;$/gmu) ?? []).length, 1);
  assert.equal((bundle.match(/^SET LOCAL cinatoken\.recovery_log_guard_activation = 'reviewed-v1';$/gmu) ?? []).length, 1);
  assert.throws(() => buildRecoveryLegacyLogGuardBundle(`BEGIN;\n${body}`), /transaction delimiters/u);
  assert.throws(() => buildRecoveryLegacyLogGuardBundle(`${body}\nCOMMIT;`), /transaction delimiters/u);
  assert.throws(() => buildRecoveryLegacyLogGuardBundle(''), /nonempty/u);

  const printed = spawnSync(process.execPath, [fileURLToPath(new URL('./postgres-recovery-legacy-log-guard-bundle.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, expected);
  assert.equal(printed.stderr, '');
  const refused = spawnSync(process.execPath,
    [fileURLToPath(new URL('./postgres-recovery-legacy-log-guard-bundle.mjs', import.meta.url)), '--execute'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /only prints a SQL bundle/u);
});
