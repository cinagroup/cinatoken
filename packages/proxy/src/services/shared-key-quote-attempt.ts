import postgres from 'postgres';
import type { GatewayRepositories, PostgresDatabaseClient, SharedKeyEconomicAttemptOutcome } from '@octafuse/core';
import type { RouteResult } from './model-router';
import type { UsageFromStream } from './proxy';
import { providerUsageFacts, type ProviderUsageFacts } from './provider-usage-facts';
import { parseSharedKeyId } from './shared-key-pool';
import { recordUsage } from './usage-tracker';

/** A committed pre-send admission record. It does not prove network delivery. */
export type SharedKeyQuoteAttemptReference = Readonly<{
	attemptId: string;
	requestLogId: string;
	attemptIndex: number;
	sharedKeyId: string;
	transitionId: string;
	quoteVersionId: string;
	sellerUserId: string;
	routeTargetId: string;
	claimedAt: string;
}>;

export type SharedKeyQuoteAttemptInput = Readonly<Pick<
	SharedKeyQuoteAttemptReference,
	'attemptId' | 'requestLogId' | 'attemptIndex' | 'sharedKeyId' | 'routeTargetId'
>>;

type ClaimRow = {
	attempt_id: string;
	request_log_id: string;
	attempt_index: number;
	shared_key_id: string;
	transition_id: string;
	quote_version_id: string;
	seller_user_id: string;
	route_target_id: string;
	claimed_at: string;
};

const PRODUCER_LOGIN = 'cinatoken_gateway_shared_quote_attempt_producer';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function boundedId(value: unknown, max = 128): value is string {
	return typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= max;
}

function validateInput(input: SharedKeyQuoteAttemptInput): void {
	if (!UUID.test(input.attemptId)
		|| !boundedId(input.requestLogId)
		|| !Number.isInteger(input.attemptIndex)
		|| input.attemptIndex < 1 || input.attemptIndex > 1000
		|| !boundedId(input.sharedKeyId, 200)
		|| !boundedId(input.routeTargetId)) {
		throw new TypeError('Invalid shared-key quote attempt identity');
	}
}

function decodeClaim(rows: ClaimRow[], input: SharedKeyQuoteAttemptInput): SharedKeyQuoteAttemptReference {
	const row = rows[0];
	if (rows.length !== 1 || !row
		|| row.attempt_id !== input.attemptId
		|| row.request_log_id !== input.requestLogId
		|| row.attempt_index !== input.attemptIndex
		|| row.shared_key_id !== input.sharedKeyId
		|| row.route_target_id !== input.routeTargetId
		|| !boundedId(row.transition_id)
		|| !boundedId(row.quote_version_id)
		|| !boundedId(row.seller_user_id, 200)
		|| typeof row.claimed_at !== 'string'
		|| !Number.isFinite(Date.parse(row.claimed_at))) {
		throw new Error('Shared-key quote claim returned an invalid or mismatched reference');
	}
	return Object.freeze({
		attemptId: row.attempt_id,
		requestLogId: row.request_log_id,
		attemptIndex: row.attempt_index,
		sharedKeyId: row.shared_key_id,
		transitionId: row.transition_id,
		quoteVersionId: row.quote_version_id,
		sellerUserId: row.seller_user_id,
		routeTargetId: row.route_target_id,
		claimedAt: row.claimed_at,
	});
}

/**
 * PostgreSQL owns both quote selection and reference INSERT in one transaction.
 * A missing COMMIT acknowledgement throws, and the caller must not send the
 * upstream request or try another provider as compensation.
 */
