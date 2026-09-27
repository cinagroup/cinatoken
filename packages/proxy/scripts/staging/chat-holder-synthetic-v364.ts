/** Trusted, entirely synthetic holder-side records for the local binding fixture. */
export const SYNTHETIC_QUOTE_V364 = Object.freeze({
	requestId: 'c04-holder-binding-synthetic',
	quoteId: '11111111-1111-4111-8111-111111111111',
	credentialClass: 'platform',
	modelIds: ['synthetic/model-a', 'synthetic/model-b'],
	finalBodySha256: 'af7cf3ec0a0f52b49b92e1d00ff16faf3543cde02ab6b062975dcd9c68ec9c57',
	expiresAt: '2099-01-01T00:00:00.000Z',
});

export const SYNTHETIC_ROUTE_V364 = Object.freeze({
	candidateIndex: 1,
	targetId: 'synthetic-route-b',
	modelId: 'synthetic/model-b',
});

export const SYNTHETIC_CREDENTIAL_V364 = 'synthetic-private-credential-held-by-holder-v364';
export const SYNTHETIC_PROVIDER_URL_V364 = 'https://synthetic-private-provider.invalid/v1/chat/completions';

export const SYNTHETIC_PUBLIC_BODY_V364 = JSON.stringify({
	model: 'synthetic/model-a',
	models: ['synthetic/model-a', 'synthetic/model-b'],
	messages: [{ role: 'user', content: 'synthetic public request' }],
	stream: true,
});
