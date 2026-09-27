import postgres from 'postgres';
import type { PostgresDatabaseClient, RoutePoolStickyBindingRow } from '@octafuse/core';
import type { CredentialFreeStickyContextV398 } from './credential-free-route-attempts-v398';
import type { StickyRoutingPorts } from './provider-sticky-routing';

type Sql = PostgresDatabaseClient['raw'];
type Factory = (url: string, options: { max: 1 }) => Sql;
const LOGIN = 'cinatoken_gateway_complete_text_sticky_router';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
function invalid(): never { throw new TypeError('Invalid quote-bound sticky routing v398'); }
function text(value: unknown, max = 256): string {
	if (typeof value !== 'string' || !value || value.trim() !== value || new TextEncoder().encode(value).length > max) invalid();
	return value;
}
function object(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys) invalid();
	return value as Record<string, unknown>;
}
const open: Factory = url => postgres(url, { max: 1, prepare: false, fetch_types: false,
	connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false });
export class PostgresStickyCleanupUnconfirmedV398 extends Error {
	constructor(cause: unknown) { super('PostgreSQL quote-bound sticky cleanup unconfirmed', { cause }); this.name = 'PostgresStickyCleanupUnconfirmedV398'; }
}

/** Narrow CAS port. Database proofs authorize writes and derive the idle expiry. */
export function createPostgresCompleteTextStickyRoutingV398(params: {
	stickyConnectionString: string; context: CredentialFreeStickyContextV398; signal?: AbortSignal;
}, factory: Factory = open): StickyRoutingPorts {
	const connectionString = params.stickyConnectionString, signal = params.signal;
	const url = new URL(connectionString);
	if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password || !url.hostname
		|| url.hash || url.pathname === '/' || [...url.searchParams].some(([key, value]) => key !== 'sslmode' || !['disable', 'require'].includes(value))) invalid();
	const c = params.context;
	if (!c || !UUID.test(c.quoteId) || !SHA.test(c.finalBodySha256) || !SHA.test(c.affinityHash)
		|| !/^[1-9][0-9]{0,18}$/u.test(c.routingEpoch) || BigInt(c.routingEpoch) > 9223372036854775806n
		|| !Number.isSafeInteger(c.candidateIndex) || c.candidateIndex < 0 || c.candidateIndex > 7
		|| typeof c.sessionControlled !== 'boolean' || ![null, 'cache_hit', 'stream_success'].includes(c.successPolicy)
		|| (c.sessionControlled !== (c.successPolicy !== null))) invalid();
	const context = Object.freeze({ quoteId: c.quoteId, requestId: text(c.requestId, 128), finalBodySha256: c.finalBodySha256,
		routingEpoch: c.routingEpoch, candidateIndex: c.candidateIndex, routePoolId: text(c.routePoolId), affinityHash: c.affinityHash,
		sessionControlled: c.sessionControlled, successPolicy: c.successPolicy });
	const ensureLive = () => signal?.throwIfAborted();
	const matches = (pool: string, hash: string) => { if (pool !== context.routePoolId || hash !== context.affinityHash) invalid(); };
	async function action(kind: 'get' | 'bind' | 'touch' | 'clear', target: string | null, token: string | null, expected: string | null): Promise<unknown> {
		ensureLive();
		const sql = factory(connectionString, { max: 1 }); let result: unknown, failure: unknown;
		try {
			result = await sql.begin(async tx => {
				ensureLive();
				const roles = await tx.unsafe("SELECT current_user AS current_role,session_user AS session_role,current_setting('transaction_isolation') AS isolation");
				if (roles.length !== 1 || roles[0]?.current_role !== LOGIN || roles[0]?.session_role !== LOGIN || roles[0]?.isolation !== 'read committed') invalid();
				await tx.unsafe("SET LOCAL lock_timeout='2s'"); await tx.unsafe("SET LOCAL statement_timeout='15s'"); ensureLive();
				const rows = await tx.unsafe('SELECT cinatoken_gateway.complete_text_sticky_action_v398($1::uuid,$2::text,$3::text,$4::bigint,$5::integer,$6::text,$7::text,$8::boolean,$9::text,$10::text,$11::text,$12::text,$13::text) AS value',
					[context.quoteId, context.requestId, context.finalBodySha256, context.routingEpoch, context.candidateIndex,
						context.routePoolId, context.affinityHash, context.sessionControlled, context.successPolicy, kind, target, token, expected]);
				ensureLive(); if (rows.length !== 1) invalid();
				if (kind === 'get') {
					const value = object(rows[0]?.value, 'binding,status'); if (value.status !== 'sticky_checked') invalid();
					if (value.binding === null) return null;
					const row = object(value.binding, 'affinity_hash,binding_token,created_at,expires_at,pool_epoch,route_pool_id,route_target_id,updated_at');
					if (row.route_pool_id !== context.routePoolId || row.affinity_hash !== context.affinityHash
						|| !Number.isSafeInteger(row.pool_epoch)) invalid();
					for (const field of ['created_at', 'expires_at', 'updated_at']) if (typeof row[field] !== 'string' || !Number.isFinite(Date.parse(row[field] as string))) invalid();
					return Object.freeze({ route_pool_id: context.routePoolId, affinity_hash: context.affinityHash,
						route_target_id: text(row.route_target_id), binding_token: text(row.binding_token), pool_epoch: row.pool_epoch as number,
						created_at: row.created_at as string, expires_at: row.expires_at as string, updated_at: row.updated_at as string }) satisfies RoutePoolStickyBindingRow;
				}
				const value = object(rows[0]?.value, 'changed,status');
				if (value.status !== 'sticky_mutated' || typeof value.changed !== 'boolean') invalid();
				return value.changed;
			});
		} catch (error) { failure = error; }
		try { const acknowledgement = sql.end({ timeout: 1 }); if (!acknowledgement || typeof acknowledgement.then !== 'function') invalid(); await acknowledgement; }
		catch (error) { throw new PostgresStickyCleanupUnconfirmedV398(failure === undefined ? error : new AggregateError([failure, error])); }
		if (failure !== undefined) throw failure;
		ensureLive(); return result;
	}
	const routePoolSticky: StickyRoutingPorts['routePoolSticky'] = {
		async getBinding(pool, hash) { matches(pool, hash); return await action('get', null, null, null) as RoutePoolStickyBindingRow | null; },
		async tryBind(p) {
			matches(p.routePoolId, p.affinityHash); const target = text(p.routeTargetId), token = text(p.bindingToken);
			if (!UUID.test(token)) invalid(); const expected = p.expectedToken ? text(p.expectedToken) : null;
			return await action('bind', target, token, expected) as boolean;
		},
		async touchBinding(p) { matches(p.routePoolId, p.affinityHash); return await action('touch', null, null, text(p.expectedToken)) as boolean; },
		async clearBinding(p) { matches(p.routePoolId, p.affinityHash); return await action('clear', null, null, text(p.expectedToken)) as boolean; },
	};
	return Object.freeze({ routePoolSticky: Object.freeze(routePoolSticky) });
}
