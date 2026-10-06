import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {out,info} from './capture.mjs';
const raw=await readFile(join(out,'proxy-watch-1.stdout.log')),lines=raw.toString('utf8').split(/\r?\n/);
const indices=lines.flatMap((line,i)=>/^\S native-financial-consumer \(ID 112155793299\)/.test(line)?[i]:[]);
if(!indices.length)throw Error('No original watch native section');
const last=indices.at(-1),rows=[];
for(let i=last+1;i<lines.length;i++){const match=/^  ([✓X*\-]) (.*)$/.exec(lines[i]);if(match)rows.push({icon:match[1],name:match[2]});else if(rows.length)break;}
const initial=JSON.parse(await readFile(join(out,'proxy-initial.stdout.log'),'utf8')),native=initial.jobs.find(j=>j.databaseId===112155793299);
const map=JSON.parse(await readFile(join(out,'original-workflow-map.json'),'utf8')),currentIndex=rows.findIndex(r=>r.icon==='*'),lastSuccessIndex=rows.findLastIndex(r=>r.icon==='✓');
const limit=currentIndex>=0?currentIndex+1:rows.length;
const prefixExact=limit<=native.steps.length&&rows.slice(0,limit).every((r,i)=>r.name===native.steps[i].name);
const current=currentIndex<0?null:{watchOrdinal:currentIndex+1,name:rows[currentIndex].name,actualNumber:prefixExact?native.steps[currentIndex].number:null};
let closed=false;try{await stat(join(out,'proxy-watch-1.closed.json'));closed=true;}catch(e){if(e.code!=='ENOENT')throw e;}
console.log(JSON.stringify({readAt:new Date().toISOString(),sourceSha:initial.headSha,originalRun:37429192670,nativeJobId:112155793299,
 watchToolSession:75118,originalPid:20316,watchClosedReceiptExists:closed,watchSectionHeader:lines[last],rows:rows.length,initialApiPrefixNamesExact:prefixExact,
 current,currentFixture:current?.actualNumber?map.fixtures.find(f=>f.step===current.actualNumber)??null:null,
 lastSuccess:lastSuccessIndex<0?null:{watchOrdinal:lastSuccessIndex+1,name:rows[lastSuccessIndex].name,actualNumber:prefixExact?native.steps[lastSuccessIndex]?.number??null:null},
 failures:rows.flatMap((r,i)=>r.icon==='X'?[{watchOrdinal:i+1,name:r.name,actualNumber:prefixExact?native.steps[i]?.number??null:null}]:[]),
 watchedPrefix:{path:join(out,'proxy-watch-1.stdout.log'),...info(raw),notCompleteUntilOriginalWatchCloses:true},
 watchStderr:info(await readFile(join(out,'proxy-watch-1.stderr.log'))),metadataQueriesAdded:0,readOnlyProgress:true}));
