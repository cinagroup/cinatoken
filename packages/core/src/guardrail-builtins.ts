export const GUARDRAIL_DETERMINISTIC_BUILTIN_SLUGS = [
	'email',
	'phone',
	'ssn',
	'credit-card',
	'ip-address',
	'secrets',
	'regex-prompt-injection',
] as const;

export const GUARDRAIL_EXTERNAL_DETECTION_BUILTIN_SLUGS = [
	'person-name',
	'address',
] as const;

export const GUARDRAIL_SECRET_FORMAT_IDS = [
	'aws-access-key-id',
	'github-token',
	'github-fine-grained-pat',
	'gitlab-personal-access-token',
	'openai-api-key',
	'openai-legacy-api-key',
	'anthropic-api-key',
	'openrouter-api-key',
	'google-api-key',
	'google-oauth-client-secret',
	'stripe-secret-key',
	'slack-token',
	'slack-legacy-workspace-token',
	'slack-app-token',
	'slack-webhook-url',
	'npm-access-token',
	'sendgrid-api-key',
	'huggingface-access-token',
	'databricks-api-token',
	'atlassian-api-token',
	'doppler-token',
	'linear-api-key',
	'shopify-access-token',
	'telegram-bot-token',
	'age-secret-key',
	'json-web-token',
	'bitcoin-wif-uncompressed',
	'bitcoin-wif-compressed',
	'bitcoin-extended-private-key',
	'ethereum-private-key',
	'private-key-block',
	'pypi-upload-token',
	'digitalocean-token',
] as const;

export type GuardrailDeterministicBuiltinSlug = typeof GUARDRAIL_DETERMINISTIC_BUILTIN_SLUGS[number];
export type GuardrailSecretFormatId = typeof GUARDRAIL_SECRET_FORMAT_IDS[number];
export type GuardrailBuiltinAction = 'flag' | 'redact' | 'block';
export type GuardrailBuiltinFilter = {
	slug: GuardrailDeterministicBuiltinSlug;
	action: GuardrailBuiltinAction;
};

export type GuardrailBuiltinMatch = {
	start: number;
	end: number;
	/** Per-format replacement used by the Secrets preset. */
	replacement?: string;
};

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}\b/giu;
const PHONE_PATTERN = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{4}\b/gu;
const SSN_PATTERN = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/gu;
const CREDIT_CARD_CANDIDATE_PATTERN = /\b\d[\d -]{11,25}\d\b/gu;
const IPV4_CANDIDATE_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;

type GuardrailSecretPattern = {
	id: GuardrailSecretFormatId;
	pattern: RegExp;
};

/**
 * Recognizable, bounded credential structures from OpenRouter's public
 * Secrets preset contract. Deliberately excludes entropy-only guesses,
 * unprefixed hashes, UUIDs, and bare hexadecimal strings.
 */
