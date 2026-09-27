import postgres from 'postgres';
import type { PostgresDatabaseClient } from '@octafuse/core';
import type { FinalChatQuoteSnapshot } from './chat-final-quote-input';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';
import type { RouteResult } from './model-router';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlFactory = (connection: string, options: { max: 1 }) => SqlClient;
type Statement = Pick<SqlClient, 'unsafe'>;
const LOGIN = 'cinatoken_gateway_complete_text_ingress_planner';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

export type SecretlessCompleteTextRouteV391 = Readonly<{
	candidateIndex: number;
	modelId: string;
	routeTargetId: string;
	sourceGeneration: string;
	attestedSourceSha256: string;
}>;

/** A committed quote's current projection; it is neither a send grant nor a lease. */
export type SecretlessCompleteTextPlanV391 = Readonly<{
	requestId: string;
	quoteId: string;
	finalBodySha256: string;
	modelIds: readonly string[];
	routeCount: number;
	expiresAt: string;
	routes: readonly SecretlessCompleteTextRouteV391[];
}>;

export class PostgresCompleteTextPlanRejectedV391 extends Error {
	constructor(readonly status: 'not_found' | 'stale' | 'invalid_manifest' | 'stale_manifest') {
		super(`PostgreSQL secretless complete text plan ${status}`);
		this.name = 'PostgresCompleteTextPlanRejectedV391';
	}
}
export class PostgresCompleteTextPlanCleanupUnconfirmedV391 extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL secretless planner LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresCompleteTextPlanCleanupUnconfirmedV391';
	}
}

function invalid(): never { throw new TypeError('PostgreSQL secretless complete text plan invalid'); }
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string): void {
	if (Object.keys(value).sort().join(',') !== expected) invalid();
}
function bounded(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.trim() === value
		&& encoder.encode(value).length > 0 && encoder.encode(value).length <= max;
}
function connection(value: string): string {
	let url: URL;
	try { url = new URL(value); } catch { return invalid(); }
	if (typeof value !== 'string' || value !== value.trim()
		|| !['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname
		|| !url.username || !url.password || !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].length > 1 || [...url.searchParams].some(([key, setting]) =>
			key.toLowerCase() !== 'sslmode' || !['disable', 'require'].includes(setting))) invalid();
	return value;
}
const open: SqlFactory = value => postgres(value, { max: 1, prepare: false,
	fetch_types: false, connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false });

function capturedQuote(quote: CompleteFlatTextQuoteV360, input: FinalChatQuoteSnapshot) {
	if (!quote || !input || !Object.isFrozen(input) || !Object.isFrozen(input.modelIds)
		|| !bounded(quote.requestId, 128) || quote.requestId !== input.requestId
		|| typeof quote.quoteId !== 'string' || !UUID.test(quote.quoteId)
		|| quote.credentialClass !== 'platform' || !SHA.test(quote.finalBodySha256)
		|| quote.finalBodySha256 !== input.finalBodySha256
		|| !Array.isArray(quote.modelIds) || quote.modelIds.length < 1 || quote.modelIds.length > 8
		|| quote.modelIds.length !== input.modelIds.length
		|| quote.modelIds.some((id, index) => !bounded(id, 240) || id !== input.modelIds[index])
		|| new Set(quote.modelIds).size !== quote.modelIds.length
		|| !Number.isSafeInteger(quote.routeCount) || quote.routeCount < quote.modelIds.length
		|| quote.routeCount > 100 || !Number.isFinite(Date.parse(quote.expiresAt))) invalid();
	return Object.freeze({ requestId: quote.requestId, quoteId: quote.quoteId,
		finalBodySha256: quote.finalBodySha256, modelIds: Object.freeze([...quote.modelIds]),
		routeCount: quote.routeCount, expiresAt: quote.expiresAt });
}

