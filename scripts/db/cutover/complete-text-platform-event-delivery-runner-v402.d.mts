import type {
	PlatformEventClaimV402,
	PlatformEventConsumptionV402,
	PlatformEventFinishV402,
} from './postgres-complete-text-platform-event-delivery-v402.mjs';

export function publishCompleteTextPlatformEventsV402(params: {
	connectionString: string;
	limit: number;
	leaseNonce: string;
	queue: { send(eventId: string): Promise<void> };
}): Promise<Readonly<{
	scan: Readonly<{ status: 'scanned'; enqueued: number }>;
	claim: PlatformEventClaimV402;
	publications: readonly Readonly<{
		eventId: string;
		outcome: 'published' | 'failed';
		receipt: PlatformEventFinishV402;
	}>[];
}>>;

export function consumeCompleteTextPlatformMessageV402(params: {
	connectionString: string;
	message: { body: unknown; ack(): void | Promise<void> };
}): Promise<PlatformEventConsumptionV402>;
