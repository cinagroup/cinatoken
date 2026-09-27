import type { UsageRecoveryControlEnv } from '../../scripts/staging/usage-recovery-control-env';

const PATH = '/_control/usage-recovery/run';
const COMMAND = 'run-once-v1';
const COUNTERS = ['scanned', 'claimed', 'committed', 'blocked', 'deferred', 'lostOwnership', 'uncertain', 'skipped'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const RECOVERY_COMMAND_BODY_TIMEOUT_MS = 1000;

function response(status: number, value: object): Response {
	return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function unknownOutcome(): Response {
	// Transport failure cannot prove that the receiver did not commit. Never retry here.
	return response(502, { status: 'outcome_unknown', retry_safe: false });
}
function commandIssue(request: Request): string | undefined {
	// Fixed categories only, after Access authorization. Never echo headers or bodies.
	if (request.headers.has('Origin')) return 'browser_origin';
	if (request.headers.get('X-CinaToken-Recovery-Command') !== COMMAND) return 'command_header';
	if (request.headers.has('Transfer-Encoding')) return 'transfer_encoding';
	if (![null, '0'].includes(request.headers.get('Content-Length'))) return 'content_length';
	return undefined;
}

type EmptyBodyResult = 'empty' | 'body_not_empty' | 'body_unreadable' | 'body_not_byte_stream' | 'command_timeout' | 'cancelled_before_dispatch';
export async function verifyEmptyBody(request: Request): Promise<EmptyBodyResult> {
	if (request.bodyUsed) return 'body_unreadable';
	if (request.body === null) return 'empty';
	if (request.body.locked) return 'body_unreadable';
	let reader: ReadableStreamBYOBReader;
	try { reader = request.body.getReader({ mode: 'byob' }); }
	catch { return 'body_not_byte_stream'; }
	// Incoming Workers HTTP bodies are byte streams. Never fall back to an
	// unbounded default-reader chunk, text(), clone(), drain or header-only trust.
	let stopped: 'command_timeout' | 'cancelled_before_dispatch' | undefined;
	let cancellation: Promise<void> | undefined;
	let eof = false;
	const cancel = () => {
		cancellation ??= Promise.resolve().then(() => reader.cancel('recovery_command_rejected')).catch(() => undefined);
	};
	const stop = (reason: 'command_timeout' | 'cancelled_before_dispatch') => {
		stopped ??= reason;
		cancel();
	};
	const onAbort = () => stop('cancelled_before_dispatch');
	const timer = setTimeout(() => stop('command_timeout'), RECOVERY_COMMAND_BODY_TIMEOUT_MS);
	request.signal.addEventListener('abort', onAbort, { once: true });
	try {
		if (request.signal.aborted) onAbort();
		if (stopped) return stopped;
		// A single one-byte BYOB read: only genuine EOF proves zero wire bytes.
		const part = await reader.read(new Uint8Array(1));
		if (stopped) return stopped; // cancel-induced done=true is NOT successful EOF.
		if (part.value?.byteLength !== 0 || part.done !== true) return 'body_not_empty';
		eof = true;
		return 'empty';
	} catch { return stopped ?? 'body_unreadable'; }
	finally {
		clearTimeout(timer);
		request.signal.removeEventListener('abort', onAbort);
		if (!eof) cancel();
		// Do not free the isolate gate on a timer while read/cancel is still alive.
		if (cancellation) await cancellation;
		try { reader.releaseLock(); }
		catch { return 'body_unreadable'; }
	}
}
function projectResult(value: unknown): Response {
	if (!object(value)) return unknownOutcome();
	if (value.status !== 'finished') {
		if (typeof value.status === 'string' && ['disabled', 'invalid_configuration', 'profile_changed', 'busy', 'host_rejected', 'invalid_arguments'].includes(value.status)) {
			return response(503, { status: 'recovery_unavailable', retry_safe: false });
		}
		return unknownOutcome();
	}
	if (typeof value.runId !== 'string' || value.runId.length !== 36 || !UUID.test(value.runId) || !object(value.result)) return unknownOutcome();
	const result: Record<string, number | boolean> = {};
	// Do not enumerate/spread/stringify the RPC object or inspect unknown audit fields.
	for (const key of COUNTERS) {
		const count = value.result[key];
		if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 50) return unknownOutcome();
		result[key] = count;
	}
	for (const key of ['capacityLimited', 'admissionStopped'] as const) {
		const flag = value.result[key];
		if (typeof flag !== 'boolean') return unknownOutcome();
		result[key] = flag;
	}
	if (Number(result.committed) > Number(result.claimed) || Number(result.claimed) > Number(result.scanned)) return unknownOutcome();
	// finished means one invocation ended, not that every job was settled successfully.
	return response(200, { status: 'finished', runId: value.runId, result, retry_safe: false });
}

/** Dedicated machine-only control surface. The only cross-request state is a scalar busy gate. */
export function createUsageRecoveryControl() {
	let active = false;
	return {
		fetch(request: Request, env: UsageRecoveryControlEnv, ctx: Pick<ExecutionContext, 'access' | 'waitUntil'>): Promise<Response> {
			let url: URL;
			try {
				if (request.url.length > 2048) throw new TypeError();
				url = new URL(request.url);
			} catch { return Promise.resolve(response(404, { status: 'not_found' })); }
			if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== PATH || url.search || url.hash || request.method !== 'POST') {
				return Promise.resolve(response(404, { status: 'not_found' }));
			}
			if (env.RECOVERY_CONTROL_ENVIRONMENT !== 'staging' || env.RECOVERY_CONTROL_ENABLED !== 'true') {
				return Promise.resolve(response(503, { status: 'control_disabled' }));
			}
			const audience = env.RECOVERY_CONTROL_ACCESS_AUD;
			if (typeof audience !== 'string' || !/^[0-9a-f]{64}$/.test(audience)) {
				return Promise.resolve(response(503, { status: 'invalid_configuration' }));
			}
			// Native runtime context only. Access does not propagate over Service Bindings.
			// Audience is public metadata; the dedicated Access policy supplies authorization.
			if (!ctx.access || ctx.access.aud !== audience) return Promise.resolve(response(403, { status: 'forbidden' }));
			// No browser flow/CORS and no caller-selected tenant, IDs, limits or payload.
			// This constant header is a command-shape/CSRF check, NOT an authentication secret.
			const issue = commandIssue(request);
			if (issue !== undefined) {
				return Promise.resolve(response(400, { status: 'invalid_command', reason: issue }));
			}
			if (request.signal.aborted) return Promise.resolve(response(409, { status: 'cancelled_before_dispatch' }));
			if (active) return Promise.resolve(response(503, { status: 'control_busy' }));
			const service = env.USAGE_RECOVERY;
			active = true;
			let registered = false;
			const task = Promise.resolve().then(async () => {
				if (!registered) return response(503, { status: 'host_rejected' });
				if (request.signal.aborted) return response(409, { status: 'cancelled_before_dispatch' });
				const body = await verifyEmptyBody(request);
				if (request.signal.aborted || body === 'cancelled_before_dispatch') return response(409, { status: 'cancelled_before_dispatch' });
				if (body === 'command_timeout') return response(408, { status: 'command_timeout' });
				if (body !== 'empty') return response(400, { status: 'invalid_command', reason: body });
				try { return projectResult(await service.run()); }
				catch { return unknownOutcome(); }
			}).finally(() => { active = false; });
			// Register before any body read or RPC. No waiter queue or automatic retry.
			// After dispatch, disconnect/disable cannot imply D1 cancellation or release this gate.
			try { ctx.waitUntil(task.then(() => undefined)); registered = true; }
			catch { /* Queued task observes registered=false, with zero downstream calls. */ }
			return task;
		},
	};
}