export async function claimPostgresSharedKeyQuoteAttempt(
	sql: postgres.Sql,
	input: SharedKeyQuoteAttemptInput,
): Promise<SharedKeyQuoteAttemptReference> {
	validateInput(input);
	return sql.begin(async tx => {
		await tx.unsafe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
		await tx.unsafe("SET LOCAL lock_timeout = '2s'");
		await tx.unsafe("SET LOCAL statement_timeout = '5s'");
		const identity = await tx.unsafe<Array<{ current_role: string; session_role: string }>>(
			'SELECT CURRENT_USER::text AS current_role, SESSION_USER::text AS session_role',
		);
		if (identity.length !== 1
			|| identity[0]?.current_role !== PRODUCER_LOGIN
			|| identity[0]?.session_role !== PRODUCER_LOGIN) {
			throw new Error('Dedicated shared-key quote attempt LOGIN required');
		}
		const rows = await tx.unsafe<ClaimRow[]>(`SELECT
			attempt_id::text, request_log_id, attempt_index, shared_key_id,
			transition_id, quote_version_id, seller_user_id, route_target_id,
			claimed_at::text FROM
			cinatoken_economic_quotes.claim_shared_key_dispatch_quote_attempt(
				$1::uuid,$2::text,$3::integer,$4::text,$5::text)`,
			[input.attemptId, input.requestLogId, input.attemptIndex,
				input.sharedKeyId, input.routeTargetId]);
		return decodeClaim(rows, input);
	});
}

export type SharedKeyQuoteAttemptCapture = Readonly<{
	/** Invoked once at the delegated text driver's pre-fetch boundary. */
	beforeFetch(route: RouteResult): Promise<SharedKeyQuoteAttemptReference | null>;
	/** Admission and the dispatch permit succeeded. The network write is still unproved. */
	fetchBoundaryPermitted(reference: SharedKeyQuoteAttemptReference): void;
	/** Raw upstream headers, observed by the driver immediately after fetch resolves. */
	upstreamHeadersObserved(reference: SharedKeyQuoteAttemptReference, status: number): void;
	/** Fetch entered but no raw upstream response headers were observed. */
	transportAmbiguous(reference: SharedKeyQuoteAttemptReference): void;
	/** Bind a completed provider usage object to its exact observed 2xx attempt. */
	observeProviderUsage(reference: SharedKeyQuoteAttemptReference, usage: UsageFromStream): Promise<boolean>;
	/** Request-local refs only; a later durable outbox must supply send/usage facts. */
	references(): readonly SharedKeyQuoteAttemptReference[];
	/** Atomic request-local snapshot for a typed economic handoff. */
	handoff(): SharedKeyQuoteAttemptHandoff;
}>;

export type SharedKeyQuoteAttemptTransportObservation = Readonly<{
	reference: SharedKeyQuoteAttemptReference;
	stage: 'claimed_only' | 'fetch_boundary_permitted' | 'upstream_headers_observed' | 'transport_ambiguous';
	upstreamHttpStatus: number | null;
	observedAtIso: string;
}>;

export type SharedKeyQuoteAttemptHandoff = Readonly<{
	quoteAttempts: readonly SharedKeyQuoteAttemptReference[];
	transport: readonly SharedKeyQuoteAttemptTransportObservation[];
	/** Missing per-attempt facts remain unknown, including provider cost without a bill. */
	economicOutcomes: readonly SharedKeyEconomicAttemptOutcome[];
}>;

type ObservedProviderUsage = ProviderUsageFacts & Readonly<{
	evidenceSha256: string;
	observedAtIso: string;
}>;

/**
 * Future production implementation must commit the buyer log and one typed
 * economic event for every captured attempt in the same transaction. The
 * current legacy mutable-price seller settlement cannot satisfy this method.
 */
export type SharedKeyEconomicProducer = Readonly<{
	recordUsageAndOutbox(
		repositories: GatewayRepositories,
		usage: Parameters<typeof recordUsage>[1],
		handoff: SharedKeyQuoteAttemptHandoff,
		selectedReference: SharedKeyQuoteAttemptReference | null,
	): Promise<void>;
}>;

/**
 * Review-only adapter. Runtime repositories resolve pricing and audit reads;
 * the buyer LOGIN owns the log, debit, and v2 event critical transaction.
 * The caller owns the dedicated client's lifetime. No shipped app binding
 * constructs or installs this producer, so the quote feature stays closed.
 */
