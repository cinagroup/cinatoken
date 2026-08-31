/**
 * Web Fetch URL 校验（SSRF 精简版）：仅检查字面量 host / IP，不做 DNS lookup（Worker 上不可靠且慢）。
 */

export type UrlGuardOk = { ok: true; url: string; hostname: string };
export type UrlGuardFail = { ok: false; error: string };
export type UrlGuardResult = UrlGuardOk | UrlGuardFail;

/**
 * 校验目标 URL：仅允许 http/https；拒绝 localhost / 私网字面量 / 元数据 host。
 */
export function assertFetchUrlSafe(raw: string): UrlGuardResult {
	const trimmed = raw?.trim() ?? '';
	if (!trimmed) {
		return { ok: false, error: 'url is required' };
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { ok: false, error: 'url is invalid' };
	}

	const protocol = parsed.protocol.toLowerCase();
	if (protocol !== 'http:' && protocol !== 'https:') {
		return { ok: false, error: 'url must use http or https' };
	}
	if (parsed.username || parsed.password) {
		return { ok: false, error: 'url credentials are not allowed' };
	}
	if (parsed.hash) {
		return { ok: false, error: 'url fragments are not allowed' };
	}

	const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/u, '');
	if (!hostname) {
		return { ok: false, error: 'url hostname is required' };
	}

	if (isBlockedHost(hostname)) {
		return { ok: false, error: 'url host is not allowed' };
	}

	return { ok: true, url: parsed.toString(), hostname };
}

function isBlockedHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
		return true;
	}
	if (
		host === '0.0.0.0' ||
		host === '127.0.0.1' ||
		host === '::1' ||
		host === '0' ||
		host === 'metadata.google.internal' ||
		host.endsWith('.internal') ||
		host.endsWith('.localdomain')
	) {
		return true;
	}
	if (host.includes(':')) {
		const ipv6 = parseIpv6(host);
		if (!ipv6 || isBlockedIpv6(ipv6)) return true;
	}
	const ipv4Mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
	if (ipv4Mapped && isBlockedIpv4(ipv4Mapped[1])) {
		return true;
	}
	if (isBlockedIpv4(host)) {
		return true;
	}
	return false;
}

function isBlockedIpv4(host: string): boolean {
	const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!ipv4) {
		return false;
	}
	const a = Number(ipv4[1]);
	const b = Number(ipv4[2]);
	const c = Number(ipv4[3]);
	const d = Number(ipv4[4]);
	if ([a, b, c, d].some((n) => n > 255)) {
		return true;
	}
	return isBlockedIpv4Parts(a, b, c, d);
}

function isBlockedIpv4Parts(a: number, b: number, c: number, d: number): boolean {
	void d;
	return a === 0 || a === 10 || a === 127 || a >= 224
		|| (a === 100 && b >= 64 && b <= 127)
		|| (a === 169 && b === 254)
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && (b === 0 || b === 168))
		|| (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
		|| (a === 203 && b === 0 && c === 113);
}

function parseIpv6(host: string): number[] | null {
	const zoneIndex = host.indexOf('%');
	if (zoneIndex >= 0) return null;
	const halves = host.split('::');
	if (halves.length > 2) return null;
	const parsePart = (part: string): number[] | null => {
		if (!part) return [];
		const values: number[] = [];
		for (const token of part.split(':')) {
			if (token.includes('.')) {
				const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(token);
				if (!match) return null;
				const bytes = match.slice(1).map(Number);
				if (bytes.some((value) => value > 255)) return null;
				values.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/iu.test(token)) return null;
			values.push(Number.parseInt(token, 16));
		}
		return values;
	};
	const left = parsePart(halves[0] ?? '');
	const right = parsePart(halves[1] ?? '');
	if (!left || !right) return null;
	if (halves.length === 1) return left.length === 8 ? left : null;
	const omitted = 8 - left.length - right.length;
	if (omitted < 1) return null;
	return [...left, ...Array.from({ length: omitted }, () => 0), ...right];
}

function isBlockedIpv6(parts: number[]): boolean {
	if (parts.length !== 8) return true;
	if (parts.every((value) => value === 0)) return true;
	if (parts.slice(0, 7).every((value) => value === 0) && parts[7] === 1) return true;
	if ((parts[0]! & 0xfe00) === 0xfc00) return true;
	if ((parts[0]! & 0xffc0) === 0xfe80) return true;
	// Deprecated site-local space is still routed by some private networks.
	if ((parts[0]! & 0xffc0) === 0xfec0) return true;
	if ((parts[0]! & 0xff00) === 0xff00) return true;
	// The well-known and local-use NAT64 prefixes can translate literals into
	// destinations that the IPv4 policy would otherwise reject.
	if (parts[0] === 0x0064 && parts[1] === 0xff9b && parts.slice(2, 6).every((value) => value === 0)) return true;
	if (parts[0] === 0x0064 && parts[1] === 0xff9b && parts[2] === 0x0001) return true;
	const embeddedIpv4 = (parts.slice(0, 5).every((value) => value === 0) && parts[5] === 0xffff)
		|| parts.slice(0, 6).every((value) => value === 0)
		|| (parts.slice(0, 4).every((value) => value === 0) && parts[4] === 0xffff && parts[5] === 0);
	if (embeddedIpv4) {
		return isBlockedIpv4Parts(parts[6]! >> 8, parts[6]! & 0xff, parts[7]! >> 8, parts[7]! & 0xff);
	}
	if (parts[0] === 0x2002) {
		return isBlockedIpv4Parts(parts[1]! >> 8, parts[1]! & 0xff, parts[2]! >> 8, parts[2]! & 0xff);
	}
	return false;
}