const SECRET_PATTERNS: readonly GuardrailSecretPattern[] = [
	{ id: 'aws-access-key-id', pattern: /\b(?:(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}|A3T[A-Z0-9]{17})\b/gu },
	{ id: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/gu },
	{ id: 'github-fine-grained-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/gu },
	{ id: 'gitlab-personal-access-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,255}\b/gu },
	{ id: 'openai-api-key', pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{8,128}T3BlbkFJ[A-Za-z0-9_-]{8,128}\b/gu },
	{ id: 'openai-legacy-api-key', pattern: /\bsk-(?!proj-|svcacct-|admin-)[A-Za-z0-9_-]{8,128}T3BlbkFJ[A-Za-z0-9_-]{8,128}\b/gu },
	{ id: 'anthropic-api-key', pattern: /\bsk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{91,97}AA\b/gu },
	{ id: 'openrouter-api-key', pattern: /\bsk-or-v1-[0-9a-f]{64}\b/gu },
	{ id: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/gu },
	{ id: 'google-oauth-client-secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{28}\b/gu },
	{ id: 'stripe-secret-key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,99}\b/gu },
	{ id: 'slack-token', pattern: /\bxox(?:b|p|o|s)-\d{8,14}-[A-Za-z0-9-]{20,200}\b/gu },
	{ id: 'slack-legacy-workspace-token', pattern: /\bxox(?:a|r)-(?:\d{8,14}-)?[A-Za-z0-9-]{20,200}\b/gu },
	{ id: 'slack-app-token', pattern: /\bxapp-\d{1,4}-[A-Z0-9]{8,20}-\d{8,14}-[a-f0-9]{32,128}\b/gu },
	{ id: 'slack-webhook-url', pattern: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9][A-Za-z0-9/_-]{19,511}/gu },
	{ id: 'npm-access-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/gu },
	{ id: 'sendgrid-api-key', pattern: /\bSG\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{32,128}\b/gu },
	{ id: 'huggingface-access-token', pattern: /\bhf_[A-Za-z0-9]{30,200}\b/gu },
	{ id: 'databricks-api-token', pattern: /\bdapi[0-9a-f]{32}(?:-\d+)?\b/gu },
	{ id: 'atlassian-api-token', pattern: /\bATATT3[A-Za-z0-9_-]{80,300}\b/gu },
	{ id: 'doppler-token', pattern: /\bdp\.(?:pt|st|ct|sa|scim|audit)\.[A-Za-z0-9_-]{40,200}\b/gu },
	{ id: 'linear-api-key', pattern: /\blin_api_[A-Za-z0-9]{32,128}\b/gu },
	{ id: 'shopify-access-token', pattern: /\b(?:shpat|shpca|shppa|shpss)_[0-9a-fA-F]{32}\b/gu },
	{ id: 'telegram-bot-token', pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/gu },
	{ id: 'age-secret-key', pattern: /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}\b/gu },
	{ id: 'json-web-token', pattern: /\beyJ[A-Za-z0-9_-]{4,1024}\.eyJ[A-Za-z0-9_-]{4,2048}\.[A-Za-z0-9_-]{16,1024}\b/gu },
	{ id: 'bitcoin-wif-uncompressed', pattern: /\b5[HJK][1-9A-HJ-NP-Za-km-z]{49}\b/gu },
	{ id: 'bitcoin-wif-compressed', pattern: /\b[KL][1-9A-HJ-NP-Za-km-z]{51}\b/gu },
	{ id: 'bitcoin-extended-private-key', pattern: /\b(?:xprv|yprv|zprv|Yprv|Zprv|tprv|uprv|vprv|Uprv|Vprv)[1-9A-HJ-NP-Za-km-z]{107}\b/gu },
	{ id: 'ethereum-private-key', pattern: /\b0x[0-9a-fA-F]{64}\b/gu },
	{ id: 'pypi-upload-token', pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,300}\b/gu },
	{ id: 'digitalocean-token', pattern: /\b(?:dop|doo|dor|dos)_v1_[0-9a-f]{64}\b/gu },
];

const PRIVATE_KEY_BEGIN_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/gu;
const PRIVATE_KEY_BLOCK_MAX_CHARACTERS = 32 * 1024;

const PROMPT_INJECTION_PATTERNS = [
	/\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|prior|earlier|above|existing|original|system|developer|safety|security)\s+(?:instructions?|rules?|guidelines?|constraints?|directives?|prompts?)\b/giu,
	/\b(?:reveal|show|display|print|repeat|leak|expose)\s+(?:the\s+)?(?:hidden|secret|original|system|developer|initial|internal)?\s*(?:prompt|instructions?|rules?|directives?)\b/giu,
	/\b(?:disable|bypass|circumvent|remove)\s+(?:the\s+)?(?:safety|security|content|policy|guardrail|filter)s?\b/giu,
	/\b(?:you\s+are\s+now|act\s+as|switch\s+to)\s+(?:an?\s+)?(?:unrestricted|jailbroken|developer|administrator|admin|root|dan)\b/giu,
] as const;

const TYPOGLYCEMIA_TARGETS = [
	'ignore', 'disregard', 'forget', 'override', 'bypass', 'reveal', 'instructions',
	'previous', 'system', 'developer', 'security', 'safety', 'prompt',
] as const;

function regexMatches(text: string, regex: RegExp): GuardrailBuiltinMatch[] {
	const matches: GuardrailBuiltinMatch[] = [];
	// Clone the shared pattern so request handling never mutates module-level
	// RegExp state through lastIndex in a reused Worker isolate.
	const matcher = new RegExp(regex.source, regex.flags);
	for (const match of text.matchAll(matcher)) {
		const start = match.index;
		const value = match[0];
		if (start === undefined || !value) continue;
		matches.push({ start, end: start + value.length });
	}
	return matches;
}

function mergeMatches(matches: GuardrailBuiltinMatch[]): GuardrailBuiltinMatch[] {
	if (matches.length < 2) return matches;
	const sorted = matches
		.filter((match) => Number.isSafeInteger(match.start) && Number.isSafeInteger(match.end) && match.end > match.start)
		.sort((left, right) => left.start - right.start || right.end - left.end);
	const merged: GuardrailBuiltinMatch[] = [];
	for (const match of sorted) {
		const previous = merged[merged.length - 1];
		if (!previous || match.start >= previous.end) {
			merged.push({ ...match });
			continue;
		}
		if (match.end > previous.end) previous.end = match.end;
	}
	return merged;
}

function digitCount(value: string): number {
	let count = 0;
	for (const character of value) if (character >= '0' && character <= '9') count += 1;
	return count;
}

function luhnValid(value: string): boolean {
	const digits = value.replace(/[^0-9]/gu, '');
	if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) return false;
	let sum = 0;
	let double = false;
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		let digit = Number(digits[index]);
		if (double) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		double = !double;
	}
	return sum % 10 === 0;
}

