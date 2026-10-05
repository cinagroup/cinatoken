import fs from 'node:fs';import cp from 'node:child_process';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const report=JSON.parse(fs.readFileSync('docs/operators/deployment/releases/2026-10-05-web-resource-retention-local.json'));
for(const f of report.raw){const staged=cp.execFileSync('C:/Program Files/Git/cmd/git.exe',['show',':'+f.path],{maxBuffer:8000000,windowsHide:true});assert.equal(staged.length,f.bytes,f.path);assert.equal(crypto.createHash('sha256').update(staged).digest('hex'),f.sha256,f.path);assert.ok(staged.equals(fs.readFileSync(f.sourcePath)),f.path);}
console.log(JSON.stringify({actualExit:0,stagedRawFiles:report.raw.length,allBytesExactlySaved:true}));
