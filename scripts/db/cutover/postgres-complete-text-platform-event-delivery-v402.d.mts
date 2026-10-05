import type { PostgresDatabaseClient } from '../../../packages/core/src/storage/database-client';

type Sql = PostgresDatabaseClient['raw'];
export type PlatformEventDeliveryFactoryV402 = (connection: string, options: { max: 1 }) => Sql;
export type PlatformEventItemV402 = Readonly<{
	eventId: string;
	attemptCount: number;
	leaseUntil: string;
}>;
export type PlatformEventClaimV402 = Readonly<{
	status: 'claimed';
	leaseNonce: string;
	items: readonly PlatformEventItemV402[];
}>;
export type PlatformEventReceiptV402 = Readonly<{
	eventId: string;
	terminalId: string;
	requestId: string;
	eventType: 'platform_text_no_fetch_closed';
	eventVersion: 1;
	payloadSha256: string;
	consumedAt: string;
}>;
export type PlatformEventConsumptionV402 = PlatformEventReceiptV402 & Readonly<{
	status: 'consumed' | 'already_consumed';
}>;
export type PlatformEventJobV402 = Readonly<{
	status: 'pending' | 'publishing' | 'published' | 'delivered' | 'dead_letter';
	attemptCount: number;
	nextAttemptAt: string;
	leaseNonce: string | null;
	leaseUntil: string | null;
}>;
export type PlatformEventObservationV402 = Readonly<{
	status: 'consumed' | 'pending' | 'missing';
	eventId: string;
	receipt: PlatformEventReceiptV402 | null;
	job: PlatformEventJobV402 | null;
}>;
export type PlatformEventFinishV402 = Readonly<{
	status: 'published' | 'retry_scheduled' | 'dead_letter' | 'already_consumed' | 'lease_lost';
	eventId: string;
	attemptCount: number;
}>;

export const PLATFORM_EVENT_PUBLISHER_V402: 'cinatoken_gateway_complete_text_platform_event_publisher';
export const PLATFORM_EVENT_CONSUMER_V402: 'cinatoken_gateway_complete_text_platform_event_consumer';
export class PostgresPlatformEventCleanupUnconfirmedV402 extends Error {
	constructor(cause: unknown);
}

export function scanPostgresCompleteTextPlatformEventsV402(
	params: { connectionString: string; limit: number }, factory?: PlatformEventDeliveryFactoryV402,
): Promise<Readonly<{ status: 'scanned'; enqueued: number }>>;
export function claimPostgresCompleteTextPlatformEventsV402(
	params: { connectionString: string; limit: number; leaseNonce: string }, factory?: PlatformEventDeliveryFactoryV402,
): Promise<PlatformEventClaimV402>;
export function finishPostgresCompleteTextPlatformPublishV402(
	params: { connectionString: string; eventId: string; leaseNonce: string; outcome: 'published' | 'failed' },
	factory?: PlatformEventDeliveryFactoryV402,
): Promise<PlatformEventFinishV402>;
export function consumePostgresCompleteTextPlatformEventV402(
	params: { connectionString: string; eventId: string }, factory?: PlatformEventDeliveryFactoryV402,
): Promise<PlatformEventConsumptionV402>;
export function observePostgresCompleteTextPlatformEventV402(
	params: { connectionString: string; eventId: string }, factory?: PlatformEventDeliveryFactoryV402,
): Promise<PlatformEventObservationV402>;
export function requeuePostgresCompleteTextPlatformEventV402(
	params: { connectionString: string; eventId: string; operatorLogin: 'cinatoken_gateway_migrator'; reason: string },
	factory?: PlatformEventDeliveryFactoryV402,
): Promise<Readonly<{ status: 'requeued' | 'already_consumed'; eventId: string; restoreCount: number }>>;
