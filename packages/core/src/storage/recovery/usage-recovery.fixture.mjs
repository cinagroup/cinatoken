import { setup } from './usage-settlement-test-support.mjs';
import { runUsageRecoveryD1 } from './run-usage-recovery-d1.ts';
import { createRequestCapacityPool } from '../../../../proxy/src/services/request-capacity.ts';

// Test-only process: receives a DB path and clock, never an original request/settlement DTO.
const [filename, mode, seconds] = process.argv.slice(2);
const db = setup(null, { filename, applyMigrations: false });
db.sqlite.function('unixepoch', { varargs: true }, () => Number(seconds));
if (mode === 'claim-after') db.hooks.afterStatement = sql => {
  if (sql.startsWith('UPDATE request_usage_recovery_jobs SET') && sql.includes('attempts=MIN')) process.exit(73);
};
if (mode === 'batch-before') db.hooks.beforeStatement = sql => {
  if (sql.startsWith('INSERT INTO request_usage_commit_receipts')) process.exit(73);
};
if (mode === 'batch-after') db.hooks.afterBatch = () => process.exit(73);
try {
  const result = await runUsageRecoveryD1(db.client, { scope: { kind: 'all' }, maxItems: 5, concurrency: 1,
    leaseSeconds: 10, runBudgetMs: 10000, reservedBytesPerConsumer: 1024 },
  createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1024 }));
  process.stdout.write(JSON.stringify(result));
} finally { db.sqlite.close(); }
