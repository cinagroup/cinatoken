import assert from 'node:assert/strict';
import { imageSseFixture } from './staging-image-sse-fixture.mjs';

// Operator-only, not imported by either Worker. No network, credentials, retry, or timer ownership here.
export const SSE_STAGING_SCOPE = Object.freeze({
  account: '7ea8e46d8210bad342fa7595f7935fea',
  database: '6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1',
  worker: 'cinatoken-proxy-staging',
  app: 'ed5fd912-d6f1-4662-9575-02e0d6877af4',
  policy: 'fe10cfee-e285-491e-88ee-f0aecee1c1cd',
  audience: '25fd1a7f07ecaa1f6913341ec7890cff5ef6971a46908cb97a238b2093cecee5',
  domain: 'cinatoken-proxy-staging.cinagroup.workers.dev',
});
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const modes = new Set(['success', 'provider-error', 'partial-provider-error', 'invalid-json', 'early-eof', 'usage-limit', 'property-limit', 'cancel', 'deadline']);
const capacity = mode => mode === 'usage-limit' || mode === 'property-limit';
const spent = mode => mode === 'success' || capacity(mode) ? 100000 : 0;
const subdomain = `/workers/scripts/${SSE_STAGING_SCOPE.worker}/subdomain`;
const appPath = `/access/apps/${SSE_STAGING_SCOPE.app}`;
const policyPath = `${appPath}/policies/${SSE_STAGING_SCOPE.policy}`;

function validateJournal(journal, { requests = true } = {}) {
  assert.match(journal.runId, new RegExp(`^c02-success-${uuid}$`));
  if (requests) {
    assert.ok(Array.isArray(journal.requests) && journal.requests.length <= 9);
    const ids = new Set(), seenModes = new Set();
    for (const r of journal.requests) {
      assert.match(r.id, new RegExp(`^gen-${uuid}$`));
      assert.ok(modes.has(r.mode) && !ids.has(r.id) && !seenModes.has(r.mode));
      ids.add(r.id); seenModes.add(r.mode);
    }
  }
  if (journal.tokenName !== undefined) assert.match(journal.tokenName, new RegExp(`^cinatoken-sse-v[0-9]+-${uuid}$`));
  if (journal.tokenId !== undefined) {
    assert.match(journal.tokenId, new RegExp(`^${uuid}$`));
    assert.ok(journal.tokenName, 'An ID alone does not establish token ownership');
  }
}

function checkApp(app, tokenId) {
  assert.equal(app.id, SSE_STAGING_SCOPE.app);
  assert.equal(app.type, 'self_hosted');
  assert.equal(app.domain, SSE_STAGING_SCOPE.domain);
  assert.equal(app.aud, SSE_STAGING_SCOPE.audience);
  assert.deepEqual(app.destinations, [{ type: 'public', uri: SSE_STAGING_SCOPE.domain }]);
  assert.equal(app.policies.length, 1);
  const p = app.policies[0];
  assert.equal(p.id, SSE_STAGING_SCOPE.policy);
  assert.equal(p.name, 'CinaToken staging closed');
  assert.equal(p.precedence, 1);
  assert.deepEqual(p.exclude ?? [], []); assert.deepEqual(p.require ?? [], []);
  if (p.decision === 'deny') assert.deepEqual(p.include, [{ everyone: {} }]);
  else {
    assert.equal(p.decision, 'non_identity'); assert.ok(tokenId);
    assert.deepEqual(p.include, [{ service_token: { token_id: tokenId } }]);
  }
}

/** api(path, method?, body?) is an account-scoped, bounded, NO-auto-retry adapter.
 * Re-enter after any uncertain result: current state, not a checkpoint flag, chooses the next write.
 * persist must durably record the safe checkpoint before the next operation. No secrets are returned.
 */
