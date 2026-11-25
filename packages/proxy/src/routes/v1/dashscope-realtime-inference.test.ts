import {nativeRealtimeFixture} from '../../test-support/native-realtime-fixture';
/**
 * `GET /dashscope/api-ws/v1/inference`：升级后先接受下游，读到 run-task 的
 * `payload.model` / `payload.task` 才选路由、连上游（Node 绑定注入假运行时）。
 */
import assert from 'node:assert/strict';
import {describe,it,type TestContext} from 'node:test';
import {drainNodeBackgroundWork} from '../../runtime/schedule-background-work';
import type { GatewayRepositories, StorageContext } from '@octafuse/core';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { createProxyApp } from '../../app';
import type { RouteResult } from '../../services/model-router';
import {
	createRealtimeSocket,
	type RealtimeFrameData,
} from '../../services/egress/dashscope-realtime-socket';
import type {
	DeferredRealtimeRuntime,
	RealtimeUpstreamConnect,
} from '../../services/egress/dashscope-realtime-session';

function fakeSocket() {
	const sent: RealtimeFrameData[] = [];
	const closes: Array<{ code?: number; reason?: string }> = [];
	let handlers!: {
		message(data: RealtimeFrameData): void;
		close(code: number, reason: string): void;
		error(): void;
	};
	const socket = createRealtimeSocket({
		send: (data) => {
			sent.push(data);
		},
		close: (code, reason) => {
			closes.push({ code, reason });
		},
		subscribe: (h) => {
			handlers = h;
		},
	});
	return {
		socket,
		sent,
		closes,
		emitMessage: (data: RealtimeFrameData) => handlers.message(data),
		emitClose: (code = 1000, reason = '') => handlers.close(code, reason),
	};
}

type Mocks = {
	models?: Record<string, Record<string, unknown>>;
	routes?: Array<Record<string, unknown>>;
};

/** 未显式提供的仓储方法一律返回 `null`，只实现这条路径会用到的几个。 */

function appWith(mocks:Mocks={}) {
 let storage:Promise<StorageContext>|undefined;
 return createProxyApp(()=>storage ??= nativeRealtimeFixture(mocks,'dashscope'));
}

function runTask(model: string, task = 'asr', taskId = 'task-1'): string {
	return JSON.stringify({
		header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
		payload: {task_group:'audio',task,function:'recognition',model,parameters:{format:'pcm',sample_rate:16000}},
	});
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 200; i += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`timed out waiting for ${label}`);
}

async function openInference(
	mocks: Mocks,
	connectUpstream: RealtimeUpstreamConnect = async () => {
		throw new Error('upstream must not be connected');
	},
 test?:TestContext,
) {
	const client = fakeSocket();
	const connects: RouteResult[] = [];
 const sockets:Array<{close(code?:number,reason?:string):void}>=[];
 test?.after(async()=>{client.emitClose();for(const socket of sockets)socket.close(1000,'test completed');await drainNodeBackgroundWork();});
	const runtime: DeferredRealtimeRuntime = {
		client: client.socket,
		connectUpstream: async (route, ...rest) => {
			connects.push(route);
   const opened=await connectUpstream(route,...rest);
   if('socket' in opened)sockets.push(opened.socket);
   return opened;
		},
	};
	const response = await appWith(mocks).request(
		'/dashscope/api-ws/v1/inference',
		{ headers: { Upgrade: 'websocket', Authorization: 'bearer sk-ok' } },
		{ NODE_REALTIME_DEFERRED: () => runtime }
	);
	return { client, connects, response };
}

