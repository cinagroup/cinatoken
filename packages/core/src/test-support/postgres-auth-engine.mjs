import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createFinancialEngine, gateway as g, now} from './postgres-financial-engine.mjs';
import {hashLookupKey, prepareGatewayApiKeyForStorage} from '../lib/key-hash.ts';

export const inferenceSecret = 'sk-local-engine-inference-not-a-real-key';
export const managementSecret = 'sk-local-engine-management-not-a-real-key';
export const personal = {accountType:'personal',personalOwnerUserId:'user',organizationId:null};
export const organization = {accountType:'organization',personalOwnerUserId:null,organizationId:'org'};
export async function authImplementation(relative) {
  const before = process.env.GATEWAY_PG_AUTH_BASELINE_DIR;
  return import(before ? pathToFileURL(resolve(before,relative.replace(/\.ts$/,'.js'))).href : new URL('../'+relative,import.meta.url).href);
}

// Only parameter substitution is adapted. No query results, authorization,
// transaction outcome, socket, session pool or concurrency is simulated here.
function tagged(raw) {
  function sql(strings,...values) {
    assert.ok(Array.isArray(strings.raw),'Only literal tagged templates are supported');
    assert.ok(values.every(v=>v===null||['string','number','boolean'].includes(typeof v)),'No builder/identifier interpolation');
    return raw.unsafe(strings.reduce((text,part,i)=>text+(i?'$'+i:'')+part,''),values);
  }
  sql.unsafe=raw.unsafe.bind(raw);
  sql.begin=callback=>raw.begin(tx=>callback(tagged(tx)));
  sql.options=raw.options;
  return sql;
}
const extraTables=['organizations','organization_memberships','workspace_memberships','management_api_keys'];
export async function createAuthEngine() {
  assert.ok(!process.env.GATEWAY_PG_FINANCIAL_BASELINE,'Auth comparison must not change the financial helper baseline');
  const f=await createFinancialEngine();
  try {
    const prepared=await prepareGatewayApiKeyForStorage(inferenceSecret);
    const managementHash=await hashLookupKey(managementSecret);
    const orgHash=await hashLookupKey(managementSecret+'-org');
    for(const table of extraTables) await f.pg.exec(`CREATE TABLE public.${table} (LIKE ${g}.${table} INCLUDING DEFAULTS INCLUDING INDEXES);
      CREATE TEMP TABLE ${table} (LIKE ${g}.${table} INCLUDING DEFAULTS INCLUDING INDEXES)`);
    const rows=async(sql,params=[]) => (await f.pg.query(sql,params)).rows;
    async function snapshot(schema) {
      const base=await f.snapshot(schema);
      for(const table of extraTables) base.push([table,(await rows(`SELECT md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) AS digest FROM ${schema}.${table} t`))[0].digest]);
      return base;
    }
    async function reset(path) {
      await f.pg.exec(`TRUNCATE ${extraTables.map(t=>`${g}.${t}`).join(',')} CASCADE;
        TRUNCATE ${extraTables.flatMap(t=>[`public.${t}`,`pg_temp.${t}`]).join(',')}`);
      await f.reset(path);
      await f.pg.query(`UPDATE ${g}.api_keys SET key=$1,key_hash=$2,key_preview=$3,name='Gateway key' WHERE id='key'`,[prepared.storageKey,prepared.keyHash,prepared.keyPreview]);
      await f.pg.exec(`UPDATE ${g}.users SET external_system='cinaauth',external_user_id='subject' WHERE id='user';
        INSERT INTO ${g}.organizations (id,source,name,status,source_updated_at) VALUES ('org','cinaauth','Organization','active',CURRENT_TIMESTAMP);
        INSERT INTO ${g}.workspaces (id,scope_type,organization_id,name,slug) VALUES ('org-workspace','organization','org','Organization workspace','org');
        INSERT INTO ${g}.organization_memberships (organization_id,subject,user_id,source_updated_at) VALUES ('org','subject','user',CURRENT_TIMESTAMP);
        INSERT INTO ${g}.workspace_memberships (id,membership_key,workspace_id,subject) VALUES ('membership',repeat('a',64),'org-workspace','subject')`);
      for(const [id,hash,account] of [['management',managementHash,personal],['org-management',orgHash,organization]]) {
        await f.pg.query(`INSERT INTO ${g}.management_api_keys (id,key_hash,key_preview,account_type,personal_owner_user_id,organization_id,name,created_by_user_id)
          VALUES ($1,$2,'mgmt-preview',$3,$4,$5,'Gateway management','user')`,[id,hash,account.accountType,account.personalOwnerUserId,account.organizationId]);
      }
      for(const schema of ['public','pg_temp']) {
        for(const table of extraTables) await f.pg.exec(`INSERT INTO ${schema}.${table} SELECT * FROM ${g}.${table}`);
        await f.pg.query(`UPDATE ${schema}.api_keys SET key=$1,key_hash=$2,name='Shadow key'`,[prepared.storageKey,prepared.keyHash]);
        await f.pg.exec(`UPDATE ${schema}.management_api_keys SET name='Shadow management';
          INSERT INTO ${schema}.workspaces SELECT * FROM ${g}.workspaces WHERE id='org-workspace'`);
      }
      await f.pg.exec(`SET search_path TO ${path}; DISCARD PLANS`);
      f.queries.length=0; f.transactions.length=0;
      return {public:await snapshot('public'),temp:await snapshot('pg_temp')};
    }
    return {...f,client:{...f.client,raw:tagged(f.client.raw)},rows,snapshot,reset,prepared,managementHash,orgHash,now};
  } catch(error) {await f.pg.close();throw error;}
}