export function createPostgresSharedKeyEconomicProducer(
	buyerClient: PostgresDatabaseClient,
): SharedKeyEconomicProducer {
	if (buyerClient?.driver !== 'postgres') {
		throw new TypeError('Shared-key economic buyer client requires PostgreSQL');
	}
	return Object.freeze({
		async recordUsageAndOutbox(repositories, usage, handoff, selectedReference) {
			if (repositories.client.driver !== 'postgres') {
				throw new Error('Shared-key economic producer requires PostgreSQL');
			}
			if (repositories.client.raw === buyerClient.raw) {
				throw new Error('Shared-key economic buyer and runtime clients must be distinct');
			}
			await recordUsage(repositories, {
				...usage,
				shared_key_economic_handoff: { handoff, selectedReference },
			}, buyerClient);
		},
	});
}

/**
 * Share this object across all outer model and inner key loops for one request.
 * Every shared-key candidate receives a distinct attempt index and UUID.
 */
export function createSharedKeyQuoteAttemptCapture(
	requestLogId: string,
	claim: (input: SharedKeyQuoteAttemptInput) => Promise<SharedKeyQuoteAttemptReference>,
): SharedKeyQuoteAttemptCapture {
	if (!boundedId(requestLogId) || typeof claim !== 'function') {
		throw new TypeError('Invalid shared-key quote attempt capture setup');
	}
	let nextAttemptIndex = 0;
	const captured: SharedKeyQuoteAttemptReference[] = [];
	const observed = new Map<string, SharedKeyQuoteAttemptTransportObservation>();
	const providerUsage = new Map<string, ObservedProviderUsage>();
	const nowIso = (): string => new Date().toISOString();
	const ownedObservation = (reference: SharedKeyQuoteAttemptReference): SharedKeyQuoteAttemptTransportObservation => {
		const current = observed.get(reference.attemptId);
		if (!current || current.reference !== reference) {
			throw new TypeError('Unowned shared-key quote attempt observation');
		}
		return current;
	};
	const updateObservation = (
		reference: SharedKeyQuoteAttemptReference,
		expected: SharedKeyQuoteAttemptTransportObservation['stage'],
		stage: SharedKeyQuoteAttemptTransportObservation['stage'],
		status: number | null,
	): void => {
		const current = ownedObservation(reference);
		if (current.stage !== expected) {
			throw new Error(`Invalid shared-key quote attempt transport transition: ${current.stage} -> ${stage}`);
		}
		observed.set(reference.attemptId, Object.freeze({
			reference, stage, upstreamHttpStatus: status, observedAtIso: nowIso(),
		}));
	};
	return Object.freeze({
		async beforeFetch(route: RouteResult): Promise<SharedKeyQuoteAttemptReference | null> {
			const sharedKeyId = parseSharedKeyId(route.providerKeyId);
			if (sharedKeyId === null) return null;
			const input = Object.freeze({
				attemptId: crypto.randomUUID(),
				requestLogId,
				attemptIndex: ++nextAttemptIndex,
				sharedKeyId,
				routeTargetId: route.targetId,
			});
			validateInput(input);
			const reference = await claim(input);
			// Fail closed when a test double or future transport returns a different
			// row, even if its SQL command appeared to succeed.
			const checked = decodeClaim([{
				attempt_id: reference.attemptId,
				request_log_id: reference.requestLogId,
				attempt_index: reference.attemptIndex,
				shared_key_id: reference.sharedKeyId,
				transition_id: reference.transitionId,
				quote_version_id: reference.quoteVersionId,
				seller_user_id: reference.sellerUserId,
				route_target_id: reference.routeTargetId,
				claimed_at: reference.claimedAt,
			}], input);
			captured.push(checked);
			observed.set(checked.attemptId, Object.freeze({
				reference: checked, stage: 'claimed_only', upstreamHttpStatus: null,
				observedAtIso: nowIso(),
			}));
			return checked;
		},
		fetchBoundaryPermitted(reference): void {
			updateObservation(reference, 'claimed_only', 'fetch_boundary_permitted', null);
		},
		upstreamHeadersObserved(reference, status): void {
			if (!Number.isInteger(status) || status < 100 || status > 599) {
				throw new TypeError('Invalid upstream HTTP status for shared-key quote attempt');
			}
			// A deadline may have already settled this request as ambiguous while
			// the underlying fetch is still resolving. A late header must not turn
			// that owned late task into an exception or rewrite a completed handoff.
			if (ownedObservation(reference).stage === 'transport_ambiguous') return;
			updateObservation(reference, 'fetch_boundary_permitted', 'upstream_headers_observed', status);
		},
		transportAmbiguous(reference): void {
			const current = ownedObservation(reference);
			if (current.stage === 'upstream_headers_observed' || current.stage === 'transport_ambiguous') return;
			updateObservation(reference, 'fetch_boundary_permitted', 'transport_ambiguous', null);
		},
		async observeProviderUsage(reference, usage): Promise<boolean> {
			const current = ownedObservation(reference);
			if (current.stage !== 'upstream_headers_observed'
				|| current.upstreamHttpStatus == null
				|| current.upstreamHttpStatus < 200 || current.upstreamHttpStatus >= 300) return false;
			const facts = providerUsageFacts(usage);
			if (!facts) return false;
			const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(usage.raw_usage!));
			const evidenceSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
			// A concurrent timeout may have marked this attempt ambiguous while hashing.
			if (ownedObservation(reference).stage !== 'upstream_headers_observed') return false;
			const previous = providerUsage.get(reference.attemptId);
			if (previous) return previous.evidenceSha256 === evidenceSha256;
			providerUsage.set(reference.attemptId, Object.freeze({ ...facts, evidenceSha256, observedAtIso: nowIso() }));
			return true;
		},
		references(): readonly SharedKeyQuoteAttemptReference[] {
			return Object.freeze([...captured]);
		},
		handoff(): SharedKeyQuoteAttemptHandoff {
			const quoteAttempts = Object.freeze([...captured]);
			const transport = Object.freeze(quoteAttempts.map(reference => ownedObservation(reference)));
			const economicOutcomes = Object.freeze(transport.map(({ reference, observedAtIso }) => {
				const reported = providerUsage.get(reference.attemptId);
				return Object.freeze({
					attemptId: reference.attemptId,
					requestLogId: reference.requestLogId,
					attemptIndex: reference.attemptIndex,
					sharedKeyId: reference.sharedKeyId,
					transitionId: reference.transitionId,
					quoteVersionId: reference.quoteVersionId,
					usageCertainty: reported ? 'actual' as const : 'unknown' as const,
					inputTokens: reported?.inputTokens ?? null,
					outputTokens: reported?.outputTokens ?? null,
					cacheReadTokens: reported?.cacheReadTokens ?? null,
					cacheWriteTokens: reported?.cacheWriteTokens ?? null,
					providerCostCertainty: 'unknown' as const,
					providerCostMicros: null,
					evidenceKind: reported ? 'provider_usage' as const : 'manual_review' as const,
					evidenceSha256: reported?.evidenceSha256 ?? null,
					observedAtIso: reported?.observedAtIso ?? observedAtIso,
				});
			}));
			return Object.freeze({ quoteAttempts, transport, economicOutcomes });
		},
	});
}

/**
 * A separate Hyperdrive origin must authenticate as the dedicated producer
 * LOGIN. The request-scoped capture owns no global connection or credential.
 * Shipped bindings omit the activation and origin, so ordinary traffic stays
 * on the existing path until the economic outbox and consumer are integrated.
 */
export function createConfiguredSharedKeyQuoteAttemptCapture(input: Readonly<{
	activation: string | undefined;
	connectionString: string | undefined;
	databaseDriver: string;
	requestLogId: string;
}>): SharedKeyQuoteAttemptCapture | null {
	if (input.activation === undefined) return null;
	if (input.activation !== 'reviewed-v1'
		|| input.databaseDriver !== 'postgres'
		|| typeof input.connectionString !== 'string'
		|| input.connectionString.length === 0) {
		throw new TypeError('Invalid shared-key quote attempt activation');
	}
	return createSharedKeyQuoteAttemptCapture(input.requestLogId, async attempt => {
		const sql = postgres(input.connectionString!, {
			max: 1,
			fetch_types: false,
			prepare: false,
			connect_timeout: 3,
		});
		try {
			return await claimPostgresSharedKeyQuoteAttempt(sql, attempt);
		} finally {
			await sql.end({ timeout: 1 });
		}
	});
}
