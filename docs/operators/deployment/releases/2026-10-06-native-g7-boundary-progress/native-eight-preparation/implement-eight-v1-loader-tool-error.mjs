import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = "C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-next-eight-repair-0511920406eb4b37baca7e103b9080d5";
const repo = 'C:/cinagroup/cinatoken';
const plan = JSON.parse(await readFile(join(repo, 'docs/operators/deployment/releases/2026-10-06-pg73-docker-progress/native-agent/FINAL-next-eight-pg73-plan.json'), 'utf8'));
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
assert.equal(sha.status, 0);
assert.equal(sha.stdout.trim(), '6658ec978009afa5fe3f4beccf6bde358590b663');
const report = { schema: 'cinatoken.pg73.next-eight-edit.v1', startedAt: new Date().toISOString(), baseCommit: sha.stdout.trim(), files: [] };
function replaceOnce(source, needle, replacement) {
  assert.equal(source.split(needle).length, 2, `exactly one anchor required: ${needle.slice(0, 70)}`);
  return source.replace(needle, replacement);
}
for (const entry of plan.nextEight) {
  const path = join(repo, entry.file);
  const before = await readFile(path);
  assert.equal(before.length, entry.bytes);
  assert.equal(digest(before), entry.sha256);
  const original = before.toString('utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  let source = original;
  const operations = [];
  const edit = (needle, replacement) => {
    source = replaceOnce(source, needle, replacement);
    operations.push({ needle, replacement });
  };
  edit("import { readFile, readdir, writeFile } from 'node:fs/promises';", "import { readFile, writeFile } from 'node:fs/promises';");
  edit("import { grantPostgresRuntime } from './grant-postgres-runtime.ts';", "import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';");
  const loader = /\(await readdir\((migrations|migrationDir)\)\)(?:\r?\n\s*)?\.filter\((?:name|x)=>? ?(?:name|x)\.endsWith\('\.sql'\)\)\)\.sort\(\)/u;
  // Existing style variants all terminate in the same exact .sql/sort corpus loader.
  const loaders = [...source.matchAll(/\(await readdir\((?:migrations|migrationDir)\)\)\s*\.filter\((?:name|x)\s*=>\s*(?:name|x)\.endsWith\('\.sql'\)\)\)\.sort\(\)/gu)];
  assert.equal(loaders.length, 1, entry.file);
  edit(loaders[0][0], 'await listPg73Migrations()');
  const isConcurrent = entry.file.includes('request-capability-login-v356');
  const comment = isConcurrent
    ? [ '      // The concurrent call reuses its already running owned peer bridge.',
        '      let preparedConcurrentGrant;',
        '      const grantPostgresRuntime = ({ DATABASE_URL }) => preparedConcurrentGrant',
        '        ?? grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });' ].join(newline)
    : [ '      // Keep the original grant calls and exact rejection checks on the PG73 ledger.',
        '      const grantPostgresRuntime = ({ DATABASE_URL }) =>',
        '        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });' ].join(newline);
  const firstCall = [...source.matchAll(/^      await grantPostgresRuntime\([^\r\n]+\);/gmu)][0];
  assert.ok(firstCall, entry.file);
  edit(firstCall[0], comment + newline + firstCall[0]);
  if (isConcurrent) {
    edit("      const runtime = connection(cluster,'cinatoken_gateway_runtime',passwords.runtime,'runtime');",
      [ "      const grantPeer = connection(cluster,'cinatoken_gateway_migrator',passwords.migrator,'grant-peer');",
        "      const runtime = connection(cluster,'cinatoken_gateway_runtime',passwords.runtime,'runtime');" ].join(newline));
    edit('      clients.push(migrator,runtime,issuer,claim,peer);', '      clients.push(migrator,grantPeer,runtime,issuer,claim,peer);');
    const start = [ '      let concurrentGrant;', '      await migrator.begin(async tx => {' ].join(newline);
    const replacement = [
      '      let concurrentGrant;',
      '      try {',
      '      await migrator.begin(async tx => {',
      '        // Hold the production interlock before the peer installs temporary 0074.',
      '        // Only this owned transaction removes its ledger row: proposal preflight',
      '        // sees PG73 while the external grant still sees the committed 0074 row.',
      "        await tx.unsafe('SELECT pg_catalog.pg_advisory_xact_lock(746923553)');",
      '        preparedConcurrentGrant = grantPg73RuntimeFixture({',
      '          cluster, migrator: grantPeer, migratorUrl });',
      '        // The original handler is attached after proposal installation below.',
      '        preparedConcurrentGrant.catch(() => {});',
      '        let temporaryAuditVisible = false;',
      '        for (let attempt=0;attempt<60;attempt++) {',
      '          const [audit] = await tx.unsafe(`SELECT EXISTS (',
      '            SELECT 1 FROM cinatoken_gateway.schema_migrations',
      "            WHERE version='0074_config_change_audit.sql') AS installed`);",
      '          if (audit.installed) {temporaryAuditVisible=true;break;}',
      '          await delay(25);',
      '        }',
      "        assert.equal(temporaryAuditVisible,true,'owned peer must commit temporary 0074 before PG73 activation');",
      '        await tx.unsafe(`DELETE FROM cinatoken_gateway.schema_migrations',
      "          WHERE version='0074_config_change_audit.sql'`);",
    ].join(newline);
    edit(start, replacement);
    const end = "      assert.match(concurrentResult.message,/Request capability v356 is installed/u);";
    edit(end, [end,
      '      } finally {',
      '        // A failed proposal transaction also releases the interlock; await the',
      '        // helper finally before disconnecting its peer or making another grant.',
      '        if (preparedConcurrentGrant) await preparedConcurrentGrant.catch(() => {});',
      '        preparedConcurrentGrant = undefined;',
      '      }',
    ].join(newline));
  }
  const after = Buffer.from(source);
  let reversed = source;
  for (const operation of [...operations].reverse()) reversed = replaceOnce(reversed, operation.replacement, operation.needle);
  assert.equal(reversed, original);
  await writeFile(join(root, basename(path) + '.before'), before, { flag: 'wx' });
  await writeFile(join(root, basename(path) + '.after'), after, { flag: 'wx' });
  await writeFile(path, after);
  report.files.push({ file: entry.file, before: { bytes: before.length, sha256: digest(before) }, after: { bytes: after.length, sha256: digest(after) }, operations, reverseExact: true });
}
report.completedAt = new Date().toISOString();
report.actualExit = 0;
await writeFile(join(root, 'eight-edits.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ files: report.files.map(({ file, before, after, reverseExact }) => ({ file, before, after, reverseExact })), actualExit: 0 }) + '\n');
