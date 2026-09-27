// Test fixture only. All paths are temporary local test workspaces supplied by
// the parent. No cloud/provider transport and no credentials are loaded.
import {createByokD1OperatorJournal} from './byok-d1-operator-journal.mjs';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
const [workspace,mode]=process.argv.slice(2);
if(!['race','crash-before','crash-after'].includes(mode))throw Error('test_mode');
const meta={runId:'c02-byok-a1b2c3d4e5f6',candidateSha256:'a'.repeat(64),priorManifestSha256:'b'.repeat(64)};
try {
  const journal=createByokD1OperatorJournal(workspace,meta);
  if(mode==='race'){journal.close();process.stdout.write('WON');}
  else await journal.attempt('arm',async()=>{
    if(mode==='crash-after'){
      const fd=openSync(resolve(workspace,'synthetic-side-effect'),'wx');writeSync(fd,'one');fsyncSync(fd);closeSync(fd);
    }
    process.send({state:'live-pending'});
    await new Promise(()=>{setInterval(()=>{},1000);});
  });
}catch {process.stdout.write('REFUSED');process.exitCode=2;}
