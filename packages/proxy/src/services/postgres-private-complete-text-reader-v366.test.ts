import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import {
	PostgresPrivateCompleteTextReaderCleanupUnconfirmedError,
	PostgresPrivateCompleteTextReaderRejectedError,
	createPostgresPrivateCompleteTextReadPortsV366,
	readPostgresPrivateCompleteTextRouteV366,
} from './postgres-private-complete-text-reader-v366';

const CONNECTION = 'postgres://cinatoken_gateway_complete_text_private_reader:synthetic@localhost:5432/synthetic?sslmode=disable';
const REQUEST = {
	requestId: 'reader-request',
	quoteId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
	attemptNonce: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
	candidateIndex: 0,
	routeTargetId: 'selected-route',
	finalBodyUtf8: '{"model":"model-a","messages":[{"role":"user","content":"hi"}]}',
} as const;
const NOW=Date.parse('2026-09-25T12:00:00.000Z');
const CIPHERTEXT='enc:v2:synthetic-private-provider';
const digest=(value: string)=>createHash('sha256').update(value).digest('hex');
const successValue={
	status:'private_route_loaded',
	quote:{requestId:REQUEST.requestId,quoteId:REQUEST.quoteId,
		finalBodySha256:'a'.repeat(64),modelIds:['model-a'],routeCount:1,
		credentialClass:'platform',maxPerAttemptCeilingMicros:1,
		threeAttemptCeilingMicros:3,expiresAt:'2026-09-25T12:05:00.000Z'},
	selected:{candidateIndex:0,modelId:'model-a',routeTargetId:REQUEST.routeTargetId,
		routePoolId:'pool-a',routeGroup:'default',routePriority:0,routeWeight:1,
		providerId:'provider-a',providerName:'Provider A',
		providerModelName:'upstream-model-a',providerCiphertext:CIPHERTEXT,
		providerCiphertextSha256:digest(CIPHERTEXT),
		providerEndpoints:{openai:{base:'https://upstream.example/v1'}},
		endpointId:'endpoint-a',sourceGeneration:'1',
		attestedSourceSha256:'b'.repeat(64),sourceSha256:'c'.repeat(64),
		subjectFingerprint:'d'.repeat(64),
		endpointRow:{id:'endpoint-a',model_id:'model-a',provider_id:'provider-a',
			provider_slug:'provider-a',tag:'standard',endpoint_class:null,region:null,
			context_length:1000,max_prompt_tokens:null,max_completion_tokens:null,
			quantization:null,supported_parameters:'[]',
			pricing:'{"currency":"USD","prompt":"0.000002","completion":"0.000004"}',
			supports_tool_choice:'{"auto":true,"function":false,"none":true,"required":false}',
			image_capabilities:'{}',audio_capabilities:'{}',
			supports_implicit_caching:false,supports_voice_cloning:false,
			evidence_url:'https://evidence.example/endpoint-a',verified_by:'fixture',
			verified_at:'2026-09-25T11:59:00.000Z',
			expires_at:'2026-09-25T12:05:00.000Z',status:'verified',
			created_at:'2026-09-25T11:00:00.000Z',
			updated_at:'2026-09-25T11:00:00.000Z'},
	},
} as const;