export async function closeSseStagingAccess({ api, journal, persist = async () => {} }) {
  validateJournal(journal, { requests: false });
  let ingress = await api(subdomain);
  if (ingress.enabled !== false || ingress.previews_enabled !== false) {
    await api(subdomain, 'POST', { enabled: false, previews_enabled: false });
    ingress = await api(subdomain);
  }
  assert.equal(ingress.enabled, false); assert.equal(ingress.previews_enabled, false);
  await persist({ step: 'ingress-closed' });

  // Exact-name discovery covers a token-create acknowledgement lost before the ID was recorded.
  const tokens = journal.tokenName ? await api('/access/service_tokens') : [];
  assert.ok(Array.isArray(tokens));
  const found = tokens.filter(t => t.name === journal.tokenName);
  assert.ok(found.length <= 1, 'Ambiguous token ownership');
  const token = found[0], tokenId = journal.tokenId ?? token?.id;
  if (token) {
    assert.match(token.id, new RegExp(`^${uuid}$`));
    if (journal.tokenId) assert.equal(token.id, journal.tokenId);
  }
  if (journal.tokenId) assert.ok(tokens.every(t => t.id !== journal.tokenId || t.name === journal.tokenName));
  let app = await api(appPath); checkApp(app, tokenId);
  if (token && token.enabled !== false) await api(`/access/service_tokens/${token.id}`, 'PUT', { name: journal.tokenName, enabled: false });
  await persist({ step: 'token-disabled-or-absent', ...(tokenId ? { tokenId } : {}) });

  // Reverse setup order: Access rejects removal of the last service-auth policy while this is true.
  if (app.service_auth_401_redirect === true) {
    await api(appPath, 'PUT', { ...app, service_auth_401_redirect: false });
    app = await api(appPath); checkApp(app, tokenId);
    assert.notEqual(app.service_auth_401_redirect, true);
  }
  await persist({ step: 'service-auth-redirect-off' });
  if (app.policies[0].decision !== 'deny') {
    await api(policyPath, 'PUT', { name: 'CinaToken staging closed', precedence: 1,
      decision: 'deny', include: [{ everyone: {} }], exclude: [], require: [] });
  }
  app = await api(appPath); checkApp(app, tokenId);
  assert.equal(app.policies[0].decision, 'deny'); assert.notEqual(app.service_auth_401_redirect, true);
  await persist({ step: 'deny-all-restored' });
  if (token) await api(`/access/service_tokens/${token.id}`, 'DELETE');
  if (journal.tokenName) {
    const remaining = await api('/access/service_tokens');
    assert.ok(remaining.every(t => t.id !== tokenId && t.name !== journal.tokenName));
  }
  const finalIngress = await api(subdomain);
  assert.equal(finalIngress.enabled, false); assert.equal(finalIngress.previews_enabled, false);
  await persist({ step: 'access-cleanup-complete' });
  return { ingressClosed: true, denyEveryone: true, tokenAbsent: true };
}

/** Exact frozen SSE deadline contract; an injected timer is not a real wall-clock acceptance. */
export function assertSseDeadlineObservation({ journal, id, wire, elapsedMs, probe, logs, account, recoveryCounts }) {
  validateJournal(journal);
  const request = journal.requests.find(r => r.mode === 'deadline'); assert.ok(request);
  assert.equal(request.id, id); assert.match(request.probeId, new RegExp(`^${uuid}$`));
  assert.match(id, new RegExp(`^gen-${uuid}$`));
  assert.equal(typeof wire, 'string'); assert.ok(Buffer.byteLength(wire) <= 8192);
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 295000 && elapsedMs <= 325000);
  const blocks = wire.split('\n\n').filter(s => s.trim());
  assert.ok(blocks.every(s => s.startsWith('data: ')));
  const records = blocks.map(s => s.slice(6));
  assert.equal(records.length, 3);
  assert.deepEqual(JSON.parse(records[0]), {type:'image_generation.partial_image',partial_image_index:0,b64_json:'AQID'});
  assert.equal(records.at(-1), '[DONE]'); assert.equal(records.filter(s => s === '[DONE]').length, 1);
  const errors = records.filter(s => s !== '[DONE]').map(JSON.parse).filter(s => s.type === 'error');
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].error, {
    code: 'server_error', message: 'Image generation timed out waiting for the upstream stream',
    metadata: { retry_safe: false, outcome_unknown: true, request_id: id },
  });
  assert.doesNotMatch(wire, /spoofed-|PRIVATE_DETAIL/);
  assert.equal(probe.runId, journal.runId); assert.equal(probe.probeId, request.probeId); assert.equal(probe.mode, 'hold');
  assert.equal(probe.phase, 'terminal');
  assert.equal(probe.events.filter(e => e.phase === 'terminal').length, 1);
  assert.ok(['request_abort', 'response_cancel'].includes(probe.events.at(-1).reason));
  const matches = logs.filter(log => log.id === id); assert.equal(matches.length, 1);
  assert.deepEqual(logs.map(log => log.id).sort(), journal.requests.map(r => r.id).sort());
  assert.equal(matches[0].status, 'error'); assert.equal(matches[0].charged_cost, 0);
  assert.equal(matches[0].upstream_attempt_count, 1);
  assert.equal(account.budget_reserved_micros, 0);
  assert.equal(account.budget_spent_micros, journal.requests.reduce((n, r) => n + spent(r.mode), 0));
  assert.deepEqual(recoveryCounts, [0, 0, 0]);
}

