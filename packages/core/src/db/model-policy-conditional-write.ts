import { MODEL_PATCH_COLS } from './patch-allowlists';

/** Current-value read-set: null and every byte of a stored policy remain distinct.
 * This is not a historical revision: an A -> B -> A policy again matches A. */
export function modelPolicyPatch(rest: Record<string, unknown>): [string, unknown][] {
	return Object.entries(rest).filter(([key, value]) => MODEL_PATCH_COLS.has(key) && value !== undefined);
}

export function modelPolicyTags(tags: string[] | undefined): string[] | undefined {
	return tags === undefined ? undefined : [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))];
}

export function modelPolicyWriteMatched(rows: unknown, id: string): boolean {
	if (!Array.isArray(rows) || rows.length > 1 || rows.some((row) => !row || row.id !== id))
		throw new Error('Invalid conditional model write acknowledgement');
	return rows.length === 1;
}

export function assertModelPolicyExpected(expected: string | null): void {
	if (expected !== null && (typeof expected !== 'string' || expected.length > 65536)) throw new Error('Invalid model policy read-set');
}
