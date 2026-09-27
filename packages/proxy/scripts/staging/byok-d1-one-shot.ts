import type { D1Database, ExecutionContext } from '@cloudflare/workers-types';
import { timingSafeEqual } from 'node:crypto';
import { BYOK_D1_CASES, runByokD1Case } from './byok-d1-acceptance';
import { guardByokD1 } from './byok-d1-guard';

/** NOT connected to a deployed entrypoint. The operator must verify the exact
 * staging binding/closed baseline, reserve costs, INSERT one control row, and
 * protect the existing Worker with Access before exposing this handler.
 * No provisioning, reset, deletion, arbitrary SQL or inference endpoint.
 */
export const BYOK_D1_CONTROL_KEY = 'c02_byok_d1_acceptance_v1';
export const BYOK_D1_ORIGIN = 'https://cinatoken-proxy-staging.cinagroup.workers.dev';
const prefix = '/__staging/byok-d1/';
const maxControlBytes = 32_768;
type CaseResult = Awaited<ReturnType<typeof runByokD1Case>>;
type Counters = ReturnType<ReturnType<typeof guardByokD1>['snapshot']>;
type Receipt = { caseId: typeof BYOK_D1_CASES[number]; outcome: 'PASS' | 'FAIL';
	completedAt: number; result: CaseResult | null; counters: Counters };
