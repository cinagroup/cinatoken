import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildRetirementCandidates, retireClosedTransactions, reserveAcceptedQueries, sourcePins, sha256 } from './postgres-transaction-retirement.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);

test('pinned driver retirement candidate: build parity and real Node wire contracts', { timeout: 45000 }, async t => {
  const before = {};
  for (const name of ['package-lock.json','pnpm-lock.yaml','node_modules/postgres/package.json'])
    before[name] = sha256(await readFile(new URL('../../../' + name, import.meta.url)));
  for (const [variant, pin] of Object.entries(sourcePins)) {
    const source = await readFile(new URL('../../../node_modules/postgres/' + pin.entry, import.meta.url), 'utf8');
    assert.throws(() => retireClosedTransactions(source + '\n', variant), /Unsupported/);
    assert.throws(() => retireClosedTransactions(source, 'unknown'), /Unsupported/);
    const patched = retireClosedTransactions(source, variant);
    assert.throws(() => retireClosedTransactions(patched, variant), /Unsupported/);
    assert.equal(patched.split('transactionClosed = error').length, 2);
    assert.equal(patched.split('return q.reject(transactionClosed)').length, 2);
    assert.ok(patched.indexOf('connection.onclose = error') < patched.indexOf('scope(connection, fn)'));
    const connection = await readFile(new URL('../../../node_modules/postgres/' + pin.entry.replace('index.js','connection.js'), import.meta.url), 'utf8');
    assert.throws(() => reserveAcceptedQueries(connection + '\n', variant), /Unsupported/);
    assert.throws(() => reserveAcceptedQueries(connection, 'unknown'), /Unsupported/);
    assert.throws(() => reserveAcceptedQueries(reserveAcceptedQueries(connection, variant), variant), /Unsupported/);
  }
  const built = await buildRetirementCandidates();
  const second = await buildRetirementCandidates();
  for (const variant of ['esm','cjs','cf']) {
    assert.equal(built.artifacts[variant].sha256, second.artifacts[variant].sha256, 'reproducible ' + variant);
    assert.deepEqual(built.artifacts[variant].inputs, second.artifacts[variant].inputs);
  }
  const cf = await readFile(built.artifacts.cf.path, 'utf8');
  assert.ok(cf.includes('cloudflare:sockets'));
  assert.ok(cf.includes('return q.reject(transactionClosed)'));
  assert.match(cf, /!(connection\d*)\.reserved && onopen\(\1\)/);
  t.diagnostic(JSON.stringify({ candidateBuild: built, repeatedBuildDirectory: second.directory }));
  for (const variant of ['esm','cjs']) {
    await t.test(variant + ' real driver loopback', { timeout: 18000 }, async () => {
      try {
        const env = { ...process.env, GATEWAY_POSTGRES_RECOVERY_DRIVER: built.artifacts[variant].path };
        delete env.NODE_TEST_CONTEXT;
        const result = await run(process.execPath, ['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1',
          'packages/core/src/storage/recovery/postgres-transaction-retirement.wire.test.mjs',
          'packages/core/src/storage/recovery/postgres-transaction-reservation.wire.test.mjs'], {
          cwd: root, env,
          timeout: 15000, maxBuffer: 512 * 1024, windowsHide: true,
        });
        t.diagnostic(variant + '\n' + result.stdout + result.stderr);
        assert.match(result.stdout, /# fail 0\b/);
        assert.match(result.stdout, /# tests 26\b/);
      } catch (error) { t.diagnostic(error.stdout ?? ''); t.diagnostic(error.stderr ?? ''); throw error; }
    });
  }
  const incomplete = await buildRetirementCandidates({ reservation: 'hook-only' });
  for (const variant of ['esm','cjs']) {
    await t.test(variant + ' delayed-drain negative control rejects hook-only candidate', { timeout: 10000 }, async () => {
      const env = { ...process.env, GATEWAY_POSTGRES_RECOVERY_DRIVER: incomplete.artifacts[variant].path };
      delete env.NODE_TEST_CONTEXT;
      await assert.rejects(run(process.execPath, ['--import','tsx','--test','--test-reporter=tap',
        '--test-name-pattern=delayed drain=true', 'packages/core/src/storage/recovery/postgres-transaction-reservation.wire.test.mjs'],
        { cwd: root, env, timeout: 8000, maxBuffer: 512 * 1024, windowsHide: true }), error => {
        t.diagnostic(variant + ' expected negative result\n' + error.stdout + error.stderr);
        assert.equal(error.code, 1);
        assert.match(error.stdout, /drain must not offer a reserved idle callback connection/);
        assert.match(error.stdout, /# tests 1\b/);
        assert.match(error.stdout, /# pass 0\b/);
        assert.match(error.stdout, /# fail 1\b/);
        return true;
      });
    });
  }
  t.diagnostic(JSON.stringify({ negativeBuildDirectory: incomplete.directory,
    negativeHashes: Object.fromEntries(Object.entries(incomplete.artifacts).map(([key,value]) => [key,value.sha256])) }));
  for (const [name, hash] of Object.entries(before))
    assert.equal(sha256(await readFile(new URL('../../../' + name, import.meta.url))), hash, name + ' untouched');
  for (const [variant, pin] of Object.entries(sourcePins)) {
    assert.equal(sha256(await readFile(new URL('../../../node_modules/postgres/' + pin.entry, import.meta.url))), pin.sha256, variant + ' untouched');
    assert.equal(sha256(await readFile(new URL('../../../node_modules/postgres/' + pin.entry.replace('index.js','connection.js'), import.meta.url))), pin.connection, variant + ' connection untouched');
  }
});
