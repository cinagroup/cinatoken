import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const sourceRoot = 'C:/Users/cina/AppData/Local/Temp/cinatoken-public-preferences-md-scope-79204d34279045ad83a65f36ab1e0bab'
const out = 'C:/cinagroup/cinatoken/docs/developers/architecture/evidence/2026-10-06-public-ssr-preferences/production-f9/closure/scope-final-review'
assert.equal(fs.existsSync(out), false)
fs.mkdirSync(out)
const records = []
const names = ['final-md-manual-evidence-review.json', 'final-scope-complete.result.json', 'final-scope-complete.stderr.log', 'final-scope-complete.stdout.log', 'final-scope-review-complete.json', 'run-final-scope-complete.mjs']
for (const name of names) {
  const source = path.join(sourceRoot, name)
  const data = fs.readFileSync(source)
  fs.writeFileSync(path.join(out, name), data, { flag: 'wx' })
  assert.deepEqual(fs.readFileSync(path.join(out, name)), data)
  records.push({ path: name, original: source, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
}
const script = fs.readFileSync(fileURLToPath(import.meta.url))
fs.writeFileSync(path.join(out, 'copy-scope-final-review.mjs'), script, { flag: 'wx' })
records.push({ path: 'copy-scope-final-review.mjs', original: fileURLToPath(import.meta.url), bytes: script.length, sha256: createHash('sha256').update(script).digest('hex') })
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ at: new Date().toISOString(), scope: 'Independent final checklist and lossless archive review, generated after the ZIP source inventory froze; includes original real close receipt.', files: records }, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ out, files: records.length }))
