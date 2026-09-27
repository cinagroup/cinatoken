/// <reference path="./complete-text-holder-v390-env.d.ts" />
import type { ChatTextHolderRequestV363 } from '../services/chat-text-holder-request-v363';
import { createPostgresPrivateCompleteTextReadPortsV366 } from '../services/postgres-private-complete-text-reader-v366';
import { grantPostgresCompleteTextAttemptV362 } from '../services/postgres-complete-text-attempt-grant-v362';
import { claimPostgresCompleteTextCustodyV365, recordPostgresCompleteTextSendStartV365 } from '../services/postgres-complete-text-send-start-v365';
import { renewPostgresCompleteTextHoldsV367 } from '../services/postgres-complete-text-hold-renewal-v369';
import { appendPostgresCompleteTextHolderFactV367 } from '../services/postgres-complete-text-result-facts-v367';
import { createObservedPrivateCompleteTextHolderV384,
	type ObservedPrivateTextHolderPortsV384 } from '../services/private-complete-text-observed-holder-v384';
import { createHyperdriveDedicatedRoleTransportV390 } from '../services/hyperdrive-dedicated-role-transport-v390';

const MAX_FINAL_BYTES = 1_048_576;
const MAX_ENVELOPE_BYTES = 6 * MAX_FINAL_BYTES + 8_192;
const MAX_REQUEST_MS = 300_000;
const MAX_LEASE_MS = 14 * 60_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const FIELDS = ['requestId', 'quoteId', 'attemptNonce', 'candidateIndex', 'routeTargetId', 'finalBodyUtf8'];
const encoder = new TextEncoder();

type WorkerContext = Pick<ExecutionContext, 'waitUntil'>;
export type CompleteTextHolderWorkerOptionsV390 = Readonly<{
	/** Local test transport only; the exported Worker uses native fetch. */
	fetchUpstream?: typeof fetch;
	/** Local tests may shorten, never extend, the request and renewal bounds. */
	maxRequestMs?: number;
	maxUnrenewedStreamMs?: number;
}>;

/** Trusted server composition only; no request field or binding selects this factory. */
export type CompleteTextHolderWorkerCompositionV390 = Readonly<{
	createHolder(ports: ObservedPrivateTextHolderPortsV384, database: Readonly<{
		connectionString: string;
		createSql: ReturnType<typeof createHyperdriveDedicatedRoleTransportV390>['createSql'];
		own<T>(operation: () => Promise<T>): Promise<T>;
	}>): ReturnType<typeof createObservedPrivateCompleteTextHolderV384>;
}>;

class HolderRequestStopped extends Error {
	constructor(readonly status: 499 | 504) { super('Private holder request stopped'); }
}
class HolderRequestRejected extends Error {
	constructor(readonly status: 400 | 413) { super('Private holder request rejected'); }
}

function rejected(status: number): Response {
	return Response.json({ error: 'holder_request_unavailable' }, {
		status, headers: { 'Cache-Control': 'no-store' },
	});
}

