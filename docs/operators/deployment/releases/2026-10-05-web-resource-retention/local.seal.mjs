import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = 'C:/cinagroup/cinatoken'
const directory = dirname(fileURLToPath(import.meta.url))
const ref = path => { const bytes = readFileSync(path); return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
const owned = ['packages/web/scripts/package-release.mjs', 'packages/web/scripts/package-release.test.mjs', 'packages/web/scripts/source-delivery.mjs']
const expectations = { baseline: 1, fixed: 0, 'format-write': 1, 'format-write-corrected': 1, 'format-write-web': 0, 'full-web-unit': 0, 'full-web-types': 0, 'full-web-lint': 0, 'full-web-format': 0, 'owned-diff': 0, 'diff-check': 0 }
const checks = Object.entries(expectations).map(([label, expected]) => {
 const path = join(directory, label + '.closed.json')
 const record = JSON.parse(readFileSync(path, 'utf8'))
 assert.equal(record.actualExitCode, expected)
 assert.equal(record.signal, null)
 assert.equal(record.error, null)
 return { label, expected, cwd: label === 'format-write-web' || label === 'full-web-unit' ? root + '/packages/web' : root, record: ref(path), stdout: ref(record.stdoutPath), stderr: ref(record.stderrPath) }
})
const stdout = readFileSync(join(directory, 'full-web-unit.stdout.txt'), 'utf8')
for (const assertion of [/tests 1596\b/, /pass 1596\b/, /fail 0\b/, /skipped 0\b/, /cancelled 0\b/]) assert.match(stdout, assertion)
for (const name of ['same-browser releases retain each previous source archive without inventing asset mappings', 'source archives remain downloadable through their exact cutoff without renewing their age', 'a previous source archive with no hashed assets is retained independently of coverage', 'independently retained source archives do not resolve an unknown legacy asset', 'an import with no eligible final asset is rejected rather than adding an unreferenced archive']) assert.ok(stdout.includes(name), name)
const git = spawnSync('C:/Program Files/Git/cmd/git.exe', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })
assert.equal(git.status, 0)
const report = { schemaVersion: 1, at: new Date().toISOString(), status: 'local-source-archive-retention-verified', gitHeadObserved: git.stdout.trim(), nodeVersion: process.version, platform: process.platform, architecture: process.arch, ownedFiles: owned.map(path => ref(join(root, path))), localWebUnit: { tests: 1596, passed: 1596, failed: 0, skipped: 0, cancelled: 0 }, regressionBeforeFix: { tests: 4, passed: 0, failed: 4, actualExitCode: 1, testRawSnapshotBeforeFormattingPreserved: false }, regressionAfterFix: { tests: 4, passed: 4, failed: 0, actualExitCode: 0 }, checks, implementation: { allAdmittedUnexpiredArchivesIncluded: true, retainedArchivesRequireHashMapping: false, retainedArchiveMayBecomeExtraCurrentArchive: false, historicalImportAdmissionUnchanged: true, assetCoverageCalculationUnchanged: true, archiveTimestampsNotRenewedUnlessSelectedCurrent: true, combinedSourceAndAssetBudgetUnchanged: true }, boundary: { buildRun: false, gitMutation: false, deployRun: false, productionClaim: false }, failuresPreserved: ['baseline original product defect', 'root prettier CLI path missing', 'root cwd missing prettier plugin; corrected Web cwd used'] }
const output = join(directory, 'FINAL-source-archive-retention-STOP-v1.json')
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
process.stdout.write(JSON.stringify(ref(output), null, 2) + '\n')