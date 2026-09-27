import { createHash } from 'node:crypto';
import postgres from 'postgres';
import {
	parseProviderEndpoints,
	parseVerifiedModelEndpointSnapshot,
	type ModelEndpointRow,
	type PostgresDatabaseClient,
} from '@octafuse/core';
import type { RouteResult } from './model-router';
import type { ChatTextHolderRequestV363 } from './chat-text-holder-request-v363';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';
import type { PrivateCompleteTextHolderPortsV365 } from './private-complete-text-holder-v365';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlFactory = (connectionString: string, options: { max: 1 }) => SqlClient;
type SqlStatement = Pick<SqlClient, 'unsafe'>;
const READER_LOGIN = 'cinatoken_gateway_complete_text_private_reader';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GENERATION = /^[1-9][0-9]*$/u;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export type PrivateCompleteTextRouteSnapshotV366 = Readonly<{
	quote: CompleteFlatTextQuoteV360;
	route: RouteResult;
	providerCiphertext: string;
}>;

export class PostgresPrivateCompleteTextReaderRejectedError extends Error {
	constructor(readonly status: string) {
		super(`PostgreSQL private complete text route ${status}`);
		this.name = 'PostgresPrivateCompleteTextReaderRejectedError';
	}
}

export class PostgresPrivateCompleteTextReaderCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL private complete text reader LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresPrivateCompleteTextReaderCleanupUnconfirmedError';
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Private complete text reader response invalid');
	}
	return value as Record<string, unknown>;
}

function connectionString(value: string): string {
	if (typeof value !== 'string' || !value || value !== value.trim()) {
		throw new TypeError('Private complete text reader connection invalid');
	}
	let url: URL;
	try { url = new URL(value); }
	catch { throw new TypeError('Private complete text reader connection invalid'); }
	if (!['postgres:', 'postgresql:'].includes(url.protocol)
		|| !url.hostname || !url.username || !url.password
		|| !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].length > 1
		|| [...url.searchParams].some(([key, setting]) =>
			key.toLowerCase() !== 'sslmode' || !['require', 'disable'].includes(setting))) {
		throw new TypeError('Private complete text reader connection invalid');
	}
	return value;
}

function selectedIdentity(value: ChatTextHolderRequestV363) {
	if (typeof value.requestId !== 'string' || value.requestId.length < 1
		|| value.requestId.length > 128
		|| typeof value.quoteId !== 'string' || !UUID.test(value.quoteId)
		|| !Number.isSafeInteger(value.candidateIndex)
		|| value.candidateIndex < 0 || value.candidateIndex > 7
		|| typeof value.routeTargetId !== 'string'
		|| new TextEncoder().encode(value.routeTargetId).length < 1
		|| new TextEncoder().encode(value.routeTargetId).length > 256) {
		throw new TypeError('Private complete text route identity invalid');
	}
	return Object.freeze({
		requestId: value.requestId, quoteId: value.quoteId,
		candidateIndex: value.candidateIndex, routeTargetId: value.routeTargetId,
	});
}

function oneValue(rows: unknown): unknown {
	if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
		|| typeof rows[0] !== 'object' || !('value' in rows[0])) {
		throw new TypeError('Private complete text reader SQL response invalid');
	}
	return rows[0].value;
}