/** Own real outstanding operations through response end; never race SQL writes. */
function lifetime(request: Request, milliseconds: number, ctx: WorkerContext) {
	const controller = new AbortController();
	const pending = new Set<Promise<unknown>>();
	let finished = false;
	let cleanupUnconfirmed = false;
	let end!: () => void;
	const ended = new Promise<void>(resolve => { end = resolve; });
	const stop = () => controller.abort(new HolderRequestStopped(499));
	const timer = setTimeout(() => controller.abort(new HolderRequestStopped(504)), milliseconds);
	request.signal.addEventListener('abort', stop, { once: true });
	if (request.signal.aborted) stop();
	function ensureLive(): void {
		controller.signal.throwIfAborted();
		if (finished) throw new HolderRequestStopped(499);
	}
	function own<T>(operation: () => Promise<T>, requireLive = true): Promise<T> {
		if (requireLive) ensureLive();
		// Start now: cleanup must begin before finish aborts the fetch signal.
		const task = (async () => {
			if (requireLive) ensureLive();
			return operation();
		})();
		pending.add(task);
		void task.then(() => pending.delete(task), error => {
			pending.delete(task);
			if (!requireLive || (error instanceof Error && error.name.includes('CleanupUnconfirmed')))
				cleanupUnconfirmed = true;
		});
		return task;
	}
	function finish(): void {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		request.signal.removeEventListener('abort', stop);
		// Also stops v365's private renewal timer after EOF/error/cancel.
		if (!controller.signal.aborted) controller.abort(new HolderRequestStopped(499));
		end();
	}
	ctx.waitUntil(ended.then(async () => {
		while (pending.size > 0) await Promise.allSettled([...pending]);
		if (cleanupUnconfirmed) console.warn(JSON.stringify({
			event: 'private_holder_cleanup_unconfirmed', version: 390,
		}));
	}));
	return { signal: controller.signal, ensureLive, own, finish };
}
type Lifetime = ReturnType<typeof lifetime>;

async function readEnvelope(request: Request, owner: Lifetime): Promise<ChatTextHolderRequestV363> {
	const declared = request.headers.get('Content-Length');
	if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_ENVELOPE_BYTES))
		throw new HolderRequestRejected(413);
	if (!request.body) throw new HolderRequestRejected(400);
	const reader = request.body.getReader();
	let done = false;
	let cancellation: Promise<void> | undefined;
	const cancel = () => cancellation ??= owner.own(() => reader.cancel(), false);
	const onAbort = () => { void cancel().catch(() => undefined); };
	owner.signal.addEventListener('abort', onAbort, { once: true });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			owner.ensureLive();
			const part = await reader.read();
			owner.ensureLive();
			if (part.done) { done = true; break; }
			size += part.value.byteLength;
			if (size > MAX_ENVELOPE_BYTES) throw new HolderRequestRejected(413);
			chunks.push(part.value);
		}
	} finally {
		owner.signal.removeEventListener('abort', onAbort);
		if (done) reader.releaseLock();
		else void cancel().finally(() => reader.releaseLock()).catch(() => undefined);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	let parsed: unknown;
	try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
	catch { throw new HolderRequestRejected(400); }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HolderRequestRejected(400);
	const row = parsed as Record<string, unknown>;
	if (Object.keys(row).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(row, key))
		|| typeof row.requestId !== 'string' || row.requestId.length < 1 || row.requestId.length > 128
		|| typeof row.quoteId !== 'string' || !UUID.test(row.quoteId)
		|| typeof row.attemptNonce !== 'string' || !UUID.test(row.attemptNonce)
		|| typeof row.candidateIndex !== 'number' || !Number.isSafeInteger(row.candidateIndex)
		|| row.candidateIndex < 0 || row.candidateIndex > 7
		|| typeof row.routeTargetId !== 'string' || encoder.encode(row.routeTargetId).length < 1
		|| encoder.encode(row.routeTargetId).length > 256
		|| typeof row.finalBodyUtf8 !== 'string' || encoder.encode(row.finalBodyUtf8).length < 2
		|| encoder.encode(row.finalBodyUtf8).length > MAX_FINAL_BYTES) throw new HolderRequestRejected(400);
	return Object.freeze({ requestId: row.requestId, quoteId: row.quoteId,
		attemptNonce: row.attemptNonce, candidateIndex: row.candidateIndex,
		routeTargetId: row.routeTargetId, finalBodyUtf8: row.finalBodyUtf8 });
}

