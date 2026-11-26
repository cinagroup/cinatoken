import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { getModelAnalyticsService, getProviderAnalyticsService, getReliabilityAnalyticsService } from './dashboard-service';

const start = '2026-09-26 00:00:00';
const end = '2026-09-27 00:00:00';
const raw = {
  model_id: 'model-a', route_group: 'default', provider_id: 'provider-a', provider_name: 'Provider A',
  request_count: 3, success_count: 2, error_count: 1,
  input_tokens: 100, output_tokens: 9900, cache_read_tokens: 20, cache_write_tokens: 5,
  charged_cost: 5, metered_cost: 3, standard_cost: 7,
  tokens_per_second: 3300, stream_tokens_per_second: 50, stream_sample_count: 1,
  failover_rate: 400 / 3, failover_request_rate: 100 / 3, failover_request_count: 1,
  avg_first_reasoning_token_ms: 80, avg_first_token_ms: 240, avg_effective_ttft_ms: 80,
  avg_reasoning_phase_ms: 160, reasoning_ttft_rate: 40, content_ttft_rate: 70,
};

it('model and provider APIs preserve legacy fields, filters and tags with additive quality metrics', async () => {
  const calls: unknown[] = [];
  const repos = { analytics: {
    queryModelAnalytics: async (options: unknown) => { calls.push(options); return [raw]; },
    queryProviderAnalytics: async (options: unknown) => { calls.push(options); return [raw]; },
    queryDistinctModelTags: async () => ['chat'],
  } } as unknown as GatewayRepositories;
  const models = await getModelAnalyticsService(repos, { start_date: start, end_date: end, user_email: 'a@example.com', api_key_id: 'key-a', tag: 'chat' });
  const providers = await getProviderAnalyticsService(repos, { start_date: start, end_date: end, model_id: 'model-a', route_group: 'default' });
  for (const result of [models, providers]) {
    assert.deepEqual(result.tags, ['chat']);
    const row = result.data[0];
    for (const key of ['request_count', 'input_tokens', 'output_tokens', 'charged_cost', 'metered_cost', 'standard_cost', 'success_count', 'error_count', 'tokens_per_second', 'failover_rate'] as const) {
      assert.equal(row[key], raw[key], key);
    }
    assert.ok(Math.abs(row.success_rate - 200 / 3) < 1e-10);
    assert.equal(row.cache_hit_rate, 20);
    assert.equal(row.stream_tokens_per_second, 50);
    assert.equal(row.failover_request_rate, 100 / 3);
  }
  assert.deepEqual(calls[0], { start, end, tag: 'chat', providerId: undefined, userEmail: 'a@example.com', userId: undefined, apiKeyId: 'key-a' });
  assert.deepEqual(calls[1], { start, end, tag: undefined, modelId: 'model-a', routeGroup: 'default' });
});

it('reliability errors use the selected range and retain the response envelope', async () => {
  const calls: unknown[] = [];
  const logs = [{ id: 'error-in-range', model_id: null, provider_id: null, provider_name: null, status: 'error', created_at: '2026-09-26T01:00:00.000Z' }];
  const repos = { analytics: {
    queryProviderReliability: async () => [raw], queryModelProviderReliability: async () => [raw],
  }, requestLogs: {
    getRecentErrors: async () => { throw new Error('Unbounded errors must not be used'); },
    getRequestLogs: async (options: unknown) => { calls.push(options); return { logs, total: 1 }; },
  } } as unknown as GatewayRepositories;
  const result = await getReliabilityAnalyticsService(repos, { start_date: start, end_date: end });
  assert.deepEqual(Object.keys(result).sort(), ['modelProviders', 'providers', 'recentErrors']);
  assert.equal(result.providers[0].avg_effective_ttft_ms, 80);
  assert.equal(result.providers[0].content_ttft_rate, 70);
  assert.equal(result.modelProviders[0].avg_first_token_ms, 240);
  assert.equal(result.modelProviders[0].reasoning_ttft_rate, 40);
  assert.deepEqual(result.recentErrors, logs);
  assert.deepEqual(calls, [{ page: 1, pageSize: 10, status: 'error', startDate: start, endDate: end }]);
});

it('user snapshots preserve a proven target and nullable wallets without inventing unknown balances', async () => {
  const { getUserAnalyticsService, getKeyAnalyticsService } = await import('./dashboard-service');
  const id = 'f2b74bc0-32f3-4613-aea7-96f723d08e12';
  const calls: unknown[] = [];
  const repos = { analytics: {
    queryUserAnalytics: async () => [
      {...raw, user_id:id, user_email:'same@example.test', budget_max:10, budget_spent:2, wallet_granted:1, wallet_spent:3},
      {...raw, user_id:null, user_email:'gone@example.test', budget_max:null, budget_spent:null, wallet_granted:null, wallet_spent:null},
    ],
    queryKeyAnalytics: async (options:unknown) => { calls.push(options); return [{...raw,api_key_id:null,key_name:null,last_active_at:null}]; },
  }, users: {getById:async (value:string)=>value===id?{id}:null} } as unknown as GatewayRepositories;
  const users=await getUserAnalyticsService(repos,{start_date:start,end_date:end});
  assert.equal(users[0]?.user_id,id); assert.equal(users[0]?.wallet_spent,3);
  assert.equal(users[1]?.user_id,null); assert.equal(users[1]?.wallet_granted,null); assert.equal(users[1]?.wallet_spent,null);
  const keys=await getKeyAnalyticsService(repos,{start_date:start,end_date:end,user_id:id});
  assert.equal(keys[0]?.api_key_id,null); assert.equal(keys[0]?.key_name,null);
  assert.deepEqual(calls,[{start,end,userId:id}]);
});
