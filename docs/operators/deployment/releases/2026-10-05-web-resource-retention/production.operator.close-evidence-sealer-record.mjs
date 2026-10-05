import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const root='C:/cinagroup/cinatoken',temp='C:/Users/cina/AppData/Local/Temp/cinatoken-web-retention-40bda77a453343d89d5fe50706d58326',dir='docs/operators/deployment/releases/2026-10-05-web-resource-retention',summary='docs/operators/deployment/releases/2026-10-05-web-resource-retention-production.json';
const bytes=fs.readFileSync(root+'/'+summary),report=JSON.parse(bytes);
const closed=JSON.parse(fs.readFileSync(temp+'/seal-production.result.json','utf8'));assert.equal(closed.actualExit,0);
function append(source,name){const b=fs.readFileSync(source),target=dir+'/'+name;assert.equal(fs.existsSync(root+'/'+target),false);fs.writeFileSync(root+'/'+target,b,{flag:'wx'});const receipt={sourcePath:source,path:target,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};report.raw.push(receipt);return receipt;}
const original=append(root+'/'+summary,'production.operator.initial-production-summary-snapshot.json');
for(const item of report.raw)if(/production.operator.seal-production\.(stdout|stderr)\.log$/.test(item.path)){item.capturePhase='Snapshot taken while the evidence sealer itself was running; not the terminal sealer log';item.terminalLog=false;}
for(const name of ['seal-production.stdout.log','seal-production.stderr.log','seal-production.result.json','seal-production-evidence.mjs'])append(temp+'/'+name,'production.operator.closed-'+name);
report.schema='cinatoken-web-resource-retention-production-v2';
report.publicationPreparation.evidenceSealer={actualExit:closed.actualExit,startedAt:closed.at,finishedAt:closed.finishedAt,initialSummarySnapshot:original.path,inProgressOwnLogsPreserved:true,closedOwnLogsAppended:true};
fs.writeFileSync(root+'/'+summary,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({actualExit:0,rawFiles:report.raw.length,initialControlSummaryPreserved:true,inProgressSnapshotsNotTerminal:true,closedSealerEvidenceAppended:true,browserStrictPassed:report.checks.browser.strictPassed}));