function connections(env: CompleteTextHolderV390Env) {
	const bindings = [env.COMPLETE_TEXT_READER, env.COMPLETE_TEXT_GRANTER,
		env.COMPLETE_TEXT_HOLDER, env.COMPLETE_TEXT_RENEWER];
	if (bindings.some(binding => !binding?.connectionString)
		|| new Set(bindings.map(binding => binding.connectionString)).size !== 4
		|| typeof env.PROVIDER_KEY_ENCRYPTION_SECRET !== 'string'
		|| env.PROVIDER_KEY_ENCRYPTION_SECRET.length < 16) throw new Error('Private bindings invalid');
	return {
		reader: createHyperdriveDedicatedRoleTransportV390(env.COMPLETE_TEXT_READER,
			'cinatoken_gateway_complete_text_private_reader'),
		granter: createHyperdriveDedicatedRoleTransportV390(env.COMPLETE_TEXT_GRANTER,
			'cinatoken_gateway_complete_text_attempt_granter'),
		holder: createHyperdriveDedicatedRoleTransportV390(env.COMPLETE_TEXT_HOLDER,
			'cinatoken_gateway_complete_text_send_holder'),
		renewer: createHyperdriveDedicatedRoleTransportV390(env.COMPLETE_TEXT_RENEWER,
			'cinatoken_gateway_complete_text_hold_renewer'),
	};
}

/** Stream only the raw accepted body; headers and errors stay private/sanitized. */
function deliver(response: Response, owner: Lifetime): Response {
	if (!response.body) throw new Error('Private holder response body missing');
	const reader = response.body.getReader();
	let terminal = false;
	let target: ReadableStreamDefaultController<Uint8Array>;
	const cancelReader = (reason?: unknown) => owner.own(() => reader.cancel(reason), false)
		.finally(() => reader.releaseLock());
	const finish = () => {
		terminal = true;
		owner.signal.removeEventListener('abort', onAbort);
		owner.finish();
	};
	const onAbort = () => {
		if (terminal) return;
		terminal = true;
		target.error(new Error('Private holder stream stopped'));
		void cancelReader().catch(() => undefined);
		finish();
	};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			target = controller;
			owner.signal.addEventListener('abort', onAbort, { once: true });
			if (owner.signal.aborted) onAbort();
		},
		async pull(controller) {
			if (terminal) return;
			try {
				owner.ensureLive();
				const part = await reader.read();
				if (terminal) return;
				owner.ensureLive();
				if (part.done) { reader.releaseLock(); finish(); controller.close(); }
				else controller.enqueue(part.value);
			} catch {
				if (!terminal) {
					controller.error(new Error('Private holder stream unavailable'));
					// A rejected read already confirms an errored source stream.
					reader.releaseLock();
					finish();
				}
			}
		},
		cancel(reason) {
			if (terminal) return;
			terminal = true;
			owner.signal.removeEventListener('abort', onAbort);
			const pending = cancelReader(reason);
			return pending.finally(finish);
		},
	}, { highWaterMark: 0 });
	return new Response(body, { status: 200, headers: {
		'Content-Type': response.headers.get('Content-Type')!.toLowerCase().split(';', 1)[0]!,
		'Cache-Control': 'no-store',
	} });
}

