import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPostgresRecoveryRun } from './run-usage-recovery-postgres.ts';

// The old CF bundle imports cloudflare:sockets at module load. This local hook
// makes any attempted network connection fail; the gate must reject earlier.
const socketModule = 'data:text/javascript,' + encodeURIComponent(
  'export const connect = () => { throw new Error("historical gate attempted a network socket") }',
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'cloudflare:sockets'
      ? { url: socketModule, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const persisted = JSON.parse(await readFile(join(root,
  'docs/developers/architecture/implementation-evidence/C03-postgres-local-shutdown-fence-v306-results.json'), 'utf8'));
assert.equal(persisted.version, 'v306');
assert.match(persisted.report, /^\.wrangler\/staging\/postgres-owned-cancel-v306-run-[A-Za-z0-9-]+\/results\.json$/);
const reportPath = resolve(root, persisted.report);
const relativeReport = relative(root, reportPath);
assert.ok(relativeReport && !relativeReport.startsWith('..' + sep) && !isAbsolute(relativeReport));
const scratch = JSON.parse(await readFile(reportPath, 'utf8'));
assert.equal(scratch.version, 'v306');
const options = Object.freeze({
  scope: Object.freeze({ kind: 'all' }), maxRegistrations: 1, maxItems: 1,
  concurrency: 1, leaseSeconds: 30, runBudgetMs: 60_000,
  reservedBytesPerScan: 512, reservedBytesPerConsumer: 1024,
});

for (const variant of ['esm', 'cjs', 'cf']) {
  test('v307 historical scan fence rejects SHA-pinned v306 ' + variant + ' before capacity, SQL or socket',
    { timeout: 5000 }, async () => {
      const artifact = scratch.candidate.artifacts[variant];
      assert.ok(artifact);
      assert.ok(isAbsolute(artifact.path));
      const relativeArtifact = relative(root, artifact.path);
      assert.ok(relativeArtifact.startsWith('.wrangler' + sep + 'staging' + sep) &&
        !relativeArtifact.includes('..' + sep) && !isAbsolute(relativeArtifact));
      const digest = createHash('sha256').update(await readFile(artifact.path)).digest('hex');
      assert.equal(digest, artifact.sha256);
      assert.equal(digest, persisted.artifactSha256[variant], 'v306 persistent SHA pins this old artifact');

      const postgres = (await import(pathToFileURL(artifact.path).href)).default;
      let socketCalls = 0, sqlCalls = 0, capacityCalls = 0;
      const raw = postgres({
        host: '127.0.0.1', port: 1, database: 'synthetic', username: 'synthetic',
        password: 'synthetic', ssl: false, fetch_types: false, prepare: false, max: 1,
        socket: () => { socketCalls++; throw new Error('historical gate attempted a socket'); },
      });
      assert.equal(raw.ownedCancellation, 'postgres-js-3.4.9-owned-cancel-v302');
      assert.equal(raw.ownedRecoveryScanFence, undefined, 'v306 predates the v307 scan fence');
      const guarded = new Proxy(raw, {
        get(target, key, receiver) {
          if (key === 'unsafe') return () => {
            sqlCalls++;
            throw new Error('historical gate attempted SQL');
          };
          return Reflect.get(target, key, receiver);
        },
      });
      const capacity = { tryAcquire() {
        capacityCalls++;
        throw new Error('historical gate attempted capacity acquisition');
      } };
      assert.throws(() => createPostgresRecoveryRun(
        { driver: 'postgres', raw: guarded }, options, capacity, { ownedScans: true },
      ), error => error instanceof TypeError && error.message === 'Owned recovery scan driver required');
      assert.equal(capacityCalls, 0);
      assert.equal(sqlCalls, 0);
      assert.equal(socketCalls, 0);
    });
}
