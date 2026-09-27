import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import type { RouteResult } from './model-router';
import {
  createRouteAwareBudgetAdmission,
  RequestBudgetAdmissionError,
} from './request-budget-admission';

function setup(options: { reserveBlocked?: boolean; releaseFails?: boolean } = {}) {
  const calls: string[] = [];
  const repositories = {
    userBudgets: {
      expireBefore: async () => 0,
      reserve: async () => {
        calls.push('ordinary:reserve');
        return options.reserveBlocked
          ? { status: 'blocked', remainingMicros: 0 }
          : { status: 'reserved', reservation: {
              requestId: 'request-v348', userId: 'buyer-v348',
              apiKeyId: 'api-key-v348', budgetEpoch: 1,
              limitMicros: 1_000_000, reservedMicros: 100_000,
            } };
      },
      release: async () => {
        calls.push('ordinary:release');
        if (options.releaseFails) throw new Error('synthetic release failure');
        return 1;
      },
      markDispatched: async () => {
        calls.push('ordinary:dispatch'); return true;
      },
    },
    guardrailBudgets: {
      expireBefore: async () => 0,
      reserveMany: async () => {
        calls.push('guardrail:reject');
        return { status: 'blocked', assignmentId: 'assignment-v348' };
      },
    },
  } as unknown as GatewayRepositories;
  const create = () => createRouteAwareBudgetAdmission(repositories, {
    ordinary: { requestId: 'request-v348', userId: 'buyer-v348',
      apiKeyId: 'api-key-v348', budgetMax: 1, expectedBudgetEpoch: 1,
      estimatedChargedCost: 0.1 },
    guardrail: { intents: [{ workspaceId: 'workspace-v348',
      assignmentId: 'assignment-v348', guardrailId: 'guardrail-v348',
      guardrailVersion: 1, scopeType: 'user', scopeId: 'buyer-v348',
      period: 'daily', periodStart: '2026-09-25T00:00:00.000Z',
      periodEnd: '2026-09-26T00:00:00.000Z', limitMicros: 1_000_000 }],
      reservedMicros: 100_000 },
    privateByokGatewayKey: { includeInLimit: false, reservedMicros: 0 },
  });
  return { create, calls };
}

const sharedRoute = { providerKeyId: 'sharedkey:key-v348' } as RouteResult;

test('Guardrail rejection after ordinary reserve releases before dispatch', async () => {
  const { create, calls } = setup();
  const admission = await create();
  await assert.rejects(admission.beforeUpstreamDispatch(sharedRoute), error => {
    assert.ok(error instanceof RequestBudgetAdmissionError);
    assert.equal(error.code, 'gateway.guardrail_blocked');
    return true;
  });
  assert.deepEqual(calls, [
    'ordinary:reserve', 'guardrail:reject', 'ordinary:release',
  ]);
  assert.equal(admission.ordinaryLease.kind, 'free');
  assert.equal(admission.ordinaryLease.state, 'unmetered');
  assert.equal(admission.guardrailDispatched, false);
});

test('failed compensating release preserves the owned reserved lease', async () => {
  const { create, calls } = setup({ releaseFails: true });
  const admission = await create();
  await assert.rejects(admission.beforeUpstreamDispatch(sharedRoute),
    /could not be released before dispatch/u);
  assert.deepEqual(calls, [
    'ordinary:reserve', 'guardrail:reject', 'ordinary:release',
  ]);
  assert.equal(admission.ordinaryLease.kind, 'reserved');
  assert.equal(admission.ordinaryLease.state, 'reserved');
  assert.equal(admission.guardrailDispatched, false);
});

test('ordinary budget block creates no reservation to release', async () => {
  const { create, calls } = setup({ reserveBlocked: true });
  const admission = await create();
  await assert.rejects(admission.beforeUpstreamDispatch(sharedRoute), error => {
    assert.ok(error instanceof RequestBudgetAdmissionError);
    assert.equal(error.code, 'gateway.budget_exceeded');
    return true;
  });
  assert.deepEqual(calls, ['ordinary:reserve']);
  assert.equal(admission.ordinaryLease.kind, 'free');
});
