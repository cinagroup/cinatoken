import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const [sha, label, owner] = process.argv.slice(2);
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
assert.match(label ?? '', /^[a-z0-9-]+$/);
assert.ok(['cinatoken-admin', 'cinatoken-web'].includes(owner));
const base = 'https://api.cloudflare.com/client/v4';
const account = '7ea8e46d8210bad342fa7595f7935fea';
const before = JSON.parse(fs.readFileSync(new URL('inventory-before.json', import.meta.url), 'utf8'));
const report = { at: new Date().toISOString(), actualExit: null, sourceCommit: sha, readOnly: true, secretValuesRecorded: false, workers: [] };
async function get(p) { const r = await fetch(base + p, { headers: { Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN }, signal: AbortSignal.timeout(30000) }); const j = await r.json(); assert.equal(r.status, 200); assert.equal(j.success, true); return j.result; }
try {
  const routes = await get('/zones/' + before.zone.id + '/workers/routes');
  report.route = routes.find(r => r.id === '5738534653ef46f48a44e3f3b22e5d8e');
  assert.equal(report.route.pattern, 'cinatoken.com/*'); assert.equal(report.route.script, owner); assert.equal(report.route.request_limit_fail_open, false);
  report.proxyRoute = routes.find(r => r.pattern === 'api.cinatoken.com/*');
  assert.deepEqual(report.proxyRoute, before.routes.find(r => r.pattern === 'api.cinatoken.com/*'));
  for (const name of ['cinatoken-admin', 'cinatoken-proxy', 'cinatoken-web']) {
    const [settings, ds] = await Promise.all([get('/accounts/' + account + '/workers/scripts/' + name + '/settings'), get('/accounts/' + account + '/workers/scripts/' + name + '/deployments')]);
    const deployment = ds.deployments[0]; assert.equal(deployment.versions.length, 1); assert.equal(deployment.versions[0].percentage, 100);
    const version = await get('/accounts/' + account + '/workers/scripts/' + name + '/versions/' + deployment.versions[0].version_id);
    const record = { name, versionId: version.id, percentage: 100, commitTag: version.annotations?.['workers/tag'], deploymentId: deployment.id };
    if (name !== 'cinatoken-web') assert.equal(record.versionId, before.workers.find(w => w.name === name).deployment.versions[0].id, 'Backend deployment must remain unchanged');
    else {
      assert.equal(record.commitTag, sha);
      record.bindings = settings.bindings.map(b => ({ name: b.name, type: b.type, ...(b.service ? { service: b.service } : {}), ...(b.name.startsWith('CINATOKEN_WEB_') ? { value: b.text } : {}) }));
      const flags = record.bindings.filter(b => b.name.endsWith('_ENABLED'));
      assert.equal(flags.length, 29); assert(flags.every(b => b.value === 'true'));
      assert.equal(record.bindings.find(b => b.name === 'CINATOKEN_WEB_PUBLIC_ORIGIN').value, 'https://cinatoken.com');
      assert.equal(record.bindings.find(b => b.name === 'CINATOKEN_WEB_PROXY_ORIGINS').value, 'https://api.cinatoken.com');
      assert.equal(record.bindings.find(b => b.name === 'CINATOKEN_ADMIN_SERVICE').service, 'cinatoken-admin');
      assert.equal(record.bindings.filter(b => b.type !== 'plain_text' && b.type !== 'assets' && b.type !== 'service').length, 0);
      record.flags = { total: 29, enabled: 29 }; report.webVersionId = record.versionId;
    }
    report.workers.push(record);
  }
  report.actualExit = 0;
} catch (error) { report.actualExit = 1; report.error = error.message; }
report.finishedAt = new Date().toISOString();
const path = new URL(label + '.live-proof.json', import.meta.url);
const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(path, bytes, { flag: 'wx' });
console.log(JSON.stringify({ ...report, raw: { path: path.pathname.replace(/^\/([A-Za-z]:)/, '$1'), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } }));
process.exitCode = report.actualExit;
