/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export class GatewayKeyInputError extends Error {
	constructor() {
		super('Invalid Gateway key input')
		this.name = 'GatewayKeyInputError'
	}
}
function safeJson(value: unknown, depth = 0): boolean {
	if (depth > 16) return false
	if (value === null || typeof value === 'boolean' || typeof value === 'string')
		return true
	if (typeof value === 'number') return Number.isFinite(value)
	if (Array.isArray(value))
		return (
			value.length <= 1000 && value.every((part) => safeJson(part, depth + 1))
		)
	if (!value || typeof value !== 'object') return false
	const entries = Object.entries(value)
	return (
		entries.length <= 1000 &&
		entries.every(
			([key, part]) =>
				!['__proto__', 'constructor', 'prototype'].includes(key) &&
				safeJson(part, depth + 1)
		)
	)
}
export function parseGatewayKeyMetadata(
	raw: string
): Record<string, unknown> | null {
	if (!raw.trim()) return null
	if (new TextEncoder().encode(raw).length > 65_536)
		throw new GatewayKeyInputError()
	try {
		const value: unknown = JSON.parse(raw)
		if (
			!value ||
			typeof value !== 'object' ||
			Array.isArray(value) ||
			!safeJson(value)
		)
			throw new GatewayKeyInputError()
		return value as Record<string, unknown>
	} catch {
		throw new GatewayKeyInputError()
	}
}
export function gatewayKeyMetadataReadable(raw: string | null): boolean {
	if (raw === null) return true
	try {
		parseGatewayKeyMetadata(raw)
		return true
	} catch {
		return false
	}
}
