import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createByokEngine} from '../test-support/postgres-byok-engine.mjs';
import {createSlotD1Engine} from '../test-support/byok-slots-d1-engine.mjs';

const account={accountType:'personal',personalOwnerUserId:'user',organizationId:null};
const management={...account,keyId:'management',createdByUserId:'user'};
const portal={...account,principalType:'portal_user',workspaceId:'workspace',userId:'user'};
const now='2026-09-16T00:00:00.000Z';
const product=await import(process.env.GATEWAY_BYOK_SLOTS_BASELINE
  ?pathToFileURL(resolve(process.env.GATEWAY_BYOK_SLOTS_BASELINE)).href:new URL('./byok-keys.ts',import.meta.url).href);
const only=process.env.GATEWAY_BYOK_SLOTS_ENGINE;
assert.ok(!only||['d1','postgres'].includes(only));

for(const dialect of ['d1','postgres'].filter(x=>!only||only===x))test(dialect+': BYOK append reclaims holes atomically without changing priority',async t=>{
  const pg=dialect==='postgres';
  const f=pg?await createByokEngine():createSlotD1Engine();t.after(()=>pg?f.pg.close():f.db.close());
  const g=pg?'cinatoken_gateway.':'',table=g+'byok_keys';
  const exec=sql=>pg?f.pg.exec(sql):f.exec(sql),query=(sql,values)=>pg?f.pg.query(sql,values):f.query(sql,values);
  const byok=product.createByokKeysRepository(f.client),cipher=pg?f.ciphertext:'enc:v2:synthetic-fixture';
  const base={workspaceId:'workspace',provider:'fixture',name:'New',apiKey:cipher,label:'label',disabled:false,isFallback:true,alwaysUseForProvider:false,alwaysUseForMatchingModels:false,allowedModels:null,allowedUserIds:null,allowedApiKeyHashes:null};
  const insert=(principal=management,id='new',input={})=>byok.insertForManagement({principal,id,nowIso:now,input:{...base,...input}});
  const del=(id,principal=management)=>byok.deleteForManagement({principal,id,nowIso:now});
  const rows=()=>f.rows(`SELECT * FROM ${table} ORDER BY id`);
  const live=()=>f.rows(`SELECT * FROM ${table} WHERE workspace_id='workspace' AND provider='fixture' AND deleted_at IS NULL ORDER BY sort_order,id`);
  const state=async()=>({keys:await rows(),audit:await f.rows(`SELECT * FROM ${g}user_audit_logs ORDER BY id`)});
  const runtime=async()=>(await byok.listActiveForRequest({workspaceId:'workspace',provider:'fixture',modelId:'fixture/model',userId:'user',apiKeyHash:'a'.repeat(64)})).map(r=>r.id);
  const id=i=>'slot-'+String(99-i).padStart(2,'0'); // ID order deliberately opposes slot order.
  async function seed(slots=Array.from({length:100},(_,i)=>i)){
    await exec(`DELETE FROM ${table};DELETE FROM ${g}user_audit_logs;`);
    const records=slots.map(i=>[id(i),'workspace','fixture',cipher,i,i%7===0,i>=50,i===1,i===2]);
    records.push(['other-provider','workspace','other-provider',cipher,99,false,false,false,false],['other-workspace','other-workspace','fixture',cipher,99,false,false,false,false]);
    for(const values of records){
      const binds=values.map((_,i)=>pg?'$'+(i+1):'?').join(',');
      await query(`INSERT INTO ${table}(id,workspace_id,provider,api_key_encrypted,sort_order,disabled,is_fallback,always_use_for_provider,always_use_for_matching_models,label,allowed_models_json,allowed_user_ids_json,allowed_api_key_hashes_json,created_at,updated_at)
        VALUES(${binds},'label','["fixture/model"]','["user"]','["${'a'.repeat(64)}"]','2026-09-15T00:00:00.000Z','2026-09-15T00:00:00.000Z')`,pg?values:values.map(x=>typeof x==='boolean'?Number(x):x));
    }
    f.queries.length=0;
  }
  async function failure(step){
    const conditions={move:"NEW.provider LIKE 'cinatoken-compact-%' AND OLD.provider='fixture'",rank:"NEW.provider LIKE 'cinatoken-compact-%' AND NEW.sort_order<>OLD.sort_order",restore:"OLD.provider LIKE 'cinatoken-compact-%' AND NEW.provider='fixture'"};
    const on=step==='audit'?g+'user_audit_logs':table,event=conditions[step]?'UPDATE':'INSERT';
    if(pg){
      await exec(`CREATE FUNCTION cinatoken_gateway.slot_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'slot_test_failure'; END $$;
        CREATE TRIGGER slot_test_failure BEFORE ${event} ON ${on} FOR EACH ROW ${conditions[step]?`WHEN (${conditions[step]})`:''} EXECUTE FUNCTION cinatoken_gateway.slot_test_failure();`);
      return ()=>exec(`DROP TRIGGER slot_test_failure ON ${on};DROP FUNCTION cinatoken_gateway.slot_test_failure();`);
    }
    await exec(`CREATE TRIGGER slot_test_failure BEFORE ${event} ON ${on} ${conditions[step]?'WHEN '+conditions[step]:''} BEGIN SELECT RAISE(ABORT,'slot_test_failure'); END;`);
    return ()=>exec('DROP TRIGGER slot_test_failure;');
  }
  const cases={};
  for(const [actor,principal]of [['management',management],['portal',portal]]){
    for(const holes of [[0],[1],[49],[98],[99],[0,50,99],Array.from({length:50},(_,i)=>i*2)])cases[actor+' removes '+holes.join(',')+' and appends at tail']=async()=>{
      await seed();for(const hole of holes)assert.equal(await del(id(hole),principal),true);
      const before=await live(),allBefore=await rows(),runtimeBefore=await runtime();
      const result=await insert(principal);assert.equal(result.sort_order,holes.includes(99)?99:before.length);
      const after=await live();assert.deepEqual(after.map(x=>x.id),[...before.map(x=>x.id),'new']);
      const withoutSlot=row=>{const {sort_order,...rest}=row;return rest;};
      assert.deepEqual(after.slice(0,-1).map(withoutSlot),before.map(withoutSlot));
      const unchanged=r=>r.workspace_id!=='workspace'||r.provider!=='fixture'||r.deleted_at!==null;
      assert.deepEqual((await rows()).filter(unchanged),allBefore.filter(unchanged));
      assert.deepEqual((await runtime()).filter(x=>x!=='new'),runtimeBefore);
      assert.equal((await rows()).filter(x=>x.provider.startsWith('cinatoken-compact-')).length,0);
      assert.ok(!JSON.stringify((await state()).audit).includes(cipher));
      assert.equal(new Set(after.map(x=>x.sort_order)).size,after.length);
    };
    for(const step of ['move','rank','restore','insert','audit'])cases[actor+' '+step+' failure rolls back compaction and audit']=async()=>{
      await seed();await del(id(0),principal);const before=await state(),cleanup=await failure(step);
      try{await assert.rejects(insert(principal),/slot_test_failure/);assert.deepEqual(await state(),before);}
      finally{await cleanup();}
    };
    cases[actor+' full capacity denies without changes']=async()=>{
      await seed();const before=await state();if(pg)await assert.rejects(insert(principal),/key limit reached/);else assert.equal(await insert(principal),null);assert.deepEqual(await state(),before);
    };
  }
  for(const [name,sql,principal]of [
    ['revoked management',`UPDATE ${g}management_api_keys SET status='revoked' WHERE id='management'`,management],
    ['disabled portal',`UPDATE ${g}users SET status='disabled' WHERE id='user'`,portal],
    ['archived workspace',`UPDATE ${g}workspaces SET status='archived' WHERE id='workspace'`,management],
    ['foreign owner',null,{...management,personalOwnerUserId:'other'}],
  ])cases[name+' cannot compact or create']=async()=>{
    await seed();await del(id(0));if(sql)await exec(sql);const before=await state();assert.equal(await insert(principal),null);assert.deepEqual(await state(),before);
  };
  cases['spare tail preserves existing sparse slot values']=async()=>{
    await seed([0,12,48]);const before=await live();assert.equal((await insert()).sort_order,49);assert.deepEqual((await live()).slice(0,-1),before);
  };
  cases['single last slot compacts to zero and empty list starts at zero']=async()=>{
    await seed([99]);assert.equal((await insert()).sort_order,1);assert.deepEqual((await live()).map(x=>x.sort_order),[0,1]);
    await seed([]);assert.equal((await insert()).sort_order,0);
  };
  cases['duplicate ID after compaction rolls back all changes']=async()=>{
    await seed();await del(id(0));const before=await state();await assert.rejects(insert(management,'other-provider'),/unique|UNIQUE|duplicate/);assert.deepEqual(await state(),before);
  };
  cases['full delete append reorder delete append lifecycle remains bounded']=async()=>{
    await seed();await del(id(49));await insert();
    const keys=(await live()).reverse().map(r=>({id:r.id,isFallback:false}));
    assert.equal(await byok.reorderForManagement({principal:management,nowIso:now,input:{workspaceId:'workspace',provider:'fixture',keys}}),'updated');
    assert.deepEqual((await live()).map(r=>r.id),keys.map(r=>r.id));assert.equal((await runtime()).length,32);
    await del(keys[50].id);await insert(portal,'new-again');assert.deepEqual((await live()).map(r=>r.id),[...keys.filter((_,i)=>i!==50).map(r=>r.id),'new-again']);
  };
  cases['compaction uses bounded metadata and a fixed number of indexed statements']=async()=>{
    await seed();await del(id(0));f.queries.length=0;await insert();
    if(pg){
      const slots=f.queries.find(x=>x.query.startsWith('SELECT id, sort_order'));
      assert.match(slots.query,/LIMIT 101 FOR UPDATE/);assert.deepEqual(slots.params,['workspace','fixture']);
      const updates=f.queries.filter(x=>x.query.startsWith('UPDATE'));assert.equal(updates.length,3);assert.equal(f.queries.length,8);
      for(const q of updates){assert.doesNotMatch(q.query,/api_key|allowed_|is_fallback|updated_at|always_use/);assert.ok(!JSON.stringify(q.params).includes(cipher));}
    }else{
      assert.deepEqual(f.batches.at(-1),{length:5,state:'committed'});assert.equal(f.queries.length,6);
      assert.match(f.queries[0].query,/AS MATERIALIZED/);
      const rangeQueries=f.queries.filter(x=>x.query.startsWith('UPDATE byok_keys'));
      assert.equal(rangeQueries.length,2);
      for(const q of rangeQueries){
        const plan=f.db.prepare('EXPLAIN QUERY PLAN '+q.query).all(...q.params).map(x=>x.detail).join('\n');
        assert.match(plan,/SEARCH byok_keys .*provider>\? AND provider<\?/);
        if(q.query.includes('sibling'))assert.match(plan,/SEARCH sibling .*provider>\? AND provider<\?/);
      }
    }
  };
  if(!pg)cases['every one of the 100 possible deleted slots can be refilled']=async()=>{
    for(let hole=0;hole<100;hole++){
      await seed();await del(id(hole));const before=await live();assert.equal((await insert()).sort_order,99);
      assert.deepEqual((await live()).map(x=>x.id),[...before.map(x=>x.id),'new']);
    }
  };
  const paths=pg?['cinatoken_gateway,public','public,pg_temp','pg_temp,public']:['sqlite'];
  for(const path of paths)for(const[name,operation]of Object.entries(cases))await t.test(path+': '+name,async()=>{
    const shadows=pg?await f.reset(path):null;
    if(!pg)await exec("UPDATE users SET status='active';UPDATE workspaces SET status='active';UPDATE management_api_keys SET status='active';");
    try{await operation();}finally{if(pg){assert.deepEqual(await f.snapshot('public'),shadows.public);assert.deepEqual(await f.snapshot('pg_temp'),shadows.temp);}}
  });
});
