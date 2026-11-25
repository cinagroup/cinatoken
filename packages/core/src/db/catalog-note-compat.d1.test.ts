import assert from 'node:assert/strict';
import test from 'node:test';
import {createD1StorageContext} from '../index';
import {createSqliteD1} from '../../../proxy/src/test-support/sqlite-d1';
import {catalogNoteValue} from './catalog-note-compat';

test('new catalog notes roundtrip with legacy description writers and conditional policy edits',async()=>{
 const f=createSqliteD1();
 try {
  const repos=createD1StorageContext(f.binding).repositories;
  await repos.models.insertModel({id:'model',displayName:'Model',vendor:'other',contextWindow:null,maxTokens:null,note:'first',metadata:null});
  const read=()=>({...f.sqlite.prepare('SELECT description,note FROM models WHERE id=?').get('model')});
  assert.deepEqual(read(),{description:'first',note:'first'});
  await repos.models.updateModelByPatch('model',{description:'legacy edit'});
  assert.deepEqual(read(),{description:'legacy edit',note:'legacy edit'});
  await repos.models.updateModelWithPolicyPrecondition('model',{note:null},null,undefined);
  assert.deepEqual(read(),{description:null,note:null});
  await repos.providers.insertProvider({id:'provider',name:'Provider',endpoints:null,description:'legacy create'});
  await repos.providers.updateProviderByPatch('provider',{note:'new edit'});
  assert.deepEqual({...f.sqlite.prepare('SELECT description,note FROM providers WHERE id=?').get('provider')},{description:'new edit',note:'new edit'});
  await assert.rejects(()=>repos.providers.updateProviderByPatch('provider',{note:'a',description:'b'}),/Conflicting/);
  assert.equal(catalogNoteValue({description:null,note:'stale legacy mirror'}),null);
  assert.equal(catalogNoteValue({description:'concurrent old writer',note:'stale mirror'}),'concurrent old writer');
 } finally {f.sqlite.close();}
});
