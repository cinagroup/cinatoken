/** Shared, browser-safe config semantics. Reads deliberately retain the legacy Proxy parseInt behavior. */
export const STREAM_FIRST_EVENT_TIMEOUT_MS_KEY = 'STREAM_FIRST_EVENT_TIMEOUT_MS';
export const STREAM_FIRST_EVENT_TIMEOUT_ROUTE_GROUPS_KEY = 'STREAM_FIRST_EVENT_TIMEOUT_ROUTE_GROUPS';
// Both the Node and Web timer implementations use a signed 32-bit millisecond delay.
export const STREAM_FIRST_EVENT_TIMEOUT_MAX_MS = 2_147_483_647;
export const STREAM_FIRST_EVENT_TIMEOUT_ROUTE_GROUPS_MAX_LENGTH = 4096;

export function parseFirstEventTimeoutMs(raw: string | null | undefined): number {
	const s = (raw ?? '').trim();
	if (!s) return 0;
	const n = Number.parseInt(s, 10);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return n;
}

export function parseFirstEventTimeoutRouteGroups(raw: string | null | undefined): string[] | '*' {
	const s = (raw ?? '').trim();
	if (!s) return ['default'];
	if (s === '*' || s.toLowerCase() === 'all') return '*';
	const groups = s
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
	return groups.length > 0 ? groups : ['default'];
}

/** New writes are bounded exact integers; no exponent, suffix, fraction or silent timer overflow. */
export function normalizeFirstEventTimeoutMsInput(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const value = raw.trim();
	if (value === '') return '';
	if (!/^\d+$/u.test(value)) return null;
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n > STREAM_FIRST_EVENT_TIMEOUT_MAX_MS) return null;
	return value;
}

/** Keep literal group case, spelling, ordering and whitespace within the stored list. */
export function normalizeFirstEventTimeoutRouteGroupsInput(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const value = raw.trim();
	if (value.length > STREAM_FIRST_EVENT_TIMEOUT_ROUTE_GROUPS_MAX_LENGTH) return null;
	// A lone surrogate cannot round-trip through the databases' UTF-8 strings.
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) return null;
	}
	if (value && !value.split(',').some((part) => part.trim() !== '')) return null;
	return value;
}

type TimeoutConfigValue = { value: string; source: 'configured' | 'missing' | 'invalid' };

function configValue(raw: string | null, normalized: string | null): TimeoutConfigValue {
	const value = raw ?? '';
	if (!value.trim()) return { value, source: 'missing' };
	return { value, source: normalized === null ? 'invalid' : 'configured' };
}

/** Return raw historical values, including invalid ones, so clients never silently rewrite their meaning. */
export function timeoutMsConfigValue(raw: string | null): TimeoutConfigValue {
	return configValue(raw, normalizeFirstEventTimeoutMsInput(raw ?? ''));
}

export function timeoutRouteGroupsConfigValue(raw: string | null): TimeoutConfigValue {
	return configValue(raw, normalizeFirstEventTimeoutRouteGroupsInput(raw ?? ''));
}
