import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {withSseIngressConfirmation} from './staging-sse-ingress-confirmation.mjs';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';
import {SSE_STAGING_SCOPE as gateway} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as controller, closeSseRecoveryAccess} from './staging-sse-recovery-access-v2.mjs';
const scopes = [controller, gateway];
const path = s => `/workers/scripts/${s.worker}/subdomain`;
const off = {enabled: false, previews_enabled: false}, on = {enabled: true, previews_enabled: true};
function fakeClock() {
  let ns = 0n, wall = '2026-09-08T00:00:00.000Z';
  const clock = createSseOperatorClock({readNs: () => ns, wallNow: () => wall, sleep: async ms => { ns += BigInt(ms) * 1000000n; }});
  return {clock, advance(ms) { ns += BigInt(ms) * 1000000n; }, wall(v) { wall = v; }};
}
function setup(reads = [on, off], {uncertain = false} = {}) {
  const f = fakeClock(), calls = [], events = [];
  const api = withSseIngressConfirmation({clock: f.clock, persist: async e => events.push(structuredClone(e)), api: async (p, method = 'GET', body, options) => {
    calls.push({p, method, body});
    if (method === 'POST') { if (uncertain) throw Error('PRIVATE_ERROR'); return {...on}; }
    assert.ok(options?.signal || reads.length === 0);
    const value = reads.length ? reads.shift() : off; if (value instanceof Error) throw value; return structuredClone(value);
  }});
  return {...f, api, calls, events};
}
for (const uncertain of [false, true]) test('one POST, stale GET then closed, with uncertain ACK=' + uncertain, async () => {
  const f = setup([on, off], {uncertain}); await f.api(path(gateway), 'POST', off);
  assert.deepEqual(await f.api(path(gateway)), off); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.deepEqual(f.events.filter(e => e.finished && e.step === 'ingress-confirmation-read').map(e => e.result), ['NOT_CLOSED', 'CLOSED']);
  assert.equal(f.events.find(e => e.step === 'ingress-close-write' && e.finished).result, uncertain ? 'ACK_UNCERTAIN' : 'ACK');
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_ERROR/);
  await assert.rejects(f.api(path(gateway), 'POST', off), /Never replay/);
});
test('exhausted confirmation stays failed and never repeats a write', async () => {
  const f = setup([on, on, on]); await f.api(path(gateway), 'POST', off);
  await assert.rejects(f.api(path(gateway)), /unconfirmed/); await assert.rejects(f.api(path(gateway)), /exhausted/);
  assert.equal(f.calls.length, 4); assert.equal(f.events.filter(e => e.result === 'NOT_CLOSED').length, 3);
});
test('read failure remains in journal before successful read', async () => {
  const f = setup([Error('PRIVATE_ERROR'), off]); await f.api(path(gateway), 'POST', off); assert.deepEqual(await f.api(path(gateway)), off);
  assert.ok(f.events.some(e => e.result === 'READ_FAILED')); assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_ERROR/);
});
for (const invalid of [{enabled: false}, {enabled: 'false', previews_enabled: false}, null]) test('malformed state is never closed: ' + JSON.stringify(invalid), async () => {
  const f = setup([invalid, invalid, invalid]); await f.api(path(gateway), 'POST', off); await assert.rejects(f.api(path(gateway)));
});
test('wall clock rollback does not extend the confirmation deadline', async () => {
  const f = setup([on, off]); await f.api(path(gateway), 'POST', off); f.wall('2025-01-01T00:00:00.000Z'); f.advance(15001);
  await assert.rejects(f.api(path(gateway)), /expired/); assert.equal(f.calls.length, 1);
});
test('write-ahead journal failure prevents external write', async () => {
  let calls = 0;
  const api = withSseIngressConfirmation({clock: fakeClock().clock, api: async () => { calls++; }, persist: async () => { throw Error('disk'); }});
  await assert.rejects(api(path(gateway), 'POST', off)); assert.equal(calls, 0);
  await assert.rejects(api(path(gateway), 'POST', off), /Never replay/);
});
test('a slow read journal cannot start a request beyond its window', async () => {
  const f = fakeClock(); let calls = 0;
  const api = withSseIngressConfirmation({clock: f.clock, api: async () => { calls++; return off; }, persist: async e => { if (e.step === 'ingress-confirmation-read') f.advance(16000); }});
  await api(path(gateway), 'POST', off); await assert.rejects(api(path(gateway)), /expired/); assert.equal(calls, 1);
});
test('already confirmed state does not replace a fresh final GET', async () => {
  const f = setup([off]); await f.api(path(gateway), 'POST', off); await f.api(path(gateway)); await f.api(path(gateway)); assert.equal(f.calls.length, 3);
});
test('does not intercept other paths or enable fixed ingress', async () => {
  let calls = 0; const api = withSseIngressConfirmation({clock: fakeClock().clock, persist: async () => {}, api: async () => { calls++; return 'unchanged'; }});
  assert.equal(await api('/read-only'), 'unchanged'); await assert.rejects(api(path(gateway), 'POST', on)); assert.equal(calls, 1);
});
test('concurrent GET cannot overtake a close write journal', async () => {
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const api = withSseIngressConfirmation({clock: fakeClock().clock, persist: async e => { if (e.result === 'PENDING') await pending; }, api: async () => { calls++; return off; }});
  const writing = api(path(gateway), 'POST', off);
  await assert.rejects(api(path(gateway)), /pending/); assert.equal(calls, 0);
  release(); await writing; assert.deepEqual(await api(path(gateway)), off); assert.equal(calls, 2);
});
test('concurrent confirmations cannot expand the three-read budget', async () => {
  let release, reads = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const api = withSseIngressConfirmation({clock: fakeClock().clock, persist: async () => {}, api: async (_, method) => { if (method === 'POST') return off; reads++; return pending; }});
  await api(path(gateway), 'POST', off); const first = api(path(gateway));
  await assert.rejects(api(path(gateway)), /active/); release(off);
  assert.deepEqual(await first, off); assert.equal(reads, 1);
});
test('non-cooperative transport has a per-read timeout and only three attempts', {timeout: 18000}, async () => {
  const signals = [], events = []; let writes = 0;
  const api = withSseIngressConfirmation({clock: createSseOperatorClock(), persist: async e => events.push(e), api: async (_, method, __, options) => {
    if (method === 'POST') { writes++; return off; } signals.push(options.signal); return new Promise(() => {});
  }});
  await api(path(gateway), 'POST', off); await assert.rejects(api(path(gateway)), /unconfirmed|expired/);
  assert.equal(writes, 1); assert.equal(signals.length, 3); assert.ok(signals.every(s => s.aborted));
  assert.equal(events.filter(e => e.result === 'TIMEOUT').length, 3);
});

