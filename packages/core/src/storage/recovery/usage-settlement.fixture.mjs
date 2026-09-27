// Test-only abrupt process exit. Never dispatches inference or connects to a remote database.
import { setup } from './usage-settlement-test-support.mjs';
const [filename, mode, encoded] = process.argv.slice(2);
if (!filename || !['persist-before','persist-after','batch-before','batch-after','recover'].includes(mode)) throw new Error('Invalid settlement fixture');
const db = setup(null, { filename, applyMigrations: false });
const payload = JSON.parse(encoded);
db.hooks.beforeStatement = sql => {
  if ((mode === 'persist-before' && sql.startsWith('INSERT INTO request_usage_settlements'))
    || (mode === 'batch-before' && sql.startsWith('INSERT INTO request_usage_commit_receipts'))) process.exit(73);
};
db.hooks.afterStatement = sql => { if (mode === 'persist-after' && sql.startsWith('INSERT INTO request_usage_settlements')) process.exit(73); };
db.hooks.afterBatch = sql => { if (mode === 'batch-after' && sql.some(s => s.startsWith('INSERT INTO request_usage_commit_receipts'))) process.exit(73); };
if (mode.startsWith('persist')) await db.repo.persist(payload);
else await db.repo.commit(payload);
db.sqlite.close();
if (mode !== 'recover') throw new Error('Crash hook not reached');
