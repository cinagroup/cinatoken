import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
const root = "C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-next-eight-repair-0511920406eb4b37baca7e103b9080d5";
const repo = 'C:/cinagroup/cinatoken';
const info = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const old = JSON.parse(await readFile(join(root, 'eight-edits.json'), 'utf8'));
const file = 'scripts/db/cutover/postgres-authenticated-request-capability-login-v356.native.test.mjs';
const record = old.files.find(entry => entry.file === file);
const bytes = await readFile(join(repo, file));
assert.deepEqual(info(bytes), record.after);
const newline = '\r\n';
const needle = '        concurrentGrant=grantPostgresRuntime({ DATABASE_URL: migratorUrl }).then(';
const replacement = [
  '        const [proposalInterlock] = await tx.unsafe(`SELECT EXISTS (',
  '          SELECT 1 FROM pg_catalog.pg_locks',
  "          WHERE locktype='advisory' AND pid=pg_catalog.pg_backend_pid()",
  '            AND granted AND classid=0 AND objid=746923553 AND objsubid=1',
  '        ) AS held`);',
  "        assert.equal(proposalInterlock.held,true,'original proposal transaction must retain its interlock after session unlock');",
  needle,
].join(newline);
const source = bytes.toString('utf8');
assert.equal(source.split(needle).length, 2);
const after = Buffer.from(source.replace(needle, replacement));
await writeFile(join(root, basename(file) + '.before-original-lock-proof'), bytes, { flag: 'wx' });
await writeFile(join(root, basename(file) + '.after-original-lock-proof'), after, { flag: 'wx' });
await writeFile(join(repo, file), after);
const final = { ...old, completedAt: new Date().toISOString(), originalCandidate: 'eight-edits.json', files: old.files.map(entry => entry.file === file ? {
  ...entry, after: info(after), operations: [...entry.operations, { needle, replacement }],
} : entry) };
await writeFile(join(root, 'eight-final-edits.json'), JSON.stringify(final, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ actualExit: 0, file, before: info(bytes), after: info(after), originalCandidateRetained: true }) + '\n');
