import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const tree = path.resolve(process.argv[2])
const directories = ['.', 'packages/core', 'packages/tool-engines', 'packages/proxy', 'packages/admin', 'packages/web']
const rows = []
for (const directory of directories) {
  const manifest = JSON.parse(fs.readFileSync(path.join(tree, directory, 'package.json'), 'utf8'))
  assert.equal(manifest.version, '2.9.0')
  const content = fs.readFileSync(path.join(tree, directory, 'CHANGELOG.md'), 'utf8')
  const hasVersionHeading = /^## 2\.9\.0\s*$/m.test(content)
  assert(content.length > 0)
  assert(hasVersionHeading)
  rows.push({ name: manifest.name, version: manifest.version, changelogBytes: Buffer.byteLength(content), hasVersionHeading })
}
assert.equal(rows.length, 6)
console.log(JSON.stringify({ actualOutcome: 0, rows }, null, 2))
