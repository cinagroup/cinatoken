import assert from'node:assert/strict';
import{readFile,writeFile}from'node:fs/promises';
import{join}from'node:path';
import{out}from'./evidence-lib.mjs';
let source=await readFile(join(out,'repair26.mjs'),'utf8');
const needle="replace(callLine,adapter+callLine,'local-owned-grant-binding');";assert.equal(source.split(needle).length,2);
source=source.replace(needle,"const callIndex=source.indexOf(callLine);assert.ok(callIndex>=0);const occurrenceCount=source.split(callLine).length-1;source=source.slice(0,callIndex)+adapter+source.slice(callIndex);operations.push({kind:'local-owned-grant-binding',needle:callLine,replacement:adapter+callLine,occurrence:0,originalOccurrences:occurrenceCount});");
source=source.replace("'preparation-head'","'preparation-head-v2'").replace("'original26-git'","'original26-git-v2'").replaceAll("+'.before'","+'.before-v2'").replaceAll("+'.prepared-after'","+'.prepared-after-v2'").replaceAll("'26-planned-edits.json'","'26-planned-edits-v2.json'").replaceAll("'26-applied.json'","'26-applied-v2.json'");
await writeFile(join(out,'repair26-v2.mjs'),source,{flag:'wx'});process.stdout.write('Prepared v2 plan writer; original failed script and receipts untouched.\n');
