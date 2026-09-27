// Child process used only by dispatch-intent.d1.test.mjs. Abrupt exit models lost acknowledgement.
import { createSqliteD1 } from '../../../../proxy/src/test-support/sqlite-d1.ts';
import { createDispatchIntentRepositoryD1 } from './dispatch-intent-d1.ts';
const [filename, mode, encodedRef] = process.argv.slice(2);
if (!filename || !['prepare-after', 'claim-before', 'claim-after'].includes(mode)) throw new Error('Invalid restart fixture');
const ref = JSON.parse(encodedRef);
const isIntent = sql => sql.startsWith('INSERT INTO request_dispatch_intents');
const isClaim = sql => sql.startsWith('UPDATE request_dispatch_intents') && sql.includes("SET state='dispatch_claimed'");
const db = createSqliteD1({
  beforeStatement(sql) { if (mode === 'claim-before' && isClaim(sql)) process.exit(73); },
  afterStatement(sql) { if ((mode === 'prepare-after' && isIntent(sql)) || (mode === 'claim-after' && isClaim(sql))) process.exit(73); },
}, { filename, applyMigrations: false });
const repo = createDispatchIntentRepositoryD1(db.binding);
if (mode === 'prepare-after') await repo.prepare(ref, 100, 1000);
else await repo.claim(ref, 0, '11111111-1111-4111-8111-111111111111', 200);
throw new Error('Crash hook was not reached');