type Client = PostgresDatabaseClient['raw'];
function fakeClient(events: string[], options: {
	role?: string;
	value?: unknown;
	closeFails?: boolean;
}) {
	const sql = {
		async begin<T>(run: (tx: { unsafe: (query: string, args?: unknown[]) => Promise<unknown> }) => Promise<T>) {
			events.push('begin');
			const result = await run({
				async unsafe(query: string, args?: unknown[]) {
					if (query.includes('current_user')) {
						events.push('role');
						return [{ current_role: options.role ?? 'cinatoken_gateway_complete_text_private_reader',
							session_role: options.role ?? 'cinatoken_gateway_complete_text_private_reader',
							transaction_isolation: 'read committed' }];
					}
					events.push('read');
					assert.match(query,/read_private_complete_text_route_v366/u);
					assert.deepEqual(args,[REQUEST.requestId,REQUEST.quoteId,
						REQUEST.candidateIndex,REQUEST.routeTargetId]);
					return [{ value: options.value ?? { status: 'not_found' } }];
				},
			});
			events.push('commit');
			return result;
		},
		end({ timeout }: { timeout: number }) {
			assert.equal(timeout,1);
			events.push('close');
			return options.closeFails
				? Promise.reject(new Error('close ACK unknown')) : Promise.resolve();
		},
	};
	return (_connection: string, config: { max: 1 }) => {
		assert.equal(_connection,CONNECTION);
		assert.deepEqual(config,{ max: 1 });
		return sql as unknown as Client;
	};
}

it('returns exact selected route only after COMMIT and reader close ACK', async () => {
	const events: string[]=[];
	const value=await readPostgresPrivateCompleteTextRouteV366({
		readerConnectionString:CONNECTION,request:REQUEST,nowMs:()=>NOW,
	},fakeClient(events,{value:successValue}));
	assert.deepEqual(events,['begin','role','read','commit','close']);
	assert.equal(value.quote.quoteId,REQUEST.quoteId);
	assert.equal(value.route.targetId,REQUEST.routeTargetId);
	assert.equal(value.route.endpoint?.id,'endpoint-a');
	assert.equal(value.route.providerApiKey,CIPHERTEXT);
	assert.deepEqual(value.route.providerEndpoints,
		{openai:{base:'https://upstream.example/v1'}});
	assert.equal(value.providerCiphertext,CIPHERTEXT);
});

it('serves three holder ports from one committed private read', async () => {
	const events: string[]=[];
	const ports=createPostgresPrivateCompleteTextReadPortsV366({
		readerConnectionString:CONNECTION,request:REQUEST,nowMs:()=>NOW,
	},fakeClient(events,{value:successValue}));
	assert.equal((await ports.loadQuote(REQUEST.quoteId))?.quoteId,REQUEST.quoteId);
	assert.equal((await ports.loadRoute({quoteId:REQUEST.quoteId,
		candidateIndex:0,routeTargetId:REQUEST.routeTargetId}))?.targetId,
		REQUEST.routeTargetId);
	assert.equal(await ports.loadProviderCiphertext('provider-a'),CIPHERTEXT);
	assert.equal(await ports.loadProviderCiphertext('wrong-provider'),null);
	assert.equal(await ports.loadQuote('ffffffff-ffff-ffff-ffff-ffffffffffff'),null);
	assert.deepEqual(events,['begin','role','read','commit','close']);
});

it('rejects a public or substituted database LOGIN before private read', async () => {
	const events: string[]=[];
	await assert.rejects(readPostgresPrivateCompleteTextRouteV366({
		readerConnectionString:CONNECTION,request:REQUEST,
	},fakeClient(events,{role:'cinatoken_gateway_runtime'})),
	/direct LOGIN mismatch/u);
	assert.deepEqual(events,['begin','role','close']);
});

it('treats a SQL rejection as denial and closes the direct LOGIN', async () => {
	const events: string[]=[];
	await assert.rejects(readPostgresPrivateCompleteTextRouteV366({
		readerConnectionString:CONNECTION,request:REQUEST,
	},fakeClient(events,{})),
		PostgresPrivateCompleteTextReaderRejectedError);
	assert.deepEqual(events,['begin','role','read','close']);
});

it('fails closed when the reader connection-close acknowledgement is lost', async () => {
	const events: string[]=[];
	await assert.rejects(readPostgresPrivateCompleteTextRouteV366({
		readerConnectionString:CONNECTION,request:REQUEST,
	},fakeClient(events,{value:{status:'not_found'},closeFails:true})),
		PostgresPrivateCompleteTextReaderCleanupUnconfirmedError);
	assert.deepEqual(events,['begin','role','read','close']);
});
