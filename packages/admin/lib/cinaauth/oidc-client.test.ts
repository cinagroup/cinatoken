import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as oauth from 'oauth4webapi';
import { createCinaAuthAuthorizationUrl } from './oidc-client';

describe('CinaAuth authorization request', () => {
	it('uses exact redirect, resource, S256 PKCE, state, nonce, and scopes', async () => {
		const codeVerifier = oauth.generateRandomCodeVerifier();
		const url = await createCinaAuthAuthorizationUrl(
			{
				issuer: 'https://auth.cinaseek.ai',
				authorization_endpoint: 'https://auth.cinaseek.ai/api/auth/oauth2/authorize',
			},
			{
				issuer: 'https://auth.cinaseek.ai',
				accountOrigin: 'https://accounts.cinaseek.ai',
				appOrigin: 'https://cinatoken.com',
				clientId: 'cinatoken-admin',
				redirectUri: 'https://cinatoken.com/api/auth/cinaauth/callback',
				postLogoutRedirectUri: 'https://cinatoken.com/',
				requiredRoles: ['super_admin', 'security_admin'],
			},
			{
				state: 'state-value',
				nonce: 'nonce-value',
				codeVerifier,
				callbackPath: '/dashboard',
				createdAt: Date.now(),
			},
		);

		assert.equal(url.searchParams.get('client_id'), 'cinatoken-admin');
		assert.equal(
			url.searchParams.get('redirect_uri'),
			'https://cinatoken.com/api/auth/cinaauth/callback',
		);
		assert.equal(url.searchParams.get('resource'), 'https://cinatoken.com');
		assert.equal(url.searchParams.get('scope'), 'openid profile email');
		assert.equal(url.searchParams.get('state'), 'state-value');
		assert.equal(url.searchParams.get('nonce'), 'nonce-value');
		assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
		assert.equal(
			url.searchParams.get('code_challenge'),
			await oauth.calculatePKCECodeChallenge(codeVerifier),
		);
	});
});
