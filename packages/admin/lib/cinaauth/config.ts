import { getCloudflareEnv } from '@/lib/cloudflare';

const DEFAULT_ISSUER = 'https://auth.cinaseek.ai';
const DEFAULT_ACCOUNT_ORIGIN = 'https://accounts.cinaseek.ai';
const DEFAULT_APP_ORIGIN = 'https://cinatoken.com';
const DEFAULT_CLIENT_ID = 'cinatoken-admin';
const DEFAULT_REQUIRED_ROLES = ['super_admin', 'security_admin'] as const;
const MINIMUM_SECRET_LENGTH = 32;

export type CinaAuthConfig = {
	issuer: string;
	accountOrigin: string;
	appOrigin: string;
	clientId: string;
	redirectUri: string;
	postLogoutRedirectUri: string;
	requiredRoles: string[];
};

export type CinaAuthSecrets = {
	clientSecret: string;
	bridgeSecret: string;
	transactionSecret: string;
};

const readEnv = (request: Request | undefined, name: keyof CloudflareEnv): string | undefined => {
	const runtime = getCloudflareEnv(request);
	const value = runtime?.[name];
	if (typeof value === 'string' && value.trim()) return value.trim();
	const local = process.env[String(name)];
	return local?.trim() || undefined;
};

const parseCanonicalHttpsOrigin = (value: string, name: string): string => {
	const url = new URL(value);
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.port ||
		url.pathname !== '/' ||
		url.search ||
		url.hash ||
		url.origin !== value
	) {
		throw new Error(`${name} must be an exact canonical HTTPS origin`);
	}
	return url.origin;
};

const requireStrongSecret = (value: string | undefined, name: string): string => {
	if (!value || value.length < MINIMUM_SECRET_LENGTH) {
		throw new Error(`${name} is missing or weaker than 32 characters`);
	}
	return value;
};

export const getCinaAuthConfig = (request?: Request): CinaAuthConfig => {
	const issuer = parseCanonicalHttpsOrigin(
		readEnv(request, 'CINAAUTH_ISSUER') ?? DEFAULT_ISSUER,
		'CINAAUTH_ISSUER',
	);
	const accountOrigin = parseCanonicalHttpsOrigin(
		readEnv(request, 'CINAAUTH_ACCOUNT_ORIGIN') ?? DEFAULT_ACCOUNT_ORIGIN,
		'CINAAUTH_ACCOUNT_ORIGIN',
	);
	const appOrigin = parseCanonicalHttpsOrigin(
		readEnv(request, 'CINATOKEN_APP_ORIGIN') ?? DEFAULT_APP_ORIGIN,
		'CINATOKEN_APP_ORIGIN',
	);
	const clientId = readEnv(request, 'CINATOKEN_OIDC_CLIENT_ID') ?? DEFAULT_CLIENT_ID;
	if (!/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(clientId)) {
		throw new Error('CINATOKEN_OIDC_CLIENT_ID is invalid');
	}
	const requiredRoles = (
		readEnv(request, 'CINATOKEN_REQUIRED_ROLES') ?? DEFAULT_REQUIRED_ROLES.join(',')
	)
		.split(',')
		.map((role) => role.trim())
		.filter(Boolean);
	if (requiredRoles.length === 0) throw new Error('CINATOKEN_REQUIRED_ROLES is empty');

	return {
		issuer,
		accountOrigin,
		appOrigin,
		clientId,
		redirectUri: `${appOrigin}/api/auth/cinaauth/callback`,
		postLogoutRedirectUri: `${appOrigin}/`,
		requiredRoles,
	};
};

export const getCinaAuthSecrets = (request?: Request): CinaAuthSecrets => ({
	clientSecret: requireStrongSecret(
		readEnv(request, 'CINATOKEN_OIDC_CLIENT_SECRET'),
		'CINATOKEN_OIDC_CLIENT_SECRET',
	),
	bridgeSecret: requireStrongSecret(
		readEnv(request, 'CINATOKEN_OIDC_BRIDGE_SECRET'),
		'CINATOKEN_OIDC_BRIDGE_SECRET',
	),
	transactionSecret: requireStrongSecret(
		readEnv(request, 'CINATOKEN_OIDC_TRANSACTION_SECRET'),
		'CINATOKEN_OIDC_TRANSACTION_SECRET',
	),
});

export const hasRequiredCinaAuthRole = (
	role: string | null | undefined,
	requiredRoles: readonly string[],
): boolean =>
	typeof role === 'string' &&
	role
		.split(',')
		.map((candidate) => candidate.trim())
		.some((candidate) => requiredRoles.includes(candidate));

export const fetchCinaAuth = async (request: Request, sourceRequest?: Request): Promise<Response> => {
	const service = getCloudflareEnv(sourceRequest)?.CINAAUTH_AUTH_SERVICE;
	return service ? service.fetch(request) : fetch(request);
};
