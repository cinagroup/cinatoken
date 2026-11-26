import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import {createSqliteD1} from '../test-support/sqlite-d1';
import {createD1StorageContext,getAccessibleWorkspaceForSubject,computeRouteDataPolicySubjectFingerprintFromRows,type ModelRouteRow,type ProviderRow,type GatewayRepositories} from '@octafuse/core';
import { defaultHasUsage, modelDisplayName, parseJsonModelBody, runProxyPipeline, type AuthedEnv } from './proxy-pipeline';
import { EMPTY_USAGE, type UsageFromStream } from './proxy';
import { GATEWAY_REQUEST_ID_HEADER, GatewayErrorCode, NO_AVAILABLE_ROUTE_MESSAGE } from './gateway-error-codes';
import { describeChatOutcome } from './accounting';
import { buildRouteRequestBody } from './route-default-params';

describe('proxy pipeline helpers', () => {
	it('treats any token counter as usage for chat-family endpoints', () => {
		assert.equal(defaultHasUsage(EMPTY_USAGE), false);
		assert.equal(defaultHasUsage({ ...EMPTY_USAGE, input_tokens: 3 }), true);
		assert.equal(defaultHasUsage({ ...EMPTY_USAGE, output_tokens: 1 }), true);
		assert.equal(defaultHasUsage({ ...EMPTY_USAGE, total_tokens: 8 }), true);
	});

	it('does not treat reasoning-only usage as complete for the default helper', () => {
		const usage: UsageFromStream = { ...EMPTY_USAGE, reasoning_tokens: 12 };
		assert.equal(defaultHasUsage(usage), false);
	});

	it('prefers a non-empty display name', () => {
		assert.equal(modelDisplayName({ display_name: '  GPT  ' }, 'gpt-x'), 'GPT');
		assert.equal(modelDisplayName({ display_name: '' }, 'gpt-x'), 'gpt-x');
		assert.equal(modelDisplayName({ display_name: null }, 'gpt-x'), 'gpt-x');
	});

	it('keeps empty-route errors distinct from model not found', () => {
		assert.equal(NO_AVAILABLE_ROUTE_MESSAGE, 'No available route');
		assert.equal(GatewayErrorCode.noRoute, 'gateway.no_route');
		assert.notEqual(GatewayErrorCode.noRoute, GatewayErrorCode.modelNotFound);
		assert.notEqual(NO_AVAILABLE_ROUTE_MESSAGE, 'Model not found');
	});
});

