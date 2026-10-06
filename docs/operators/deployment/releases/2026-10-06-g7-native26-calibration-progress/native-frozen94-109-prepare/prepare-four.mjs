import assert from'node:assert/strict';import{readFile,writeFile,mkdir,lstat}from'node:fs/promises';import{join,dirname,basename}from'node:path';
import{out,repo,info}from'./capture.mjs';
const inputs=JSON.parse(await readFile(join(out,'base-inputs.json'),'utf8')),plans=[];
for(const t of inputs.targets){
 const before=await readFile(join(out,'wrapper-'+t.step+'-original.stdout.log'));
 const frozen=await readFile(join(out,'legacy-'+t.step+'-historical.stdout.log'));
 assert.deepEqual(info(frozen),{bytes:t.oldBytes,sha256:t.pin});
 let after=before.toString('utf8');const operations=[];
 const change=(kind,needle,replacement)=>{assert.equal(after.split(needle).length,2,'Unique exact edit: '+kind);after=after.replace(needle,replacement);operations.push({kind,needle,replacement})};
 if(t.step===94){
  change('lineage-path',"historicalFixture: '"+t.legacy+"'","historicalFixture: '"+t.frozenPath+"'");
  change('historical-read-url',"'./"+basename(t.legacy)+"', import.meta.url","'./fixtures/historical-native/"+basename(t.frozenPath)+"', import.meta.url");
 }else{
  change('historical-read-url',"'./"+basename(t.legacy)+"', import.meta.url","'./fixtures/historical-native/"+basename(t.frozenPath)+"', import.meta.url");
  change('lineage-path-added',"lineage: { historicalNativeTestSha256,","lineage: { historicalNativeTest: '"+t.frozenPath+"',\n        historicalNativeTestSha256,");
 }
 assert.ok(after.includes(t.pin));
 const afterBytes=Buffer.from(after);let reverse=after;
 for(const op of[...operations].reverse()){assert.equal(reverse.split(op.replacement).length,2);reverse=reverse.replace(op.replacement,op.needle)}
 assert.deepEqual(Buffer.from(reverse),before);
 await writeFile(join(out,'wrapper-'+t.step+'.prepared-after'),afterBytes,{flag:'wx'});
 await writeFile(join(out,'frozen-'+t.step+'.prepared'),frozen,{flag:'wx'});
 plans.push({...t,wrapperBefore:info(before),wrapperAfter:info(afterBytes),snapshot:info(frozen),operations});
}
// Validate every input and destination before writing any repository path.
for(const p of plans){assert.deepEqual(info(await readFile(join(repo,p.wrapper))),p.wrapperBefore);
 let exists=false;try{await lstat(join(repo,p.frozenPath));exists=true}catch(e){assert.equal(e.code,'ENOENT')}
 assert.equal(exists,false,'Snapshot must be a new file');}
await writeFile(join(out,'four-planned-edits.json'),JSON.stringify({at:new Date().toISOString(),actualExit:0,
 baseCommit:inputs.baseCommit,allowedPaths:inputs.allowedPaths,plans,allPreparedBeforeRepositoryWrites:true},null,2)+'\n',{flag:'wx'});
const writes=[];
for(const p of plans){await mkdir(dirname(join(repo,p.frozenPath)),{recursive:true});
 const frozen=await readFile(join(out,'frozen-'+p.step+'.prepared'));await writeFile(join(repo,p.frozenPath),frozen,{flag:'wx'});writes.push({path:p.frozenPath,...info(frozen),newFile:true});
 const after=await readFile(join(out,'wrapper-'+p.step+'.prepared-after'));await writeFile(join(repo,p.wrapper),after);writes.push({path:p.wrapper,...info(after),newFile:false});}
assert.deepEqual([...writes.map(x=>x.path)].sort(),[...inputs.allowedPaths].sort());
await writeFile(join(out,'four-applied.json'),JSON.stringify({at:new Date().toISOString(),actualExit:0,
 baseCommit:inputs.baseCommit,repositoryWrites:writes,gitMutations:0,nativeExecuted:false},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,repositoryWritePaths:writes.map(w=>w.path),files:4,originalPinsPreserved:true,nativeExecuted:false}));
