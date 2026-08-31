import type { AdminPrincipal } from '@/lib/admin-principal';
import {
	fetchCinaAuth,
	getCinaAuthConfig,
	getCinaAuthSecrets,
	hasRequiredCinaAuthRole,
} from '@/lib/cinaauth/config';

const SUBJECT_PREFIX = 'cinaauth:';

type BridgeUser = {
	id?: string;
	email?: string | null;
	role?: string | null;
};

type BridgeResponse = {
	ok?: boolean;
	user?: BridgeUser;
};

export class CinaAuthConsoleVerificationUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'CinaAuthConsoleVerificationUnavailableError';
	}
}

export const cinaAuthSessionUsername = (subject: string): string => `${SUBJECT_PREFIX}${subject}`;

export const cinaAuthSubjectFromPrincipal = (principal: AdminPrincipal): string | null => {
	if (principal.type !== 'console' || !principal.username.startsWith(SUBJECT_PREFIX)) return null;
	const subject = principal.username.slice(SUBJECT_PREFIX.length);
	return subject || null;
};

export const verifyCinaAuthConsolePrincipal = async (
	request: Request,
	principal: AdminPrincipal,
	env?: { CINAAUTH_AUTH_SERVICE?: Fetcher },
): Promise<AdminPrincipal | null> => {
	if (principal.type === 'api_key') return principal;
	const subject = cinaAuthSubjectFromPrincipal(principal);
	if (!subject) return null;
	const config = getCinaAuthConfig(request);
	const { bridgeSecret } = getCinaAuthSecrets(request);
	const upstream = new Request(`${config.issuer}/api/auth/cinatoken-oidc/verify`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-cinatoken-bridge-secret': bridgeSecret,
		},
		body: JSON.stringify({ subject }),
		cache: 'no-store',
	});

	let response: Response;
	try {
		response = env?.CINAAUTH_AUTH_SERVICE
			? await env.CINAAUTH_AUTH_SERVICE.fetch(upstream)
			: await fetchCinaAuth(upstream, request);
	} catch (cause) {
		throw new CinaAuthConsoleVerificationUnavailableError(
			'CinaAuth console verification request failed',
			{ cause },
		);
	}

	if (!response.ok) {
		if (response.status >= 400 && response.status < 500 && response.status !== 429) {
			return null;
		}
		throw new CinaAuthConsoleVerificationUnavailableError(
			`CinaAuth console verification returned ${response.status}`,
		);
	}

	let body: BridgeResponse | null;
	try {
		body = (await response.json()) as BridgeResponse | null;
	} catch (cause) {
		throw new CinaAuthConsoleVerificationUnavailableError(
			'CinaAuth console verification returned invalid JSON',
			{ cause },
		);
	}
	if (!body || typeof body !== 'object') {
		throw new CinaAuthConsoleVerificationUnavailableError(
			'CinaAuth console verification returned an invalid response',
		);
	}
	if (
		body.ok !== true ||
		body.user?.id !== subject ||
		!hasRequiredCinaAuthRole(body.user.role, config.requiredRoles)
	) {
		return null;
	}
	return principal;
};