function parseSnapshot(value: unknown,
	identity: ReturnType<typeof selectedIdentity>, nowMs: number,
): PrivateCompleteTextRouteSnapshotV366 {
	const root = record(value);
	if (root.status !== 'private_route_loaded') {
		if (typeof root.status === 'string' && root.status.length <= 80) {
			throw new PostgresPrivateCompleteTextReaderRejectedError(root.status);
		}
		throw new TypeError('Private complete text reader response invalid');
	}
	if (Object.keys(root).sort().join(',') !== 'quote,selected,status') {
		throw new TypeError('Private complete text reader result fields invalid');
	}
	const quoteRow = record(root.quote);
	const selected = record(root.selected);
	const max = quoteRow.maxPerAttemptCeilingMicros;
	const total = quoteRow.threeAttemptCeilingMicros;
	if (quoteRow.requestId !== identity.requestId
		|| quoteRow.quoteId !== identity.quoteId
		|| typeof quoteRow.finalBodySha256 !== 'string'
		|| !SHA256.test(quoteRow.finalBodySha256)
		|| !Array.isArray(quoteRow.modelIds)
		|| quoteRow.modelIds.length < 1 || quoteRow.modelIds.length > 8
		|| quoteRow.modelIds.some(id => typeof id !== 'string' || !id
			|| new TextEncoder().encode(id).length > 240)
		|| new Set(quoteRow.modelIds).size !== quoteRow.modelIds.length
		|| !Number.isSafeInteger(quoteRow.routeCount)
		|| (quoteRow.routeCount as number) < quoteRow.modelIds.length
		|| (quoteRow.routeCount as number) > 100
		|| quoteRow.credentialClass !== 'platform'
		|| !Number.isSafeInteger(max) || (max as number) <= 0
		|| !Number.isSafeInteger(total) || total !== (max as number) * 3
		|| typeof quoteRow.expiresAt !== 'string'
		|| !Number.isFinite(Date.parse(quoteRow.expiresAt))
		|| Date.parse(quoteRow.expiresAt) <= nowMs) {
		throw new TypeError('Private complete text quote snapshot invalid');
	}
	if (selected.candidateIndex !== identity.candidateIndex
		|| selected.routeTargetId !== identity.routeTargetId
		|| typeof selected.modelId !== 'string'
		|| selected.modelId !== quoteRow.modelIds[identity.candidateIndex]
		|| (selected.routePoolId !== null
			&& typeof selected.routePoolId !== 'string')
		|| typeof selected.providerId !== 'string' || !selected.providerId
		|| typeof selected.providerName !== 'string' || !selected.providerName
		|| typeof selected.providerModelName !== 'string'
		|| !selected.providerModelName
		|| typeof selected.providerCiphertext !== 'string'
		|| !selected.providerCiphertext.startsWith('enc:v2:')
		|| typeof selected.providerCiphertextSha256 !== 'string'
		|| sha256(selected.providerCiphertext) !== selected.providerCiphertextSha256
		|| typeof selected.endpointId !== 'string' || !selected.endpointId
		|| typeof selected.sourceGeneration !== 'string'
		|| !GENERATION.test(selected.sourceGeneration)
		|| typeof selected.attestedSourceSha256 !== 'string'
		|| !SHA256.test(selected.attestedSourceSha256)
		|| typeof selected.sourceSha256 !== 'string'
		|| !SHA256.test(selected.sourceSha256)
		|| typeof selected.subjectFingerprint !== 'string'
		|| !SHA256.test(selected.subjectFingerprint)
		|| selected.routeGroup !== 'default'
		|| !Number.isSafeInteger(selected.routePriority)
		|| !Number.isSafeInteger(selected.routeWeight)
		|| (selected.routeWeight as number) <= 0) {
		throw new TypeError('Private complete text selected route invalid');
	}
	const endpointRaw = record(selected.endpointRow);
	if (endpointRaw.id !== selected.endpointId
		|| endpointRaw.model_id !== selected.modelId
		|| endpointRaw.provider_id !== selected.providerId) {
		throw new TypeError('Private complete text endpoint identity invalid');
	}
	const endpoint = parseVerifiedModelEndpointSnapshot(
		endpointRaw as unknown as ModelEndpointRow, new Date(nowMs));
	if (!endpoint) throw new TypeError('Private complete text endpoint invalid');
	const endpointsRaw = record(selected.providerEndpoints);
	if (Object.keys(endpointsRaw).some(key => key !== 'openai')) {
		throw new TypeError('Private complete text provider endpoints invalid');
	}
	const providerEndpoints = parseProviderEndpoints({ endpoints: endpointsRaw });
	const quote: CompleteFlatTextQuoteV360 = Object.freeze({
		requestId: identity.requestId, quoteId: identity.quoteId,
		finalBodySha256: quoteRow.finalBodySha256,
		modelIds: Object.freeze([...quoteRow.modelIds]),
		routeCount: quoteRow.routeCount as number,
		credentialClass: 'platform',
		maxPerAttemptCeilingMicros: max as number,
		threeAttemptCeilingMicros: total as number,
		expiresAt: quoteRow.expiresAt,
	});
	const route: RouteResult = Object.freeze({
		targetId: identity.routeTargetId,
		modelSurfaceId: null,
		routePoolId: selected.routePoolId as string | null,
		providerId: selected.providerId,
		providerName: selected.providerName,
		providerModelName: selected.providerModelName,
		endpoint,
		gatewayModelId: selected.modelId,
		gatewayCandidateIndex: identity.candidateIndex,
		dataPolicySubjectFingerprint: selected.subjectFingerprint,
		upstreamProtocol: 'openai', upstreamOperation: 'chat',
		adapter: 'passthrough', providerEndpoints,
		providerApiKey: selected.providerCiphertext,
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null, routingMetadata: null,
		routeGroup: 'default',
		routePriority: selected.routePriority as number,
		routeWeight: selected.routeWeight as number,
		providerKeyId: selected.providerId,
		providerKeyLabel: selected.providerName,
	});
	return Object.freeze({ quote, route,
		providerCiphertext: selected.providerCiphertext });
}

