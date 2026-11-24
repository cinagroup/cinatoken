/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { McpClientError, type executeMcpClient } from './mcp-client'

export function mcpClientResultMessage(
	result: Awaited<ReturnType<typeof executeMcpClient>>
): string | null {
	if (result.status < 200 || result.status >= 300) return 'clientHttpError'
	if (result.parsed.rpcError) return 'clientRpcError'
	return result.parsed.valid ? null : 'clientInvalid'
}

export function mcpClientFailureMessage(
	failure: unknown,
	cancelled = false
): string {
	if (cancelled) return 'cancelled'
	if (!(failure instanceof McpClientError)) return 'clientFailed'
	const keys = {
		invalid: 'clientInvalid',
		network: 'clientNetwork',
		cancelled: 'cancelled',
		timeout: 'clientTimeout',
		tooLarge: 'clientTooLarge',
	} as const
	return keys[failure.code]
}
