import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const repo = 'C:/cinagroup/cinatoken';
const dir = `${repo}/scripts/diagnostics/v364-owned-linux-boundary`;
const old = `${repo}/scripts/diagnostics/v364-owned-linux`;
const temp = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-boundary-preparation-1427c951d98b46c6ae8299694b679b38';
const sha = b => createHash('sha256').update(b).digest('hex');
const file = path => { const b = readFileSync(`${repo}/${path}`); return { path, bytes: b.length, sha256: sha(b) }; };
const expected = ['bare-async-source.mjs', 'direct-holder.mjs', 'proc-census.mjs', 'run-boundary.mjs', 'execute-owned-linux.py', 'README.md'];
for (const name of expected) { const b = readFileSync(`${dir}/${name}`); const normalized = b.toString('utf8').replaceAll('\r\n', '\n'); writeFileSync(`${dir}/${name}`, normalized); }
const workflowPath = '.github/workflows/v364-owned-linux-boundary.yml';
writeFileSync(`${repo}/${workflowPath}`, readFileSync(`${repo}/${workflowPath}`, 'utf8').replaceAll('\r\n', '\n'));
const frozen = JSON.parse(readFileSync(`${old}/source-inputs.json`, 'utf8'));
const priorAnalysisPath = 'docs/operators/deployment/releases/2026-10-06-pg73-docker-progress/native-agent/FINAL-v364-linux-artifact-analysis.json';
const priorArtifactRoot = 'docs/operators/deployment/releases/2026-10-06-pg73-docker-progress/root-followup/diagnostic-linux-download/_temp/v364-owned-once-37396338452-1';
const legacyPaths = readdirSync(old).map(name => 'scripts/diagnostics/v364-owned-linux/' + name).concat('.github/workflows/v364-owned-linux-diagnostic.yml');
const evidencePaths = ['executor.closed.json', 'closed-result.json', 'executor-start.json', 'executor.stdout.txt', 'executor.stderr.txt', 'original-strict.stdout.txt', 'original-strict.stderr.txt', 'events.json.gz'].map(name => priorArtifactRoot + '/' + name);
const paths = [...frozen.map(item => item.path), ...legacyPaths, priorAnalysisPath, ...evidencePaths];
assert.equal(new Set(paths).size, paths.length);
const inputs = paths.map(path => {
  const item = file(path); const blob = execFileSync('git', ['show', 'HEAD:' + path], { cwd: repo });
  assert.equal(blob.length, item.bytes, path); assert.equal(sha(blob), item.sha256, path + ' Git exact'); return item;
});
for (const item of frozen) assert.deepEqual(inputs.find(v => v.path === item.path), item);
assert.equal(file('scripts/diagnostics/v364-owned-linux/sealed-package.json').sha256, '392f5a44294abf70c4bc3cbb7b727103f96d5ce8f5e87bfc3fe3dc8bd1fc6bd4');
const preparedAtHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const pins = { schema: 'v364-boundary-source-inputs-v1', reviewBaseHEAD: '6658ec978009afa5fe3f4beccf6bde358590b663',
  preparedAtHead, executionSHAIsSeparate: true, priorAnalysisPath, priorArtifactRoot, files: inputs };
writeFileSync(`${dir}/source-inputs.json`, JSON.stringify(pins, null, 2) + '\n', { flag: 'wx' });
const allFiles = expected.concat('source-inputs.json');
const sealed = { schema: 'v364-owned-linux-boundary-sealed-package-v1', lineEndings: 'LF', frozenInputsVerifiedAgainstGitHEAD: true,
  files: allFiles.map(name => { const b = readFileSync(`${dir}/${name}`); assert.equal(b.includes(13), false); assert.equal(b.toString().startsWith('\ufeff'), false); return { path: name, bytes: b.length, sha256: sha(b) }; }),
  workflow: file(workflowPath) };
writeFileSync(`${dir}/sealed-package.json`, JSON.stringify(sealed, null, 2) + '\n', { flag: 'wx' });
const receipt = { schema: 'v364-boundary-package-created-v1', actualExit: 0, preparedAtHead,
  reviewBaseHEAD: pins.reviewBaseHEAD, executionSHAIsSeparate: true, sourcePins: inputs.length, frozen10Exact: true,
  manifest: file('scripts/diagnostics/v364-owned-linux-boundary/sealed-package.json'), files: sealed.files, workflow: sealed.workflow,
  existingFilesModified: false, runtimeExecuted: false, ciInvocations: 0, productionRequests: 0, databaseRequests: 0 };
writeFileSync(`${temp}/package-created.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(receipt));
