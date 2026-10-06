import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const repo='C:/cinagroup/cinatoken',prefix='docs/developers/architecture/evidence/2026-10-06-native-retention-and-http-backlog-preparation/';
const collection=JSON.parse(fs.readFileSync(path.join(repo,prefix,'collection.json')));
const expected=[
 'scripts/db/cutover/postgres-shared-key-buyer-receipt-retention-v346.native.test.mjs',
 ...['run-direct-socket.mjs','queued-write-source.mjs','README.md','sealed-package.json'].map(v=>'scripts/diagnostics/v364-direct-socket/'+v),
 'docs/developers/architecture/web-frontend-migration.md',
 ...collection.entries.map(v=>prefix+v.storedRelative),prefix+'collection.json',prefix+'README.md'
].sort();
assert.equal(new Set(expected).size,expected.length);
const names=execFileSync('C:/Program Files/Git/cmd/git.exe',['-c','core.longpaths=true','diff','--cached','--name-only','-z'],{cwd:repo,encoding:'utf8'}).split('\0').filter(Boolean).sort();
assert.deepEqual(names,expected,'Only this batch is staged');
const stage=execFileSync('C:/Program Files/Git/cmd/git.exe',['-c','core.longpaths=true','ls-files','--stage','-z','--',...expected],{cwd:repo,encoding:'utf8'}).split('\0').filter(Boolean);
const blobs=new Map(stage.map(row=>{const m=row.match(/^(\d+) ([a-f0-9]{40}) 0\t(.*)$/s);assert.ok(m);return[m[3],{mode:m[1],blob:m[2]}];}));
assert.equal(blobs.size,expected.length);
for(const name of expected){const b=fs.readFileSync(path.join(repo,name));const blob=createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');assert.equal(blobs.get(name).blob,blob,name+' staged bytes');}
console.log(JSON.stringify({exactStageScope:true,allStagedBlobBytesMatchWorktree:true,files:expected.length,packageSeal:blobs.get('scripts/diagnostics/v364-direct-socket/sealed-package.json'),ciSourceCommit:collection.ciSourceCommit,productionCommit:collection.productionCommit,nativeGatePassDerived:false}));
