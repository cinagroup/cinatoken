const CONFIG_NAME = 'CINATOKEN_WEB_PROXY_ORIGINS'
const MAX_CONFIG_LENGTH = 4096
const MAX_ORIGINS = 16

function invalidOrigins() {
	// Never echo environment contents into logs or public shell errors.
	throw new Error(
		`${CONFIG_NAME} must contain at most 16 trusted HTTP(S) origins`
	)
}

function validHost(host) {
	if (host === '[::1]') return true
	if (host.length > 253) return false
	if (/^[0-9.]+$/.test(host)) {
		const octets = host.split('.')
		return (
			octets.length === 4 &&
			octets.every(
				(value) => /^(0|[1-9][0-9]{0,2})$/.test(value) && Number(value) <= 255
			)
		)
	}
	const labels = host.split('.')
	return (
		labels.every(
			(label) =>
				label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
		) && /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(labels.at(-1))
	)
}

/** Strict ASCII origins; mirrored by the Docker POSIX validator. No URL coercion. */
export function parseWebProxyOrigins(value = '') {
	if (
		typeof value !== 'string' ||
		value.length > MAX_CONFIG_LENGTH ||
		/[^a-z0-9:/.,[\] -]/.test(value)
	) {
		invalidOrigins()
	}
	if (value.trim() === '') return []
	const entries = value.split(',')
	if (entries.length > MAX_ORIGINS) invalidOrigins()
	const origins = []
	for (const entry of entries) {
		const origin = entry.trim()
		const match =
			/^(https?):\/\/([a-z0-9.-]+|\[::1\])(?::([1-9][0-9]{0,4}))?$/.exec(origin)
		if (!match || !validHost(match[2])) invalidOrigins()
		const [, scheme, host, port] = match
		if (port && Number(port) > 65535) invalidOrigins()
		if (
			scheme === 'http' &&
			!['localhost', '127.0.0.1', '[::1]'].includes(host)
		) {
			invalidOrigins()
		}
		if (!origins.includes(origin)) origins.push(origin)
	}
	return origins
}

/** Retain the existing self/WSS policy; append validated Proxy HTTP/WS origins. */
export function webProxyConnectSources(value = '') {
	const origins = parseWebProxyOrigins(value)
	const sockets = origins.map((origin) => origin.replace(/^http/, 'ws'))
	return ["'self'", 'wss:', ...origins, ...sockets].join(' ')
}
