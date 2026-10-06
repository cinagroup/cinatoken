import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const out = path.dirname(fileURLToPath(import.meta.url))
const original = fs.readFileSync(path.join(out, 'run-local-checks.mjs'), 'utf8')
const start = original.indexOf('for (const relative of owned) wx(')
const finish = original.indexOf('for (const file of allScripts) command(')
assert(start > 0 && finish > start)
const resume = `
const originalIndex = JSON.parse(fs.readFileSync(path.join(out, 'original-artifact-immutable-index.json')))
const originalArtifactIndex = originalIndex.files
const original = JSON.parse(fs.readFileSync(path.join(originalArtifact, 'result.json')))
const beforeFormat = JSON.parse(fs.readFileSync(path.join(out, 'format-before.result.json')))
const unit = JSON.parse(fs.readFileSync(path.join(out, 'actual-owned-unit-tests.result.json')))
assert.equal(unit.actualExit, 0)
assert(unit.closed)
assert.deepEqual(descriptor(unit.stdout), unit.stdoutBytes)
assert.deepEqual(descriptor(unit.stderr), unit.stderrBytes)
const unitRaw = fs.readFileSync(unit.stdout, 'utf8')
for (const [field, expected] of [['tests',7],['pass',7],['fail',0],['skipped',0]])
  assert.match(unitRaw, new RegExp('^(?:ℹ|#) '+field+' '+expected+'\\\\b', 'm'))
const allScripts = fs.readdirSync(path.join(cwd, 'scripts/verification/web-platform-g7')).filter((name) => name.endsWith('.mjs')).sort().map((name) => 'scripts/verification/web-platform-g7/'+name)
`
let continuation = original.slice(0, start) + resume + original.slice(finish)
continuation = continuation.replace('toolSource: descriptor(fileURLToPath(import.meta.url)),', `historicalLocalProducerFailure: { actualExit: 1, originalExecToolChunk: 'ea7562', error: 'Producer expected TAP prefix #; Node24 default spec uses ℹ. The actual unit child exited0 with7pass/0skip.', originalSource: descriptor(path.join(out, 'run-local-checks.mjs')), originalUnitReceipt: path.join(out, 'actual-owned-unit-tests.result.json'), noUnitOrFormattingWriteRerun: true },\n  toolSource: descriptor(fileURLToPath(import.meta.url)),`)
fs.writeFileSync(path.join(out, 'finish-local-checks.mjs'), continuation, { flag: 'wx' })
console.log(JSON.stringify({ createdContinuation: true, originalSourceNotChanged: true, noUnitRerun: true }))
