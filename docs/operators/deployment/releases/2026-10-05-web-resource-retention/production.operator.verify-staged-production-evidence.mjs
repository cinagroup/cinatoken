import fs from 'node:fs';import crypto from 'node:crypto';import cp from 'node:child_process';import assert from 'node:assert/strict';
const root='C:/cinagroup/cinatoken',git='C:/Program Files/Git/cmd/git.exe',reportPath='docs/operators/deployment/releases/2026-10-05-web-resource-retention-production.json';
const report=JSON.parse(fs.readFileSync(root+'/'+reportPath,'utf8'));
assert.equal(report.sourceCommit,'c13a64b9c3b2c90adcf736910ea408868d7854f1');
assert.equal(report.production.webVersionId,'2a0a2777-d3b1-47f0-a0a7-88e701b4d2d9');
assert.equal(report.scope.wholeMigrationComplete,false);
let bytes=0;for(const r of report.raw){const local=fs.readFileSync(root+'/'+r.path);const staged=cp.execFileSync(git,['show',':'+r.path],{cwd:root,maxBuffer:10000000});assert.equal(local.length,r.bytes,r.path);assert.equal(staged.length,r.bytes,r.path);assert.equal(crypto.createHash('sha256').update(local).digest('hex'),r.sha256,r.path);assert.equal(crypto.createHash('sha256').update(staged).digest('hex'),r.sha256,r.path);bytes+=r.bytes;}
const stagedReport=cp.execFileSync(git,['show',':'+reportPath],{cwd:root,maxBuffer:5000000});assert.deepEqual(stagedReport,fs.readFileSync(root+'/'+reportPath));
console.log(JSON.stringify({actualExit:0,rawFiles:report.raw.length,rawBytes:bytes,allLocalAndGitStagedHashesExact:true,reportStagedExact:true,wholeMigrationComplete:false}));
