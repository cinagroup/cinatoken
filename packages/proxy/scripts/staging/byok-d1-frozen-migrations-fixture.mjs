import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';

// The C02 staging candidate was frozen at 0068, not at the current production
// inventory. Keep its names and SQL bytes pinned when later migrations exist.
export const BYOK_D1_FROZEN_MIGRATION_COUNT=68;
export const BYOK_D1_FROZEN_MIGRATION_SHA256='7c9572bdb1c8d858e291868b213c7064f4f86d8f783894f88e4b749277b3d23f';
const directory=new URL('../../../core/migrations-d1/',import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');

/** Test-only historical SQLite input. Later SQL is deliberately not applied;
 * this fixture does not validate a current-schema candidate or native D1.
 */
export function readByokD1FrozenMigrations(source=directory){
  const inventory=readdirSync(source).filter(name=>name.endsWith('.sql')).sort();
  assert.ok(inventory.every(name=>/^\d{4}_[a-z0-9_]+\.sql$/.test(name)),'byok_frozen_migration_name');
  const names=inventory.filter(name=>Number(name.slice(0,4))<=BYOK_D1_FROZEN_MIGRATION_COUNT);
  assert.equal(names.length,BYOK_D1_FROZEN_MIGRATION_COUNT,'byok_frozen_migration_count');
  names.forEach((name,index)=>assert.equal(Number(name.slice(0,4)),index+1,'byok_frozen_migration_order'));
  const migrations=names.map(name=>{const bytes=readFileSync(new URL(name,source));return {name,sql:bytes.toString('utf8'),sha256:sha(bytes)};});
  const pinned=migrations.map(({name,sha256})=>({name,sha256}));
  assert.equal(sha(JSON.stringify(pinned)),BYOK_D1_FROZEN_MIGRATION_SHA256,'byok_frozen_migration_source_pin');
  return Object.freeze(migrations.map(migration=>Object.freeze(migration)));
}
