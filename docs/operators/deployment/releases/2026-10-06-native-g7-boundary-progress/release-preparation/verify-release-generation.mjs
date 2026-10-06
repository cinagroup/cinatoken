import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const taskRoot = path.dirname(fileURLToPath(import.meta.url))
const repository = 'C:/cinagroup/cinatoken'
const base = '4e2ed5196a26cc43c2a3cb7ea852f1fc6284ff27'
const phase = process.argv[2]
assert(['snapshot', 'before', 'after', 'integrity', 'seal'].includes(phase))
const fixed = [
  ['cinatoken', '.'],
  ['@octafuse/core', 'packages/core'],
  ['@octafuse/tool-engines', 'packages/tool-engines'],
  ['@octafuse/proxy', 'packages/proxy'],
  ['@octafuse/admin', 'packages/admin'],
  ['@cinatoken/web', 'packages/web'],
]
const manifests = [...fixed.map(([, dir]) => path.posix.join(dir, 'package.json')), 'packages/chain-worker/package.json']
const changelogs = fixed.map(([, dir]) => path.posix.join(dir, 'CHANGELOG.md'))
const files = [...manifests, ...changelogs, '.changeset/config.json', '.changeset/README.md', '.changeset/cinatoken-gateway-postgres.md', 'packages/web/.prettierrc', 'packages/web/.prettierignore', 'package-lock.json']
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const descriptor = (file) => {
  const bytes = fs.readFileSync(file)
  return { bytes: bytes.length, sha256: sha(bytes) }
}
const wx = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data, { flag: 'wx' })
}
const json = (file, data) => wx(file, `${JSON.stringify(data, null, 2)}\n`)
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const receiptDir = path.join(taskRoot, 'commands')
fs.mkdirSync(receiptDir, { recursive: true })
const gitGlobal = path.join(taskRoot, 'empty-git-config')
if (!fs.existsSync(gitGlobal)) wx(gitGlobal, '')
const commandEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitGlobal, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
const command = (label, program, args, cwd, { expected = [0], input } = {}) => {
  const startedAt = new Date().toISOString()
  const result = spawnSync(program, args, { cwd, env: commandEnv, encoding: null, timeout: 120000, maxBuffer: 16 * 1024 * 1024, input, windowsHide: true })
  const finishedAt = new Date().toISOString()
  const stdout = result.stdout ?? Buffer.alloc(0)
  const stderr = result.stderr ?? Buffer.alloc(0)
  const stdoutPath = path.join(receiptDir, `${label}.stdout.log`)
  const stderrPath = path.join(receiptDir, `${label}.stderr.log`)
  wx(stdoutPath, stdout)
  wx(stderrPath, stderr)
  const closed = Number.isInteger(result.status) && result.signal === null && !result.error
  const receipt = {
    schema: 'cinatoken-isolated-release-command-v1', label, program, args, cwd, startedAt, finishedAt,
    actualExit: result.status, signal: result.signal, spawnError: result.error ? { code: result.error.code, message: result.error.message } : null,
    closed, expectedActualExits: expected, expectedExitMatched: closed && expected.includes(result.status),
    stdout: { path: stdoutPath, ...descriptor(stdoutPath) }, stderr: { path: stderrPath, ...descriptor(stderrPath) },
  }
  json(path.join(receiptDir, `${label}.result.json`), receipt)
  assert(closed, `${label}: no ordinary numeric child exit`)
  assert(expected.includes(result.status), `${label}: actual exit ${result.status} outside ${expected}`)
  return { receipt, stdout, stderr }
}
const sourceFiles = () => files.map((relative) => {
  const absolute = path.join(repository, relative)
  return { relative, exists: fs.existsSync(absolute), ...(fs.existsSync(absolute) ? descriptor(absolute) : {}) }
})

