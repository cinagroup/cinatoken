import { createHash } from 'node:crypto';
import type { RouteResult } from '../model-router';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const ROUTE_DOMAIN = 'cinatoken.text.route-source.v1\n';
const CREDENTIAL_DOMAIN = 'cinatoken.text.wire-credentials.v1\n';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export type TextCredentialBinding = Readonly<{
	location: 'authorization-bearer' | 'x-api-key' | 'query-key' | 'url-userinfo';
	/** Hash of the secret actually placed on this wire surface. Never a masked key label. */
	sha256: string;
}>;

export type TextRouteIdentity = Readonly<{
	targetId: string;
	providerId: string;
	endpointId: string | null;
	providerKeyId: string | null;
	providerModelName: string;
	upstreamProtocol: string;
	upstreamOperation: string;
	/** Also commits to endpoint config and the route's source credential across awaits. */
	routeSourceSha256: string;
}>;

export type PreparedTextAttempt = Readonly<{
	kind: 'text-json-v1';
	routeIdentity: TextRouteIdentity;
	method: 'POST';
	/** Commits to the exact URL string passed to fetch, including query auth.
	 * The URL itself must not enter an admission record or error log. */
	upstreamUrlSha256: string;
	/** SHA-256 of the same frozen JSON projection used by the upload stream. */
	outboundBodySha256: string;
	outboundBodyBytes: number;
	/** Canonical semantic JSON from the same frozen upload snapshot; optional outside strict Chat. */
	outboundBodyCanonicalSha256?: string;
	credentialBindings: readonly TextCredentialBinding[];
	/** Domain-separated digest of every effective auth surface in wire order. */
	credentialFingerprintSha256: string;
}>;

/** Capture before asynchronous auth/body hashing so route mutation fails closed. */
export function captureTextRouteIdentity(route: RouteResult): TextRouteIdentity {
	const source = JSON.stringify([
		route.targetId, route.providerId, route.endpoint?.id ?? null,
		route.providerKeyId ?? null, route.providerModelName,
		route.upstreamProtocol, route.upstreamOperation,
		route.providerEndpoints, route.providerApiKey,
	]);
	if (!source || !route.targetId || !route.providerId || !route.providerModelName) {
		throw new TypeError('Incomplete text route identity');
	}
	return Object.freeze({
		targetId: route.targetId,
		providerId: route.providerId,
		endpointId: route.endpoint?.id ?? null,
		providerKeyId: route.providerKeyId ?? null,
		providerModelName: route.providerModelName,
		upstreamProtocol: route.upstreamProtocol,
		upstreamOperation: route.upstreamOperation,
		routeSourceSha256: createHash('sha256').update(ROUTE_DOMAIN).update(source).digest('hex'),
	});
}

/** Build only non-secret wire commitments. `url` and auth values are never retained. */
export function createPreparedTextAttempt(params: {
	routeIdentity: TextRouteIdentity;
	url: string;
	method: 'POST';
	headers: HeadersInit;
	outboundBodySha256: string;
	outboundBodyBytes: number;
	outboundBodyCanonicalSha256?: string;
}): PreparedTextAttempt {
	if (!SHA256_HEX.test(params.outboundBodySha256)
		|| (params.outboundBodyCanonicalSha256 !== undefined
			&& !SHA256_HEX.test(params.outboundBodyCanonicalSha256))
		|| !Number.isSafeInteger(params.outboundBodyBytes) || params.outboundBodyBytes < 0) {
		throw new TypeError('Invalid prepared text body identity');
	}
	const url = new URL(params.url);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new TypeError('Invalid prepared text upstream URL');
	}
	const headers = new Headers(params.headers);
	const bindings: TextCredentialBinding[] = [];
	const authorization = headers.get('authorization');
	if (authorization) {
		const bearer = /^Bearer (.*)$/i.exec(authorization);
		if (!bearer) throw new TypeError('Unsupported text authorization identity');
		bindings.push(Object.freeze({ location: 'authorization-bearer', sha256: sha256(bearer[1]!) }));
	}
	const apiKey = headers.get('x-api-key');
	if (apiKey !== null) bindings.push(Object.freeze({ location: 'x-api-key', sha256: sha256(apiKey) }));
	for (const queryKey of url.searchParams.getAll('key')) {
		bindings.push(Object.freeze({ location: 'query-key', sha256: sha256(queryKey) }));
	}
	if (url.username || url.password) {
		bindings.push(Object.freeze({ location: 'url-userinfo', sha256: sha256(`${url.username}:${url.password}`) }));
	}
	if (bindings.length === 0) throw new TypeError('Missing prepared text credential identity');
	const credentialBindings = Object.freeze(bindings);
	return Object.freeze({
		kind: 'text-json-v1',
		routeIdentity: params.routeIdentity,
		method: params.method,
		upstreamUrlSha256: sha256(params.url),
		outboundBodySha256: params.outboundBodySha256,
		outboundBodyBytes: params.outboundBodyBytes,
		...(params.outboundBodyCanonicalSha256 === undefined ? {}
			: { outboundBodyCanonicalSha256: params.outboundBodyCanonicalSha256 }),
		credentialBindings,
		credentialFingerprintSha256: createHash('sha256').update(CREDENTIAL_DOMAIN)
			.update(JSON.stringify(credentialBindings)).digest('hex'),
	});
}

/** Structural guard for the opt-in failover boundary; the trusted driver is the producer. */
export function preparedTextAttemptMatchesRoute(value: unknown, route: RouteResult): value is PreparedTextAttempt {
	if (!value || typeof value !== 'object') return false;
	const prepared = value as Partial<PreparedTextAttempt>;
	if (!Object.isFrozen(prepared) || !Object.isFrozen(prepared.routeIdentity)
		|| !Object.isFrozen(prepared.credentialBindings)) return false;
	if (prepared.kind !== 'text-json-v1' || prepared.method !== 'POST'
		|| !SHA256_HEX.test(prepared.upstreamUrlSha256 ?? '')
		|| !SHA256_HEX.test(prepared.outboundBodySha256 ?? '')
		|| (prepared.outboundBodyCanonicalSha256 !== undefined
			&& !SHA256_HEX.test(prepared.outboundBodyCanonicalSha256))
		|| !SHA256_HEX.test(prepared.credentialFingerprintSha256 ?? '')
		|| !Number.isSafeInteger(prepared.outboundBodyBytes) || (prepared.outboundBodyBytes ?? -1) < 0
		|| !Array.isArray(prepared.credentialBindings) || prepared.credentialBindings.length === 0
		|| prepared.credentialBindings.some(binding =>
			!binding || !Object.isFrozen(binding)
			|| !['authorization-bearer', 'x-api-key', 'query-key', 'url-userinfo'].includes(binding.location)
			|| !SHA256_HEX.test(binding.sha256))) return false;
	try {
		if (createHash('sha256').update(CREDENTIAL_DOMAIN)
			.update(JSON.stringify(prepared.credentialBindings)).digest('hex')
			!== prepared.credentialFingerprintSha256) return false;
		const expected = captureTextRouteIdentity(route);
		const observed = prepared.routeIdentity;
		return observed != null && (Object.keys(expected) as Array<keyof TextRouteIdentity>)
			.every(key => observed[key] === expected[key]);
	} catch { return false; }
}
