import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFinancialEngine } from '../../test-support/postgres-financial-engine.mjs';
import { createDispatchIntentRepositoryPostgres, PostgresDispatchClaimUncertainError } from './dispatch-intent-postgres.ts';

const g = 'cinatoken_gateway', table = `${g}.request_dispatch_intents`;
const proposal = readFileSync(new URL('../../../migrations-proposals/postgres/request-dispatch-intents.sql', import.meta.url), 'utf8');
const source = readFileSync(new URL('./dispatch-intent-postgres.ts', import.meta.url), 'utf8');
const ref = () => ({ requestId: 'pg-' + randomUUID(), attemptIndex: 1, userId: 'user', apiKeyId: 'key',
  workspaceId: 'workspace', operation: 'images.generations', contextSha256: 'a'.repeat(64) });
const parameters = id => [id.requestId, id.attemptIndex, id.userId, id.apiKeyId, id.workspaceId, id.operation, id.contextSha256];
const insert = `INSERT INTO ${table} (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
const isClaim = query => query.includes("SET state='dispatch_claimed'");

// PGlite executes real PostgreSQL SQL, but serializes transactions: concurrent Promise callers
// here do NOT constitute native multi-session, socket, Hyperdrive or Workers acceptance.
test('PostgreSQL dispatch intent local engine / fault contract', { timeout: 180_000 }, async t => {
  assert.ok(!process.env.GATEWAY_PG_FINANCIAL_BASELINE, 'Do not run this suite against a financial baseline');
  const f = await createFinancialEngine({ migrationHead: '0068_function_schema_resolution.sql' }); t.after(() => f.pg.close());
  await f.pg.transaction(tx => tx.exec(proposal));
  for (const schema of ['public', 'pg_temp']) await f.pg.exec(`CREATE ${schema === 'pg_temp' ? 'TEMP' : ''} TABLE ${schema === 'pg_temp' ? 'request_dispatch_intents' : schema + '.request_dispatch_intents'} (LIKE ${table} INCLUDING ALL)`);
  const repo = createDispatchIntentRepositoryPostgres(f.client);
  const deadline = async (delta = 60_000) => Number((await f.pg.query(`SELECT (floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + $1)::text AS n`, [delta])).rows[0].n);
  const count = async () => Number((await f.pg.query(`SELECT count(*)::text AS n FROM ${table}`)).rows[0].n);
  const reset = async (searchPath = 'public, pg_temp, pg_catalog') => {
    await f.reset(searchPath);
    await f.pg.exec(`TRUNCATE public.request_dispatch_intents, pg_temp.request_dispatch_intents`);
  };
  const wrapper = (hooks = {}) => createDispatchIntentRepositoryPostgres({ ...f.client, raw: {
    async unsafe(query, params) {
      await hooks.beforeQuery?.(query, params);
      const rows = await f.client.raw.unsafe(query, params);
      await hooks.afterQuery?.(query, params, rows);
      return rows;
    },
    async begin(run) {
      await hooks.beforeBegin?.();
      const result = await f.client.raw.begin(async tx => {
        const value = await run({ async unsafe(query, params) {
          await hooks.beforeTxQuery?.(query, params);
          const rows = await tx.unsafe(query, params);
          await hooks.afterTxQuery?.(query, params, rows, tx);
          return rows;
        } });
        await hooks.beforeCommit?.(value);
        return value;
      });
      await hooks.afterCommit?.(result);
      return result;
    },
  } });

  async function check(name, fn) { await t.test(name, async () => { await reset(); await fn(); }); }
  await check('proposal expands all 68 migrations without changing their automatic set or money tables', async () => {
    assert.equal(f.migrations.length, 68);
    assert.ok(!f.migrations.some(x => /dispatch.intents/.test(x)));
    assert.doesNotMatch(source, /fetch\(|setTimeout|criticalWrites|markDispatched/);
    const columns = (await f.pg.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='request_dispatch_intents'`, [g])).rows;
    assert.equal(columns.length, 14);
    assert.ok(columns.every(row => !/secret|token|balance|cost|payload|body/.test(row.column_name)));
    const fn = (await f.pg.query(`SELECT p.prosecdef, p.proconfig, p.proacl::text FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='guard_request_dispatch_intent'`, [g])).rows[0];
    assert.equal(fn.prosecdef, false); assert.deepEqual(fn.proconfig, ['search_path=pg_catalog, pg_temp']);
    assert.ok(!fn.proacl.includes('{=X/'));
    assert.doesNotMatch(readFileSync(new URL('../context.ts', import.meta.url), 'utf8'), /dispatch-intent-postgres/);
    assert.doesNotMatch(readFileSync(new URL('../../index.ts', import.meta.url), 'utf8'), /dispatch-intent-postgres/);
    t.diagnostic((await f.pg.query('SELECT version() AS version')).rows[0].version);
  });

  await check('exact preparation is idempotent but neither creates nor renews a sending permit', async () => {
    const id = ref(), expiry = await deadline(), first = await repo.prepare(id, expiry);
    assert.equal(first.state, 'prepared'); assert.equal(first.revision, 0);
    assert.equal(first.claimed_at_ms, null); assert.equal(first.dispatch_claim_id, null);
    assert.ok(Number.isSafeInteger(first.created_at_ms)); assert.ok(first.created_at_ms < expiry);
    assert.deepEqual(await repo.prepare(id, expiry), first); assert.equal(await count(), 1);
    await assert.rejects(repo.prepare(id, expiry + 1), /conflict/);
    assert.equal(await repo.claim(id, 0, randomUUID()), 'granted');
    assert.equal((await repo.prepare(id, expiry)).state, 'dispatch_claimed');
    assert.equal(await repo.claim(id, 1, randomUUID()), 'not_granted');
  });

  for (const [label, patch] of Object.entries({ request: { requestId: 'other' }, attempt: { attemptIndex: 2 },
    user: { userId: 'other' }, key: { apiKeyId: 'other-key' }, workspace: { workspaceId: 'other-workspace' },
    operation: { operation: 'images.edits' }, context: { contextSha256: 'b'.repeat(64) } })) {
    await check(`ST-03 mismatched ${label} cannot inspect, claim or classify the existing intent`, async () => {
      const id = ref(); await repo.prepare(id, await deadline()); const wrong = { ...id, ...patch };
      assert.equal(await repo.inspect(wrong), null);
      assert.equal(await repo.claim(wrong, 0, randomUUID()), 'not_granted');
      assert.equal(await repo.classifyOverdue(wrong, 0), false);
      assert.equal((await repo.inspect(id)).state, 'prepared');
    });
  }
  for (const patch of [{ userId: 'other' }, { workspaceId: 'other-workspace' }]) {
    await check(`independently valid FK identifiers do not prove the creation scope: ${JSON.stringify(patch)}`, async () => {
      const id = { ...ref(), ...patch }, expiry = await deadline();
      await assert.rejects(repo.prepare(id, expiry), /persistence unconfirmed/);
      await assert.rejects(f.pg.query(insert, [...parameters(id), expiry]), /scope mismatch/);
      assert.equal(await count(), 0);
    });
  }
  await check('duplicate request/attempt cannot acquire a different frozen context or deadline', async () => {
    const id = ref(), expiry = await deadline(), first = await repo.prepare(id, expiry);
    for (const patch of [{ contextSha256: 'b'.repeat(64) }, { operation: 'images.edits' }, { workspaceId: 'other-workspace' }]) {
      await assert.rejects(repo.prepare({ ...id, ...patch }, expiry), /conflict|unconfirmed/);
    }
    assert.deepEqual(await repo.inspect(id), first); assert.equal(await count(), 1);
  });
  await check('invalid identity, revision, claim, deadline and batch inputs fail before I/O', async () => {
    const bad = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: {
      unsafe() { assert.fail('Unexpected SQL'); }, begin() { assert.fail('Unexpected transaction'); },
    } });
    for (const patch of [{ requestId: 'x\n' }, { requestId: 'x'.repeat(201) }, { apiKeyId: null }, { userId: {} },
      { workspaceId: undefined }, { attemptIndex: 0 }, { attemptIndex: 33 }, { attemptIndex: 1.5 },
      { contextSha256: 'a'.repeat(64) + '\n' }, { operation: 'chat' }]) {
      await assert.rejects(bad.prepare({ ...ref(), ...patch }, 1), TypeError);
      await assert.rejects(bad.inspect({ ...ref(), ...patch }), TypeError);
      await assert.rejects(bad.claim({ ...ref(), ...patch }, 0, randomUUID()), TypeError);
    }
    for (const number of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(bad.prepare(ref(), number), TypeError);
      await assert.rejects(bad.claim(ref(), number, randomUUID()), TypeError);
      await assert.rejects(bad.classifyOverdue(ref(), number), TypeError);
    }
    for (const claim of ['bad', randomUUID() + '\n', null]) await assert.rejects(bad.claim(ref(), 0, claim), TypeError);
    await assert.rejects(bad.claim(ref(), Number.MAX_SAFE_INTEGER, randomUUID()), TypeError);
    for (const limit of [0, 51, 1.5, NaN]) await assert.rejects(bad.listOverdue('user', 'workspace', limit), TypeError);
    await assert.rejects(bad.listOverdue('user\n', 'workspace', 1), TypeError);
    for (const driver of ['d1', 'mysql', undefined]) assert.throws(() => createDispatchIntentRepositoryPostgres({ driver }), /PostgreSQL/);
  });
  await check('ST-01 many callers, same-claim retry and new repository yield exactly one explicit grant', async () => {
    const id = ref(); await repo.prepare(id, await deadline()); const claim = randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, () => repo.claim(id, 0, claim)));
    assert.equal(results.filter(x => x === 'granted').length, 1);
    assert.equal(results.filter(x => x === 'not_granted').length, 11);
    assert.equal(await repo.claim(id, 1, claim), 'not_granted');
    assert.equal(await createDispatchIntentRepositoryPostgres(f.client).claim(id, 1, randomUUID()), 'not_granted');
    assert.equal((await repo.inspect(id)).revision, 1);
  });
  await check('claim ID collision rolls back the second intent and never reuses a grant', async () => {
    const a = ref(), b = ref(), claim = randomUUID(); await repo.prepare(a, await deadline()); await repo.prepare(b, await deadline());
    assert.equal(await repo.claim(a, 0, claim), 'granted');
    await assert.rejects(repo.claim(b, 0, claim), PostgresDispatchClaimUncertainError);
    assert.equal((await repo.inspect(b)).state, 'prepared');
    assert.equal((await repo.inspect(a)).dispatch_claim_id, claim);
    assert.equal(f.transactions.at(-1).state, 'rolled_back');
  });
  await check('ST-02 preparation ACK loss can reconcile exact creation without granting', async () => {
    const id = ref(), expiry = await deadline(); let writes = 0;
    const fault = wrapper({ afterQuery(query) { if (query.startsWith('INSERT')) { writes++; throw new Error('ACK lost'); } } });
    assert.equal((await fault.prepare(id, expiry)).state, 'prepared'); assert.equal(writes, 1); assert.equal(await count(), 1);
  });
  await check('prepare write plus readback failure is unconfirmed and does not resubmit', async () => {
    const id = ref(); let writes = 0;
    const fault = wrapper({ beforeQuery(query) { if (query.startsWith('SELECT')) throw new Error('read unavailable'); },
      afterQuery(query) { if (query.startsWith('INSERT')) { writes++; throw new Error('ACK lost'); } } });
    await assert.rejects(fault.prepare(id, await deadline()), /read unavailable/);
    assert.equal(writes, 1); assert.equal((await repo.inspect(id)).state, 'prepared');
  });
  await check('identity scalars are owned across awaits and acknowledgement reconciliation', async () => {
    const id = ref(), original = { ...id }, expiry = await deadline();
    const fault = wrapper({ afterQuery(query) { if (query.startsWith('INSERT')) { id.contextSha256 = 'b'.repeat(64); throw new Error('ACK lost'); } } });
    assert.equal((await fault.prepare(id, expiry)).context_sha256, original.contextSha256);
    const claim = wrapper({ beforeBegin() { original.userId = 'other'; } });
    const frozen = { ...original };
    assert.equal(await claim.claim(original, 0, randomUUID()), 'granted');
    assert.equal((await repo.inspect(frozen)).state, 'dispatch_claimed');
  });
  for (const phase of ['beforeBegin', 'beforeCommit', 'afterCommit']) {
    await check(`ST-02 ${phase} failure confers no grant, performs no readback and has no retry`, async () => {
      const id = ref(), claim = randomUUID(); await repo.prepare(id, await deadline());
      let begins = 0, reads = 0;
      const hooks = { beforeBegin() { begins++; }, beforeQuery() { reads++; } };
      const base = hooks[phase]; hooks[phase] = (...args) => { base?.(...args); throw new Error('synthetic ACK failure'); };
      await assert.rejects(wrapper(hooks).claim(id, 0, claim), PostgresDispatchClaimUncertainError);
      assert.equal(begins, 1); assert.equal(reads, 0);
      assert.equal((await repo.inspect(id)).state, phase === 'afterCommit' ? 'dispatch_claimed' : 'prepared');
      if (phase === 'afterCommit') assert.equal(await repo.claim(id, 1, claim), 'not_granted');
    });
  }
  await check('no grant is delivered while COMMIT acknowledgement remains pending', async () => {
    const id = ref(); await repo.prepare(id, await deadline());
    let release, reached, settled = false;
    const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { reached = resolve; });
    const pending = wrapper({ async afterCommit() { reached(); await gate; } }).claim(id, 0, randomUUID()).then(x => { settled = true; return x; });
    await entered;
    try { assert.equal(settled, false); assert.equal((await repo.inspect(id)).state, 'dispatch_claimed'); }
    finally { release(); }
    assert.equal(await pending, 'granted');
  });
  await check('ST-03 stale revision and early expiry classification do not mutate', async () => {
    const id = ref(), before = await repo.prepare(id, await deadline());
    assert.equal(await repo.claim(id, 1, randomUUID()), 'not_granted');
    assert.equal(await repo.classifyOverdue(id, 0), false); assert.deepEqual(await repo.inspect(id), before);
    assert.deepEqual(await repo.listOverdue('user', 'workspace', 50), []);
  });
  await check('time is freshly checked after the lock step, not at transaction start', async () => {
    const id = ref(), expiry = await deadline(1_000); await repo.prepare(id, expiry);
    // Synthetic delay after the real row-lock SELECT, in the same transaction. NOT a second connection lock wait.
    const delayed = wrapper({ async afterTxQuery(query, params, rows, tx) {
      if (query.includes('FOR UPDATE')) await tx.unsafe('SELECT pg_sleep(1.1)');
    } });
    assert.equal(await delayed.claim(id, 0, randomUUID()), 'not_granted');
    assert.equal((await repo.inspect(id)).state, 'prepared');
    assert.equal(await repo.classifyOverdue(id, 0), true);
    assert.equal((await repo.inspect(id)).state, 'expired_before_dispatch');
  });
  await check('negative control: transaction-start clock incorrectly grants after an in-transaction delay', async () => {
    const definition = (await f.pg.query(`SELECT pg_get_functiondef('cinatoken_gateway.guard_request_dispatch_intent()'::regprocedure) AS sql`)).rows[0].sql;
    assert.match(definition, /clock_timestamp\(\)/);
    // Mutate ONLY this ephemeral database function, never the source/proposal. Restore in finally.
    await f.pg.exec(definition.replaceAll('clock_timestamp()', 'transaction_timestamp()'));
    try {
      const id = ref(), expiry = await deadline(1_000); await repo.prepare(id, expiry);
      const broken = wrapper({ async afterTxQuery(query, params, rows, tx) {
        if (query.includes('FOR UPDATE')) await tx.unsafe('SELECT pg_sleep(1.1)');
      } });
      assert.equal(await broken.claim(id, 0, randomUUID()), 'granted', 'The negative control must expose an erroneous expired grant');
      assert.ok(await deadline(0) >= expiry);
    } finally { await f.pg.exec(definition); }
  });
  await check('overdue classification is scoped, bounded, deterministic, terminal and non-financial', async () => {
    const financial = await f.snapshot(g), expiry = await deadline(350), ids = [ref(), ref(), ref()];
    for (const id of ids) await repo.prepare(id, expiry);
    const claim = randomUUID(); assert.equal(await repo.claim(ids[1], 0, claim), 'granted');
    await f.pg.query('SELECT pg_sleep(0.4)');
    const rows = await repo.listOverdue('user', 'workspace', 2);
    assert.deepEqual(rows.map(x => x.request_id), ids.map(x => x.requestId).sort().slice(0, 2));
    assert.deepEqual(await repo.listOverdue('other', 'other-workspace', 50), []);
    assert.equal(await repo.classifyOverdue(ids[0], 0), true);
    assert.equal(await repo.classifyOverdue(ids[1], 0), false);
    assert.equal(await repo.classifyOverdue(ids[1], 1), true);
    assert.equal((await repo.inspect(ids[0])).state, 'expired_before_dispatch');
    const unknown = await repo.inspect(ids[1]); assert.equal(unknown.state, 'outcome_unknown'); assert.equal(unknown.dispatch_claim_id, claim);
    assert.equal(unknown.revision, 2); assert.ok(unknown.updated_at_ms >= expiry);
    assert.equal(await repo.classifyOverdue(ids[1], 2), false);
    assert.equal(await repo.claim(ids[1], 2, claim), 'not_granted');
    assert.equal((await repo.listOverdue('user', 'workspace', 50)).length, 1);
    assert.deepEqual(await f.snapshot(g), financial);
  });
  await check('classification ACK loss persists only terminal metadata, with no replay or money change', async () => {
    const id = ref(); await repo.prepare(id, await deadline(100)); const before = await f.snapshot(g);
    await f.pg.query('SELECT pg_sleep(0.15)');
    await assert.rejects(wrapper({ afterCommit() { throw new Error('classify ACK lost'); } }).classifyOverdue(id, 0), /ACK lost/);
    assert.equal((await repo.inspect(id)).state, 'expired_before_dispatch');
    assert.equal(await repo.classifyOverdue(id, 0), false); assert.deepEqual(await f.snapshot(g), before);
  });
  for (const assignment of ["request_id='new'", 'attempt_index=2', "user_id='other'", "api_key_id='other-key'",
    "workspace_id='other-workspace'", "operation='images.edits'", "context_sha256=repeat('b',64)",
    'expires_at_ms=expires_at_ms+1', 'created_at_ms=created_at_ms+1', 'updated_at_ms=updated_at_ms+1',
    'claimed_at_ms=created_at_ms', 'revision=revision+2', "state='outcome_unknown'"]) {
    await check(`database rejects direct invalid transition: ${assignment}`, async () => {
      const id = ref(), before = await repo.prepare(id, await deadline());
      const set = assignment.startsWith('revision=') ? assignment : `revision=revision+1, ${assignment}`;
      await assert.rejects(f.pg.query(`UPDATE ${table} SET ${set} WHERE request_id=$1`, [id.requestId]));
      assert.deepEqual(await repo.inspect(id), before);
    });
  }
  await check('a claimed intent cannot reopen or exchange its claim identity', async () => {
    const id = ref(); await repo.prepare(id, await deadline()); await repo.claim(id, 0, randomUUID());
    const before = await repo.inspect(id);
    for (const change of ["state='prepared',dispatch_claim_id=NULL,claimed_at_ms=NULL", "state='outcome_unknown',dispatch_claim_id='00000000-0000-0000-0000-000000000001'"]) {
      await assert.rejects(f.pg.query(`UPDATE ${table} SET revision=revision+1, ${change} WHERE request_id=$1`, [id.requestId]));
    }
    assert.deepEqual(await repo.inspect(id), before);
  });
  await check('database rejects forged initial claim, timestamps, invalid hash and invalid attempt', async () => {
    for (const [column, value] of [['state', "'dispatch_claimed'"], ['revision', '1'], ['created_at_ms', '1'], ['updated_at_ms', '1']]) {
      const id = ref(); await assert.rejects(f.pg.query(insert.replace('expires_at_ms)', `expires_at_ms,${column})`).replace('$8)', `$8,${value})`), [...parameters(id), await deadline()]));
    }
    for (const edit of [{ contextSha256: 'z'.repeat(64) }, { attemptIndex: 33 }, { requestId: 'a\n' }]) {
      await assert.rejects(f.pg.query(insert, [...parameters({ ...ref(), ...edit }), await deadline()]));
    }
    await assert.rejects(repo.prepare(ref(), 0), /persistence unconfirmed/); assert.equal(await count(), 0);
  });
  await check('integer decoding rejects noncanonical or unsafe persisted values instead of rounding', async () => {
    const id = ref(); await repo.prepare(id, await deadline());
    for (const wire of ['9007199254740992', '01', '1.0', '1\n', 1, null]) {
      await assert.rejects(wrapper({ afterQuery(query, params, rows) { if (query.startsWith('SELECT')) rows[0].revision = wire; } }).inspect(id));
    }
    assert.equal((await repo.inspect(id)).revision, 0);
  });
  for (const searchPath of ['public, pg_temp, pg_catalog', 'pg_temp, public, pg_catalog', 'pg_catalog, cinatoken_gateway, pg_temp']) {
    await check(`shadow relations do not redirect SQL: ${searchPath}`, async () => {
      await reset(searchPath); const before = { actual: await f.snapshot(g), public: await f.snapshot('public'), temp: await f.snapshot('pg_temp') };
      const id = ref(); await repo.prepare(id, await deadline()); assert.equal(await repo.claim(id, 0, randomUUID()), 'granted');
      assert.equal(await repo.classifyOverdue(id, 1), false);
      assert.deepEqual(await f.snapshot(g), before.actual); assert.deepEqual(await f.snapshot('public'), before.public); assert.deepEqual(await f.snapshot('pg_temp'), before.temp);
      for (const schema of ['public', 'pg_temp']) assert.equal((await f.pg.query(`SELECT count(*)::int AS n FROM ${schema}.request_dispatch_intents`)).rows[0].n, 0);
    });
  }
  await check('recovery scan has a scope/deadline partial index and index-compatible ordered plan', async () => {
    const indexes = (await f.pg.query(`SELECT indexdef FROM pg_catalog.pg_indexes WHERE schemaname=$1 AND tablename='request_dispatch_intents'`, [g])).rows;
    const index = indexes.find(x => x.indexdef.includes('request_dispatch_intents_recovery')).indexdef;
    assert.match(index, /user_id, workspace_id, expires_at_ms, request_id, attempt_index/); assert.match(index, /WHERE/);
    await f.pg.transaction(async tx => {
      await tx.exec('SET LOCAL enable_seqscan=off');
      const plan = (await tx.query(`EXPLAIN SELECT request_id FROM ${table} WHERE user_id='user' AND workspace_id='workspace'
        AND state IN ('prepared','dispatch_claimed') AND expires_at_ms <= (SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
        ORDER BY expires_at_ms, request_id, attempt_index LIMIT 50`)).rows.map(x => x['QUERY PLAN']).join('\n');
      assert.match(plan, /request_dispatch_intents_recovery/); assert.doesNotMatch(plan, /Sort/);
    });
  });
});

test('ST-02 fresh process reads a persisted committed claim but cannot reacquire sending rights', { timeout: 90_000 }, () => {
  const parent = realpathSync(tmpdir()), owned = mkdtempSync(join(parent, 'cinatoken-pg-dispatch-'));
  const child = fileURLToPath(new URL('../../test-support/postgres-dispatch-intent-child.mjs', import.meta.url));
  try {
    for (const mode of ['write', 'read']) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', child, join(owned, 'db'), mode], {
        encoding: 'utf8', timeout: 40_000, env: { ...process.env, GATEWAY_PG_FINANCIAL_BASELINE: '' },
      });
      assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).mode, mode);
    }
  } finally {
    // Only the exact mkdtemp-owned fixture is recursively removed, after absolute containment checks.
    const target = realpathSync(owned);
    assert.equal(dirname(target), parent); assert.equal(resolve(target), resolve(owned));
    assert.ok(basename(target).startsWith('cinatoken-pg-dispatch-'));
    rmSync(target, { recursive: true });
  }
});
