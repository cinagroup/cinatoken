import assert from'node:assert/strict';import{readFile,writeFile,readdir,lstat}from'node:fs/promises';import{join}from'node:path';
import{command,out,info}from'./capture.mjs';
const result=await command('finalize',process.execPath,[join(out,'finalize.mjs')]);console.log(JSON.stringify(result.receipt));
if(result.receipt.actualExit!==0||result.receipt.signal||result.receipt.spawnError){console.error(result.stderr.toString());process.exitCode=result.receipt.actualExit??1;}
else{
 const entries=[];for(const relative of(await readdir(out)).sort()){const path=join(out,relative),s=await lstat(path);assert.equal(s.isFile(),true);assert.equal(s.isSymbolicLink(),false);entries.push({relative,...info(await readFile(path))})}
 const path=join(out,'PREPARATION-SEAL.json'),bytes=Buffer.from(JSON.stringify({schema:'cinatoken-quote-three-casts-owned-seal-v1',frozenAt:new Date().toISOString(),
  ownedRoot:out,sealedFileCount:entries.length,entries,selfExcluded:'PREPARATION-SEAL.json',finalWriterActualClosedReceipt:'finalize.closed.json',
  preparedOnly:true,nativeExecuted:false,gatePassDerived:false,ownerStopWrites:true},null,2)+'\n');
 await writeFile(path,bytes,{flag:'wx'});
 const finalPath=join(out,'FINAL-quote-version-three-casts-preparation.json');
 console.log(JSON.stringify({FINAL:{path:finalPath,...info(await readFile(finalPath))},seal:{path,...info(bytes)},sealedFileCount:entries.length,
  actualExit:0,ownerStopWrites:true}));
}
