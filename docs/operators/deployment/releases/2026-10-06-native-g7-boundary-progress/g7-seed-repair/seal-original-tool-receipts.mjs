import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const out = path.dirname(fileURLToPath(import.meta.url))
const firstOutput = String.raw`node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: The input did not match the regular expression /# tests 7\b/. Input:

'✔ command budget never admits zero, negative or oversized remaining timeout (2.4868ms)\n' +
  '✔ execution admission rejects wrong SHA, platform, endpoint and TLS bypass (2.8898ms)\n' +
  '✔ cleanup ownership never admits foreign or unlabeled resources (0.6425ms)\n' +
  '✔ topology rejects public ports, extra networks and writable input mounts (1.7236ms)\n' +
  '✔ the real SQL text fixture satisfies production endpoint and operation admission (5.8407ms)\n' +
  '✔ provider encryption and real route fingerprint bind the seeded plaintext credential (20.0908ms)\n' +
  "✔ the rotated owned Admin key uses the production lookup hash and rejects the migration's development key (3.3111ms)\n" +
  'ℹ tests 7\n' +
  'ℹ suites 0\n' +
  'ℹ pass 7\n' +
  'ℹ fail 0\n' +
  'ℹ cancelled 0\n' +
  'ℹ skipped 0\n' +
  'ℹ todo 0\n' +
  'ℹ duration_ms 478.6688\n'

    at file:///C:/Users/cina/AppData/Local/Temp/cinatoken-g7-seed-current-schema-repair-fea67a837643495ba516bfee9c889f57/run-local-checks.mjs:52:8
    at ModuleJob.run (node:internal/modules/esm/module_job:430:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:661:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5) {
  generatedMessage: true,
  code: 'ERR_ASSERTION',
  actual: '✔ command budget never admits zero, negative or oversized remaining timeout (2.4868ms)\n' +
    '✔ execution admission rejects wrong SHA, platform, endpoint and TLS bypass (2.8898ms)\n' +
    '✔ cleanup ownership never admits foreign or unlabeled resources (0.6425ms)\n' +
    '✔ topology rejects public ports, extra networks and writable input mounts (1.7236ms)\n' +
    '✔ the real SQL text fixture satisfies production endpoint and operation admission (5.8407ms)\n' +
    '✔ provider encryption and real route fingerprint bind the seeded plaintext credential (20.0908ms)\n' +
    "✔ the rotated owned Admin key uses the production lookup hash and rejects the migration's development key (3.3111ms)\n" +
    'ℹ tests 7\n' +
    'ℹ suites 0\n' +
    'ℹ pass 7\n' +
    'ℹ fail 0\n' +
    'ℹ cancelled 0\n' +
    'ℹ skipped 0\n' +
    'ℹ todo 0\n' +
    'ℹ duration_ms 478.6688\n',
  expected: /# tests 7\b/,
  operator: 'match',
  diff: 'simple'
}

Node.js v24.14.1
`.replaceAll('\n', '\r\n')
const first = { chunk_id: 'ea7562', wall_time_seconds: 1.7271082, exit_code: 1, original_token_count: 639, output: firstOutput }
const final = {
  chunk_id: 'b8984c', wall_time_seconds: 1.6145798, exit_code: 0, original_token_count: 156,
  output: JSON.stringify({ actualOutcome: 0, report: path.join(out, 'FINAL-g7-seed-current-schema-repair.json'), bytes: 3994, sha256: '421899867db8000a1d1b3bd7971a4dfa20e66d0e2e319bf5f5700796e8fd0ab9', sourceFiles: [{ relative: 'scripts/verification/web-platform-g7/database.mjs', bytes: 11117, sha256: '643686dc1f78e75601a6b339c22fb06e91caf4c21403ad5ed24a231598d5e5f1' }, { relative: 'scripts/verification/web-platform-g7/fixture.test.mjs', bytes: 5964, sha256: '2db99943e1228b81f3c2a5b3fc958af8c65f904cb6745ecda8fc94d96d00d844' }], commandReceipts: 14 }) + '\n',
}
assert.equal(createHash('sha256').update(fs.readFileSync(path.join(out, 'FINAL-g7-seed-current-schema-repair.json'))).digest('hex'), JSON.parse(final.output).sha256)
fs.writeFileSync(path.join(out, 'original-first-producer-tool-output.txt'), first.output, { flag: 'wx' })
fs.writeFileSync(path.join(out, 'FINAL-g7-seed-repair.exec-tool-receipts.json'), JSON.stringify({
  schema: 'cinatoken-original-exec-command-tool-receipts-v1',
  provenance: 'Original completed tools.exec_command return values copied from this conversation; no commands replayed. The first combined output is the tool-returned command output, not an independently captured stdout/stderr split.',
  firstProducer: first, finalProducer: final,
}, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ actualOutcome: 0, firstActualExit: 1, finalActualExit: 0, file: path.join(out, 'FINAL-g7-seed-repair.exec-tool-receipts.json'), sha256: createHash('sha256').update(fs.readFileSync(path.join(out, 'FINAL-g7-seed-repair.exec-tool-receipts.json'))).digest('hex') }))