const ASR_MODEL = {id:'fun-asr-realtime',display_name:'Fun-ASR',input_modalities:'["audio"]',output_modalities:'["text"]',pricing_profile:JSON.stringify({audio_billing_mode:'per_second',audio:{price_per_second:0.0001}})};
const ASR_ROUTE = {
	id: 'route-1',
	model_id: 'fun-asr-realtime',
	provider_id: 'dashscope',
	provider_model_name: 'fun-asr-realtime-v2',
	priority: 0,
	status: 'active',
	route_group: 'default',
	weight: 1,
	price_override: null,
	custom_params: null,
	upstream_protocol: 'dashscope',
	route_pool_id: 'pool-1',
	upstream_operation: 'audio.transcriptions.realtime.inference',
	adapter: 'passthrough',
};

function lastEvent(client: ReturnType<typeof fakeSocket>) {
	return JSON.parse(String(client.sent[client.sent.length - 1]));
}

describe('DashScope realtime inference (deferred upstream)', () => {
	it('rejects a non-WebSocket request with the canonical 400', async (t) => {
		const response = await appWith().request(
			'/dashscope/api-ws/v1/inference',
			{ headers: { Authorization: 'Bearer sk-ok' } },
			{ NODE_REALTIME_DEFERRED: () => fakeSocketRuntime() }
		);
		assert.equal(response.status,400);
	});

	it('accepts the downstream without connecting upstream and asks node.ts to resume reading', async (t) => {
		const { response, connects } = await openInference({},undefined,t);
		assert.equal(response.headers.get('x-octafuse-realtime-upgrade'), '1');
		assert.equal(connects.length, 0);
	});

	it('closes with 1008 when the first frame is not run-task', async (t) => {
		const { client, connects } = await openInference({},undefined,t);
		client.emitMessage(JSON.stringify({ header: { action: 'finish-task', task_id: 'x' } }));
		await waitFor(() => client.closes.length > 0, 'close');
		assert.equal(client.closes[0]?.code, 1008);
		assert.equal(connects.length, 0);
	});

	it('answers task-failed for an unsupported payload.task', async (t) => {
		const { client, connects } = await openInference({ models: { 'fun-asr-realtime': ASR_MODEL } },undefined,t);
		client.emitMessage(runTask('fun-asr-realtime', 'stt', 'task-9'));
		await waitFor(() => client.closes.length > 0, 'close');
		const event = lastEvent(client);
		assert.equal(event.header.event, 'task-failed');
		assert.equal(event.header.task_id, 'task-9');
		assert.equal(event.header.error_code, 'InvalidParameter');
		assert.equal(client.closes[0]?.code, 1000);
		assert.equal(connects.length, 0);
	});

	it('answers task-failed when payload.model is missing', async (t) => {
		const { client } = await openInference({},undefined,t);
		client.emitMessage(runTask('', 'asr', 'task-2'));
		await waitFor(() => client.closes.length > 0, 'close');
		const event = lastEvent(client);
		assert.equal(event.header.error_code, 'InvalidParameter');
		assert.match(event.header.error_message, /payload\.model/);
	});

	it('answers task-failed when the model does not exist', async (t) => {
		const { client, connects } = await openInference({},undefined,t);
		client.emitMessage(runTask('no-such-model', 'asr', 'task-3'));
		await waitFor(() => client.closes.length > 0, 'close');
		const event = lastEvent(client);
		assert.equal(event.header.event, 'task-failed');
		assert.equal(event.header.task_id, 'task-3');
		assert.equal(event.header.error_code, GatewayErrorCode.modelNotFound);
		assert.match(event.header.error_message, /no-such-model/);
		assert.equal(connects.length, 0);
	});

	it('answers task-failed when the model has no route for the task operation', async (t) => {
		const { client, connects } = await openInference({
			models: { 'fun-asr-realtime': ASR_MODEL },
			routes: [],
		},undefined,t);
		client.emitMessage(runTask('fun-asr-realtime', 'asr', 'task-4'));
		await waitFor(() => client.closes.length > 0, 'close');
		const event = lastEvent(client);
		assert.equal(event.header.error_code, GatewayErrorCode.noRoute);
		assert.equal(connects.length, 0);
	});

	it('answers task-failed when every upstream connection fails', async (t) => {
		const { client, connects } = await openInference({ models: { 'fun-asr-realtime': ASR_MODEL }, routes: [ASR_ROUTE] },async () => ({ response: new Response('nope', { status: 503 }), requestId: null }),t);
		client.emitMessage(runTask('fun-asr-realtime', 'asr', 'task-5'));
		await waitFor(() => client.closes.length > 0, 'close');
		const event = lastEvent(client);
		assert.equal(event.header.event, 'task-failed');
		assert.equal(event.header.task_id, 'task-5');
		assert.ok(connects.length >= 1,JSON.stringify(client.sent));
		assert.equal(client.closes[0]?.code, 1000);
	});

	it('routes by run-task, connects upstream, replays frames and bridges events', async (t) => {
		const upstream = fakeSocket();
		const { client, connects } = await openInference({ models: { 'fun-asr-realtime': ASR_MODEL }, routes: [ASR_ROUTE] },async () => ({ socket: upstream.socket, requestId: 'req-1' }),t);
		// run-task 与紧随其后的音频帧在连接上游之前就到达
		client.emitMessage(runTask('fun-asr-realtime', 'asr', 'task-6'));
		client.emitMessage(new Uint8Array([1, 2, 3, 4]));
		await waitFor(()=>upstream.sent.length>=2||client.sent.length>0,'replayed frames');
  assert.ok(upstream.sent.length>=2,JSON.stringify(client.sent));

		assert.equal(connects.length, 1);
		assert.equal(connects[0]?.providerModelName, 'fun-asr-realtime-v2');
		assert.equal(connects[0]?.upstreamOperation, 'audio.transcriptions.realtime.inference');
		const forwarded = JSON.parse(String(upstream.sent[0]));
		assert.equal(forwarded.header.action, 'run-task');
		assert.equal(forwarded.payload.model, 'fun-asr-realtime-v2');
		assert.deepEqual([...(upstream.sent[1] as Uint8Array)], [1, 2, 3, 4]);

		upstream.emitMessage(
			JSON.stringify({ header: { event: 'task-started', task_id: 'task-6' }, payload: {} })
		);
		await waitFor(() => client.sent.length >= 1, 'event relay');
		assert.equal(lastEvent(client).header.event, 'task-started');

		upstream.emitMessage(
			JSON.stringify({
				header: { event: 'task-finished', task_id: 'task-6' },
				payload: { usage: { duration: 3 } },
			})
		);
		upstream.emitClose(1000, '');
		await waitFor(() => client.closes.length > 0, 'client close');
		assert.equal(client.closes[0]?.code, 1000);
	});

	it('rejects TTS before dispatch without a proven code-point billing ceiling', async (t) => {
		const upstream = fakeSocket();
		const ttsRoute = {
			...ASR_ROUTE,
			id: 'route-tts',
			model_id: 'cosyvoice-v2',
			provider_model_name: 'cosyvoice-v2',
			upstream_operation: 'audio.speech.realtime.inference',
		};
		const { client, connects } = await openInference({ models: { 'cosyvoice-v2': {id:'cosyvoice-v2',input_modalities:'["text"]',output_modalities:'["audio"]',pricing_profile:JSON.stringify({audio_billing_mode:'per_character',audio:{price_per_character:0.0001}})} }, routes: [ttsRoute] },async () => ({ socket: upstream.socket, requestId: null }),t);
		client.emitMessage(runTask('cosyvoice-v2', 'tts', 'task-7'));
		await waitFor(()=>client.closes.length>0,'safe TTS rejection');
  assert.equal(connects.length,0);
  assert.equal(lastEvent(client).header.event, 'task-failed');
  assert.equal(lastEvent(client).header.error_message, 'Upstream provider is unavailable');
	});
});

function fakeSocketRuntime(): DeferredRealtimeRuntime {
	return {
		client: fakeSocket().socket,
		connectUpstream: async () => {
			throw new Error('unused');
		},
	};
}
