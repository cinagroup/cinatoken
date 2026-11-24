/**
 * Shared predicates for admin request-log list filters.
 * Prefix predicates use literal, case-sensitive comparisons across dialects.
 */
import { INGRESS_HOST_MAX_LENGTH } from '../lib/api-key-rate-limit';

/** Match the stored Host snapshot verbatim, including case and optional port.
 * Do not parse it as a URL, lowercase it, or silently discard an invalid filter.
 */
export function normalizeRequestLogIngressHost(value: unknown): string | undefined {
	if (value === undefined || value === '') return undefined;
	if (typeof value !== 'string' || value.length > INGRESS_HOST_MAX_LENGTH || /\p{Cc}/u.test(value)) {
		throw new TypeError('Invalid ingress host');
	}
	const host = value.trim();
	if (!host) throw new TypeError('Invalid ingress host');
	try {
		encodeURIComponent(host);
	} catch {
		throw new TypeError('Invalid ingress host');
	}
	return host;
}

/** A literal startsWith filter: retain case, Unicode, `%`, `_`, and backslashes. */
export function normalizeRequestLogModelIdPrefix(value: unknown): string | undefined {
	if (value === undefined || value === '') return undefined;
	if (typeof value !== 'string' || value.length > 600 || /\p{Cc}/u.test(value)) {
		throw new TypeError('Invalid model prefix');
	}
	const prefix = value.trim();
	if (!prefix) throw new TypeError('Invalid model prefix');
	try {
		encodeURIComponent(prefix);
	} catch {
		throw new TypeError('Invalid model prefix');
	}
	return prefix;
}

/** A bounded, canonical set of literal provider IDs; only omission or '' clears it. */
export function normalizeRequestLogProviderIds(value: unknown): string[] | undefined {
	if (value === undefined || value === '') return undefined;
	if (typeof value !== 'string' || value.length > 6009 || /\p{Cc}/u.test(value)) {
		throw new TypeError('Invalid provider IDs');
	}
	try {
		encodeURIComponent(value);
	} catch {
		throw new TypeError('Invalid provider IDs');
	}
	const ids = [
		...new Set(
			value
				.split(',')
				.map((id) => id.trim())
				.filter((id) => id !== ''),
		),
	].sort();
	if (ids.length === 0 || ids.length > 10 || ids.some((id) => id.length > 600)) {
		throw new TypeError('Invalid provider IDs');
	}
	return ids;
}

export function escapeSqlLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function appendProviderIdsCondition(
	conditions: string[],
	bindValues: unknown[],
	column: string,
	providerIds: string[] | undefined,
): void {
	const ids = (providerIds ?? []).map((id) => id.trim()).filter((id) => id !== '');
	if (ids.length === 0) return;
	conditions.push(`${column} IN (${ids.map(() => '?').join(', ')})`);
	bindValues.push(...ids);
}

export function appendModelIdPrefixCondition(
	conditions: string[],
	bindValues: unknown[],
	column: string,
	prefix: string | undefined,
	dialect: 'd1' | 'mysql' | 'postgres' = 'd1',
): void {
	const normalized = normalizeRequestLogModelIdPrefix(prefix);
	if (normalized === undefined) return;
	if (dialect === 'mysql') {
		// Byte lengths and binary equality avoid the connection's text collation.
		conditions.push(`LEFT(BINARY ${column}, LENGTH(?)) = BINARY ?`);
	} else if (dialect === 'postgres') {
		conditions.push(`LEFT(${column}, LENGTH(?)) COLLATE "C" = ? COLLATE "C"`);
	} else {
		conditions.push(`SUBSTR(${column}, 1, LENGTH(?)) COLLATE BINARY = ?`);
	}
	bindValues.push(normalized, normalized);
}
