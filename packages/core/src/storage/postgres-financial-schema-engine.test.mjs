import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFinancialEngine, implementation, intent, reserveParams, chargeParams,
  gateway as g, now, expires, later, functionCatalogSql,
} from '../test-support/postgres-financial-engine.mjs';

// Opt-in, entirely in-memory. This tests real SQL and PL/pgSQL, not Postgres.js
// transport, concurrent connections, Hyperdrive, Workers or production roles.
test('financial SQL and functions are independent of caller search_path', async t => {
  const f = await createFinancialEngine();
  t.after(() => f.pg.close());
  const { createPostgresGuardrailBudgetsRepository } = await implementation('db/postgres/guardrail-budgets.impl.ts');
  const { insertRequestUsageAndChargeTxPg: charge } = await implementation('db/postgres/critical-writes.impl.ts');
  const workspace = await implementation('storage/workspace-budgets.ts');
  const guards = createPostgresGuardrailBudgetsRepository(f.client);
  const rows = async (sql, params = []) => (await f.pg.query(sql, params)).rows;
  const scalar = async sql => Number(Object.values((await rows(sql))[0])[0]);
  const windows = () => rows(`SELECT scope_type, unreserved_micros::int, settled_micros::int, reserved_micros::int FROM ${g}.guardrail_budget_windows ORDER BY scope_type`);
  const assertReserved = async (scopes = ['user'], id = 'request', extra = {}) => {
    assert.equal((await guards.reserveMany({ ...reserveParams(scopes, id), ...extra })).status, 'reserved');
  };
  const ordinary = async () => {
    // Seed a previously admitted ordinary reservation; the v250 suite exercises
    // its admission method. Here the transaction under test owns settlement.
    await f.pg.query(`INSERT INTO ${g}.user_budget_reservations
      (request_id,user_id,api_key_id,budget_epoch,limit_micros,reserved_micros,state,expires_at,created_at,updated_at)
      VALUES ('request','user','key',0,10000000,100000,'dispatched',$1,$2,$2)`, [expires, now]);
    await f.pg.exec(`UPDATE ${g}.users SET budget_reserved_micros=100000 WHERE id='user'`);
  };
  const settledCharge = (mode = 'actual') => ({ ...chargeParams(),
    userBudgetSettlement: { requestId: 'request', mode, reason: 'engine_test' },
    guardrailBudgetSettlement: { requestId: 'request', mode, reason: 'engine_test' } });
  const account = { accountType: 'personal', personalOwnerUserId: 'user', organizationId: null };
  const withdraw = (id, amount) => f.pg.query(`INSERT INTO ${g}.withdrawals
    (id,user_id,amount,net_amount,amount_micros,net_amount_micros,wallet_address,status)
    VALUES ($1,'user',$2,$2,$3,$3,'synthetic-wallet','requested')`, [id,amount,amount*1000000]);

  await t.test('migration changes only function search_path, retaining owner/body/ACL/security mode', async () => {
    const baselineNames = new Set(f.functionsBefore.map(row => row.proname));
    const after = (await rows(functionCatalogSql)).filter(row => baselineNames.has(row.proname));
    assert.equal(after.length, 10);
    const withoutConfig = list => list.map(({ proconfig, ...rest }) => rest);
    assert.deepEqual(withoutConfig(after), withoutConfig(f.functionsBefore));
    for (const entry of after) assert.deepEqual(entry.proconfig, ['search_path=pg_catalog, cinatoken_gateway, pg_temp'], entry.proname);
    const retention = after.find(row => row.proname === 'delete_provider_attempt_availability_before');
    assert.equal(retention.prosecdef, true);
    assert.ok(retention.proacl && !retention.proacl.some(value => value.startsWith('=')), 'PUBLIC execution stays revoked');
  });

  const cases = {
    async 'reserve three scopes, replay and payload conflict'() {
      await assertReserved(['user', 'api_key', 'workspace']);
      assert.deepEqual(await windows(), ['api_key', 'user', 'workspace'].map(scope_type => ({scope_type, unreserved_micros:0, settled_micros:0, reserved_micros:100000})));
      assert.equal((await guards.reserveMany(reserveParams(['user','api_key','workspace']))).status, 'idempotent');
      assert.equal((await guards.reserveMany({...reserveParams(['user','api_key','workspace']),reservedMicros:200000})).status, 'conflict');
      assert.equal(f.transactions.length, 1);
    },
    async 'budget rejection rolls back all created windows'() {
      const intents = [intent('workspace'), {...intent(),limitMicros:1}, intent('api_key')];
      assert.equal((await guards.reserveMany({...reserveParams(),intents})).status, 'blocked');
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.guardrail_budget_windows`), 0);
      assert.deepEqual(f.transactions, [{state:'rolled_back'}]);
    },
    async 'seed existing usage from gateway logs'() {
      await charge(f.client, chargeParams('prior', 0.2));
      await assertReserved(['user','workspace']);
      assert.deepEqual((await windows()).map(row=>row.unreserved_micros), [200000,200000]);
    },
    async 'key validation uses current gateway epoch'() {
      await f.pg.exec(`UPDATE ${g}.api_keys SET limit_epoch=1 WHERE id='key'`);
      assert.equal((await guards.reserveMany(reserveParams(['api_key']))).status, 'conflict');
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.guardrail_budget_windows`), 0);
    },
    async 'workspace validation rejects stale epoch'() {
      await f.pg.exec(`UPDATE ${g}.workspace_budgets SET config_epoch=1`);
      assert.equal((await guards.reserveMany(reserveParams(['workspace']))).status, 'conflict');
    },
    async 'release is idempotent and cannot release dispatched reservations'() {
      await assertReserved(['user','workspace']);
      assert.equal(await guards.releaseMany('request',now,'test'),2);
      assert.equal(await guards.releaseMany('request',now,'test'),0);
      await assertReserved(['user'],'sent');
      assert.equal(await guards.markDispatched('sent',now,expires),true);
      assert.equal(await guards.markDispatched('sent',now,expires),true);
      assert.equal(await guards.releaseMany('sent',now,'test'),0);
      assert.equal(await scalar(`SELECT sum(reserved_micros) FROM ${g}.guardrail_budget_windows`),100000);
    },
    async 'forfeit consumes reserved ceilings once'() {
      await assertReserved(['user','workspace']);
      await guards.markDispatched('request',now,expires);
      assert.equal(await guards.forfeitMany('request',later,'test'),2);
      assert.equal(await guards.forfeitMany('request',later,'test'),0);
      assert.deepEqual((await windows()).map(row=>[row.reserved_micros,row.settled_micros]),[[0,100000],[0,100000]]);
    },
    async 'expiry releases unsent and forfeits sent reservations'() {
      await assertReserved(['user'],'unsent'); await assertReserved(['workspace'],'sent');
      await guards.markDispatched('sent',now,expires);
      assert.equal(await guards.expireBefore(later,1),1);
      assert.equal(await guards.expireBefore(later),1);
      assert.equal(await guards.expireBefore(later),0);
      assert.deepEqual(await rows(`SELECT request_id,state,settled_micros::int FROM ${g}.guardrail_budget_reservations ORDER BY request_id`),
        [{request_id:'sent',state:'expired',settled_micros:100000},{request_id:'unsent',state:'released',settled_micros:0}]);
    },
    async 'dispatched route-key extension preserves prior ceiling'() {
      await assertReserved(['api_key'],'request',{settlementBasis:'gateway_key_route'});
      await guards.markDispatched('request',now,expires);
      const params = {...reserveParams(['api_key','user','workspace']),reservedMicros:200000};
      assert.equal((await guards.extendDispatched(params)).status,'reserved');
      assert.equal((await guards.extendDispatched(params)).status,'idempotent');
      assert.deepEqual((await windows()).map(row=>row.reserved_micros),[100000,200000,200000]);
    },
    async 'unreserved charge updates gateway user/key windows'() {
      await assertReserved(['user','api_key'],'seed'); await guards.releaseMany('seed',now,'test');
      await charge(f.client,chargeParams());
      assert.deepEqual((await windows()).map(row=>row.unreserved_micros),[50000,50000]);
      assert.equal(await scalar(`SELECT budget_spent FROM ${g}.users WHERE id='user'`),1.05);
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.user_audit_logs`),1);
    },
    async 'actual settlement excludes reserved request from unreserved update and deduplicates'() {
      await assertReserved(['user','api_key','workspace']); await ordinary();
      await charge(f.client,settledCharge());
      const before = await f.snapshot(g);
      await charge(f.client,settledCharge());
      assert.deepEqual(await f.snapshot(g),before);
      assert.deepEqual((await windows()).map(row=>[row.unreserved_micros,row.settled_micros,row.reserved_micros]),[[0,50000,0],[0,50000,0],[0,50000,0]]);
      assert.equal(await scalar(`SELECT budget_spent FROM ${g}.users WHERE id='user'`),1.05);
    },
    async 'ordinary settlement keeps reservation lock and append-only log read through rollback, replay and conflict'() {
      await assertReserved(['user','api_key','workspace']); await ordinary();
      const params=settledCharge(),before=await f.snapshot(g),start=f.queries.length;
      await f.pg.exec(`ALTER TABLE ${g}.guardrail_budget_windows ADD CONSTRAINT engine_reject_ordinary_settlement CHECK (settled_micros=0)`);
      try {
        await assert.rejects(charge(f.client,params),/engine_reject_ordinary_settlement|Failed query/);
        assert.deepEqual(await f.snapshot(g),before);
      } finally { await f.pg.exec(`ALTER TABLE ${g}.guardrail_budget_windows DROP CONSTRAINT engine_reject_ordinary_settlement`); }
      const statements=f.queries.slice(start).map(({query})=>query);
      const logReads=statements.filter(query=>/^select\b/i.test(query)&&query.includes('"api_key_request_logs"'));
      assert.equal(logReads.length,1);
      assert.doesNotMatch(logReads[0],/\bfor\s+update\b/i);
      assert.ok(statements.some(query=>/^select\b/i.test(query)&&query.includes('"user_budget_reservations"')&&/\bfor\s+update\b/i.test(query)));
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.api_key_request_logs`),0);
      await charge(f.client,params);
      const committed=await f.snapshot(g);
      await charge(f.client,params);
      assert.deepEqual(await f.snapshot(g),committed);
      await f.pg.exec(`UPDATE ${g}.api_key_request_logs SET charged_cost=9 WHERE id='request'`);
      const tampered=await f.snapshot(g);
      await assert.rejects(charge(f.client,params),/Conflicting replay for ordinary-user budget settlement/);
      assert.deepEqual(await f.snapshot(g),tampered);
    },
    async 'reserved settlement retains the admitted ceiling'() {
      await assertReserved(['user','api_key','workspace']); await ordinary();
      await charge(f.client,settledCharge('reserved'));
      assert.deepEqual((await windows()).map(row=>[row.unreserved_micros,row.settled_micros,row.reserved_micros]),[[0,100000,0],[0,100000,0],[0,100000,0]]);
      assert.equal(await scalar(`SELECT budget_spent FROM ${g}.users WHERE id='user'`),1.1);
    },
    async 'BYOK route-key actual settlement uses standard cost without buyer debit'() {
      await assertReserved(['api_key'],'request',{settlementBasis:'gateway_key_route'});
      const params=chargeParams('request',0);
      params.shouldChargeBudget=false;
      Object.assign(params.requestLog,{isByok:true,standardCost:0.075,requestOrigin:'https://example.invalid',dataRegion:'global',chargedCostUsd:0});
      await charge(f.client,{...params,guardrailBudgetSettlement:{requestId:'request',mode:'actual',reason:'byok'}});
      assert.deepEqual((await windows()).map(row=>[row.settled_micros,row.reserved_micros]),[[75000,0]]);
      assert.equal(await scalar(`SELECT budget_spent FROM ${g}.users WHERE id='user'`),1);
    },
    async 'late raw SQL failure rolls back log, debit, audit and stats without retry'() {
      await assertReserved(['user'],'seed'); await guards.releaseMany('seed',now,'test');
      // A real database constraint fails only at the final raw SQL update.
      await f.pg.exec(`ALTER TABLE ${g}.guardrail_budget_windows ADD CONSTRAINT engine_reject_raw_update CHECK (unreserved_micros=0)`);
      try {
        const before = await f.snapshot(g), count = f.transactions.length;
        await assert.rejects(charge(f.client,chargeParams()), /engine_reject_raw_update|Failed query/);
        assert.deepEqual(await f.snapshot(g),before);
        assert.deepEqual(f.transactions.slice(count),[{state:'rolled_back'}]);
      } finally { await f.pg.exec(`ALTER TABLE ${g}.guardrail_budget_windows DROP CONSTRAINT engine_reject_raw_update`); }
    },
    async 'missing gateway relation never falls back to same-name shadows'() {
      for (const [table, action] of [
        ['guardrail_budget_reservations',()=>guards.reserveMany(reserveParams())],
        ['workspace_budgets',()=>workspace.listWorkspaceBudgets(f.client,'workspace')],
        ['guardrail_budget_windows',()=>charge(f.client,chargeParams())],
      ]) {
        const before=await f.snapshot(g);
        await f.pg.exec(`ALTER TABLE ${g}.${table} RENAME TO engine_hidden_relation`);
        try { await assert.rejects(action(),error=>error.code==='42P01'||error.cause?.code==='42P01'); }
        finally { await f.pg.exec(`ALTER TABLE ${g}.engine_hidden_relation RENAME TO ${table}`); }
        assert.deepEqual(await f.snapshot(g),before);
      }
    },
    async 'workspace list, upsert epoch and delete use gateway tables'() {
      assert.equal((await workspace.listWorkspaceBudgets(f.client,'workspace'))[0].limit_micros,2000000);
      const params={workspaceId:'workspace',interval:'daily',limitMicros:2500000,nowIso:now};
      const updated=await workspace.upsertWorkspaceBudget(f.client,params);
      assert.equal(updated.id,'budget'); assert.equal(updated.config_epoch,1); assert.equal(updated.limit_micros,2500000);
      await workspace.upsertWorkspaceBudget(f.client,{...params,interval:'weekly',limitMicros:3000000});
      await assert.rejects(workspace.upsertWorkspaceBudget(f.client,{...params,limitMicros:4000000}),/limits must satisfy/);
      assert.equal(await workspace.deleteWorkspaceBudget(f.client,'workspace','daily'),true);
      assert.deepEqual((await workspace.listWorkspaceBudgets(f.client,'workspace')).map(row=>row.reset_interval),['weekly']);
    },
    async 'workspace usage uses logs before window and authoritative window afterward'() {
      await charge(f.client,chargeParams('prior',0.2));
      const before=(await workspace.listWorkspaceBudgetUsage(f.client,'workspace',new Date(now)))[0];
      assert.equal(before.spent_micros,200000); assert.equal(before.reserved_micros,0);
      await assertReserved(['workspace']);
      const after=(await workspace.listWorkspaceBudgetUsage(f.client,'workspace',new Date(now)))[0];
      assert.equal(after.spent_micros,200000); assert.equal(after.reserved_micros,100000); assert.equal(after.remaining_micros,1700000);
    },
    async 'workspace slug respects management account and inactive workspace'() {
      assert.equal(await workspace.resolveWorkspaceSlugForManagementAccount(f.client,' workspace ',account),'workspace');
      assert.equal(await workspace.resolveWorkspaceSlugForManagementAccount(f.client,'other',account),null);
      await f.pg.exec(`UPDATE ${g}.workspaces SET status='archived' WHERE id='workspace'`);
      assert.deepEqual(await workspace.listWorkspaceBudgets(f.client,'workspace'),[]);
      assert.equal(await workspace.upsertWorkspaceBudget(f.client,{workspaceId:'workspace',interval:'daily',limitMicros:9}),null);
      assert.equal(await workspace.deleteWorkspaceBudget(f.client,'workspace','daily'),false);
    },
    async 'request log trigger uses real key workspace, not shadow key'() {
      await charge(f.client,chargeParams());
      // The existing trigger is BEFORE INSERT, not an UPDATE immutability policy.
      // Keep schema-resolution verification separate from expanding that policy.
      await assert.rejects(f.pg.exec(`INSERT INTO ${g}.api_key_request_logs (id,user_id,api_key_id,workspace_id,upstream_protocol,status)
        VALUES ('bad-log','user','key','other-workspace','openai','success')`),/workspace/i);
      assert.equal((await rows(`SELECT workspace_id FROM ${g}.api_key_request_logs`))[0].workspace_id,'workspace');
    },
    async 'guardrail API-key assignment trigger uses real workspace'() {
      await f.pg.exec(`INSERT INTO ${g}.guardrail_assignments (id,guardrail_id,workspace_id,scope_type,scope_id) VALUES ('key-assignment','guardrail','workspace','api_key','key')`);
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.guardrail_assignments`),2);
    },
    async 'workspace order trigger rejects invalid direct SQL'() {
      await assert.rejects(f.pg.exec(`INSERT INTO ${g}.workspace_budgets (id,workspace_id,reset_interval,limit_micros) VALUES ('weekly','workspace','weekly',1000000)`),/workspace_budget_order_invalid/);
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.workspace_budgets`),1);
    },
    async 'withdrawal lock and refund update only gateway ledger'() {
      await withdraw('withdrawal',1);
      assert.equal(await scalar(`SELECT balance_micros FROM ${g}.user_earnings WHERE user_id='user'`),4000000);
      assert.equal(await scalar(`SELECT locked_amount_micros FROM ${g}.user_earnings WHERE user_id='user'`),1000000);
      await f.pg.exec(`UPDATE ${g}.withdrawals SET status='failed' WHERE id='withdrawal'`);
      assert.equal(await scalar(`SELECT balance_micros FROM ${g}.user_earnings WHERE user_id='user'`),5000000);
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.portal_ledger_entries`),2);
    },
    async 'withdrawal confirmation and insufficient funds follow gateway account'() {
      await assert.rejects(withdraw('too-much',6),/balance|funds/i);
      await withdraw('withdrawal',1);
      await f.pg.exec(`UPDATE ${g}.withdrawals SET status='confirmed' WHERE id='withdrawal'`);
      assert.equal(await scalar(`SELECT locked_amount_micros FROM ${g}.user_earnings WHERE user_id='user'`),0);
      assert.equal(await scalar(`SELECT lifetime_withdrawn_micros FROM ${g}.user_earnings WHERE user_id='user'`),1000000);
    },
    async 'shared-key credit uses gateway earnings and ledger'() {
      await charge(f.client,chargeParams());
      await f.pg.exec(`INSERT INTO ${g}.shared_keys (id,seller_user_id,channel_type,api_key,key_fingerprint)
        VALUES ('shared','user','openai','synthetic-not-a-key','synthetic-fingerprint');
        INSERT INTO ${g}.shared_key_earnings (id,request_log_id,shared_key_id,seller_user_id,net_amount)
        VALUES ('earning','request','shared','user',0.25)`);
      assert.equal(await scalar(`SELECT balance_micros FROM ${g}.user_earnings WHERE user_id='user'`),5250000);
      assert.equal(await scalar(`SELECT lifetime_earned_micros FROM ${g}.user_earnings WHERE user_id='user'`),250000);
      assert.equal(await scalar(`SELECT amount_micros FROM ${g}.portal_ledger_entries WHERE id='earning:earning'`),250000);
    },
    async 'retention function retains cutoff and bounded-limit guards'() {
      assert.equal(await scalar(`SELECT ${g}.delete_provider_attempt_availability_before(statement_timestamp()-interval '26 hours',1)`),0);
      await assert.rejects(f.pg.query(`SELECT ${g}.delete_provider_attempt_availability_before(statement_timestamp(),1)`));
      await assert.rejects(f.pg.query(`SELECT ${g}.delete_provider_attempt_availability_before(statement_timestamp()-interval '26 hours',5001)`));
    },
  };
  for (const path of ['public, pg_temp','pg_catalog','pg_temp, public']) {
    for (const [name, run] of Object.entries(cases)) await t.test(`${path}: ${name}`, async () => {
      const shadows = await f.reset(path);
      await run();
      assert.deepEqual(await f.snapshot('public'),shadows.public,'public shadow tables must remain unchanged');
      assert.deepEqual(await f.snapshot('pg_temp'),shadows.temp,'temporary shadow tables must remain unchanged');
      assert.equal((await rows('SHOW search_path'))[0].search_path,path,'function SET is local to invocation');
    });
  }
});