export function createCompleteTextHolderWorkerV390(options: CompleteTextHolderWorkerOptionsV390 = {},
	composition?: CompleteTextHolderWorkerCompositionV390) {
	const createHolder = composition?.createHolder ?? createObservedPrivateCompleteTextHolderV384;
	if (typeof createHolder !== 'function') throw new TypeError('Private holder composition invalid');
	const maxRequestMs = options.maxRequestMs ?? MAX_REQUEST_MS;
	const maxUnrenewedStreamMs = options.maxUnrenewedStreamMs ?? MAX_LEASE_MS;
	if (!Number.isSafeInteger(maxRequestMs) || maxRequestMs < 1 || maxRequestMs > MAX_REQUEST_MS
		|| !Number.isSafeInteger(maxUnrenewedStreamMs) || maxUnrenewedStreamMs < 1
		|| maxUnrenewedStreamMs > MAX_LEASE_MS) throw new TypeError('Private holder local bound invalid');
	return Object.freeze({
		async fetch(request: Request, env: CompleteTextHolderV390Env, ctx: WorkerContext): Promise<Response> {
			const owner = lifetime(request, maxRequestMs, ctx);
			let response: Response | undefined;
			let handedOff = false;
			try {
				if (env.COMPLETE_TEXT_HOLDER_ENABLED !== 'reviewed-v1') return rejected(503);
				const url = new URL(request.url);
				if (url.origin !== 'https://holder.service.invalid' || url.pathname !== '/complete-text-attempt'
					|| url.search || url.hash || request.method !== 'POST') return rejected(404);
				if (request.headers.get('Content-Type') !== 'application/json') return rejected(415);
				const requestEnvelope = await readEnvelope(request, owner);
				owner.ensureLive();
				const db = connections(env);
				const read = createPostgresPrivateCompleteTextReadPortsV366({
					readerConnectionString: db.reader.roleConnectionString, request: requestEnvelope,
				}, db.reader.createSql);
				const holder = createHolder({
					providerEncryptionSecret: env.PROVIDER_KEY_ENCRYPTION_SECRET,
					loadQuote: id => owner.own(() => read.loadQuote(id)),
					loadRoute: input => owner.own(() => read.loadRoute(input)),
					loadProviderCiphertext: id => owner.own(() => read.loadProviderCiphertext(id)),
					grantAttempt: (attemptNonce, claim) => owner.own(() => grantPostgresCompleteTextAttemptV362({
						granterConnectionString: db.granter.roleConnectionString, attemptNonce, claim }, db.granter.createSql)),
					claimSendCustody: (grantId, holderRunId) => owner.own(() => claimPostgresCompleteTextCustodyV365({
						holderConnectionString: db.holder.roleConnectionString, grantId, holderRunId }, db.holder.createSql)),
					recordSendStart: (grantId, holderRunId, expectedEpoch, uploadSha256) => owner.own(() =>
						recordPostgresCompleteTextSendStartV365({ holderConnectionString: db.holder.roleConnectionString,
							grantId, holderRunId, expectedEpoch, uploadSha256 }, db.holder.createSql)),
					renewHolds: (grantId, holderRunId, sendStartId, expectedEpoch) => owner.own(() =>
						renewPostgresCompleteTextHoldsV367({ renewerConnectionString: db.renewer.roleConnectionString,
							grantId, holderRunId, sendStartId, expectedEpoch }, db.renewer.createSql)),
					appendFetchInvokedFact: input => owner.own(() => appendPostgresCompleteTextHolderFactV367({
						holderConnectionString: db.holder.roleConnectionString, ...input }, db.holder.createSql)),
					fetchUpstream: (url, init) => {
						owner.ensureLive();
						return (options.fetchUpstream ?? fetch)(url, init);
					},
					maxUnrenewedStreamMs,
				}, Object.freeze({ connectionString: db.holder.roleConnectionString,
					createSql: db.holder.createSql,
					own: <T>(operation: () => Promise<T>) => owner.own(operation),
				}));
				response = await holder.run(requestEnvelope, owner.signal);
				owner.ensureLive();
				const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
				if (response.status !== 200 || !response.body
					|| !/^(application\/json|text\/event-stream)(;|$)/u.test(contentType))
					throw new Error('Private holder response unavailable');
				const delivery = deliver(response, owner);
				response = undefined;
				handedOff = true;
				return delivery;
			} catch (error) {
				return rejected(error instanceof HolderRequestStopped || error instanceof HolderRequestRejected
					? error.status : 502);
			} finally {
				// Successful delivery owns the response and finishes on EOF/error/cancel.
				// An error response must release any body that was never handed over.
				if (response) void owner.own(() => response!.body?.cancel() ?? Promise.resolve(), false)
					.catch(() => undefined);
				if (!request.bodyUsed && request.body && !request.body.locked)
					void owner.own(() => request.body!.cancel(), false).catch(() => undefined);
				if (!handedOff) owner.finish();
			}
		},
	});
}

export default createCompleteTextHolderWorkerV390() satisfies ExportedHandler<CompleteTextHolderV390Env>;
