/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** SEO uses an operator-configured origin, never a request Host/forwarded header. */
export function publicSiteOrigin(value) {
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > 2048 ||
		value.trim() !== value
	)
		throw new TypeError(
			'CINATOKEN_WEB_PUBLIC_ORIGIN must be a trusted HTTPS origin'
		)
	let url
	try {
		url = new URL(value)
	} catch {
		throw new TypeError(
			'CINATOKEN_WEB_PUBLIC_ORIGIN must be a trusted HTTPS origin'
		)
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash ||
		url.origin !== value.replace(/\/$/, '')
	)
		throw new TypeError(
			'CINATOKEN_WEB_PUBLIC_ORIGIN must be a trusted HTTPS origin'
		)
	return url.origin
}
