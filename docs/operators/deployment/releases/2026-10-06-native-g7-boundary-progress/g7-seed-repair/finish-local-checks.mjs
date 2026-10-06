import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const out = path.dirname(fileURLToPath(import.meta.url))
const cwd = 'C:/cinagroup/cinatoken'
const owned = ['scripts/verification/web-platform-g7/database.mjs', 'scripts/verification/web-platform-g7/fixture.test.mjs']
const originalArtifact = 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E/g7-artifact-first'
const hash = (data) => createHash('sha256').update(data).digest('hex')
const descriptor = (file) => { const data = fs.readFileSync(file); return { bytes: data.length, sha256: hash(data) } }
const wx = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { flag: 'wx' }) }
const json = (file, data) => wx(file, `${JSON.stringify(data, null, 2)}\n`)
const command = (label, program, args, expected = [0]) => {
  const startedAt = new Date().toISOString()
  const child = spawnSync(program, args, { cwd, timeout: 120000, encoding: null, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  const finishedAt = new Date().toISOString()
  const stdout = path.join(out, `${label}.stdout.log`), stderr = path.join(out, `${label}.stderr.log`)
  wx(stdout, child.stdout ?? Buffer.alloc(0)); wx(stderr, child.stderr ?? Buffer.alloc(0))
  const receipt = {
    label, executable: program, args, cwd, startedAt, finishedAt, actualExit: child.status, signal: child.signal,
    spawnError: child.error ? { code: child.error.code, message: child.error.message } : null,
    closed: Number.isInteger(child.status) && child.signal === null && !child.error,
    expectedActualExits: expected, expectedExitMatched: expected.includes(child.status), stdout, stderr,
    stdoutBytes: descriptor(stdout), stderrBytes: descriptor(stderr),
  }
  json(path.join(out, `${label}.result.json`), receipt)
  assert(receipt.closed && receipt.expectedExitMatched, `${label}: unexpected actual exit`)
  return receipt
}
const sourceSnapshot = JSON.parse(fs.readFileSync(path.join(out, 'source-before.json')))

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
  assert.match(unitRaw, new RegExp('^(?:ℹ|#) '+field+' '+expected+'\\b', 'm'))
const allScripts = fs.readdirSync(path.join(cwd, 'scripts/verification/web-platform-g7')).filter((name) => name.endsWith('.mjs')).sort().map((name) => 'scripts/verification/web-platform-g7/'+name)
for (const file of allScripts) command(`syntax-${path.basename(file)}`, process.execPath, ['--check', file])
command('format-final-full-package', process.execPath, ['node_modules/prettier/bin-prettier.js', '--check', ...allScripts, 'scripts/verification/web-platform-g7/README.md', '.github/workflows/web-platform-g7.yml'])
const diff = command('owned-exact-diff', 'git', ['diff', '--', ...owned])
command('owned-diff-check', 'git', ['diff', '--check', '--', ...owned])
const sourceSHA = fs.readFileSync(command('observed-source-head', 'git', ['rev-parse', 'HEAD']).stdout, 'utf8').trim()
for (const entry of sourceSnapshot.sourceFiles.filter((file) => !owned.includes(file.relative))) assert.deepEqual(descriptor(path.join(cwd, entry.relative)), { bytes: entry.bytes, sha256: entry.sha256 })
for (const entry of originalArtifactIndex) assert.deepEqual(descriptor(path.join(originalArtifact, entry.relative)), { bytes: entry.bytes, sha256: entry.sha256 })
const final = owned.map((relative) => {
  wx(path.join(out, 'source-after', relative), fs.readFileSync(path.join(cwd, relative)))
  return { relative, ...descriptor(path.join(cwd, relative)) }
})
const receipts = fs.readdirSync(out).filter((file) => file.endsWith('.result.json')).map((file) => ({ file, ...JSON.parse(fs.readFileSync(path.join(out, file))) }))
for (const receipt of receipts) {
  assert(receipt.closed && receipt.expectedExitMatched)
  assert.deepEqual(descriptor(receipt.stdout), receipt.stdoutBytes)
  assert.deepEqual(descriptor(receipt.stderr), receipt.stderrBytes)
}
json(path.join(out, 'FINAL-g7-seed-current-schema-repair.json'), {
  schema: 'cinatoken-g7-seed-current-schema-repair-v1', closed: true, actualOutcome: 0, createdAt: new Date().toISOString(), out, observedSourceHead: sourceSHA,
  changedSourceFiles: final, exactDiff: diff.stdout, originalFailureSourceSHA: original.sourceSHA, originalLinuxRun: '37402317152', originalActualExit: 1, originalWireActualExit: null,
  originalArtifact: { path: originalArtifact, files: originalArtifactIndex.length, allFilesByteAndHashUnchanged: true, index: path.join(out, 'original-artifact-immutable-index.json'), originalCleanupVerifiedAbsent: true },
  cause: 'Actual 0023 migrates MASTER_KEY to existing admin_api_keys legacy-master; 0024 deletes the old system_config MASTER_KEY. The original owned seeder updated that deleted row and required one returned row.',
  repair: {
    onlyOwnedSeedAndUnitTest: true, productionBusinessSourceUnchanged: true, noWorkflowEdit: true,
    rotatedExistingActiveLegacyMasterRowRequired: true, exactNamePermissionsAndDevelopmentKeySelector: true,
    secretKeyHashFromProductionCore: true, prefixFirst12MatchesProductionRotation: true,
    originalPermissionsAndStatusPreserved: true, noObsoleteMasterConfigRecreated: true,
    actualAdminRepositoryNewKeyHitAndOldDevelopmentKeyMissRequiredOnLinux: true,
    safeFailureDiagnostics: 'Constant stage and allowlisted assertion operator only; scalar selectors contain integer/boolean expected and actual. No error message/stack, credential, connection string or query parameters printed.',
  },
  localChecks: { unit: '7/7 pass, 0 fail, 0 skipped', newUnit: 'Actual production lookup hash compared with independent Node SHA-256; correct key succeeds, development key and stale development hash reject.', syntax: `${allScripts.length}/${allScripts.length} actual0`, packageFormatterActualExit: 0, scopedDiffCheckActualExit: 0, allCommandReceipts: receipts.length, allClosedNumericExits: true, allRawBytesExact: true, beforeFormatActualExit: beforeFormat.actualExit },
  runtimeClaims: { localDockerRun: false, localPostgresRun: false, localTlsRun: false, sqliteSubstitute: false, pgliteClaim: false, LinuxSeedRepairVerified: false, realCinaAuthIdentityVerified: false, fullG7Verified: false, fullG8Verified: false, productionRequests: 0, commitOrPush: false },
  historicalLocalProducerFailure: { actualExit: 1, originalExecToolChunk: 'ea7562', error: 'Producer expected TAP prefix #; Node24 default spec uses ℹ. The actual unit child exited0 with7pass/0skip.', originalSource: descriptor(path.join(out, 'run-local-checks.mjs')), originalUnitReceipt: path.join(out, 'actual-owned-unit-tests.result.json'), noUnitOrFormattingWriteRerun: true },
  toolSource: descriptor(fileURLToPath(import.meta.url)),
})
console.log(JSON.stringify({ actualOutcome: 0, report: path.join(out, 'FINAL-g7-seed-current-schema-repair.json'), ...descriptor(path.join(out, 'FINAL-g7-seed-current-schema-repair.json')), sourceFiles: final, commandReceipts: receipts.length }))
