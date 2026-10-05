import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const [origin, sha, label] = process.argv.slice(2);
assert.ok(['https://cinatoken-web.cinagroup.workers.dev', 'https://cinatoken.com'].includes(origin));
assert.match(sha ?? '', /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/); assert.match(label ?? '', /^[a-z0-9-]+$/);
const manifest = JSON.parse(fs.readFileSync('C:/cinagroup/cinatoken/.release/web/' + sha + '/manifest.json', 'utf8'));
const report = { at: new Date().toISOString(), origin, sourceCommit: sha, actualExit: null, files: [] };
let cursor = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < manifest.files.length) {
    const file = manifest.files[cursor++];
    try {
      const response = await fetch(origin + '/web-assets/' + file.path, { redirect: 'manual', signal: AbortSignal.timeout(45000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      report.files.push({ path: file.path, status: response.status, bytes: bytes.length, sha256: actual, expectedBytes: file.bytes, expectedSha256: file.sha256, matched: response.status === 200 && bytes.length === file.bytes && actual === file.sha256, cacheControl: response.headers.get('cache-control') });
    } catch (error) { report.files.push({ path: file.path, matched: false, error: error.message }); }
  }
}));
report.files.sort((a,b) => a.path.localeCompare(b.path));
report.actualExit = report.files.length === manifest.files.length && report.files.every(f => f.matched) ? 0 : 1;
report.finishedAt = new Date().toISOString();
fs.writeFileSync(new URL(label + '.assets-proof.json', import.meta.url), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ actualExit: report.actualExit, sourceCommit: sha, origin, files: report.files.length, matched: report.files.filter(f => f.matched).length, failures: report.files.filter(f => !f.matched) }));
process.exitCode = report.actualExit;

