/**
 * Next's Node adapter can synthesize request.url from its listening address.
 * The HTTP Host is the browser-facing authority preserved by our ingress.
 * Never derive an application's origin from Origin or X-Forwarded-Host.
 */
export function getPublicRequestUrl(request: Request): URL {
	const url = new URL(request.url);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new TypeError("Public request protocol must be HTTP or HTTPS");
	}
	const host = request.headers.get("host");
	if (host === null) return url;
	if (
		!host ||
		host.length > 1024 ||
		Array.from(host).some(
			(character) =>
				character.charCodeAt(0) <= 32 || character.charCodeAt(0) >= 127
		) ||
		/[/\\?#@,%]/u.test(host)
	) {
		throw new TypeError("Public request Host is invalid");
	}
	const authority = new URL(`${url.protocol}//${host}`);
	if (
		authority.username ||
		authority.password ||
		authority.pathname !== "/" ||
		authority.search ||
		authority.hash ||
		(!authority.hostname.startsWith("[") &&
			!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/iu.test(
				authority.hostname
			))
	) {
		throw new TypeError("Public request Host is invalid");
	}
	url.hostname = authority.hostname;
	url.port = authority.port;
	return url;
}