// SQLite/D1 JSON failure makes a failed precondition abort the surrounding batch, not just skip a DELETE.
const guard = (condition, params) => ({ sql: `SELECT CASE WHEN ${condition} THEN 1 ELSE json('staging_cleanup_precondition_failed') END AS cleanup_guard`, params });
const reservationColumns = ['request_id', 'user_id', 'api_key_id', 'budget_epoch', 'state', 'reserved_micros', 'settled_micros', 'terminal_at', 'terminal_reason', 'updated_at'];

/** Only observed terminal rows of these exact requests may be removed. Missing rows permit resume. */
export function terminalSseReservationCleanup(journal, rows) {
  validateJournal(journal); assert.ok(Array.isArray(rows) && rows.length <= journal.requests.length);
  const ids = new Set(), statements = [];
  for (const row of rows) {
    const r = journal.requests.find(r => r.id === row.request_id); assert.ok(r && !ids.has(r.id)); ids.add(r.id);
    assert.equal(row.user_id, journal.runId + '-user'); assert.equal(row.api_key_id, journal.runId + '-key');
    assert.equal(row.state, capacity(r.mode) ? 'expired' : 'settled');
    assert.equal(row.terminal_reason, capacity(r.mode) ? 'usage_unavailable_after_dispatch' : 'request_usage_settled');
    assert.equal(row.reserved_micros, 100000); assert.equal(row.settled_micros, spent(r.mode));
    assert.ok(Number.isSafeInteger(row.budget_epoch) && row.budget_epoch >= 0);
    for (const k of ['terminal_at', 'updated_at']) assert.equal(new Date(row[k]).toISOString(), row[k]);
    const where = reservationColumns.map(c => `${c}=?`).join(' AND '), params = reservationColumns.map(c => row[c]);
    statements.push(guard(`EXISTS(SELECT 1 FROM user_budget_reservations WHERE ${where})`, params));
    statements.push({ sql: `DELETE FROM user_budget_reservations WHERE ${where}`, params });
  }
  return statements;
}

function probeSelection(journal) {
  assert.ok(Array.isArray(journal.probes) && journal.probes.length <= 9);
  const keys = journal.probes.map(p => {
    assert.match(p.probeId, new RegExp(`^${uuid}$`));
    assert.ok(p.mode === 'hold' || (modes.has(p.mode) && p.mode !== 'cancel' && p.mode !== 'deadline'));
    return 'c02_images_sse_probe:' + p.probeId;
  });
  assert.equal(new Set(keys).size, keys.length);
  return { sql: `SELECT key,value,description FROM system_config WHERE description=?${keys.length ? ` OR key IN (${keys.map(() => '?').join(',')})` : ''} ORDER BY key`,
    params: ['c02-sse:' + journal.runId, ...keys] };
}

export function terminalSseProbeCleanup(journal, rows) {
  validateJournal(journal); probeSelection(journal);
  assert.ok(Array.isArray(rows) && rows.length <= journal.probes.length);
  const seen = new Set(), statements = [];
  for (const row of rows) {
    const p = journal.probes.find(p => row.key === 'c02_images_sse_probe:' + p.probeId);
    assert.ok(p && !seen.has(row.key)); seen.add(row.key);
    assert.equal(row.description, 'c02-sse:' + journal.runId);
    assert.equal(typeof row.value, 'string'); assert.ok(Buffer.byteLength(row.value) <= 4096);
    const value = JSON.parse(row.value);
    assert.equal(value.runId, journal.runId); assert.equal(value.probeId, p.probeId); assert.equal(value.mode, p.mode);
    assert.ok(['armed', 'terminal'].includes(value.phase), 'Do not erase a nonterminal probe');
    const where = 'key=? AND value=? AND description=?', params = [row.key, row.value, row.description];
    statements.push(guard(`EXISTS(SELECT 1 FROM system_config WHERE ${where})`, params));
    statements.push({ sql: `DELETE FROM system_config WHERE ${where}`, params });
  }
  return statements;
}

export class SseCleanupPendingError extends Error {
  constructor(resumeAtMs) { super('Staging execution may still be active; identities must stay closed'); this.resumeAtMs = resumeAtMs; }
}

export function sseCleanupNotBefore(journal) {
  validateJournal(journal);
  let deadline = 0;
  for (const r of journal.requests) {
    assert.equal(new Date(r.startedAt).toISOString(), r.startedAt);
    // Conservatively cover the fixed 315 s provider cap and post-disconnect persistence.
    deadline = Math.max(deadline, Date.parse(r.startedAt) + 350000);
    if (r.headersAt !== undefined) {
      assert.equal(new Date(r.headersAt).toISOString(), r.headersAt);
      deadline = Math.max(deadline, Date.parse(r.headersAt) + 350000);
    }
    if (r.finishedAt !== undefined) {
      assert.equal(new Date(r.finishedAt).toISOString(), r.finishedAt);
      deadline = Math.max(deadline, Date.parse(r.finishedAt) + 30000);
    }
  }
  return deadline;
}

