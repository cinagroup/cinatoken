import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const directory = dirname(fileURLToPath(import.meta.url))
const executable = 'C:/Program Files/GitHub CLI/gh.exe'
const expectedSha = 'c13a64b9c3b2c90adcf736910ea408868d7854f1'
const runId = 37312669228
const ref = path => { const bytes = readFileSync(path); return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
const receipts = []
function gh(label, args) {
 const startedAt = new Date().toISOString()
 const result = spawnSync(executable, args, { cwd: 'C:/cinagroup/cinatoken', encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
 const stdoutPath = join(directory, label + '.stdout.json')
 const stderrPath = join(directory, label + '.stderr.txt')
 writeFileSync(stdoutPath, result.stdout ?? '', { flag: 'wx' })
 writeFileSync(stderrPath, result.stderr ?? '', { flag: 'wx' })
 const record = { startedAt, finishedAt: new Date().toISOString(), executable, args, actualExitCode: result.status, signal: result.signal, error: result.error?.message ?? null, stdoutPath, stderrPath }
 const recordPath = join(directory, label + '.closed.json')
 writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
 receipts.push({ label, record: ref(recordPath), stdout: ref(stdoutPath), stderr: ref(stderrPath) })
 if (result.status !== 0 || result.error) return { ok: false, record }
 return { ok: true, record, json: JSON.parse(result.stdout) }
}
let priorSummary = ''
let sequence = 0
let final = null
while (!final) {
 const label = 'query-' + String(++sequence).padStart(3, '0')
 const result = gh(label, ['run', 'view', String(runId), '--json', 'databaseId,headSha,status,conclusion,jobs,url,createdAt,updatedAt'])
 if (!result.ok) {
  process.stdout.write(JSON.stringify({ at: result.record.finishedAt, observationFailure: true, label, actualExitCode: result.record.actualExitCode, signal: result.record.signal, error: result.record.error, runId, restartingWorkflow: false }) + '\n')
 } else {
  const run = result.json
  assert.equal(run.databaseId, runId)
  assert.equal(run.headSha, expectedSha)
  const summary = { status: run.status, conclusion: run.conclusion, jobs: run.jobs.map(job => ({ name: job.name, status: job.status, conclusion: job.conclusion, successfulSteps: job.steps.filter(step => step.status === 'completed' && step.conclusion === 'success').length, activeStep: job.steps.find(step => step.status === 'in_progress')?.name ?? null })) }
  const signature = JSON.stringify(summary)
  if (signature !== priorSummary) process.stdout.write(JSON.stringify({ at: result.record.finishedAt, runId, sha: expectedSha, ...summary }) + '\n')
  priorSummary = signature
  if (run.status === 'completed') final = run
 }
 if (!final) await new Promise(resolve => setTimeout(resolve, 45000))
}
const jobs = final.jobs
const steps = jobs.flatMap(job => job.steps.map(step => ({ job: job.name, ...step })))
const allPassed = final.conclusion === 'success' && jobs.length === 2 && jobs.every(job => job.status === 'completed' && job.conclusion === 'success') && steps.length === 36 && steps.every(step => step.status === 'completed' && step.conclusion === 'success')
const artifactRead = gh('artifacts', ['api', 'repos/cinagroup/cinatoken/actions/runs/' + runId + '/artifacts'])
assert.ok(artifactRead.ok, 'Artifact metadata read did not complete')
const artifacts = artifactRead.json.artifacts.filter(item => item.name === 'cinatoken-web')
let artifactVerified = false
if (allPassed) {
 assert.equal(artifacts.length, 1)
 const artifact = artifacts[0]
 assert.equal(artifact.expired, false)
 assert.equal(artifact.workflow_run.id, runId)
 assert.equal(artifact.workflow_run.head_sha, expectedSha)
 assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0)
 assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0)
 assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/)
 assert.ok(Date.parse(artifact.expires_at) > Date.now())
 artifactVerified = true
}
const report = { schemaVersion: 1, at: new Date().toISOString(), expectedSha, runId, url: final.url, workflow: 'web-frontend.yml', status: final.status, conclusion: final.conclusion, all36StepsSucceeded: allPassed, jobCount: jobs.length, stepCount: steps.length, jobs, artifactVerified, artifacts, receipts, workflowTriggeredOrRerun: false, sourceOrGitMutation: false, deploymentRun: false, observationIntervalMs: 45000 }
const output = join(directory, 'FINAL-web-c13a64b9-CI-STOP-v1.json')
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
process.stdout.write(JSON.stringify({ finalReport: ref(output), all36StepsSucceeded: allPassed, artifactVerified, artifacts }) + '\n')
process.exit(allPassed && artifactVerified ? 0 : 1)