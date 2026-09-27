import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { insertRequestUsageAndChargeTxPg } from '../../db/postgres/critical-writes.impl.ts';
import { encodeUsageSettlement } from './usage-settlement-codec.ts';
import { sample } from './usage-settlement-test-support.mjs';

// This unit models transaction rollback and repository projections, not SQL,
// role grants or transport. The native HTTP successor verifies those boundaries.
function replayFixture() {
  const value = sample(0.25), request = value.params.requestLog;
  const state = {
    spent: 0.25, reserved: 0, receipts: [],
    reservation: { request_id: request.id, user_id: request.userId, api_key_id: request.apiKeyId,
      budget_epoch: 0, reserved_micros: 500000, settled_micros: 250000, state: 'settled' },
    log: { id: request.id, user_id: request.userId, api_key_id: request.apiKeyId,
      workspace_id: request.workspaceId, provider_key_id: null, route_target_id: request.routeTargetId,
      route_trace: null, charged_cost: '0.25', budget_charged_micros: 250000,
      input_tokens: request.inputTokens, output_tokens: request.outputTokens,
      cache_read_tokens: 0, cache_write_tokens: 0, status: 'success' },
  };
  const reads = [], mutations = [], transactions = [];
  const dialect = new PgDialect();
  const client = { driver: 'postgres', drizzle: {
    async transaction(callback) {
      const before = structuredClone(state);
      const tx = {
        async execute(statement) {
          const { sql } = dialect.sqlToQuery(statement);
          if (/^INSERT INTO cinatoken_gateway.request_usage_commit_receipts/u.test(sql)) {
            state.receipts.push(request.id); mutations.push('receipt'); return [];
          }
          if (sql.includes('recovery_api_key_workspace_matches')) return [{ matches: true }];
          throw new Error('Unexpected fixture SQL: ' + sql);
        },
        select(fields) {
          let table, lock;
          const query = {
            from(value) { table = getTableName(value); return query; },
            where() { return query; },
            for(value) { lock = value; return query; },
            then(yes, no) {
              return Promise.resolve().then(() => {
                reads.push({ table, columns: Object.values(fields).map(column => column.name), lock });
                const row = table === 'user_budget_reservations' ? state.reservation
                  : table === 'api_key_request_logs' ? state.log
                    : table === 'api_keys' ? { workspace_id: request.workspaceId } : null;
                if (!row) throw new Error('Unexpected fixture table: ' + table);
                return [Object.fromEntries(Object.entries(fields).map(([name, column]) => [name, row[column.name]]))];
              }).then(yes, no);
            },
          };
          return query;
        },
        insert() { throw new Error('Replay must not insert another row'); },
        update() { throw new Error('Replay must not change a monetary row'); },
      };
      try { const result = await callback(tx); transactions.push('committed'); return result; }
      catch (error) { Object.assign(state, before); transactions.push('rolled_back'); throw error; }
    },
  } };
  return { value, state, reads, mutations, transactions, client };
}

test('recovery prior-log rejection rolls its receipt back and reads only the permitted identity', async () => {
  const f = replayFixture(), before = structuredClone(f.state);
  const encoded = await encodeUsageSettlement(f.value);
  const input = { ref: { ...f.value.intent, dispatchClaimId: f.value.dispatchClaimId,
    payloadSha256: encoded.sha256 }, proof: { token: randomUUID(), revision: 1 },
    recordedAtIso: f.value.recordedAtIso };
  await assert.rejects(insertRequestUsageAndChargeTxPg(f.client, f.value.params, input),
    /Legacy log cannot be adopted by a new settlement receipt/u);
  assert.deepEqual(f.state, before);
  assert.deepEqual(f.transactions, ['rolled_back']);
  assert.deepEqual(f.mutations, ['receipt']);
  assert.deepEqual(f.reads.filter(read => read.table === 'api_key_request_logs'),
    [{ table: 'api_key_request_logs', columns: ['id'], lock: undefined }]);
  assert.equal(f.reads.find(read => read.table === 'user_budget_reservations')?.lock, 'update');
});

test('ordinary matching replay retains its full economic projection without another debit or row', async () => {
  const f = replayFixture(), before = structuredClone(f.state);
  await insertRequestUsageAndChargeTxPg(f.client, f.value.params);
  assert.deepEqual(f.state, before);
  assert.deepEqual(f.mutations, []);
  assert.deepEqual(f.transactions, ['committed']);
  assert.deepEqual(f.reads.find(read => read.table === 'api_key_request_logs')?.columns,
    ['id', 'user_id', 'api_key_id', 'workspace_id', 'provider_key_id', 'route_target_id', 'route_trace',
      'charged_cost', 'budget_charged_micros', 'input_tokens', 'output_tokens',
      'cache_read_tokens', 'cache_write_tokens', 'status']);
});

test('ordinary conflicting replay rejects without changing money, rows or terminal reservation', async () => {
  for (const patch of [{ charged_cost: '0.5' }, { user_id: 'other' }, { api_key_id: 'other' },
    { workspace_id: 'other' }, { budget_charged_micros: 1 }]) {
    const f = replayFixture(); Object.assign(f.state.log, patch);
    const before = structuredClone(f.state);
    await assert.rejects(insertRequestUsageAndChargeTxPg(f.client, f.value.params),
      /Conflicting replay for ordinary-user budget settlement/u);
    assert.deepEqual(f.state, before);
    assert.deepEqual(f.transactions, ['rolled_back']);
    assert.deepEqual(f.mutations, []);
  }
});