/** batch(statements) must be atomic and bound to the verified staging D1, with no automatic retries.
 * Includes the fixture's existing cleanup only after terminal observations have been durably saved.
 * Every operation is resumable, including SQL commit followed by a lost acknowledgement.
 */
export async function cleanupSseStagingData({ api, batch, journal, nowMs, persist }) {
  validateJournal(journal, { requests: false }); assert.equal(typeof persist, 'function');
  assert.ok(Number.isFinite(nowMs));
  const ingress = await api(subdomain); assert.equal(ingress.enabled, false); assert.equal(ingress.previews_enabled, false);
  const app = await api(appPath); checkApp(app, journal.tokenId);
  assert.equal(app.policies[0].decision, 'deny'); assert.notEqual(app.service_auth_401_redirect, true);
  const db = await api(`/d1/database/${SSE_STAGING_SCOPE.database}`);
  assert.equal(db.uuid, SSE_STAGING_SCOPE.database); assert.equal(db.name, 'cinatoken-staging');
  const fixture = await imageSseFixture(journal.runId, journal.keyHash, journal.expiresAt);
  await batch([fixture.revoke]);
  const quiescentAfterMs = sseCleanupNotBefore(journal);
  if (nowMs < quiescentAfterMs) throw new SseCleanupPendingError(quiescentAfterMs);
  const user = fixture.ids.user, key = fixture.ids.key;
  const select = { sql: 'SELECT * FROM user_budget_reservations WHERE user_id=? OR api_key_id=? ORDER BY request_id', params: [user, key] };
  const selectProbes = probeSelection(journal);
  const observation = await batch([select, selectProbes]); assert.equal(observation.length, 2);
  const rows = observation[0];
  const deletes = terminalSseReservationCleanup(journal, rows);
  const probeDeletes = terminalSseProbeCleanup(journal, observation[1]);
  await persist({ step: 'terminal-reservations-observed', rows, probes: observation[1] });
  if (deletes.length) await batch(deletes);
  // Guard the destructive fixture batch as well: a new/late reservation must retain the owner records.
  const guards = [
    guard('NOT EXISTS(SELECT 1 FROM user_budget_reservations WHERE user_id=? OR api_key_id=?)', [user, key]),
    guard('NOT EXISTS(SELECT 1 FROM users WHERE id=? AND budget_reserved_micros<>0)', [user]),
    ...['request_dispatch_intents', 'request_usage_settlements', 'request_usage_recovery_jobs'].map(table =>
      guard(`NOT EXISTS(SELECT 1 FROM ${table} WHERE user_id=? OR api_key_id=?)`, [user, key])),
    guard('NOT EXISTS(SELECT 1 FROM users WHERE id=? AND metadata IS NOT ?)', [user, JSON.stringify({staging_fixture:journal.runId,purpose:'private-synthetic-images'})]),
    guard('NOT EXISTS(SELECT 1 FROM api_keys WHERE id=? AND (user_id IS NOT ? OR workspace_id IS NOT ? OR key_hash IS NOT ?))', [key,user,fixture.ids.workspace,journal.keyHash]),
  ];
  await batch([...guards, ...probeDeletes, ...fixture.cleanup]);
  const remaining = await batch([select,
    { sql: 'SELECT id FROM users WHERE id=?', params: [user] },
    { sql: 'SELECT id FROM api_keys WHERE id=?', params: [key] },
    selectProbes,
    ...[['workspaces',[fixture.ids.workspace]],['models',fixture.ids.models],['providers',fixture.ids.providers],['model_routes',fixture.ids.routes],['model_endpoints',fixture.ids.endpoints]].map(([table,ids]) =>
      ({sql:`SELECT id FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`,params:ids})),
  ]);
  assert.equal(remaining.length, 9); assert.ok(remaining.every(rows => rows.length === 0));
  await persist({ step: 'fixture-data-cleanup-complete' });
  return { removedReservations: rows.length, fixtureRemoved: true };
}

/** Shared entry point for the next versioned operator; never accepts saved SQL or a production target.
 * Caller retains deployment/schema/baseline verification and the cumulative cost journal.
 */
export async function reconcileSseStagingRun(options) {
  const access = await closeSseStagingAccess(options);
  const data = await cleanupSseStagingData(options);
  return { access, data };
}
