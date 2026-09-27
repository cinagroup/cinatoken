import assert from 'node:assert/strict';
import {createProjectionEngine} from './postgres-projection-engine.mjs';
import {gateway as g} from './postgres-financial-engine.mjs';
import {encryptSharedKeySecret} from '../lib/shared-key-encryption.ts';

export async function createByokEngine(){
  const f=await createProjectionEngine();
  try{
    assert.ok(!process.env.GATEWAY_PG_PROJECTION_BASELINE_DIR);
    const secret='synthetic-local-test-kek-not-a-real-secret';
    const ciphertext=await encryptSharedKeySecret('synthetic-provider-key',secret,'local-fixture');
    const rotated=await encryptSharedKeySecret('synthetic-rotated-key',secret,'local-fixture');
    for(const s of ['public','pg_temp'])await f.pg.exec(s==='pg_temp'
      ?`CREATE TEMP TABLE byok_keys (LIKE ${g}.byok_keys INCLUDING DEFAULTS INCLUDING INDEXES)`
      :`CREATE TABLE public.byok_keys (LIKE ${g}.byok_keys INCLUDING DEFAULTS INCLUDING INDEXES)`);
    async function snapshot(schema){const result=await f.snapshot(schema);result.push(['byok_keys',(await f.rows(`SELECT md5(COALESCE(string_agg(row_to_json(t)::text,E'\n' ORDER BY row_to_json(t)::text),'')) AS digest FROM ${schema}.byok_keys t`))[0].digest]);return result;}
    async function reset(path){
      await f.pg.exec(`TRUNCATE ${g}.byok_keys,public.byok_keys,pg_temp.byok_keys`);await f.reset(path);
      for(const [id,workspace,sort,fallback,creator]of [['byok-a','workspace',0,false,'management'],['byok-b','workspace',1,true,'management'],['byok-org','org-workspace',0,false,'org-management'],['byok-other','other-workspace',0,false,null]])await f.pg.query(`INSERT INTO ${g}.byok_keys (id,workspace_id,provider,name,api_key_encrypted,label,sort_order,is_fallback,created_by_management_key_id) VALUES ($1::text,$2,'fixture',$1::text,$3,'label',$4,$5,$6)`,[id,workspace,ciphertext,sort,fallback,creator]);
      for(const s of ['public','pg_temp'])await f.pg.exec(`INSERT INTO ${s}.byok_keys SELECT * FROM ${g}.byok_keys;UPDATE ${s}.byok_keys SET name='Shadow credential',allowed_user_ids_json='["shadow-user"]'`);
      f.queries.length=0;f.transactions.length=0;return {public:await snapshot('public'),temp:await snapshot('pg_temp')};
    }
    return {...f,reset,snapshot,ciphertext,rotated};
  }catch(error){await f.pg.close();throw error;}
}
