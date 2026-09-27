import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildFactProducerProposalsBundle } from './postgres-fact-producer-proposals-bundle.mjs';

const intentUrl = new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url);
const outboxUrl = new URL('../../../packages/core/migrations-proposals/postgres/settlement-outbox-producer-definer.sql', import.meta.url);
const moduleUrl = new URL('./postgres-fact-producer-proposals-bundle.mjs', import.meta.url);

test('producer proposals bundle renders one transaction in fixed order without opening a database', () => {
  const intent = readFileSync(intentUrl, 'utf8');
  const outbox = readFileSync(outboxUrl, 'utf8');
  const expected = `BEGIN;\nSET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1';\nSET LOCAL cinatoken.settlement_outbox_definer_activation = 'reviewed-v1';\n${intent.trimEnd()}\n${outbox.trimEnd()}\nCOMMIT;\n`;
  const bundle = buildFactProducerProposalsBundle();
  assert.equal(bundle, expected);
  assert.equal((bundle.match(/^BEGIN;$/gmu) ?? []).length, 1);
  assert.equal((bundle.match(/^COMMIT;$/gmu) ?? []).length, 1);
  assert.equal((bundle.match(/^SET LOCAL cinatoken\.dispatch_intent_definer_activation = 'reviewed-v1';$/gmu) ?? []).length, 1);
  assert.equal((bundle.match(/^SET LOCAL cinatoken\.settlement_outbox_definer_activation = 'reviewed-v1';$/gmu) ?? []).length, 1);
  assert.ok(bundle.indexOf('guard_request_dispatch_intent() RETURNS trigger') <
    bundle.indexOf('enqueue_usage_settlement_fact() RETURNS trigger'));

  const source = readFileSync(moduleUrl, 'utf8');
  assert.doesNotMatch(source, /(?:from|import\()\s*['"](?:postgres|pg|node:(?:net|tls|http|https|child_process))/u);
  assert.doesNotMatch(source, /DATABASE_URL/u);
  const printed = spawnSync(process.execPath, [fileURLToPath(moduleUrl)], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, DATABASE_URL: 'postgres://render-only.invalid/no-connection' },
  });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, expected);
  assert.equal(printed.stderr, '');
  const refused = spawnSync(process.execPath, [fileURLToPath(moduleUrl), '--execute'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /only prints a SQL bundle/u);
});

test('producer proposals bundle rejects empty, malformed and transaction-control fragments', () => {
  const safe = 'SELECT 1;';
  for (const invalid of ['', '  \n\t', '-- comments only\n', '/* comments only */', null, 42]) {
    assert.throws(() => buildFactProducerProposalsBundle(invalid, safe), /nonempty/u);
    assert.throws(() => buildFactProducerProposalsBundle(safe, invalid), /nonempty/u);
  }
  for (const invalid of [
    'BEGIN; SELECT 1;', 'START TRANSACTION; SELECT 1;',
    'SELECT 1;COMMIT;', 'SELECT 1; ROLLBACK;',
    'SELECT 1; END;', 'SAVEPOINT escape; SELECT 1;',
  ]) {
    assert.throws(() => buildFactProducerProposalsBundle(invalid, safe), /transaction delimiters/u);
    assert.throws(() => buildFactProducerProposalsBundle(safe, invalid), /transaction delimiters/u);
  }
  for (const invalid of ['SELECT 1', "SELECT 'unterminated;", '/* unterminated', 'SELECT 1;;']) {
    assert.throws(() => buildFactProducerProposalsBundle(invalid, safe), /unsafe|delimiter/u);
  }
  assert.equal(buildFactProducerProposalsBundle('DO $$ BEGIN PERFORM 1; END; $$;', safe),
    `BEGIN;\nSET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1';\nSET LOCAL cinatoken.settlement_outbox_definer_activation = 'reviewed-v1';\nDO $$ BEGIN PERFORM 1; END; $$;\n${safe}\nCOMMIT;\n`);
});
