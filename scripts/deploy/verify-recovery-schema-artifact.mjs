/** Read-only LOCAL artifact check. No generation approval, remote DB or migration command. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECOVERY_SCHEMA_ARTIFACT as artifact } from '../../packages/core/src/storage/recovery/usage-recovery-schema-artifact.ts';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function readRecoveryMigrationSources() {
  const root=new URL('../../packages/core/',import.meta.url);
  return {
    base:readdirSync(new URL('migrations-d1/',root)).filter(name=>name.endsWith('.sql')).sort()
      .map(name=>({name,sql:readFileSync(new URL('migrations-d1/'+name,root),'utf8')})),
    proposals:artifact.proposals.map(({name})=>({name,sql:readFileSync(new URL('migrations-proposals/d1/'+name,root),'utf8')})),
  };
}
export function verifyRecoverySchemaArtifact({base,proposals}=readRecoveryMigrationSources()) {
  assert.equal(base.length,artifact.baseMigrationCount,'Formal migration count drift');
  assert.equal(hash(JSON.stringify(base.map(({name,sql})=>({name,sha256:hash(sql)})))),artifact.baseMigrationSetSha256,'Formal migration source drift');
  assert.deepEqual(proposals.map(({name,sql})=>({name,sha256:hash(sql)})),artifact.proposals,'Recovery proposal source drift');
  // Never execute different SQL and silently bless the resulting manifest.
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for(const source of [...base,...proposals])db.exec(source.sql);
    const rows=db.prepare(`SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE tbl_name IN (${artifact.tables.map(()=>'?').join(',')}) ORDER BY type COLLATE BINARY,name COLLATE BINARY`).all(...artifact.tables);
    const actual=rows.map(row=>({type:row.type,name:row.name,table:row.tbl_name,bytes:row.sql===null?null:Buffer.byteLength(row.sql),sha256:row.sql===null?null:hash(row.sql)}));
    assert.deepEqual(actual,artifact.objects,'SQLite definitions differ from reviewed artifact');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    return {status:'LOCAL_ARTIFACT_MATCH',version:artifact.version,formalMigrations:base.length,proposals:proposals.length,
      objects:actual.length,definitionBytes:actual.reduce((n,row)=>n+(row.bytes??0),0),sqliteVersion:db.prepare('SELECT sqlite_version() AS v').get().v,
      baseMigrationSetSha256:artifact.baseMigrationSetSha256,remoteVerified:false,sqlExecutedOnlyInMemory:true};
  } finally { db.close(); }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length,2,'No update, enable, deployment or database-path arguments accepted');
  console.log(JSON.stringify(verifyRecoverySchemaArtifact()));
}
