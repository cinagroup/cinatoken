/** Actual PostgreSQL SQL/functions in existing PGlite WASM, entirely in memory.
 * This does not prove native PostgreSQL multi-session lock/isolation behavior. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinancialEngine } from '../test-support/postgres-financial-engine.mjs';
import { createPostgresPortalLedgerRepository } from './postgres/portal-marketplace.impl.ts';

const now = '2026-10-01T06:00:00.000Z';
test('actual 81-migration PostgreSQL ledger accepts only unclaimed administrative rejection', async t => {
  const f = await createFinancialEngine();
  const raw = Object.assign((parts,...params) => f.client.raw.unsafe(
    parts.reduce((sql,part,index)=>sql+(index?'$'+index:'')+part,''),params),f.client.raw);
  const ledger = createPostgresPortalLedgerRepository({...f.client,raw});
  try {
    assert.equal(f.migrations.length, 81);
    assert.equal(f.migrations.at(-1), '0081_tools_config_group_audit.sql');
    async function setup(searchPath = 'pg_catalog, public, pg_temp, cinatoken_gateway') {
      const shadows = await f.reset(searchPath);
      await f.pg.exec(`DELETE FROM cinatoken_gateway.chain_job_transactions;
        INSERT INTO cinatoken_gateway.withdrawals
        (id,user_id,amount,fee,net_amount,amount_micros,fee_micros,net_amount_micros,wallet_address,status)
        VALUES('w','user',1,0.1,0.9,1000000,100000,900000,'wallet','requested')`);
      return shadows;
    }
    const state = async () => ({
      withdrawal: (await f.pg.query(`SELECT status,failure_reason,updated_at::text FROM cinatoken_gateway.withdrawals`)).rows,
      earnings: (await f.pg.query(`SELECT balance_micros,locked_amount_micros,lifetime_withdrawn_micros
        FROM cinatoken_gateway.user_earnings`)).rows,
      journal: (await f.pg.query(`SELECT kind,amount_micros FROM cinatoken_gateway.portal_ledger_entries ORDER BY kind`)).rows,
    });
    await t.test('rejection wins then claim and retry lose, with public/temp shadows untouched', async () => {
      const shadows = await setup();
      assert.deepEqual(await ledger.rejectRequestedWithdrawal('w','reviewed',now),{kind:'rejected',withdrawalId:'w'});
      const before = await state();
      assert.equal(before.withdrawal[0].status,'failed');
      assert.equal(before.earnings[0].balance_micros,'5000000');
      assert.equal(before.earnings[0].locked_amount_micros,'0');
      assert.deepEqual(before.journal.map(x=>[x.kind,x.amount_micros]),[['withdrawal_lock','-1000000'],['withdrawal_refund','1000000']]);
      const claim = await f.pg.query(`UPDATE cinatoken_gateway.withdrawals SET status='processing'
        WHERE id='w' AND status='requested' RETURNING id`);
      assert.deepEqual(claim.rows,[]);
      assert.deepEqual(await ledger.rejectRequestedWithdrawal('w','again',now),{kind:'conflict'});
      assert.deepEqual(await ledger.rejectRequestedWithdrawal('missing','reviewed',now),{kind:'not-found'});
      assert.deepEqual(await state(),before);
      assert.deepEqual(await f.snapshot('public'),shadows.public);
      assert.deepEqual(await f.snapshot('pg_temp'),shadows.temp);
    });
    for (const barrier of ['processing','submitted','confirmed','failed','hash','outbox']) {
      await t.test('reject conflicts with '+barrier+' and cannot refund', async () => {
        await setup();
        if (barrier==='hash') await f.pg.exec(`UPDATE cinatoken_gateway.withdrawals SET tx_hash='0xsynthetic'`);
        else if (barrier==='outbox') await f.pg.exec(`INSERT INTO cinatoken_gateway.chain_job_transactions
          VALUES('withdrawal','w','0xsynthetic','synthetic-signed',1,'${now}',NULL)`);
        else await f.pg.query(`UPDATE cinatoken_gateway.withdrawals SET status=$1 WHERE id='w'`,[barrier]);
        const before=await state();
        assert.deepEqual(await ledger.rejectRequestedWithdrawal('w','reviewed',now),{kind:'conflict'});
        assert.deepEqual(await state(),before);
      });
    }
    await t.test('insufficient canonical lock raises and rolls back the whole status/journal update', async () => {
      await setup();
      await f.pg.exec(`UPDATE cinatoken_gateway.user_earnings SET locked_amount_micros=500000,locked_amount=0.5`);
      const before=await state();
      await assert.rejects(ledger.rejectRequestedWithdrawal('w','reviewed',now),/insufficient_locked_balance/);
      assert.deepEqual(await state(),before);
    });
    await t.test('global chain refund still supports submitted transaction reverts without caller amount', async () => {
      await setup('pg_catalog, cinatoken_gateway, pg_temp');
      await f.pg.exec(`UPDATE cinatoken_gateway.withdrawals SET status='submitted',tx_hash='0xsynthetic'`);
      await ledger.refundWithdrawal('w','user',99,'chain revert',now);
      const before=await state();
      assert.equal(before.withdrawal[0].status,'failed');
      assert.equal(before.earnings[0].balance_micros,'5000000');
      await ledger.refundWithdrawal('w','user',99,'again',now);
      assert.deepEqual(await state(),before);
    });
  } finally { await f.pg.close(); }
});
