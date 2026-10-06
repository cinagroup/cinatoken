import assert from'node:assert/strict';import{createRequire}from'node:module';
import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';
import{out,repo,info}from'./capture.mjs';
const require=createRequire(join(repo,'package.json')),ts=require('typescript');
const inputs=JSON.parse(await readFile(join(out,'history-tail-inputs.json'),'utf8'));
const records=[];
for(const r of inputs.records){
 const raw=await readFile(join(out,'tail-step-'+r.step+'.stdout.log')),text=raw.toString('utf8');
 const ast=ts.createSourceFile(r.file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 assert.equal(ast.parseDiagnostics.length,0);
 const hashes=[],urls=[],assertions=[],fixedAssertions=[];
 function walk(n){
  const line=ast.getLineAndCharacterOfPosition(n.getStart(ast)).line+1;
  if(ts.isStringLiteralLike(n)&&/^[a-f0-9]{64}$/.test(n.text)){
   let parent=n.parent;hashes.push({line,hash:n.text,parent:parent.getText(ast),sourceLine:text.split('\n')[line-1]});
  }
  if(ts.isNewExpression(n)&&n.expression.getText(ast)==='URL'&&n.arguments?.length){
   urls.push({line,source:n.getText(ast),literal:ts.isStringLiteralLike(n.arguments[0])?n.arguments[0].text:null});
  }
  if(ts.isCallExpression(n)&&/^assert\./.test(n.expression.getText(ast))){assertions.push(n.getText(ast));
   if(n.getText(ast).match(/sha256|Sha256|sha\(|digest\(|historical|originalFixture|fixtureSha|sourcePins/))fixedAssertions.push({line,source:n.getText(ast)});
  }
  ts.forEachChild(n,walk);
 }walk(ast);
 const interestingLines=text.split('\n').flatMap((s,i)=>/historicalFixture|fixtureSha|sourcePins|sourceSha256|originalFixture|legacyFixture|\.native\.test\.mjs/.test(s)?[{line:i+1,source:s}]:[]);
 records.push({...r,...info(raw),assertionCount:assertions.length,hashes,urls,fixedAssertions,interestingLines});
 console.log(JSON.stringify({step:r.step,file:r.file,assertions:assertions.length,hashes,fixtureUrls:urls.filter(x=>x.literal?.includes('native.test')),fixedAssertions,interestingLines}));
}
await writeFile(join(out,'tail-pin-scan.json'),JSON.stringify({at:new Date().toISOString(),baseCommit:inputs.authority.base,steps:[95,113],records,nativeExecuted:false,repositoryWrites:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,files:records.length,totalFixedHashLiterals:records.reduce((a,r)=>a+r.hashes.length,0)}));
