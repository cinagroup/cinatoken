import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const sourceRoot = 'C:/Users/cina/AppData/Local/Temp/cinatoken-public-preferences-fixture-c60a7fdf3ecc40f49e04ef65e7956771'
const out = 'C:/cinagroup/cinatoken/docs/developers/architecture/evidence/2026-10-06-public-ssr-preferences/production-f9/closure/independent-archive-review'
assert.equal(fs.existsSync(out), false)
fs.mkdirSync(out)
const records = []
for (const name of ['archive-final-roundtrip-review.json', 'archive-review-attempt1-script.py', 'archive-review-attempt1.result.json', 'archive-review-process.result.json', 'verify-final-archive-roundtrip.py']) {
  const source = path.join(sourceRoot, name)
  const data = fs.readFileSync(source)
  fs.writeFileSync(path.join(out, name), data, { flag: 'wx' })
  assert.deepEqual(fs.readFileSync(path.join(out, name)), data)
  records.push({ path: name, original: source, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
}
const script = fs.readFileSync(fileURLToPath(import.meta.url))
fs.writeFileSync(path.join(out, 'copy-independent-archive-review.mjs'), script, { flag: 'wx' })
records.push({ path: 'copy-independent-archive-review.mjs', original: fileURLToPath(import.meta.url), bytes: script.length, sha256: createHash('sha256').update(script).digest('hex') })
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ at: new Date().toISOString(), scope: 'Independent read-only archive review generated after the ZIP froze. Initial reviewer enumeration expectation failure remains actual1; corrected exact enumeration completed actual0. Neither changes source, production or original acceptance failures.', files: records }, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ out, files: records.length }))
