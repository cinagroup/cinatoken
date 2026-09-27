import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const bodyUrl = new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url);
const transactionCommand = /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;\s*$/imu;

/** Render only. This module never opens a database connection or executes SQL. */
export function buildRecoveryLegacyLogGuardBundle(
  body = readFileSync(bodyUrl, 'utf8'),
) {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new TypeError('A nonempty recovery log guard body is required');
  }
  if (transactionCommand.test(body)) {
    throw new TypeError('The guard body must not contain transaction delimiters');
  }
  return `BEGIN;\nSET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1';\n${body.trimEnd()}\nCOMMIT;\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    throw new TypeError('This command only prints a SQL bundle and accepts no options');
  }
  process.stdout.write(buildRecoveryLegacyLogGuardBundle());
}