/** One direct reader LOGIN, one transaction and one close ACK per route read. */
export async function readPostgresPrivateCompleteTextRouteV366(params: {
	readerConnectionString: string;
	request: ChatTextHolderRequestV363;
	nowMs?: () => number;
}, factory: SqlFactory = postgres): Promise<PrivateCompleteTextRouteSnapshotV366> {
	const connection = connectionString(params.readerConnectionString);
	const identity = selectedIdentity(params.request);
	const sql = factory(connection, { max: 1 });
	const transactional = sql as unknown as {
		begin<R>(callback: (tx: SqlStatement) => Promise<R>): Promise<R>;
	};
	let result: PrivateCompleteTextRouteSnapshotV366 | undefined;
	let failure: unknown;
	try {
		result = await transactional.begin(async tx => {
			const roles = await tx.unsafe(`SELECT current_user AS current_role,
			  session_user AS session_role,
			  pg_catalog.current_setting('transaction_isolation') AS transaction_isolation`);
			if (!Array.isArray(roles) || roles.length !== 1
				|| roles[0]?.current_role !== READER_LOGIN
				|| roles[0]?.session_role !== READER_LOGIN
				|| roles[0]?.transaction_isolation !== 'read committed') {
				throw new TypeError('Private complete text reader direct LOGIN mismatch');
			}
			const row = oneValue(await tx.unsafe(
				`SELECT cinatoken_gateway.read_private_complete_text_route_v366(
				  $1::text,$2::uuid,$3::integer,$4::text) AS value`,
				[identity.requestId,identity.quoteId,identity.candidateIndex,
					identity.routeTargetId],
			));
			const nowMs = (params.nowMs ?? Date.now)();
			if (!Number.isSafeInteger(nowMs)) throw new TypeError('Private reader clock invalid');
			return parseSnapshot(row,identity,nowMs);
		});
	} catch(error) { failure=error; }
	try {
		const closed=sql.end({timeout:1});
		if (!closed || typeof closed.then !== 'function') {
			throw new Error('Private reader LOGIN close did not acknowledge');
		}
		await closed;
	} catch(cleanupError) {
		throw new PostgresPrivateCompleteTextReaderCleanupUnconfirmedError(
			failure===undefined ? cleanupError
				: new AggregateError([failure,cleanupError],
					'Private reader operation and LOGIN close failed'),
		);
	}
	if(failure!==undefined) throw failure;
	return result!;
}

/**
 * Adapts the single coherent SQL snapshot to the existing v365 holder's three
 * read ports. A failed or uncertain read is never retried within this holder.
 */
export function createPostgresPrivateCompleteTextReadPortsV366(params: {
	readerConnectionString: string;
	request: ChatTextHolderRequestV363;
	nowMs?: () => number;
}, factory: SqlFactory = postgres): Pick<PrivateCompleteTextHolderPortsV365,
	'loadQuote' | 'loadRoute' | 'loadProviderCiphertext'> {
	const capturedRequest=Object.freeze({ ...params.request });
	const identity=selectedIdentity(capturedRequest);
	let readOnce: Promise<PrivateCompleteTextRouteSnapshotV366> | undefined;
	const snapshot=()=> readOnce ??= readPostgresPrivateCompleteTextRouteV366(
		{ ...params, request:capturedRequest },factory);
	return Object.freeze({
		async loadQuote(quoteId: string) {
			if (quoteId!==identity.quoteId) return null;
			return (await snapshot()).quote;
		},
		async loadRoute(input: Readonly<{
			quoteId: string; candidateIndex: number; routeTargetId: string;
		}>) {
			if (input.quoteId!==identity.quoteId
				|| input.candidateIndex!==identity.candidateIndex
				|| input.routeTargetId!==identity.routeTargetId) return null;
			return (await snapshot()).route;
		},
		async loadProviderCiphertext(providerId: string) {
			const value=await snapshot();
			return providerId===value.route.providerId ? value.providerCiphertext : null;
		},
	});
}
