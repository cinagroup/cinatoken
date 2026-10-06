import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const temp = path.dirname(fileURLToPath(import.meta.url))
const out = 'C:/cinagroup/cinatoken/docs/developers/architecture/evidence/2026-10-06-public-ssr-preferences/production-f9/closure'
assert.equal(fs.existsSync(out), false)
const receipt = JSON.parse(fs.readFileSync(path.join(temp, 'archive-final-production.result.json')))
assert.equal(receipt.actualExit, 0)
assert.equal(receipt.signal, null)
fs.mkdirSync(out)
const records = []
for (const suffix of ['result.json', 'stdout.log', 'stderr.log']) {
  const source = path.join(temp, 'archive-final-production.' + suffix)
  const bytes = fs.readFileSync(source)
  const name = 'archive-process.' + suffix
  fs.writeFileSync(path.join(out, name), bytes, { flag: 'wx' })
  assert.deepEqual(fs.readFileSync(path.join(out, name)), bytes)
  records.push({ path: name, original: source, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
const script = fs.readFileSync(fileURLToPath(import.meta.url))
fs.writeFileSync(path.join(out, 'write-final-archive-closure.mjs'), script, { flag: 'wx' })
records.push({ path: 'write-final-archive-closure.mjs', original: fileURLToPath(import.meta.url), bytes: script.length, sha256: createHash('sha256').update(script).digest('hex') })
const index = { at: new Date().toISOString(), actualArchiveChildExit: receipt.actualExit, actualArchiveChildSignal: receipt.signal, scope: 'Real archive process close, saved after the source inventory and ZIP roundtrip. Does not replace original HTTP or source download failure exits.', files: records }
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ out, actualArchiveChildExit: receipt.actualExit, files: records.length }))