function parse(value: unknown, quote: ReturnType<typeof capturedQuote>, now: number): SecretlessCompleteTextPlanV391 {
	const row = object(value);
	if (row.status !== 'planned_complete_subset') {
		keys(row, 'status');
		if (row.status === 'not_found' || row.status === 'stale'
			|| row.status === 'invalid_manifest' || row.status === 'stale_manifest')
			throw new PostgresCompleteTextPlanRejectedV391(row.status);
		return invalid();
	}
	keys(row, 'candidateCount,expiresAt,finalBodySha256,orderedModelIds,quoteId,requestId,routeCount,routes,status');
	if (!Number.isSafeInteger(now) || row.requestId !== quote.requestId || row.quoteId !== quote.quoteId
		|| row.finalBodySha256 !== quote.finalBodySha256 || row.routeCount !== quote.routeCount
		|| row.candidateCount !== quote.modelIds.length || !Array.isArray(row.orderedModelIds)
		|| row.orderedModelIds.length !== quote.modelIds.length
		|| row.orderedModelIds.some((id, index) => id !== quote.modelIds[index])
		|| typeof row.expiresAt !== 'string' || Date.parse(row.expiresAt) <= now
		|| Date.parse(row.expiresAt) !== Date.parse(quote.expiresAt)
		|| !Array.isArray(row.routes) || row.routes.length !== quote.routeCount) invalid();
	const seen = new Set<string>();
	const candidates = new Set<number>();
	const routes = row.routes.map(raw => {
		const route = object(raw);
		keys(route, 'attestedSourceSha256,candidateIndex,modelId,routeTargetId,sourceGeneration');
		const index = route.candidateIndex;
		if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= quote.modelIds.length
			|| route.modelId !== quote.modelIds[index as number] || !bounded(route.routeTargetId, 256)
			|| seen.has(route.routeTargetId) || typeof route.sourceGeneration !== 'string'
			|| !/^[1-9][0-9]{0,18}$/u.test(route.sourceGeneration)
			|| BigInt(route.sourceGeneration) > 9223372036854775807n
			|| typeof route.attestedSourceSha256 !== 'string' || !SHA.test(route.attestedSourceSha256)) invalid();
		seen.add(route.routeTargetId); candidates.add(index as number);
		return Object.freeze({ candidateIndex: index as number, modelId: route.modelId as string,
			routeTargetId: route.routeTargetId, sourceGeneration: route.sourceGeneration,
			attestedSourceSha256: route.attestedSourceSha256 });
	});
	if (candidates.size !== quote.modelIds.length) invalid();
	return Object.freeze({ ...quote, routes: Object.freeze(routes) });
}

/**
 * Read the already committed quote using the planner-only LOGIN. No provider
 * credentials, ciphertext, URL, endpoint DTO or amount is returned. The SQL
 * function rechecks current authenticated identity and the whole source set.
 */
export async function readPostgresCompleteTextSecretlessPlanV391(params: {
	plannerConnectionString: string;
	quote: CompleteFlatTextQuoteV360;
	finalQuoteInput: FinalChatQuoteSnapshot;
	signal?: AbortSignal;
}, factory: SqlFactory = open): Promise<SecretlessCompleteTextPlanV391> {
	const signal = params.signal;
	signal?.throwIfAborted();
	const url = connection(params.plannerConnectionString);
	const quote = capturedQuote(params.quote, params.finalQuoteInput);
	if (Date.parse(quote.expiresAt) <= Date.now()) invalid();
	const sql = factory(url, { max: 1 });
	const transactional = sql as unknown as { begin<T>(work: (tx: Statement) => Promise<T>): Promise<T> };
	let result: SecretlessCompleteTextPlanV391 | undefined;
	let failure: unknown;
	try {
		result = await transactional.begin(async tx => {
			signal?.throwIfAborted();
			const roles = await tx.unsafe(`SELECT current_user AS current_role, session_user AS session_role,
			  pg_catalog.current_setting('transaction_isolation') AS transaction_isolation`);
			signal?.throwIfAborted();
			if (roles.length !== 1 || roles[0]?.current_role !== LOGIN || roles[0]?.session_role !== LOGIN
				|| roles[0]?.transaction_isolation !== 'read committed') invalid();
			await tx.unsafe("SET LOCAL lock_timeout='2s'");
			signal?.throwIfAborted();
			await tx.unsafe("SET LOCAL statement_timeout='15s'");
			signal?.throwIfAborted();
			const rows = await tx.unsafe('SELECT cinatoken_gateway.plan_complete_flat_text_quote_v365($1::text,$2::uuid) AS value',
				[quote.requestId, quote.quoteId]);
			signal?.throwIfAborted();
			if (rows.length !== 1 || !Object.hasOwn(rows[0]!, 'value')) invalid();
			return parse(rows[0]!.value, quote, Date.now());
		});
	} catch (error) { failure = error; }
	try {
		const closed = sql.end({ timeout: 1 });
		if (!closed || typeof closed.then !== 'function') throw new Error('Planner LOGIN close did not acknowledge');
		await closed;
	} catch (error) {
		throw new PostgresCompleteTextPlanCleanupUnconfirmedV391(failure === undefined ? error
			: new AggregateError([failure, error], 'Planner operation and LOGIN cleanup failed'));
	}
	if (failure !== undefined) throw failure;
	signal?.throwIfAborted();
	if (Date.parse(result!.expiresAt) <= Date.now()) invalid();
	return result!;
}

/** Only identifiers used by v363; never fabricate a credential-bearing RouteResult. */
export function selectCompleteTextPlanRouteV391(plan: SecretlessCompleteTextPlanV391, selection: {
	candidateIndex: number; routeTargetId: string;
}): Readonly<Pick<RouteResult, 'targetId' | 'gatewayCandidateIndex' | 'gatewayModelId'>> {
	const route = plan.routes.find(item => item.candidateIndex === selection.candidateIndex
		&& item.routeTargetId === selection.routeTargetId);
	if (!Object.isFrozen(plan) || !route || Date.parse(plan.expiresAt) <= Date.now()) invalid();
	return Object.freeze({ targetId: route.routeTargetId,
		gatewayCandidateIndex: route.candidateIndex, gatewayModelId: route.modelId });
}
