import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAuthEngine} from './postgres-auth-engine.mjs';
import {gateway as g} from './postgres-financial-engine.mjs';

export async function projectionImplementation(file) {
  const before=process.env.GATEWAY_PG_PROJECTION_BASELINE_DIR;
  return import(before?pathToFileURL(resolve(before,file.replace(/\.ts$/,'.js'))).href:new URL('../storage/'+file,import.meta.url).href);
}
export async function createProjectionEngine() {
  assert.ok(!process.env.GATEWAY_PG_AUTH_BASELINE_DIR);
  const f=await createAuthEngine(), extra=['identity_event_inbox','guardrail_versions'];
  try{
    for(const table of extra)await f.pg.exec(`CREATE TABLE public.${table} (LIKE ${g}.${table} INCLUDING DEFAULTS INCLUDING INDEXES);
      CREATE TEMP TABLE ${table} (LIKE ${g}.${table} INCLUDING DEFAULTS INCLUDING INDEXES)`);
    async function snapshot(schema){
      const base=await f.snapshot(schema);
      for(const table of extra)base.push([table,(await f.rows(`SELECT md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) AS digest FROM ${schema}.${table} t`))[0].digest]);
      return base;
    }
    async function reset(path){
      await f.pg.exec(`TRUNCATE ${extra.map(t=>`${g}.${t}`).join(',')} CASCADE;
        TRUNCATE ${extra.flatMap(t=>[`public.${t}`,`pg_temp.${t}`]).join(',')}`);
      await f.reset(path);
      for(const schema of ['public','pg_temp'])await f.pg.exec(`UPDATE ${schema}.organizations SET name='Shadow organization';
        UPDATE ${schema}.organization_memberships SET user_id='other',roles_json='["shadow-role"]'`);
      f.queries.length=0;f.transactions.length=0;
      return {public:await snapshot('public'),temp:await snapshot('pg_temp')};
    }
    return {...f,snapshot,reset};
  }catch(error){await f.pg.close();throw error;}
}
