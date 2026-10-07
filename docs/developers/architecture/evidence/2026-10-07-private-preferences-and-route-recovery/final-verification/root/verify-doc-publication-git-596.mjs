import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const [mode,label]=process.argv.slice(2);assert(['staged','committed'].includes(mode)&&/^[a-z0-9-]+$/.test(label));
const own=path.dirname(fileURLToPath(import.meta.url)),repo='C:/cinagroup/cinatoken';
const git=args=>{const r=spawnSync('C:/Program Files/Git/cmd/git.exe',args,{cwd:repo,windowsHide:true,maxBuffer:128*1024*1024});assert(!r.error&&r.status===0&&r.signal===null,'Git read failed: '+args[0]);return r.stdout.toString('utf8').trim();};
const doc='docs/developers/architecture/web-frontend-migration.md';
const relative='docs/developers/architecture/evidence/2026-10-07-private-preferences-and-route-recovery';
const files=[doc];
function visit(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const abs=path.join(dir,item.name);assert(!item.isSymbolicLink());if(item.isDirectory())visit(abs);else{assert(item.isFile());files.push(path.relative(repo,abs).replaceAll('\\','/'));}}}
visit(path.join(repo,relative));files.sort();
const indexed=git(['diff','--cached','--name-only','-z']).split('\0').filter(Boolean).sort();
if(mode==='staged'){assert.equal(git(['rev-parse','HEAD']),'3494dca3fd14f8433ede2679fcb54916256a9113');assert.deepEqual(indexed,files,'Only owned document/evidence paths may be staged');}
else{assert.deepEqual(indexed,[]);assert.equal(git(['rev-parse','HEAD^']),'3494dca3fd14f8433ede2679fcb54916256a9113');assert.deepEqual(git(['diff-tree','--no-commit-id','--name-only','-r','-z','HEAD']).split('\0').filter(Boolean).sort(),files);}
const verified=files.map(file=>{const expected=git(['hash-object','--path='+file,path.join(repo,file)]);const actual=git(['rev-parse',mode==='staged'?':'+file:'HEAD:'+file]);assert.equal(actual,expected,'Git content differs for '+file);return {file,gitObjectId:actual};});
const installed=JSON.parse(fs.readFileSync(path.join(own,'installed-final-evidence-596.json'),'utf8'));
for(const row of installed.files){const file=relative+'/'+row.relative;const actual=git(['rev-parse',mode==='staged'?':'+file:'HEAD:'+file]);const original=git(['hash-object','--no-filters',row.from]);assert.equal(actual,original,'Original evidence byte content differs in Git: '+file);}
const changedSources=git(['diff','--name-only','3494dca3fd14f8433ede2679fcb54916256a9113','--','packages','scripts','.github','package.json','package-lock.json']);assert.equal(changedSources,'','Document update must not change source/release inputs');
const result={at:new Date().toISOString(),mode,status:'PASS',head:git(['rev-parse','HEAD']),sourceReleaseCommit:'3494dca3fd14f8433ede2679fcb54916256a9113',files:verified,evidenceOriginalByteMatches:installed.files.length,sourceChanges:[],limits:['Git content verification only; publication, HTTP, archive and original scope have separate actual receipts']};
fs.writeFileSync(path.join(own,label+'.git-proof.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({mode,status:result.status,head:result.head,files:verified.length,evidenceOriginalByteMatches:installed.files.length})+'\n');
