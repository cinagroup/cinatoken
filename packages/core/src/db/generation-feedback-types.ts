import {
	assertManagementApiKeyAccount,
	type ManagementApiKeyAccount,
} from './management-api-keys-types';

export const GENERATION_FEEDBACK_CATEGORIES = [
	'latency',
	'incoherence',
	'incorrect_response',
	'formatting',
	'billing',
	'api_error',
	'other',
] as const;

export type GenerationFeedbackCategory =
	(typeof GENERATION_FEEDBACK_CATEGORIES)[number];

export type InsertGenerationFeedbackForManagementAccountParams = {
	id: string;
	generationId: string;
	managementApiKeyId: string;
	account: ManagementApiKeyAccount;
	category: GenerationFeedbackCategory;
	comment: string | null;
	createdAtIso: string;
};

const FEEDBACK_ID_PATTERN = /^gfb_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GENERATION_ID_PATTERN = /^gen-[A-Za-z0-9_-]{1,128}$/u;
const CATEGORY_SET = new Set<string>(GENERATION_FEEDBACK_CATEGORIES);

export function isGenerationFeedbackCategory(
	value: unknown,
): value is GenerationFeedbackCategory {
	return typeof value === 'string' && CATEGORY_SET.has(value);
}

/** Validate every value before it reaches a dialect-specific INSERT ... SELECT. */
export function assertGenerationFeedbackInsertParams(
	params: InsertGenerationFeedbackForManagementAccountParams,
): void {
	if (!FEEDBACK_ID_PATTERN.test(params.id)) {
		throw new TypeError('generation feedback id is invalid');
	}
	if (!GENERATION_ID_PATTERN.test(params.generationId)) {
		throw new TypeError('generation id is invalid');
	}
	if (
		typeof params.managementApiKeyId !== 'string'
		|| params.managementApiKeyId.length < 1
		|| params.managementApiKeyId.length > 255
	) {
		throw new TypeError('management API key id is invalid');
	}
	assertManagementApiKeyAccount(params.account);
	if (!isGenerationFeedbackCategory(params.category)) {
		throw new TypeError('generation feedback category is invalid');
	}
	if (
		params.comment != null
		&& (
			typeof params.comment !== 'string'
			|| Array.from(params.comment).length > 1_000
		)
	) {
		throw new TypeError('generation feedback comment is invalid');
	}
	if (
		typeof params.createdAtIso !== 'string'
		|| params.createdAtIso.length < 1
		|| params.createdAtIso.length > 64
		|| !Number.isFinite(Date.parse(params.createdAtIso))
	) {
		throw new TypeError('generation feedback timestamp is invalid');
	}
}
