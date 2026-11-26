import assert from 'node:assert/strict';
import test from 'node:test';
import {createD1StorageContext} from '@octafuse/core';
import {createSqliteD1} from '../test-support/sqlite-d1';
import {authenticateOAuthGatewayActor} from './oauth-gateway-actor';

function fixture() {
 const db=createSqliteD1();
 db.sqlite.exec(`INSERT INTO users(id,email,external_system,external_user_id,budget_max) VALUES('owner','owner@example.invalid','cinaauth','verified-owner',10),('other','other@example.invalid','cinaauth','verified-other',10);`);
 return {...db,repos:createD1StorageContext(db.binding).repositories};
}
const token={oauthAccessTokenId:'test-token',userId:'owner',clientId:'test-client'};
test('OAuth actors provision a hashed tenant-bound key once, preserve revocation, and reject cross-tenant reuse',async()=>{
 const f=fixture();
 try {
  const first=await authenticateOAuthGatewayActor(f.repos,token);
  assert.equal(first?.key.workspaceId,'personal:owner');
  assert.equal(first?.key.userId,'owner');
  assert.match(first?.lookupHash ?? '',/^sha256:[a-f0-9]{64}$/);
  const stored=f.sqlite.prepare('SELECT key,key_hash FROM api_keys WHERE id=?').get('oauth:test-token');
  assert.equal(stored?.key_hash,first?.lookupHash);
  assert.notEqual(stored?.key,first?.lookupHash);
  assert.deepEqual(await authenticateOAuthGatewayActor(f.repos,token),first);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM api_keys').get()?.n,1);
  assert.equal(await authenticateOAuthGatewayActor(f.repos,{...token,userId:'other'}),null);
  f.sqlite.exec(`UPDATE api_keys SET status='revoked' WHERE id='oauth:test-token'`);
  assert.equal(await authenticateOAuthGatewayActor(f.repos,token),null);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM api_keys').get()?.n,1);
 } finally {f.sqlite.close();}
});
test('OAuth actors recheck active workspace and verified identity, and tolerate concurrent materialization',async()=>{
 const f=fixture();
 try {
  const results=await Promise.all([authenticateOAuthGatewayActor(f.repos,token),authenticateOAuthGatewayActor(f.repos,token)]);
  assert.ok(results.every(r=>r?.key.keyId==='oauth:test-token'));
  f.sqlite.exec(`UPDATE workspaces SET status='archived' WHERE id='personal:owner'`);
  assert.equal(await authenticateOAuthGatewayActor(f.repos,token),null);
  f.sqlite.exec(`UPDATE users SET status='disabled' WHERE id='owner'`);
  assert.equal(await authenticateOAuthGatewayActor(f.repos,{...token,oauthAccessTokenId:'new-token'}),null);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM api_keys').get()?.n,1);
 } finally {f.sqlite.close();}
});
