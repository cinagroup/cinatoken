export const CINATOKEN_SESSION_COOKIE = "cinatoken_session";

export const ACCOUNT_CAPABILITIES = [
	"account.read",
	"workspaces.read",
	"gateway_keys.manage",
	"management_keys.manage",
	"shared_keys.manage",
	"earnings.read",
	"wallet.manage",
	"withdrawals.manage",
	"nft.read",
] as const;

export const ADMIN_CONSOLE_CAPABILITY = "admin.console" as const;

export type AccountCapability =
	| (typeof ACCOUNT_CAPABILITIES)[number]
	| typeof ADMIN_CONSOLE_CAPABILITY;

export function getSessionCookieToken(
	request: Request,
	fallbackCookieName: string
): string | null {
	const values = readSessionCookies(request, [CINATOKEN_SESSION_COOKIE, fallbackCookieName]);
	return values.get(CINATOKEN_SESSION_COOKIE) ?? values.get(fallbackCookieName) ?? null;
}

function readSessionCookies(request: Request, names: readonly string[]): Map<string, string> {
	const values = new Map<string, string>();
	const cookieHeader = request.headers.get("cookie");
	if (!cookieHeader) return values;
	for (const part of cookieHeader.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (!names.includes(name)) continue;
		try {
			values.set(name, decodeURIComponent(rest.join("=")));
		} catch {
			// An invalid preferred session must not fall back to another identity;
			// malformed unrelated cookies do not invalidate a valid session.
			values.set(name, "");
		}
	}
	return values;
}

/** Logout revokes every session credential carried by this browser, including rollout cookies. */
export function getAllBrowserSessionTokens(request: Request): string[] {
	const values = readSessionCookies(request, [CINATOKEN_SESSION_COOKIE, 'admin_session', 'user_session']);
	return [...new Set([...values.values()].filter(Boolean))];
}

export function getAccountCapabilities(isAdmin: boolean): AccountCapability[] {
	return isAdmin
		? [...ACCOUNT_CAPABILITIES, ADMIN_CONSOLE_CAPABILITY]
		: [...ACCOUNT_CAPABILITIES];
}