function creditCardMatches(text: string): GuardrailBuiltinMatch[] {
	return regexMatches(text, CREDIT_CARD_CANDIDATE_PATTERN)
		.filter((match) => luhnValid(text.slice(match.start, match.end)));
}

function phoneMatches(text: string): GuardrailBuiltinMatch[] {
	return regexMatches(text, PHONE_PATTERN).filter((match) => {
		const value = text.slice(match.start, match.end);
		const digits = digitCount(value);
		const previous = match.start > 0 ? text[match.start - 1] : undefined;
		const next = match.end < text.length ? text[match.end] : undefined;
		return digits >= 10 && digits <= 15
			&& (previous === undefined || !/[0-9]/u.test(previous))
			&& (next === undefined || !/[0-9]/u.test(next));
	});
}

function ipv4Matches(text: string): GuardrailBuiltinMatch[] {
	return regexMatches(text, IPV4_CANDIDATE_PATTERN).filter((match) =>
		text.slice(match.start, match.end).split('.').every((octet) => Number(octet) <= 255));
}

function secretReplacement(id: GuardrailSecretFormatId): string {
	return `[SECRET:${id}]`;
}

function privateKeyBlockMatches(text: string): GuardrailBuiltinMatch[] {
	const matches: GuardrailBuiltinMatch[] = [];
	for (const begin of regexMatches(text, PRIVATE_KEY_BEGIN_PATTERN)) {
		const beginMarker = text.slice(begin.start, begin.end);
		const endMarker = beginMarker.replace('BEGIN', 'END');
		const endStart = text.indexOf(endMarker, begin.end);
		if (endStart < 0 || endStart - begin.end > PRIVATE_KEY_BLOCK_MAX_CHARACTERS) continue;
		matches.push({
			start: begin.start,
			end: endStart + endMarker.length,
			replacement: secretReplacement('private-key-block'),
		});
	}
	return matches;
}

function secretMatches(text: string): GuardrailBuiltinMatch[] {
	return mergeMatches([
		...SECRET_PATTERNS.flatMap(({ id, pattern }) =>
			regexMatches(text, pattern).map((match) => ({
				...match,
				replacement: secretReplacement(id),
			}))),
		...privateKeyBlockMatches(text),
	]);
}

function middleSignature(value: string): string {
	return [...value.slice(1, -1)].sort().join('');
}

/**
 * Canonicalize only same-length typoglycemia variants. Keeping every token's
 * length unchanged means match offsets remain valid for redaction.
 */
function canonicalizeTypoglycemia(text: string): string {
	return text.replace(/[A-Za-z]{4,16}/gu, (word) => {
		const lower = word.toLowerCase();
		for (const target of TYPOGLYCEMIA_TARGETS) {
			if (lower === target || lower.length !== target.length) continue;
			if (lower[0] !== target[0] || lower.at(-1) !== target.at(-1)) continue;
			if (middleSignature(lower) !== middleSignature(target)) continue;
			return target;
		}
		return word;
	});
}

