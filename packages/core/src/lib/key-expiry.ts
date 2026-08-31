/** Normalize an optional key expiry to canonical UTC ISO 8601 and require future time. */
export function normalizeFutureKeyExpiry(
	value: string | null | undefined,
	nowIso: string,
	keyKind: "Gateway" | "Management"
): string | null {
	if (value === undefined || value === null) return null;
	const nowMilliseconds = Date.parse(nowIso);
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(nowMilliseconds) || !Number.isFinite(milliseconds)) {
		throw new TypeError(`${keyKind} API key expiry is invalid`);
	}
	const expiresAt = new Date(milliseconds).toISOString();
	if (expiresAt !== value) {
		throw new TypeError(
			`${keyKind} API key expiry must be canonical UTC ISO 8601`
		);
	}
	if (milliseconds <= nowMilliseconds) {
		throw new TypeError(`${keyKind} API key expiry must be in the future`);
	}
	return expiresAt;
}
