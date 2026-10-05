/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** Canonical ASCII subject precondition travels in a subprotocol, outside URLs and logs. */
export function buildPlaygroundSubjectProtocols(subject: string): string[] {
	const encoded = encodeURIComponent(subject)
	const base64 = btoa(encoded)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '')
	return ['cinatoken-playground', 'cinatoken-playground-subject.' + base64]
}
