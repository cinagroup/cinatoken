export const CINATOKEN_SESSION_COOKIE = 'cinatoken_session';

export const ACCOUNT_CAPABILITIES = [
	'account.read',
	'gateway_keys.manage',
	'shared_keys.manage',
	'earnings.read',
	'wallet.manage',
	'withdrawals.manage',
	'nft.read',
] as const;

export const ADMIN_CONSOLE_CAPABILITY = 'admin.console' as const;

export type AccountCapability =
	| (typeof ACCOUNT_CAPABILITIES)[number]
	| typeof ADMIN_CONSOLE_CAPABILITY;

export function getSessionCookieToken(
	request: Request,
	fallbackCookieName: string,
): string | null {
	const cookieHeader = request.headers.get('cookie');
	if (!cookieHeader) return null;
	const values = new Map<string, string>();
	for (const part of cookieHeader.split(';')) {
		const [name, ...rest] = part.trim().split('=');
		if (!name) continue;
		try {
			values.set(name, decodeURIComponent(rest.join('=')));
		} catch {
			return null;
		}
	}
	return values.get(CINATOKEN_SESSION_COOKIE) ?? values.get(fallbackCookieName) ?? null;
}

export function getAccountCapabilities(isAdmin: boolean): AccountCapability[] {
	return isAdmin
		? [...ACCOUNT_CAPABILITIES, ADMIN_CONSOLE_CAPABILITY]
		: [...ACCOUNT_CAPABILITIES];
}
