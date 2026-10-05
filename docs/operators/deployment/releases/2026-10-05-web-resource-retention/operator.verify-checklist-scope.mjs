import fs from 'node:fs';import cp from 'node:child_process';import assert from 'node:assert/strict';
const root='C:/cinagroup/cinatoken',p='docs/developers/architecture/web-frontend-migration.md';
const before=cp.execFileSync('C:/Program Files/Git/cmd/git.exe',['show','5a13f59e851ec7e2ef6a94b50e5d4d4da26e9462:'+p],{cwd:root,encoding:'utf8',maxBuffer:5000000});
const after=fs.readFileSync(root+'/'+p,'utf8');const checkboxes=s=>s.split(/\r?\n/).filter(l=>/\[[ x]\]/i.test(l));
assert.deepEqual(checkboxes(after),checkboxes(before),'All task states/text must remain unchanged');
const main=[...after.matchAll(/^- \[[ x]\] ((?:P\d-\d{2}|SRC-\d{2}))\b/gm)].map(m=>m[1]);assert.equal(main.length,102);assert.equal(new Set(main).size,102);
const matrix=[...after.matchAll(/^\| ((?:AUTH|ACC|ADM|PUB)-\d{2}) \|/gm)].map(m=>m[1]);assert.equal(matrix.length,54);assert.equal(new Set(matrix).size,54);
const gates=[...after.matchAll(/验收门槛 (G\d)：/g)].map(m=>m[1]);assert.deepEqual(gates,['G0','G1','G2','G3','G4','G5','G6','G7','G8']);
const evidence=[...after.matchAll(/^\| (E\d{2}) \|/gm)].map(m=>m[1]);assert.deepEqual(evidence,['E00','E01','E02','E03','E04','E05','E06','E07','E08']);
console.log(JSON.stringify({actualExit:0,allCheckboxLines:checkboxes(after).length,taskCheckboxes:211,mainTasks:main.length,matrixRows:matrix.length,gates,evidence,statesAndTaskTextUnchanged:true}));



