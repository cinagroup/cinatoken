import { MODEL_ROUTE_PATCH_COLS } from '../patch-allowlists';

function snakeToCamel(key: string): string {
	return key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase());
}

/**
 * Convert the public snake_case patch into Drizzle property names only after
 * checking the same column allowlist used by the D1 and MySQL repositories.
 */
export function buildPostgresModelRoutePatch(patch: Record<string, unknown>): Record<string, unknown> {
	const set: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined || !MODEL_ROUTE_PATCH_COLS.has(key)) continue;
		set[snakeToCamel(key)] = value;
	}
	return set;
}