it('correlates the response with the logged upstream snapshot and sources from the final route', async t => {
 const statements:{sql:string;values:unknown[]}[]=[];
 const sqlite=createSqliteD1({beforeStatement:(sql,values)=>{if(sql.startsWith('INSERT INTO api_key_request_logs'))statements.push({sql,values:[...values]});}});
 t.after(()=>sqlite.sqlite.close());
 sqlite.sqlite.exec("INSERT INTO users(id,email,external_system,external_user_id) VALUES('test-user','test@example.invalid','cinaauth','verified-test-user')");
 sqlite.sqlite.exec("INSERT INTO models(id,display_name) VALUES('model','Model'); INSERT INTO providers(id,name) VALUES('first','First'),('final','Final'); INSERT INTO model_routes(id,model_id,provider_id,provider_model_name) VALUES('first','model','first','upstream-first'),('final','model','final','upstream-final')");
 const storage=createD1StorageContext(sqlite.binding);
 await getAccessibleWorkspaceForSubject(storage.client,{userId:'test-user',subject:'verified-test-user',workspaceId:'personal:test-user'});
 sqlite.sqlite.exec("INSERT INTO api_keys(id,key,user_id,workspace_id) VALUES('test-key-id','synthetic-key','test-user','personal:test-user')");
 const rows=['first','final'].map(id=>({id,model_id:'model',provider_id:id,provider_model_name:`upstream-${id}`,upstream_protocol:'openai',upstream_operation:'chat',adapter:'passthrough',status:'active',route_group:'default',priority:1,weight:1,price_override:null,routing_metadata:null,custom_params:JSON.stringify({body:{temperature:id==='final'?0.4:0.9}})})) as ModelRouteRow[];
 const providers=rows.map(row=>({id:row.provider_id,name:row.provider_id,api_key:'test-key',status:'active',endpoints:JSON.stringify({openai:{base:'https://provider.example.invalid/v1'}}),custom_params:JSON.stringify({openai:{body:{max_tokens:row.provider_id==='final'?256:1024}}})})) as ProviderRow[];
 const bindings=await Promise.all(rows.map(async(row,i)=>({
  id:`ep-${row.id}`,model_id:'model',provider_id:row.provider_id,provider_slug:row.provider_id,tag:'test',endpoint_class:'standard',region:null,context_length:8192,max_prompt_tokens:null,max_completion_tokens:1024,quantization:null,supported_parameters:'[]',pricing:'{"currency":"USD","prompt":"0","completion":"0"}',supports_implicit_caching:false,supports_voice_cloning:false,supports_tool_choice:'{"auto":true,"function":true,"none":true,"required":true}',audio_capabilities:'{}',image_capabilities:'{}',evidence_url:'https://evidence.example.invalid',verified_by:'test',verified_at:new Date().toISOString(),expires_at:'2099-01-01T00:00:00.000Z',status:'verified' as const,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),route_target_id:row.id,subject_fingerprint:await computeRouteDataPolicySubjectFingerprintFromRows(row,providers[i]!),
 })));
 const repos={...storage.repositories,
  modelRouting:{...storage.repositories.modelRouting,getModelById:async()=>({id:'model',display_name:'Model',vendor:'other',context_window:8192,max_tokens:1024,pricing_profile:null,metadata:null,input_modalities:'["text"]',output_modalities:'["text"]'}),resolveModelSurface:async()=>null,getModelRoutesByModelId:async()=>rows},
  providers:{...storage.repositories.providers,getProvidersByIds:async()=>providers},
  modelEndpoints:{...storage.repositories.modelEndpoints,listRuntimeBindingsByRouteTargetIds:async()=>bindings},
 } as GatewayRepositories;

	const app = new Hono<AuthedEnv>();
	app.post('/', (c) => {
		c.set('repositories', repos);
  c.set('requestBodyLoggingMode','redacted');
		c.set('apiKey', {
			keyId:'test-key-id',apiKeyHash:'0'.repeat(64),userId:'test-user',workspaceId:'personal:test-user',budgetEpoch:0,userEmail:null,budgetMax:null,budgetSpent:0,
			walletGranted: 0, walletSpent: 0, budgetPeriod: 'monthly', budgetResetAt: null, metadata: null,
			chargedCostFactors: null, rateLimit: null, userRateLimit: null, ingressHost: null,
		});
		return runProxyPipeline(c, {
			requestProtocol:'openai',requestOperation:'chat',strategyCapability:'chat',logTag:'test',logRecordUsageError:true,
			parseRequest: parseJsonModelBody,
			dispatch: async ({ routes, options }) => {
				const [first, final] = routes;
				const firstAttempt = options.timing?.startAttempt(first);
				options.timing?.markAttemptHeaders(firstAttempt,429);
    await options.beforeUpstreamDispatch?.(final);
				const finalAttempt = options.timing?.startAttempt(final);
				options.timing?.markAttemptHeaders(finalAttempt, 200);
				options.timing?.markFinalAttempt(finalAttempt);
				return {
					chosenRoute: final, response: Response.json({ ok: true }),
					usagePromise: Promise.resolve({ ...EMPTY_USAGE, input_tokens:1,total_tokens:1 }),
					upstreamRequestId: null, circuitEvents: [], suppressErrorAlert: false,
				};
			},
			accounting: {
				requestBodyForLog: (body) => JSON.stringify(body),
				upstreamWireBodyForLog: (route, body) => JSON.stringify({
					...buildRouteRequestBody(route, body), model: route.providerModelName,
				}),
				requestBodyForSources: (body) => body,
				describeOutcome: describeChatOutcome,
			},
		});
	});
	const tasks: Promise<unknown>[] = [];
	const response = await app.request('/', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: 'model' }),
	}, { USAGE_SAFETY_TIMEOUT_MS: '10' }, {
		waitUntil: (task: Promise<unknown>) => tasks.push(task),
		passThroughOnException: () => {},
	});
	assert.equal(response.status, 200);
	await Promise.all(tasks);
	const entry = statements.find(({ sql }) => sql.startsWith('INSERT INTO api_key_request_logs'));
	assert.ok(entry);
	const columns = entry.sql.match(/\(([^)]+)\)/)?.[1].split(',').map((col) => col.trim()) ?? [];
	const row = Object.fromEntries(columns.map((col, index) => [col, entry.values[index]]));
	assert.equal(row.id, response.headers.get(GATEWAY_REQUEST_ID_HEADER));
	assert.equal(row.route_target_id, 'final');
	assert.deepEqual(JSON.parse(String(row.upstream_request_body)), { model: 'upstream-final', max_tokens: 256, temperature: 0.4 });
	assert.deepEqual(JSON.parse(String(row.route_trace)).request_sources, { body: 'pr.', headers: [] });
});
