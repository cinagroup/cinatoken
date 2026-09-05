import {
	DEFAULT_PROVIDER_ATTEMPT_RETENTION_DAYS,
	MAX_PROVIDER_ATTEMPT_RETENTION_DAYS,
	MAX_PROVIDER_ATTEMPT_RETENTION_DELETE_BATCH,
	MIN_PROVIDER_ATTEMPT_RETENTION_DAYS,
	type RequestLogsRepository,
} from '@octafuse/core';

export const DEFAULT_PROVIDER_ATTEMPT_RETENTION_BATCH_SIZE = 5_000;
export const DEFAULT_PROVIDER_ATTEMPT_RETENTION_MAX_BATCHES = 10;
export const MAX_PROVIDER_ATTEMPT_RETENTION_BATCHES = 20;

export type ProviderAttemptRetentionEnvironment = {
	PROVIDER_ATTEMPT_RETENTION_DAYS?: string;
	PROVIDER_ATTEMPT_RETENTION_BATCH_SIZE?: string;
	PROVIDER_ATTEMPT_RETENTION_MAX_BATCHES?: string;
};

export type ProviderAttemptRetentionConfig = {
	retentionDays: number;
	batchSize: number;
	maxBatches: number;
};

export type ProviderAttemptRetentionResult = {
	cutoffIso: string;
	deleted: number;
	batches: number;
	saturated: boolean;
};

const MAX_CANONICAL_SCHEDULED_TIME_MS = Date.parse('9999-12-31T23:59:59.999Z');

function boundedInteger(
	raw: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	if (raw == null || raw.trim() === '') return fallback;
	if (!/^\d+$/u.test(raw.trim())) {
		throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
	}
	const value = Number(raw.trim());
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
	}
	return value;
}

export function resolveProviderAttemptRetentionConfig(
	environment: ProviderAttemptRetentionEnvironment,
): ProviderAttemptRetentionConfig {
	return {
		retentionDays: boundedInteger(
			environment.PROVIDER_ATTEMPT_RETENTION_DAYS,
			DEFAULT_PROVIDER_ATTEMPT_RETENTION_DAYS,
			MIN_PROVIDER_ATTEMPT_RETENTION_DAYS,
			MAX_PROVIDER_ATTEMPT_RETENTION_DAYS,
			'PROVIDER_ATTEMPT_RETENTION_DAYS',
		),
		batchSize: boundedInteger(
			environment.PROVIDER_ATTEMPT_RETENTION_BATCH_SIZE,
			DEFAULT_PROVIDER_ATTEMPT_RETENTION_BATCH_SIZE,
			1,
			MAX_PROVIDER_ATTEMPT_RETENTION_DELETE_BATCH,
			'PROVIDER_ATTEMPT_RETENTION_BATCH_SIZE',
		),
		maxBatches: boundedInteger(
			environment.PROVIDER_ATTEMPT_RETENTION_MAX_BATCHES,
			DEFAULT_PROVIDER_ATTEMPT_RETENTION_MAX_BATCHES,
			1,
			MAX_PROVIDER_ATTEMPT_RETENTION_BATCHES,
			'PROVIDER_ATTEMPT_RETENTION_MAX_BATCHES',
		),
	};
}

export function assertProviderAttemptRetentionConfig(
	config: ProviderAttemptRetentionConfig,
): void {
	if (
		!Number.isSafeInteger(config.retentionDays)
		|| config.retentionDays < MIN_PROVIDER_ATTEMPT_RETENTION_DAYS
		|| config.retentionDays > MAX_PROVIDER_ATTEMPT_RETENTION_DAYS
		|| !Number.isSafeInteger(config.batchSize)
		|| config.batchSize <= 0
		|| config.batchSize > MAX_PROVIDER_ATTEMPT_RETENTION_DELETE_BATCH
		|| !Number.isSafeInteger(config.maxBatches)
		|| config.maxBatches <= 0
		|| config.maxBatches > MAX_PROVIDER_ATTEMPT_RETENTION_BATCHES
	) {
		throw new TypeError('Provider attempt retention config is invalid');
	}
}

export async function runProviderAttemptRetention(options: {
	repository: Pick<RequestLogsRepository, 'deleteProviderAttemptAvailabilityBefore'>;
	nowMs: number;
	config: ProviderAttemptRetentionConfig;
}): Promise<ProviderAttemptRetentionResult> {
	assertProviderAttemptRetentionConfig(options.config);
	if (
		!Number.isSafeInteger(options.nowMs)
		|| options.nowMs < 0
		|| options.nowMs > MAX_CANONICAL_SCHEDULED_TIME_MS
	) {
		throw new TypeError('Provider attempt retention scheduled time is invalid');
	}
	const cutoffMs = options.nowMs - options.config.retentionDays * 86_400_000;
	const cutoffIso = new Date(cutoffMs).toISOString();
	let deleted = 0;
	let batches = 0;
	let lastBatch = 0;

	while (batches < options.config.maxBatches) {
		lastBatch = await options.repository.deleteProviderAttemptAvailabilityBefore({
			cutoffIso,
			limit: options.config.batchSize,
		});
		if (!Number.isSafeInteger(lastBatch) || lastBatch < 0 || lastBatch > options.config.batchSize) {
			throw new TypeError('Provider attempt retention repository result is invalid');
		}
		deleted += lastBatch;
		batches += 1;
		if (lastBatch < options.config.batchSize) break;
	}

	return {
		cutoffIso,
		deleted,
		batches,
		saturated: batches === options.config.maxBatches && lastBatch === options.config.batchSize,
	};
}