function decodeUtf8(bytes: Uint8Array): string | null {
	try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
	catch { return null; }
}

function decodedBase64(value: string): string | null {
	if (value.length < 16 || value.length > 1_024 || value.length % 4 === 1) return null;
	try {
		const decoded = atob(value);
		const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
		return decodeUtf8(bytes);
	} catch {
		return null;
	}
}

function decodedHex(value: string): string | null {
	const compact = value.replace(/[\s:-]/gu, '');
	if (compact.length < 16 || compact.length > 512 || compact.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(compact)) return null;
	const bytes = new Uint8Array(compact.length / 2);
	for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
	return decodeUtf8(bytes);
}

function directPromptInjectionMatches(text: string): GuardrailBuiltinMatch[] {
	return mergeMatches(PROMPT_INJECTION_PATTERNS.flatMap((pattern) => regexMatches(text, pattern)));
}

function encodedPromptInjectionMatches(text: string): GuardrailBuiltinMatch[] {
	const candidates = [
		...regexMatches(text, /[A-Za-z0-9+/]{16,1024}={0,2}/gu).map((match) => ({ match, decoded: decodedBase64(text.slice(match.start, match.end)) })),
		...regexMatches(text, /\b[0-9a-fA-F]{16,512}\b/gu).map((match) => ({ match, decoded: decodedHex(text.slice(match.start, match.end)) })),
		...regexMatches(text, /\b(?:[0-9a-fA-F]{2}[\s:-]){7,255}[0-9a-fA-F]{2}\b/gu).map((match) => ({ match, decoded: decodedHex(text.slice(match.start, match.end)) })),
	];
	return candidates
		.filter((candidate) => candidate.decoded !== null && directPromptInjectionMatches(candidate.decoded).length > 0)
		.map((candidate) => candidate.match);
}

function promptInjectionMatches(text: string): GuardrailBuiltinMatch[] {
	return mergeMatches([
		...directPromptInjectionMatches(text),
		...directPromptInjectionMatches(canonicalizeTypoglycemia(text)),
		...encodedPromptInjectionMatches(text),
	]);
}

export function guardrailBuiltinReplacement(slug: GuardrailDeterministicBuiltinSlug): string {
	if (slug === 'email') return '[EMAIL]';
	if (slug === 'phone') return '[PHONE]';
	if (slug === 'ssn') return '[SSN]';
	if (slug === 'credit-card') return '[CREDIT_CARD]';
	if (slug === 'ip-address') return '[IP_ADDRESS]';
	if (slug === 'secrets') return '[SECRET]';
	return '[PROMPT_INJECTION]';
}

export function guardrailBuiltinPublicLabel(slug: GuardrailDeterministicBuiltinSlug): string {
	if (slug === 'email') return 'Email address';
	if (slug === 'phone') return 'Phone number';
	if (slug === 'ssn') return 'Social Security number';
	if (slug === 'credit-card') return 'Credit card number';
	if (slug === 'ip-address') return 'IP address';
	if (slug === 'secrets') return 'API keys and secrets';
	return 'Prompt injection';
}

export function detectGuardrailBuiltin(
	text: string,
	slug: GuardrailDeterministicBuiltinSlug,
): GuardrailBuiltinMatch[] {
	if (slug === 'email') return regexMatches(text, EMAIL_PATTERN);
	if (slug === 'phone') return phoneMatches(text);
	if (slug === 'ssn') return regexMatches(text, SSN_PATTERN);
	if (slug === 'credit-card') return creditCardMatches(text);
	if (slug === 'ip-address') return ipv4Matches(text);
	if (slug === 'secrets') return secretMatches(text);
	return promptInjectionMatches(text);
}

export function redactGuardrailBuiltin(
	text: string,
	slug: GuardrailDeterministicBuiltinSlug,
): { value: string; count: number } {
	const matches = detectGuardrailBuiltin(text, slug);
	if (matches.length === 0) return { value: text, count: 0 };
	const replacement = guardrailBuiltinReplacement(slug);
	let value = '';
	let cursor = 0;
	for (const match of matches) {
		value += text.slice(cursor, match.start);
		value += match.replacement ?? replacement;
		cursor = match.end;
	}
	value += text.slice(cursor);
	return { value, count: matches.length };
}
