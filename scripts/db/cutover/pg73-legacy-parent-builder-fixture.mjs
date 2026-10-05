// Test-only source fixture for a frozen review-only PG73 proposal. Production
// builders and their filesystem/SQL ledger guards are copied byte for byte.
// No database URL, grant execution, proposal activation, or source rewrite.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const lastPg73 = '0073_recovery_api_key_workspace_lock.sql';
const corpusSha256 = '23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc';
const ledgerMd5 = 'ca1ea96a1b4bcd0675642f30dcf48042';
const prefix = 'cinatoken-pg73-legacy-builder-';
const builders = [
  'build-request-legacy-parent-default-acl-activation.mjs',
  'build-request-parent-default-acl-activation.mjs',
  'build-request-legacy-parent-activation.mjs',
];
const proposals = [
  'request-dispatch-parent-deadline-budget.sql',
  'request-dispatch-replay-parent-gate.sql',
  'request-dispatch-replay-reservations.sql',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function createPg73LegacyParentBuilderFixture() {
  const migrationDirectory = resolve(repository, 'packages/core/migrations-postgres');
  const versions = (await readdir(migrationDirectory))
    .filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name) && name <= lastPg73).sort();
  assert.equal(versions.length, 73, 'Frozen PG73 migration version set differs');
  assert.equal(versions.at(-1), lastPg73);
  const migrationBytes = await Promise.all(versions.map(name => readFile(join(migrationDirectory, name))));
  const corpus = versions.map((name, index) => `${name}\n${migrationBytes[index].toString('utf8')}`).join('\n');
  assert.equal(sha256(corpus), corpusSha256, 'Frozen PG73 migration corpus differs');
  assert.equal(createHash('md5').update(versions.join('\n')).digest('hex'), ledgerMd5,
    'Frozen PG73 migration ledger differs');

  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, prefix));
  const manifest = [];
  let closed = false;
  async function cleanup() {
    if (closed) return;
    const target = await realpath(root);
    assert.equal(dirname(target), parent, 'Fixture cleanup must stay in its canonical Temp parent');
    assert.equal(resolve(target), resolve(root), 'Fixture cleanup target must be its exact owned directory');
    assert.ok(basename(target).startsWith(prefix), 'Fixture cleanup requires its owned prefix');
    await rm(target, { recursive: true });
    closed = true;
  }
  async function copy(relativePath, kind, originalBytes) {
    const source = resolve(repository, relativePath);
    const target = resolve(root, relativePath);
    assert.ok(target.startsWith(root + sep),
      'Fixture copy must stay in its owned directory');
    const bytes = originalBytes ?? await readFile(source);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    assert.equal(sha256(await readFile(target)), sha256(bytes), 'Fixture copy changed source bytes');
    manifest.push(Object.freeze({ relativePath, kind, source, target, bytes: bytes.length, sha256: sha256(bytes) }));
  }
  try {
    for (let index = 0; index < versions.length; index++) {
      await copy('packages/core/migrations-postgres/' + versions[index], 'migration', migrationBytes[index]);
    }
    for (const name of builders) await copy('scripts/db/cutover/' + name, 'builder');
    for (const name of proposals) await copy('packages/core/migrations-proposals/postgres/' + name, 'proposal');
    const module = await import(pathToFileURL(join(root, 'scripts/db/cutover', builders[0])).href);
    return Object.freeze({ root, manifest: Object.freeze(manifest), cleanup,
      async build(options) {
        assert.equal(closed, false, 'Frozen builder fixture has already been cleaned up');
        return module.buildRequestLegacyParentDefaultAclActivation(options);
      },
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}
