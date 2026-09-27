import assert from 'node:assert/strict';
import test from 'node:test';
import {authenticatePostgresPersonalKeyV395 as authenticate,
  PostgresPersonalPeriodPendingV395,PostgresPersonalAuthCleanupUnconfirmedV395} from './postgres-personal-key-auth-v395.ts';

const login='cinatoken_gateway_personal_key_auth';
const bearer='sk-v395-owned-personal-test-bearer';
function setup(change=()=>{},options={}) {
  const row={status:'authenticated',keyId:'key',keyLimitEpoch:4,userId:'user',workspaceId:'personal',
    userEmail:'owned@example.invalid',budgetMax:10,budgetSpent:1.25,budgetEpoch:3,budgetPeriod:'daily',
    budgetResetAt:'2026-09-28T00:00:00.000Z',includeByokInLimit:false,
    userMetadata:'{"nested":{"region":"owned"},"shared":"user"}',keyMetadata:'{"shared":"key"}',chargedCostFactors:null};
  change(row);const events=[];let receivedBearer;
  const factory=() => ({
    async begin(work){events.push('begin');const result=await work({async unsafe(sql,values){
      if(sql.includes('current_user')){events.push('identity');return [{current_role:options.role??login,
        session_role:options.session??login,transaction_isolation:options.isolation??'read committed'}];}
      if(sql.startsWith('SET LOCAL')){events.push(sql);return [];}
      events.push('authenticate');receivedBearer=values[0];if(options.query)await options.query();return [{value:row}];
    }});if(options.commit)await options.commit();events.push('commit');return result;},
    end(){events.push('close');return options.close?options.close():Promise.resolve();},
  });
  return {row,events,factory,received:()=>receivedBearer,
    params:{authConnectionString:`postgres://${login}:owned@127.0.0.1/db?sslmode=disable`,bearer}};
}

test('v395 returns only frozen authenticated fields after owned COMMIT and close',async()=>{
  const f=setup();const result=await authenticate(f.params,f.factory);
  assert.deepEqual(f.events,['begin','identity',"SET LOCAL lock_timeout='2s'","SET LOCAL statement_timeout='15s'",'authenticate','commit','close']);
  assert.equal(result.keyLimitEpoch,4);assert.equal(result.metadata.shared,'user');
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.metadata));assert.ok(Object.isFrozen(result.metadata.nested));
  assert.equal(JSON.stringify(result).includes(bearer),false);assert.equal(Object.hasOwn(result,'status'),false);
});

test('v395 unauthorized and due-period pending never produce an authenticated context',async()=>{
  for(const status of ['unauthorized','period_reset_pending','unexpected']) {
    const f=setup(row=>{for(const key of Object.keys(row))delete row[key];row.status=status;});
    if(status==='unauthorized'){assert.equal(await authenticate(f.params,f.factory),null);assert.ok(f.events.includes('commit'));}
    else await assert.rejects(authenticate(f.params,f.factory),status==='period_reset_pending'?PostgresPersonalPeriodPendingV395:TypeError);
    assert.equal(f.events.at(-1),'close');
  }
});

test('v395 role and isolation are checked before any bearer wrapper call',async()=>{
  for(const options of [{role:'cinatoken_gateway_runtime'},{session:'cinatoken_gateway_migrator'},{isolation:'repeatable read'}]) {
    const f=setup(undefined,options);await assert.rejects(authenticate(f.params,f.factory),TypeError);
    assert.deepEqual(f.events,['begin','identity','close']);
  }
});

test('v395 rejects financial drift, unbounded source data and extra credential fields inside transaction',async()=>{
  for(const change of [r=>{r.providerKey='secret';},r=>{r.budgetSpent=-1;},r=>{r.budgetSpent=0.0000001;},
    r=>{r.budgetMax=Number.MAX_SAFE_INTEGER;},r=>{r.budgetEpoch=Number.MAX_SAFE_INTEGER+1;},
    r=>{r.keyLimitEpoch=-1;},r=>{r.budgetPeriod='yearly';},r=>{r.budgetResetAt='invalid';},
    r=>{r.keyMetadata='x'.repeat(65537);},r=>{r.includeByokInLimit=1;},r=>{r.workspaceId='';}]) {
    const f=setup(change);await assert.rejects(authenticate(f.params,f.factory),TypeError);
    assert.equal(f.events.includes('commit'),false);assert.equal(f.events.at(-1),'close');
  }
});

test('v395 validates direct role DSN and bearer bounds before opening SQL',async()=>{
  for(const patch of [{bearer:'short'},{bearer:'s'.repeat(513)},
    {authConnectionString:'postgres://cinatoken_gateway_runtime:owned@127.0.0.1/db'},
    {authConnectionString:`postgres://${login}:owned@127.0.0.1/db?options=-crole=other`}]) {
    const f=setup();Object.assign(f.params,patch);await assert.rejects(authenticate(f.params,f.factory),TypeError);
    assert.deepEqual(f.events,[]);
  }
});

test('v395 unknown COMMIT and unconfirmed LOGIN close cannot release identity',async()=>{
  const commitFailure=new Error('physical commit ACK lost');
  const f=setup(undefined,{commit:async()=>{throw commitFailure;}});
  await assert.rejects(authenticate(f.params,f.factory),error=>error===commitFailure);assert.equal(f.events.at(-1),'close');
  for(const close of [async()=>{throw new Error('close lost');},()=>undefined]) {
    const f=setup(undefined,{close});await assert.rejects(authenticate(f.params,f.factory),PostgresPersonalAuthCleanupUnconfirmedV395);
    assert.ok(f.events.includes('commit'));
  }
});

test('v395 captures bearer and cancellation before owned query, and waits for cleanup',async()=>{
  const abort=new AbortController();let queryRelease,closeRelease;
  const query=new Promise(resolve=>{queryRelease=resolve;}),close=new Promise(resolve=>{closeRelease=resolve;});
  const f=setup(undefined,{query:()=>query,close:()=>close});f.params.signal=abort.signal;
  let settled=false;const work=authenticate(f.params,f.factory).finally(()=>{settled=true;});
  await new Promise(resolve=>setTimeout(resolve,0));f.params.bearer='sk-replaced-caller-bearer';abort.abort();
  f.params.signal=new AbortController().signal;assert.equal(settled,false);assert.equal(f.received(),bearer);
  queryRelease();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(settled,false);assert.equal(f.events.at(-1),'close');
  closeRelease();await assert.rejects(work);assert.equal(f.events.includes('commit'),false);
});
