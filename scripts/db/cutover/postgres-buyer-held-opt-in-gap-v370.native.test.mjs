// Counterexample for a direct opt-in to the v368 held buyer writer. This is an
// owned local PostgreSQL cluster with minimal copies of the affected columns.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';

test('v368 buyer ACL and an unreserved Guardrail window prevent a sound direct opt-in',
  { timeout: 120_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const password = randomBytes(24).toString('hex');
    const buyer = postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
      username: 'cinatoken_gateway_buyer_settlement', password, ssl: false,
      max: 1, prepare: false, fetch_types: false, connect_timeout: 3,
      idle_timeout: 0, max_lifetime: 0, backoff: false, onnotice() {} });
    try {
      await cluster.admin.unsafe(`
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT
          PASSWORD '${password}';
        CREATE SCHEMA cinatoken_gateway;
        CREATE TABLE cinatoken_gateway.guardrail_budget_windows (
          workspace_id text NOT NULL, scope_type text NOT NULL,
          scope_id text NOT NULL, period text NOT NULL,
          period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
          unreserved_micros bigint NOT NULL DEFAULT 0,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (workspace_id,scope_type,scope_id,period,period_start)
        );
        CREATE TABLE cinatoken_gateway.guardrail_budget_reservations (
          request_id text NOT NULL, workspace_id text NOT NULL,
          scope_type text NOT NULL, scope_id text NOT NULL,
          period text NOT NULL, period_start timestamptz NOT NULL,
          state text NOT NULL
        );
        GRANT USAGE ON SCHEMA cinatoken_gateway
          TO cinatoken_gateway_buyer_settlement;
        GRANT SELECT ON cinatoken_gateway.guardrail_budget_windows,
          cinatoken_gateway.guardrail_budget_reservations
          TO cinatoken_gateway_buyer_settlement;
      `).simple();
      const now = '2026-09-25T00:00:00.000Z';
      const end = '2026-09-26T00:00:00.000Z';
      const requestId = 'request-with-held-user-window';
      const workspaceId = 'workspace-1';
      const userId = 'user-1';
      const apiKeyId = 'key-1';

      // A SQL UPDATE requires privilege even if its predicate finds no row.
      await assert.rejects(buyer.unsafe(`UPDATE cinatoken_gateway.guardrail_budget_windows
        SET unreserved_micros=unreserved_micros+1 WHERE false`), error => {
        assert.equal(error.code, '42501');
        return true;
      });

      await cluster.admin.unsafe(`INSERT INTO cinatoken_gateway.guardrail_budget_windows
        (workspace_id,scope_type,scope_id,period,period_start,period_end)
        VALUES($1,'user',$2,'daily',$3,$4)`, [workspaceId, userId, now, end]);
      await cluster.admin.unsafe(`INSERT INTO cinatoken_gateway.guardrail_budget_reservations
        (request_id,workspace_id,scope_type,scope_id,period,period_start,state)
        VALUES($1,$2,'user',$3,'daily',$4,'settled')`,
      [requestId, workspaceId, userId, now]);

      const unmatchedQuery = `SELECT w.scope_type,w.scope_id
        FROM cinatoken_gateway.guardrail_budget_windows AS w
        WHERE $1::timestamptz >= w.period_start
          AND $1::timestamptz < w.period_end
          AND w.workspace_id=$2
          AND ((w.scope_type='user' AND w.scope_id=$3)
            OR (w.scope_type='api_key' AND w.scope_id=$4))
          AND NOT EXISTS (
            SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations AS r
            WHERE r.request_id=$5 AND r.workspace_id=w.workspace_id
              AND r.scope_type=w.scope_type AND r.scope_id=w.scope_id
              AND r.period=w.period AND r.period_start=w.period_start
              AND r.state IN ('reserved','dispatched','settled','expired')
          )`;
      const args = [now, workspaceId, userId, apiKeyId, requestId];
      await assert.rejects(buyer.unsafe(`${unmatchedQuery} FOR UPDATE`, args), error => {
        assert.equal(error.code, '42501');
        return true;
      });
      await buyer.begin(async tx => {
        // The held user window is excluded. A plain SELECT has no predicate
        // protection in the read-committed isolation used by v368.
        assert.equal((await tx.unsafe(unmatchedQuery, args)).length, 0);
        await cluster.admin.unsafe(`INSERT INTO cinatoken_gateway.guardrail_budget_windows
          (workspace_id,scope_type,scope_id,period,period_start,period_end)
          VALUES($1,'api_key',$2,'daily',$3,$4)`, [workspaceId, apiKeyId, now, end]);
        const phantom = await tx.unsafe(unmatchedQuery, args);
        assert.deepEqual(phantom.map(row => row.scope_id), [apiKeyId]);
        // An opt-in that skipped the privileged final UPDATE would commit with
        // this newly applicable window unaccounted for.
      });
      const [missed] = await cluster.admin.unsafe(`SELECT unreserved_micros
        FROM cinatoken_gateway.guardrail_budget_windows
        WHERE scope_type='api_key' AND scope_id=$1`, [apiKeyId]);
      assert.equal(Number(missed.unreserved_micros), 0);

      // This is the current critical writer's final update predicate. The
      // legacy direct-write path would charge the newly created window.
      await cluster.admin.unsafe(`UPDATE cinatoken_gateway.guardrail_budget_windows AS w
        SET unreserved_micros=w.unreserved_micros+1,
          updated_at=$1
        WHERE $2::timestamptz >= w.period_start
          AND $2::timestamptz < w.period_end
          AND w.workspace_id=$3
          AND ((w.scope_type='user' AND w.scope_id=$4)
            OR (w.scope_type='api_key' AND w.scope_id=$5))
          AND NOT EXISTS (
            SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations AS r
            WHERE r.request_id=$6 AND r.workspace_id=w.workspace_id
              AND r.scope_type=w.scope_type AND r.scope_id=w.scope_id
              AND r.period=w.period AND r.period_start=w.period_start
              AND r.state IN ('reserved','dispatched','settled','expired')
          )`, [now, now, workspaceId, userId, apiKeyId, requestId]);
      const [accounted] = await cluster.admin.unsafe(`SELECT unreserved_micros
        FROM cinatoken_gateway.guardrail_budget_windows
        WHERE scope_type='api_key' AND scope_id=$1`, [apiKeyId]);
      assert.equal(Number(accounted.unreserved_micros), 1);
    } finally {
      await buyer.end({ timeout: 1 });
      await cluster.cleanup();
    }
  });
