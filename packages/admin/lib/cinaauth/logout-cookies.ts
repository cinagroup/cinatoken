import { CINATOKEN_OIDC_TRANSACTION_COOKIE, cinaAuthTransactionCookieName } from './transaction';

type TransactionCookieStore = {
	getAll(): { name: string }[];
	set(name: string, value: string, options: {
		httpOnly: boolean; secure: boolean; sameSite: 'lax'; path: string; maxAge: number;
	}): unknown;
};

/** Expiration must also satisfy the browser's __Host- prefix requirements. */
export function clearCinaAuthTransactionCookies(cookies: TransactionCookieStore): void {
	for (const cookie of cookies.getAll()) {
		const state = cookie.name.slice(CINATOKEN_OIDC_TRANSACTION_COOKIE.length + 1);
		if (cookie.name !== CINATOKEN_OIDC_TRANSACTION_COOKIE &&
			cookie.name !== cinaAuthTransactionCookieName(state)) continue;
		cookies.set(cookie.name, '', {
			httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0,
		});
	}
}
