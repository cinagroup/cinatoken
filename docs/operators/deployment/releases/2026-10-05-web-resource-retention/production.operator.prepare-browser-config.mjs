import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
const [sha,label]=process.argv.slice(2);assert.match(sha??'',/^[a-f0-9]{40}$/);assert.match(label??'',/^[a-z0-9-]+$/);
const temp=path.dirname(fileURLToPath(import.meta.url)),proofPath=temp+'/deployed.live-proof.json';const bytes=fs.readFileSync(proofPath),proof=JSON.parse(bytes);
assert.equal(proof.actualExit,0);assert.equal(proof.sourceCommit,sha);assert.equal(proof.route.script,'cinatoken-web');assert.ok(proof.webVersionId);
const web=proof.workers.find(w=>w.name==='cinatoken-web');assert.equal(web.flags.enabled,29);assert.equal(web.percentage,100);
const config={gitSHA:sha,workerVersionId:proof.webVersionId,phase:'cutover',targetOrigin:'https://cinatoken.com',canonicalOrigin:'https://cinatoken.com',operatorVerifiedLiveVersion:true,all29FlagsEnabled:true,liveProof:{path:proofPath,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}};
fs.writeFileSync(temp+'/'+label+'.browser-config.json',JSON.stringify(config,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(config));
