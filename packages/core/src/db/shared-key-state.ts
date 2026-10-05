import type { SellerSharedKeyPatch, SharedKeyStateExpectation, SharedKeyValidationResult } from './shared-keys-types';

export const SHARED_KEY_STATE_COLUMNS = [
	'seller_user_id', 'channel_type', 'key_fingerprint', 'status', 'validated_at',
	'label', 'seller_priority', 'weight', 'input_price', 'output_price', 'cache_read_price', 'cache_write_price',
] as const;

export function sharedKeySellerAssignments(patch: SellerSharedKeyPatch): { sets: string[]; values: (string | number | null)[] } {
	const columns = { label: 'label', status: 'status', weight: 'weight', inputPrice: 'input_price',
		outputPrice: 'output_price', cacheReadPrice: 'cache_read_price', cacheWritePrice: 'cache_write_price' } as const;
	const sets: string[] = []; const values: (string | number | null)[] = [];
	for (const field of Object.keys(columns) as (keyof typeof columns)[]) {
		if (patch[field] !== undefined) { sets.push(`${columns[field]} = ?`); values.push(patch[field]); }
	}
	return { sets, values };
}

/** Validate before any I/O, and own primitive expected values across the asynchronous SQL call. */
export function sharedKeyStateValues(expected: SharedKeyStateExpectation): (string | number | null)[] {
	if (!expected || typeof expected !== 'object' ||
		![expected.sellerUserId, expected.channelType, expected.keyFingerprint].every(value => typeof value === 'string' && value.length > 0) ||
		!['active', 'paused', 'disabled', 'invalid', 'validating'].includes(expected.status) ||
		!(expected.validatedAt === null || typeof expected.validatedAt === 'string' && Number.isFinite(Date.parse(expected.validatedAt))) ||
		!(expected.label === null || typeof expected.label === 'string') ||
		!Number.isSafeInteger(expected.sellerPriority) || !Number.isSafeInteger(expected.weight) ||
		![expected.inputPrice, expected.outputPrice].every(value => Number.isFinite(value) && value >= 0) ||
		![expected.cacheReadPrice, expected.cacheWritePrice].every(value => value === null || Number.isFinite(value) && value >= 0)) {
		throw new TypeError('Invalid shared key expected state');
	}
	return [expected.sellerUserId, expected.channelType, expected.keyFingerprint, expected.status,
		expected.validatedAt, expected.label, expected.sellerPriority, expected.weight,
		expected.inputPrice, expected.outputPrice, expected.cacheReadPrice, expected.cacheWritePrice];
}

export function assertSellerSharedKeyPatch(patch: SellerSharedKeyPatch, expected: SharedKeyStateExpectation): SellerSharedKeyPatch {
	sharedKeyStateValues(expected);
	if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
		Object.keys(patch).some(field => !['label', 'status', 'weight', 'inputPrice', 'outputPrice', 'cacheReadPrice', 'cacheWritePrice'].includes(field))) {
		throw new TypeError('Invalid seller shared key patch');
	}
	if (patch.status !== undefined && (
		!['active', 'paused'].includes(patch.status) || !['active', 'paused'].includes(expected.status) ||
		patch.status === 'active' && expected.status === 'paused' && expected.validatedAt === null
	)) throw new TypeError('Shared key requires successful validation before seller activation');
	if (patch.label !== undefined && patch.label !== null && typeof patch.label !== 'string' ||
		patch.weight !== undefined && (!Number.isSafeInteger(patch.weight) || patch.weight < 1 || patch.weight > 100) ||
		[patch.inputPrice, patch.outputPrice].some(value => value !== undefined && (!Number.isFinite(value) || value <= 0)) ||
		[patch.cacheReadPrice, patch.cacheWritePrice].some(value => value !== undefined && value !== null && (!Number.isFinite(value) || value < 0))) {
		throw new TypeError('Invalid seller shared key patch value');
	}
	return { ...patch };
}

export function assertSharedKeyValidation(expected: SharedKeyStateExpectation, result: SharedKeyValidationResult, nowIso: string): void {
	sharedKeyStateValues(expected);
	if (expected.status === 'disabled' || typeof result?.valid !== 'boolean' ||
		!(result.reason === null || typeof result.reason === 'string') ||
		!Number.isFinite(Date.parse(nowIso)) || new Date(nowIso).toISOString() !== nowIso) {
		throw new TypeError('Invalid shared key validation completion');
	}
}

/** Preserve six-digit historical MySQL timestamps in equality conditions. */
export function sharedKeyMySqlInstant(instant: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/u.exec(instant);
	if (match && Number.isFinite(Date.parse(`${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(6, '0')}Z`))) {
		return `${match[1]} ${match[2]}.${(match[3] ?? '').padEnd(6, '0')}`;
	}
	const parsed = new Date(instant);
	if (!Number.isFinite(parsed.getTime())) throw new TypeError('Invalid shared key timestamp');
	return `${parsed.toISOString().slice(0, 23).replace('T', ' ')}000`;
}
