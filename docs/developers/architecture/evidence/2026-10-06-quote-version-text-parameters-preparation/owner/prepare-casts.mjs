import assert from'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';import{createRequire}from'node:module';
import{out,repo,info}from'./capture.mjs';
const input=JSON.parse(await readFile(join(out,'inputs.json'),'utf8')),before=await readFile(join(out,'source.before.mjs'));
assert.deepEqual(info(before),input.before);assert.deepEqual(await readFile(join(repo,input.target)),before);
const text=before.toString('utf8');assert.deepEqual(Buffer.from(text),before);
const ts=createRequire(join(repo,'package.json'))('typescript'),ast=ts.createSourceFile(input.target,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),queries=[];
function visit(n){if(ts.isCallExpression(n)&&/\.unsafe$/.test(n.expression.getText(ast))&&n.arguments[0]){
 const sql=n.arguments[0].getText(ast);if(sql.includes(' AS after_insert')||sql.includes("resolve_shared_key_quote_at_time('quote-key-a',$1)"))queries.push({start:n.arguments[0].getStart(ast),end:n.arguments[0].end,source:sql,call:n.getText(ast)});
}ts.forEachChild(n,visit)}visit(ast);assert.equal(queries.length,3);
const edits=[];
for(const q of queries){if(q.source.includes(' AS after_insert'))for(const p of ['$1','$2']){
 const needle=p+'::timestamptz';assert.equal(q.source.split(needle).length,2);const offset=q.start+q.source.indexOf(needle)+p.length;
 edits.push({queryIndex:queries.indexOf(q),offset,insertion:'::text',parameter:p,originalLine:ast.getLineAndCharacterOfPosition(offset).line+1});
}else{const needle="'quote-key-a',$1)";assert.equal(q.source.split(needle).length,2);
 const offset=q.start+q.source.indexOf(needle)+needle.length-1;edits.push({queryIndex:queries.indexOf(q),offset,insertion:'::text::timestamptz',parameter:'$1',originalLine:ast.getLineAndCharacterOfPosition(offset).line+1});}}
assert.deepEqual(edits.map(e=>e.originalLine),[470,470,473,497]);assert.equal(edits.length,4);
let after=text;for(const e of[...edits].sort((a,b)=>b.offset-a.offset))after=after.slice(0,e.offset)+e.insertion+after.slice(e.offset);
const bytes=Buffer.from(after);assert.equal(bytes.length-before.length,50);
await writeFile(join(out,'source.prepared-after.mjs'),bytes,{flag:'wx'});
await writeFile(join(out,'four-cast-plan.json'),JSON.stringify({actualExit:0,baseCommit:input.baseCommit,target:input.target,before:info(before),after:info(bytes),queries,edits,
 onlyInsertions:true,noNewlinesInserted:true,repositoryWritePaths:[input.target]},null,2)+'\n',{flag:'wx'});
await writeFile(join(repo,input.target),bytes);
console.log(JSON.stringify({actualExit:0,repositoryFiles:1,queries:3,parameterCasts:4,...info(bytes),nativeExecuted:false}));