type Control = { version: 1; runId: string; tokenHash: string; issuedAt: number; expiresAt: number;
	state: 'ready' | 'pending' | 'failed' | 'done' | 'stopped'; cursor: number;
	pendingCase: typeof BYOK_D1_CASES[number] | null; receipts: Receipt[] };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]) {
	return Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function validCounters(value: unknown): value is Counters {
	return isObject(value) && exact(value, ['statements', 'calls', 'active', 'peakActive',
		'acknowledgedRowsRead', 'acknowledgedRowsWritten', 'callsWithoutRowMetadata', 'nativeRejectedCalls'])
		&& Object.values(value).every(n => integer(n)) && value.active === 0
		&& integer(value.statements, 200) && integer(value.calls, 200) && integer(value.peakActive, 2)
		&& Number(value.callsWithoutRowMetadata) <= Number(value.calls)
		&& Number(value.nativeRejectedCalls) <= Number(value.callsWithoutRowMetadata);
}
function validResult(value: unknown, caseId: string): value is CaseResult {
	return isObject(value) && exact(value, ['caseId', 'result', 'expectedAudits', 'batches', 'midBatchWallClockExpiryVerified'])
		&& value.caseId === caseId && value.result === 'PASS' && integer(value.expectedAudits, 8)
		&& value.midBatchWallClockExpiryVerified === false && Array.isArray(value.batches) && value.batches.length <= 8
		&& value.batches.every(b => Array.isArray(b) && b.length <= 8 && b.every(m => isObject(m)
			&& exact(m, ['changes', 'rowsRead', 'rowsWritten']) && Object.values(m).every(n => integer(n))));
}
export function parseByokD1Control(raw: string): Control {
	if (raw.length > maxControlBytes || !/^[\x20-\x7e]+$/.test(raw)) throw new Error('byok_control_encoding');
	const v: unknown = JSON.parse(raw);
	if (!isObject(v) || !exact(v, ['version', 'runId', 'tokenHash', 'issuedAt', 'expiresAt', 'state', 'cursor', 'pendingCase', 'receipts'])
		|| v.version !== 1 || typeof v.runId !== 'string' || !/^c02-byok-[a-f0-9]{12}$/.test(v.runId)
		|| typeof v.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.tokenHash)
		|| !integer(v.issuedAt) || !integer(v.expiresAt) || v.expiresAt <= v.issuedAt || v.expiresAt - v.issuedAt > 900
		|| !integer(v.cursor, BYOK_D1_CASES.length) || !Array.isArray(v.receipts) || v.receipts.length > BYOK_D1_CASES.length)
		throw new Error('byok_control_shape');
	const receipts: Receipt[] = [];
	for (let i = 0; i < v.receipts.length; i++) {
		const r: unknown = v.receipts[i], id = BYOK_D1_CASES[i];
		if (!id || !isObject(r) || !exact(r, ['caseId', 'outcome', 'completedAt', 'result', 'counters'])
			|| r.caseId !== id || !integer(r.completedAt) || r.completedAt < v.issuedAt || !validCounters(r.counters)
			|| (r.outcome !== 'PASS' && r.outcome !== 'FAIL')
			|| (r.outcome === 'PASS' ? !validResult(r.result, id) : r.result !== null)
			|| (r.outcome === 'FAIL' && i !== v.receipts.length - 1)) throw new Error('byok_control_receipt');
		receipts.push({ caseId: id, outcome: r.outcome, completedAt: r.completedAt,
			result: validResult(r.result, id) ? r.result : null, counters: r.counters });
	}
	const allPass = receipts.every(r => r.outcome === 'PASS');
	const idle = v.pendingCase === null && receipts.length === v.cursor && allPass;
	const pending = v.cursor < BYOK_D1_CASES.length && v.pendingCase === BYOK_D1_CASES[v.cursor]
		&& receipts.length === v.cursor && allPass;
	const failed = v.pendingCase === null && v.cursor < BYOK_D1_CASES.length && receipts.length === v.cursor + 1
		&& receipts.at(-1)?.outcome === 'FAIL' && receipts.slice(0, -1).every(r => r.outcome === 'PASS');
	if (!(v.state === 'ready' && idle && v.cursor < BYOK_D1_CASES.length
		|| v.state === 'pending' && pending || v.state === 'done' && idle && v.cursor === BYOK_D1_CASES.length
		|| v.state === 'failed' && failed || v.state === 'stopped' && (idle || pending || failed)))
		throw new Error('byok_control_state');
	return { version: 1, runId: v.runId, tokenHash: v.tokenHash, issuedAt: v.issuedAt, expiresAt: v.expiresAt,
		state: v.state as Control['state'], cursor: v.cursor,
		pendingCase: pending ? BYOK_D1_CASES[v.cursor]! : null, receipts };
}
function serialize(control: Control) { const raw = JSON.stringify(control); parseByokD1Control(raw); return raw; }
function response(status: number, code: string, receipt?: Receipt) {
	return Response.json({ code, ...(receipt ? { receipt } : {}) }, { status, headers: { 'Cache-Control': 'no-store' } });
}
async function swap(db: D1Database, before: string, after: string, admission: boolean) {
	const result = await db.prepare(`UPDATE system_config SET value = ?, updated_at = datetime('now')
		WHERE key = ? AND value = ?${admission ? " AND unixepoch('now') >= json_extract(value, '$.issuedAt') AND unixepoch('now') < json_extract(value, '$.expiresAt')" : ''}`)
		.bind(after, BYOK_D1_CONTROL_KEY, before).run();
	if (!result.success || !integer(result.meta.changes, 1)) throw new Error('byok_control_ack');
	return result.meta.changes === 1;
}
async function execute(request: Request, db: D1Database, action: string, bearer: string) {
	try {
		// SQL-side length filter prevents pulling an unbounded configuration value
		// into the Worker. This row alone is not proof of the database's identity.
		const row = await db.prepare('SELECT value FROM system_config WHERE key = ? AND length(CAST(value AS BLOB)) <= ?')
			.bind(BYOK_D1_CONTROL_KEY, maxControlBytes).first<{ value: string }>();
		if (!row || typeof row.value !== 'string') return response(404, 'not_available');
		const current = parseByokD1Control(row.value);
		const expected = Uint8Array.from(current.tokenHash.match(/../g)!, h => Number.parseInt(h, 16));
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bearer)));
		if (!timingSafeEqual(expected, digest)) return response(404, 'not_available');
		if (action === 'stop') {
			if (current.state === 'stopped') return response(409, 'already_stopped');
			// May be used after expiry. Stops NEW cases only; neither a timed-out
			// request nor this acknowledgement proves existing D1 work has stopped.
			const stopped = serialize({ ...current, state: 'stopped' });
			return await swap(db, row.value, stopped, false) ? response(200, 'admissions_stopped') : response(409, 'state_changed');
		}
		if (current.state !== 'ready' || BYOK_D1_CASES[current.cursor] !== action) return response(409, 'not_admissible');
		if (request.signal.aborted) return response(409, 'cancelled_before_claim');
		const caseId = BYOK_D1_CASES[current.cursor]!;
		const pending: Control = { ...current, state: 'pending', pendingCase: caseId };
		const pendingRaw = serialize(pending);
		if (!await swap(db, row.value, pendingRaw, true)) return response(409, 'claim_rejected');
		// The claim is durable before any fixture write. Once admitted, disconnect
		// does not trigger cleanup/replay. The bounded case drains its own calls.
		const guarded = guardByokD1(db);
		let result: CaseResult | null = null;
		try { result = await runByokD1Case(guarded.db, current.runId, caseId); }
		catch { /* No raw SQL/errors/parameters in receipts or responses. */ }
		finally { guarded.seal(); }
		const counters = guarded.snapshot();
		if (counters.active !== 0) return response(503, 'pending_unresolved');
		const receipt: Receipt = { caseId, outcome: result ? 'PASS' : 'FAIL',
			completedAt: Math.floor(Date.now() / 1000), result, counters };
		const cursor = current.cursor + (result ? 1 : 0);
		const completed: Control = { ...current, state: result ? (cursor === BYOK_D1_CASES.length ? 'done' : 'ready') : 'failed',
			cursor, pendingCase: null, receipts: [...current.receipts, receipt] };
		if (!await swap(db, pendingRaw, serialize(completed), false)) return response(503, 'pending_unresolved');
		return response(result ? 200 : 500, result ? 'case_pass' : 'case_failed', receipt);
	} catch { return response(503, 'pending_unresolved'); }
}

export function handleByokD1OneShot(request: Request, db: D1Database, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
	const url = new URL(request.url), action = url.pathname.slice(prefix.length);
	if (url.origin !== BYOK_D1_ORIGIN || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)
		|| (action !== 'stop' && !BYOK_D1_CASES.some(id => id === action))) return Promise.resolve(response(404, 'not_available'));
	if (request.method !== 'POST' || request.body !== null) return Promise.resolve(response(400, 'empty_post_required'));
	const authorization = request.headers.get('Authorization') ?? '';
	if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) return Promise.resolve(response(404, 'not_available'));
	if (request.signal.aborted) return Promise.resolve(response(409, 'cancelled_before_claim'));
	// Register lifetime ownership before the first DB I/O. Registration failure
	// resolves the gate to false, so even a synchronous throw cannot start work.
	let release!: (allowed: boolean) => void;
	const gate = new Promise<boolean>(resolve => { release = resolve; });
	const task = gate.then(allowed => allowed ? execute(request, db, action, authorization.slice(7)) : response(503, 'lifetime_unavailable'));
	try { ctx.waitUntil(task.then(() => {})); release(true); }
	catch { release(false); }
	return task;
}
