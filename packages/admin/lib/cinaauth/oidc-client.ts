import * as oauth from 'oauth4webapi';
import type { CinaAuthConfig } from '@/lib/cinaauth/config';
import { fetchCinaAuth } from '@/lib/cinaauth/config';
import type { CinatokenOidcTransaction } from '@/lib/cinaauth/transaction';

const authServiceFetch =
	(sourceRequest?: Request) =>
	async <Method, BodyType>(
		url: string,
		options: oauth.CustomFetchOptions<Method, BodyType>,
	): Promise<Response> => {
		const request = new Request(url, {
			method: String(options.method),
			headers: options.headers,
			body: options.body instanceof URLSearchParams ? options.body : undefined,
			redirect: options.redirect,
			signal: options.signal,
		});
		return fetchCinaAuth(request, sourceRequest);
	};

const clientFor = (config: CinaAuthConfig): oauth.Client => ({
	client_id: config.clientId,
	token_endpoint_auth_method: 'client_secret_basic',
});

export const getCinaAuthOidcFailureDetails = (error: unknown) => {
	if (error instanceof oauth.ResponseBodyError) {
		return {
			category: 'oauth_response',
			code: error.error,
			description: error.error_description?.slice(0, 160),
			status: error.status,
		};
	}
	if (error instanceof Error) {
		return { category: 'runtime', code: error.name, status: null };
	}
	return { category: 'unknown', code: 'unknown', status: null };
};

export const discoverCinaAuthAuthorizationServer = async (
	config: CinaAuthConfig,
	sourceRequest?: Request,
): Promise<oauth.AuthorizationServer> => {
	const issuer = new URL(config.issuer);
	const response = await oauth.discoveryRequest(issuer, {
		algorithm: 'oidc',
		[oauth.customFetch]: authServiceFetch(sourceRequest),
	});
	return oauth.processDiscoveryResponse(issuer, response);
};

export const createCinaAuthAuthorizationUrl = async (
	server: oauth.AuthorizationServer,
	config: CinaAuthConfig,
	transaction: CinatokenOidcTransaction,
): Promise<URL> => {
	if (!server.authorization_endpoint) throw new Error('OIDC authorization endpoint is unavailable');
	const codeChallenge = await oauth.calculatePKCECodeChallenge(transaction.codeVerifier);
	const url = new URL(server.authorization_endpoint);
	url.searchParams.set('client_id', config.clientId);
	url.searchParams.set('redirect_uri', config.redirectUri);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', 'openid profile email');
	url.searchParams.set('resource', config.appOrigin);
	url.searchParams.set('state', transaction.state);
	url.searchParams.set('nonce', transaction.nonce);
	url.searchParams.set('code_challenge', codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url;
};

export const exchangeCinaAuthAuthorizationCode = async ({
	server,
	config,
	callbackUrl,
	transaction,
	clientSecret,
	sourceRequest,
}: {
	server: oauth.AuthorizationServer;
	config: CinaAuthConfig;
	callbackUrl: URL;
	transaction: CinatokenOidcTransaction;
	clientSecret: string;
	sourceRequest?: Request;
}) => {
	const client = clientFor(config);
	const parameters = oauth.validateAuthResponse(server, client, callbackUrl, transaction.state);
	const tokenResponse = await oauth.authorizationCodeGrantRequest(
		server,
		client,
		oauth.ClientSecretBasic(clientSecret),
		parameters,
		config.redirectUri,
		transaction.codeVerifier,
		{
			additionalParameters: { resource: config.appOrigin },
			[oauth.customFetch]: authServiceFetch(sourceRequest),
		},
	);
	const tokens = await oauth.processAuthorizationCodeResponse(server, client, tokenResponse, {
		expectedNonce: transaction.nonce,
		requireIdToken: true,
	});
	await oauth.validateApplicationLevelSignature(server, tokenResponse, {
		[oauth.customFetch]: authServiceFetch(sourceRequest),
	});
	const claims = oauth.getValidatedIdTokenClaims(tokens);
	if (!claims?.sub || !tokens.id_token) throw new Error('Validated ID token claims are missing');
	return { accessToken: tokens.access_token, subject: claims.sub };
};
