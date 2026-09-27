import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSqliteD1 } from '../../../../proxy/src/test-support/sqlite-d1.ts';
import { createD1DatabaseClient } from '../database-client.ts';
import { createD1UserBudgetReservationsRepository } from '../../db/d1/user-budget-reservations.impl.ts';
import { createDispatchIntentRepositoryD1 } from './dispatch-intent-d1.ts';
import { createUsageSettlementRepositoryD1 } from './usage-settlement-d1.ts';

export function setup(t, options = {}) {
  const db = createSqliteD1({}, options), client = createD1DatabaseClient(db.binding);
  if (options.applyMigrations !== false) {
    for (const name of ['request-dispatch-intents.sql', 'request-usage-settlements.sql']) {
      db.sqlite.exec(readFileSync(new URL('../../../migrations-proposals/d1/' + name, import.meta.url), 'utf8'));
    }
    for (const prefix of ['recovery', 'other']) {
      db.sqlite.prepare('INSERT INTO users(id,email,budget_max,budget_base) VALUES(?,?,10,10)').run(prefix + '-user', prefix + '@example.invalid');
      db.sqlite.prepare("INSERT INTO workspaces(id,scope_type,personal_owner_user_id,name,slug) VALUES(?,'personal',?,?,?)")
        .run(prefix + '-workspace', prefix + '-user', prefix, prefix);
      db.sqlite.prepare('INSERT INTO api_keys(id,key,user_id,workspace_id,name) VALUES(?,?,?,?,?)')
        .run(prefix + '-key', 'test-only-hash-' + prefix, prefix + '-user', prefix + '-workspace', prefix);
    }
  }
  t?.after(() => db.sqlite.close());
  return { ...db, client, intents: createDispatchIntentRepositoryD1(db.binding), repo: createUsageSettlementRepositoryD1(client),
    budgets: createD1UserBudgetReservationsRepository(client) };
}
export function sample(cost = 0) {
  const requestId = 'gen-' + randomUUID(), recordedAtIso = '2026-09-06T23:59:59.000Z';
  const intent = { requestId, userId: 'recovery-user', apiKeyId: 'recovery-key', workspaceId: 'recovery-workspace',
    attemptIndex: 1, operation: 'images.generations', contextSha256: 'a'.repeat(64) };
  return { version: 1, intent, dispatchClaimId: randomUUID(), recordedAtIso, params: {
    userId: intent.userId, shouldChargeBudget: cost > 0, beforeSpent: 0, chargedCost: cost,
    ...(cost > 0 ? { userBudgetSettlement: { requestId, mode: 'actual', reason: 'test_actual' } } : {}),
    audit: { apiKeyId: intent.apiKeyId, eventType: 'usage_charge', actorType: 'system', beforeSpent: 0, requestLogId: requestId, source: 'gateway_usage' },
    requestLog: { id: requestId, userId: intent.userId, apiKeyId: intent.apiKeyId, workspaceId: intent.workspaceId, userEmail: null,
      modelId: 'synthetic/image', providerId: 'synthetic-provider', providerModelName: 'synthetic-image', modelName: 'Synthetic Image', providerName: 'Synthetic',
      requestBody: null, upstreamRequestBody: null, requestProtocol: 'openai', upstreamProtocol: 'openai', requestOperation: intent.operation,
      upstreamOperation: intent.operation, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 11,
      meteredCost: cost, standardCost: cost, chargedCost: cost, budgetAccountedAt: recordedAtIso, routeGroup: 'default', status: 'success', latencyMs: 10,
      errorMessage: null, rawUsage: '{"images":1}', pricingAudit: '{"fixture":"original-price","cost":' + cost + '}',
      outputImageCount: 1, billingKind: 'image_per_image', routeTargetId: 'synthetic-target',
      providerAttempts: [{ attemptIndex: 1, routeTargetId: 'synthetic-target', providerId: 'synthetic-provider',
        outcome: 'available', reason: 'accepted', httpStatus: 200, observedAtIso: recordedAtIso }],
    },
  } };
}
export async function prepare(db, value, { claim = true } = {}) {
  await db.intents.prepare(value.intent, 100, 1000);
  if (claim) await db.intents.claim(value.intent, 0, value.dispatchClaimId, 200);
  if (value.params.userBudgetSettlement) {
    const result = await db.budgets.reserve({ requestId: value.intent.requestId, userId: value.intent.userId, apiKeyId: value.intent.apiKeyId,
      expectedBudgetEpoch: 0, reservedMicros: 500000, nowIso: value.recordedAtIso, expiresAtIso: '2026-09-07T00:05:00.000Z' });
    if (result.status !== 'reserved') throw new Error('Fixture reservation failed: ' + result.status);
    await db.budgets.markDispatched(value.intent.requestId, value.recordedAtIso, '2026-09-07T00:10:00.000Z');
  }
}
export function counts(db) {
  return Object.fromEntries(['request_usage_settlements', 'request_usage_commit_receipts', 'api_key_request_logs', 'provider_attempt_availability', 'user_audit_logs']
    .map(table => [table, db.sqlite.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n]));
}
