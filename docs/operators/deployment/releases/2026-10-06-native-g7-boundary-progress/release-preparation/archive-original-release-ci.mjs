import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const output = path.dirname(fileURLToPath(import.meta.url))
const source = 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E'
const prefix = 'native12-release-terminal-failed'
const entries = []
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const originalReceipt = JSON.parse(fs.readFileSync(path.join(source, `${prefix}.result.json`)))
assert.equal(originalReceipt.actualExit, 0)
assert.equal(originalReceipt.signal, null)
assert.deepEqual(originalReceipt.args, ['run', 'view', '37401132382', '--log-failed'])
for (const suffix of ['result.json', 'stdout.log', 'stderr.log']) {
  const filename = `${prefix}.${suffix}`
  const from = path.join(source, filename)
  const to = path.join(output, 'original-ci-failure', filename)
  const bytes = fs.readFileSync(from)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.writeFileSync(to, bytes, { flag: 'wx' })
  assert(fs.readFileSync(to).equals(bytes))
  entries.push({ source: from, copy: to, bytes: bytes.length, sha256: hash(bytes), exact: true })
}
const raw = fs.readFileSync(path.join(source, `${prefix}.stdout.log`), 'utf8')
assert(raw.includes("Cannot find module '@trivago/prettier-plugin-sort-imports'"))
assert(raw.includes("ENOENT: no such file or directory, open '/home/runner/work/cinatoken/cinatoken/packages/web/CHANGELOG.md'"))
fs.writeFileSync(path.join(output, 'original-ci-failure-provenance.json'), `${JSON.stringify({ closed: true, actualArchiveOutcome: 0, originalDownloadActualExit: 0, originalReleaseFailurePreserved: true, noWorkflowRerun: true, entries }, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ actualArchiveOutcome: 0, copiedFiles: entries.length, originalDownloadActualExit: 0, releaseFailurePreserved: true }))
