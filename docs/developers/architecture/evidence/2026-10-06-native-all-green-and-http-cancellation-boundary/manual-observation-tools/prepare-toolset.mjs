import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const desc = file => { const bytes = fs.readFileSync(file); return { path: file.replaceAll('\\','/'), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; };
const tools = ['observe-ci-command.mjs','extract-artifact.py','run-artifact-audit-command.mjs','review-artifact.mjs','prepare-toolset.mjs'];
const inputs = tools.map(file => desc(path.join(root,file)));
const checks = tools.filter(file => file !== 'prepare-toolset.mjs').map(file => file.endsWith('.py') ? { label: 'syntax-python', program: 'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe', args: ['-c','import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")); print("AST syntax only; no executable imported")',path.join(root,file)] } : { label: `syntax-${file.replace('.mjs','')}`, program: process.execPath, args: ['--check',path.join(root,file)] });
const results = [];
for(const check of checks) {
  const startedAt = new Date().toISOString();
  const r = spawnSync(check.program,check.args,{cwd:root,windowsHide:true,timeout:30000,maxBuffer:1048576,encoding:null});
  const stdout = path.join(root,`${check.label}.stdout.raw`),stderr=path.join(root,`${check.label}.stderr.raw`),receipt=path.join(root,`${check.label}.result.json`);
  fs.writeFileSync(stdout,r.stdout ?? Buffer.alloc(0),{flag:'wx'});fs.writeFileSync(stderr,r.stderr ?? Buffer.alloc(0),{flag:'wx'});
  const closed = {schema:'cinatoken-observation-tool-syntax-command-closed-v1',closed:true,program:check.program,args:check.args,startedAt,endedAt:new Date().toISOString(),actualExit:r.status,signal:r.signal,spawnError:r.error ? {name:r.error.name,code:r.error.code ?? null} : null,stdout:desc(stdout),stderr:desc(stderr),syntaxOnly:true,runtimeExecuted:false,ciQueried:false};
  fs.writeFileSync(receipt,`${JSON.stringify(closed,null,2)}\n`,{flag:'wx'});results.push({receipt:desc(receipt),actualExit:r.status});
  assert.equal(r.status,0);assert.equal(r.signal,null);assert.equal(r.error,undefined);
}
for(const input of inputs) assert.deepEqual(desc(input.path),input);
const ready={schema:'cinatoken-v364-queued-linux-observation-tools-ready-v1',preparedAt:new Date().toISOString(),actualSyntaxPreparationExit:0,toolInputs:inputs,syntaxResults:results,networkOrCIQueried:false,productOrNativeExecuted:false,allowedOperations:['one-gh-watch-45s','terminal-metadata','one-full-job-log','one-full-artifact-zip','local-full-zip-decode','local-byte-and-fact-audit'],requiresExplicitRootBinding:true,watchExit1Preserved:true,extraArmSeparateFromOriginalFive:true,collection0NotGatePass:true,oldEvidenceTouched:false};
const file=path.join(root,'READY-observation-tools.json');fs.writeFileSync(file,`${JSON.stringify(ready,null,2)}\n`,{flag:'wx'});
console.log(JSON.stringify({ready:desc(file),toolInputs:inputs,actualSyntaxPreparationExit:0,ciQueried:false}));