if (phase === 'snapshot') {
  const observedHead = command('source-head-before', 'git', ['rev-parse', 'HEAD'], repository).stdout.toString().trim()
  const source = sourceFiles()
  for (const entry of source.filter((x) => x.exists)) wx(path.join(taskRoot, 'source-before', entry.relative), fs.readFileSync(path.join(repository, entry.relative)))
  assert(!source.find((x) => x.relative === 'packages/web/CHANGELOG.md').exists, 'Web changelog must start absent')
  for (const relative of [...manifests, '.changeset/config.json', '.changeset/README.md', 'packages/web/.prettierrc', '.changeset/cinatoken-gateway-postgres.md']) {
    const original = fs.readFileSync(path.join(repository, relative)).toString().replaceAll('\r\n', '\n')
    const atBase = command(`base-${relative.replaceAll(/[^a-zA-Z0-9]/g, '-')}`, 'git', ['show', `${base}:${relative}`], repository).stdout.toString().replaceAll('\r\n', '\n')
    assert.equal(original, atBase, `${relative}: content differs from authorized base`)
  }
  for (const relative of manifests) assert.equal(readJson(path.join(repository, relative)).version, '2.8.0')
  json(path.join(taskRoot, 'source-before.json'), {
    schema: 'cinatoken-release-source-snapshot-v1', closed: true, createdAt: new Date().toISOString(), repository, authorizedBase: base, observedHead,
    source, baseContentNormalization: 'CRLF to LF only for base comparison; raw source snapshots remain exact', versions: 'all seven manifests 2.8.0',
    installed: Object.fromEntries(['@changesets/cli', '@changesets/apply-release-plan', '@changesets/config', '@changesets/changelog-github', 'prettier'].map((name) => [name, readJson(path.join(repository, 'node_modules', name, 'package.json')).version])),
  })
  console.log(JSON.stringify({ phase, actualExit: 0, sourceFiles: source.length, taskRoot }))
} else if (phase === 'before' || phase === 'after') {
  const snapshot = readJson(path.join(taskRoot, 'source-before.json'))
  const isolated = path.join(taskRoot, `isolated-${phase}`)
  assert(!fs.existsSync(isolated), 'Each version generation gets a fresh isolated tree')
  fs.mkdirSync(isolated)
  const copied = snapshot.source.filter((x) => x.exists && x.relative !== 'package-lock.json' && x.relative !== '.changeset/cinatoken-gateway-postgres.md')
  for (const entry of copied) {
    const bytes = phase === 'after' && entry.relative === '.changeset/config.json'
      ? fs.readFileSync(path.join(repository, entry.relative))
      : fs.readFileSync(path.join(taskRoot, 'source-before', entry.relative))
    wx(path.join(isolated, entry.relative), bytes)
  }
  const priorConfig = readJson(path.join(taskRoot, 'source-before/.changeset/config.json'))
  const currentConfig = readJson(path.join(isolated, '.changeset/config.json'))
  if (phase === 'before') assert.deepEqual(currentConfig, priorConfig)
  else {
    assert.equal(currentConfig.prettier, false)
    const withoutPrettier = { ...currentConfig }
    delete withoutPrettier.prettier
    assert.deepEqual(withoutPrettier, priorConfig, 'Only config.prettier changes version-generation configuration')
  }
  command(`${phase}-git-init`, 'git', ['init', '--initial-branch=main'], isolated)
  command(`${phase}-git-add-baseline`, 'git', ['-c', 'core.autocrlf=false', 'add', '--', ...copied.map((x) => x.relative)], isolated)
  command(`${phase}-git-commit-baseline`, 'git', ['-c', 'user.name=Isolated Release Validation', '-c', 'user.email=release-validation@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Isolated exact-source baseline; no remote'], isolated)
  fs.symlinkSync(path.join(repository, 'node_modules'), path.join(isolated, 'node_modules'), 'junction')
  wx(path.join(isolated, '.changeset/cinatoken-gateway-postgres.md'), fs.readFileSync(path.join(taskRoot, 'source-before/.changeset/cinatoken-gateway-postgres.md')))
  const inspectScript = path.join(taskRoot, `inspect-${phase}.cjs`)
  wx(inspectScript, `const assert=require('node:assert/strict');const git=require(${JSON.stringify(path.join(repository, 'node_modules/@changesets/git'))});const getPlan=require(${JSON.stringify(path.join(repository, 'node_modules/@changesets/get-release-plan'))}).default;(async()=>{const cwd=${JSON.stringify(isolated)};const commits=await git.getCommitsThatAddFiles(['.changeset/cinatoken-gateway-postgres.md'],{cwd});assert.equal(commits.length,1);assert.equal(commits[0],undefined);const plan=await getPlan(cwd);console.log(JSON.stringify({changesetAddingCommits:commits.map(x=>x??null),plan},null,2))})().catch(e=>{console.error(e);process.exitCode=1});\n`)
  const inspection = command(`${phase}-inspect-actual-release-plan`, process.execPath, [inspectScript], isolated)
  const inspected = JSON.parse(inspection.stdout)
  assert.equal(inspected.plan.releases.length, 6)
  for (const [name] of fixed) {
    const release = inspected.plan.releases.find((x) => x.name === name)
    assert(release)
    assert.equal(release.oldVersion, '2.8.0')
    assert.equal(release.newVersion, '2.9.0')
  }
  assert(!fs.existsSync(path.join(isolated, 'packages/web/CHANGELOG.md')))
  const generated = command(`${phase}-actual-changesets-cli-version`, process.execPath, [path.join(repository, 'node_modules/@changesets/cli/bin.js'), 'version'], isolated)
  const rows = fixed.map(([name, dir]) => {
    const manifest = path.join(isolated, dir, 'package.json')
    const changelog = path.join(isolated, dir, 'CHANGELOG.md')
    const exists = fs.existsSync(changelog)
    const content = exists ? fs.readFileSync(changelog, 'utf8') : ''
    const hasVersionHeading = /^## 2\.9\.0\s*$/m.test(content)
    const sourceChangelog = snapshot.source.find((x) => x.relative === path.posix.join(dir, 'CHANGELOG.md'))
    const priorHistory = sourceChangelog.exists ? fs.readFileSync(path.join(taskRoot, 'source-before', sourceChangelog.relative), 'utf8') : ''
    const historyTail = priorHistory ? priorHistory.slice(priorHistory.indexOf('\n') + 1) : ''
    return { name, dir, version: readJson(manifest).version, manifest: descriptor(manifest), changelog: { exists, ...(exists ? descriptor(changelog) : {}), hasVersionHeading, originalHistoryPreserved: exists && (!historyTail || content.endsWith(historyTail)) } }
  })
  for (const row of rows) assert.equal(row.version, '2.9.0')
  assert.equal(readJson(path.join(isolated, 'packages/chain-worker/package.json')).version, '2.8.0')
  const stderr = generated.stderr.toString()
  const web = rows.find((x) => x.name === '@cinatoken/web')
  const allSixGenerationComplete = rows.every((x) => x.changelog.exists && x.changelog.hasVersionHeading && x.changelog.originalHistoryPreserved)
  if (phase === 'before') {
    assert(stderr.includes("Cannot find module '@trivago/prettier-plugin-sort-imports'"), 'Must reproduce the exact original formatter failure')
    assert(stderr.includes('MODULE_NOT_FOUND'))
    assert.equal(web.changelog.exists, false)
    assert.equal(allSixGenerationComplete, false)
  } else {
    assert.equal(stderr.trim(), '')
    assert(allSixGenerationComplete)
    const originalSummary = fs.readFileSync(path.join(taskRoot, 'source-before/.changeset/cinatoken-gateway-postgres.md'), 'utf8').split(/---\s*/)[2].trim()
    assert(fs.readFileSync(path.join(isolated, 'CHANGELOG.md'), 'utf8').includes(originalSummary))
    assert(!fs.existsSync(path.join(isolated, '.changeset/cinatoken-gateway-postgres.md')))
  }
  const generatedOutput = path.join(taskRoot, `generated-${phase}`)
  for (const relative of [...manifests, ...changelogs]) {
    const absolute = path.join(isolated, relative)
    if (fs.existsSync(absolute)) wx(path.join(generatedOutput, relative), fs.readFileSync(absolute))
  }
  json(path.join(taskRoot, `${phase}-generation-observed.json`), {
    schema: 'cinatoken-release-generation-observed-v1', closed: true, phase, isolated, actualCliExit: generated.receipt.actualExit,
    completeGenerationActualOutcome: allSixGenerationComplete ? 0 : 1, allSixGenerationComplete, rows,
    exactFormatterFailureObserved: phase === 'before', webChangelogAbsent: !web.changelog.exists,
    chainWorkerVersion: '2.8.0', noEmptyChangelogCreated: true, cliCommand: generated.receipt,
    offlineGitHubPluginBoundary: { actualPluginUnmodified: true, actualChangesetCommit: null, sourceChangesetSummaryHasNoPrOrCommitDirective: true, noGitRemotes: command(`${phase}-git-remotes`, 'git', ['remote'], isolated).stdout.toString() === '', noRemoteCommandsIssued: true },
    limitation: 'Real installed Changesets CLI and changelog plugin; source pending changeset is uncommitted only in the isolated Git tree, so GitHub commit/PR attribution is not exercised. No Action PR/tag/publish or Linux CI executed.',
  })
  console.log(JSON.stringify({ phase, actualCliExit: generated.receipt.actualExit, completeGenerationActualOutcome: allSixGenerationComplete ? 0 : 1, allSixGenerationComplete, allVersions: rows.map((x) => x.version), webChangelog: web.changelog }))
} else if (phase === 'integrity') {
  const validator = path.join(taskRoot, 'check-generated-output.mjs')
  assert(fs.existsSync(validator))
  const before = command('before-actual-six-changelog-integrity', process.execPath, [validator, path.join(taskRoot, 'isolated-before')], taskRoot, { expected: [1] })
  assert(before.stderr.toString().includes('ENOENT'))
  assert(before.stderr.toString().includes('packages\\web\\CHANGELOG.md'))
  const after = command('after-actual-six-changelog-integrity', process.execPath, [validator, path.join(taskRoot, 'isolated-after')], taskRoot)
  const output = JSON.parse(after.stdout)
  assert.equal(output.rows.length, 6)
  assert.equal(output.rows.every((x) => x.version === '2.9.0' && x.changelogBytes > 0 && x.hasVersionHeading), true)
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  assert(fs.existsSync(npmCli))
  command('unchanged-web-full-format-check', process.execPath, [npmCli, 'run', 'format:check', '--workspace', '@cinatoken/web'], repository)
  json(path.join(taskRoot, 'actual-integrity-and-format-gates.json'), {
    closed: true, beforeActualIntegrityExit: before.receipt.actualExit, afterActualIntegrityExit: after.receipt.actualExit,
    webFullFormatterActualExit: 0, noFormatterConfigurationOrScriptChange: true, validator,
    beforeFailure: 'Actual fs.readFileSync of the missing generated Web CHANGELOG throws ENOENT after checking all six package versions and five existing changelogs.',
  })
  console.log(JSON.stringify({ phase, beforeActualIntegrityExit: 1, afterActualIntegrityExit: 0, webFullFormatterActualExit: 0 }))
} else {
  const snapshot = readJson(path.join(taskRoot, 'source-before.json'))
  const before = readJson(path.join(taskRoot, 'before-generation-observed.json'))
  const after = readJson(path.join(taskRoot, 'after-generation-observed.json'))
  const integrity = readJson(path.join(taskRoot, 'actual-integrity-and-format-gates.json'))
  assert.equal(integrity.beforeActualIntegrityExit, 1)
  assert.equal(integrity.afterActualIntegrityExit, 0)
  assert.equal(integrity.webFullFormatterActualExit, 0)
  assert.equal(before.completeGenerationActualOutcome, 1)
  assert.equal(after.completeGenerationActualOutcome, 0)
  const current = sourceFiles()
  for (const entry of snapshot.source.filter((x) => !['.changeset/config.json', '.changeset/README.md'].includes(x.relative))) {
    assert.deepEqual(current.find((x) => x.relative === entry.relative), entry, `${entry.relative}: source input changed`)
  }
  for (const relative of manifests) assert.equal(readJson(path.join(repository, relative)).version, '2.8.0')
  const sourceAfter = ['.changeset/config.json', '.changeset/README.md'].map((relative) => {
    wx(path.join(taskRoot, 'source-after', relative), fs.readFileSync(path.join(repository, relative)))
    return { relative, ...descriptor(path.join(repository, relative)) }
  })
  const diff = command('source-exact-two-file-diff', 'git', ['diff', '--', '.changeset/config.json', '.changeset/README.md'], repository)
  command('source-two-file-diff-check', 'git', ['diff', '--check', '--', '.changeset/config.json', '.changeset/README.md'], repository)
  const observedHeadAtSeal = command('source-head-at-seal', 'git', ['rev-parse', 'HEAD'], repository).stdout.toString().trim()
  const receipts = fs.readdirSync(receiptDir).filter((x) => x.endsWith('.result.json')).map((file) => ({ file, ...readJson(path.join(receiptDir, file)) }))
  for (const receipt of receipts) {
    assert(receipt.closed)
    assert(receipt.expectedExitMatched)
    for (const stream of [receipt.stdout, receipt.stderr]) assert.deepEqual(descriptor(stream.path), { bytes: stream.bytes, sha256: stream.sha256 })
  }
  const report = {
    schema: 'cinatoken-changesets-prettier-repair-v1', createdAt: new Date().toISOString(), closed: true, actualOutcome: 0,
    repository, taskRoot, authorizedBase: base, preparedAtHead: snapshot.observedHead,
    observedHeadAtSeal, nodeVersion: process.version, installed: snapshot.installed,
    changedSourceFiles: sourceAfter, unchangedSourceInputCount: snapshot.source.length - 2, unchangedSourceInputs: current.filter((x) => !['.changeset/config.json', '.changeset/README.md'].includes(x.relative)),
    originalRepositoryVersions: 'All six fixed manifests and chain-worker remain 2.8.0; Web CHANGELOG remains absent; original lockfile/changelogs/formatter/config scripts exact.',
    configDelta: { prettier: false, allOtherFieldsEqual: true, changelogPluginUnchanged: true, fixedGroupUnchanged: true },
    before: { actualCliExit: before.actualCliExit, generationOutcome: before.completeGenerationActualOutcome, actualCompleteOutputIntegrityExit: integrity.beforeActualIntegrityExit, exactModuleNotFound: true, webChangelogAbsent: true },
    after: { actualCliExit: after.actualCliExit, generationOutcome: after.completeGenerationActualOutcome, actualCompleteOutputIntegrityExit: integrity.afterActualIntegrityExit, allSixVersion: '2.9.0', sixNonemptyChangelogsWithVersionHeading: true, originalHistoryPreserved: true, chainWorkerVersion: '2.8.0', noFormatterError: true, originalRootSummaryPresent: true, unchangedWebFullFormatGateActualExit: integrity.webFullFormatterActualExit },
    evidence: { sourceBefore: path.join(taskRoot, 'source-before.json'), before: path.join(taskRoot, 'before-generation-observed.json'), after: path.join(taskRoot, 'after-generation-observed.json'), exactDiff: diff.receipt.stdout, commandReceipts: receipts.length, allCapturedCommandsClosed: true, allRawBytesVerified: true },
    originalCiFailureEvidence: readJson(path.join(taskRoot, 'original-ci-failure-provenance.json')),
    frozenToolSources: ['verify-release-generation.mjs', 'check-generated-output.mjs', 'archive-original-release-ci.mjs'].map((relative) => ({ relative, ...descriptor(path.join(taskRoot, relative)) })),
    boundaries: { actualReleaseCi37401132382FailurePreserved: true, noSourcePackageVersionWrite: true, noSourceWebFormatterWrite: true, noDependenciesChanged: true, noSourceGitMutation: true, onlyIsolatedGitInitAndBaselineCommit: true, noRemoteWrite: true, noPublishPrOrTag: true, noProductionAccess: true, githubAttributionNotExercised: true, linuxReleaseCiNotRunByThisTask: true },
  }
  json(path.join(taskRoot, 'FINAL-release-prettier-repair.json'), report)
  console.log(JSON.stringify({ actualOutcome: 0, report: path.join(taskRoot, 'FINAL-release-prettier-repair.json'), ...descriptor(path.join(taskRoot, 'FINAL-release-prettier-repair.json')), commandReceipts: receipts.length }))
}