test('real dual closer tolerates one stale read per ingress and preserves token ordering', async () => {
  const f = fakeClock(), tokenId = randomUUID(), tokenName = 'cinatoken-sse-v208-' + randomUUID();
  const journal = {runId: 'c02-success-' + randomUUID(), tokenId, tokenName};
  const apps = scopes.map(s => ({id: s.app, type: 'self_hosted', domain: s.domain, aud: s.audience, destinations: [{type: 'public', uri: s.domain}], service_auth_401_redirect: true,
    policies: [{id: s.policy, name: s === controller ? 'CinaToken recovery staging closed' : 'CinaToken staging closed', precedence: 1, decision: 'non_identity', include: [{service_token: {token_id: tokenId}}], exclude: [], require: []}]}));
  let tokens = [{id: tokenId, name: tokenName, enabled: true}];
  const ingress = scopes.map(() => ({...on})), stale = [0, 0], calls = [], events = [];
  const api = withSseIngressConfirmation({clock: f.clock, persist: async e => events.push(e), api: async (p, method = 'GET', body) => {
    calls.push({p, method});
    for (let i = 0; i < scopes.length; i++) {
      const s = scopes[i];
      if (p === path(s)) { if (method === 'POST') { ingress[i] = {...off}; stale[i] = 1; return off; } return stale[i]-- > 0 ? {...on} : {...ingress[i]}; }
      if (p === '/access/apps/' + s.app) { if (method === 'PUT') apps[i] = structuredClone(body); return structuredClone(apps[i]); }
      if (p === `/access/apps/${s.app}/policies/${s.policy}`) { assert.ok(ingress.every(v => !v.enabled)); apps[i].policies = [{id: s.policy, ...structuredClone(body)}]; return {}; }
    }
    if (p === '/access/service_tokens') return structuredClone(tokens);
    assert.equal(p, '/access/service_tokens/' + tokenId);
    assert.ok(ingress.every(v => !v.enabled));
    if (method === 'DELETE') { assert.ok(apps.every(a => a.policies[0].decision === 'deny')); tokens = []; }
    else { assert.equal(method, 'PUT'); tokens[0].enabled = false; }
    return {};
  }});
  const result = await closeSseRecoveryAccess({api, journal, persist: async e => events.push(e)});
  assert.equal(result.sharedTokenAbsent, true); assert.equal(tokens.length, 0);
  assert.equal(calls.filter(c => c.method === 'POST').length, 2); assert.equal(events.filter(e => e.result === 'NOT_CLOSED').length, 2);
  assert.ok(apps.every(a => a.policies[0].decision === 'deny' && !a.service_auth_401_redirect));
});
