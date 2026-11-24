/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { safeLogText } from '../request-logs/request-log-domain'
import {
	asLogJsonObject,
	formatLogJson,
	parseSafeLogJson,
	type LogJsonValue,
} from '../request-logs/safe-log-json'

export const MCP_INVOCATION_PROVIDER = 'octafuse-mcp'
const serverSlug = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u

export function isMcpServerSlug(value: string): boolean {
	return value === value.trim() && serverSlug.test(value)
}

type InvocationLog = {
	provider_id?: string | null
	model_id?: string | null
	request_body?: string | null
}

export function isMcpInvocation(log: InvocationLog): boolean {
	return (
		log.provider_id === MCP_INVOCATION_PROVIDER ||
		log.model_id?.startsWith('mcp:') === true
	)
}

/** The first slash separates the immutable server slug from the upstream tool name. */
export function mcpInvocationIdentity(
	model: string | null | undefined
): { slug: string; tool: string } | null {
	if (!model?.startsWith('mcp:')) return null
	const slash = model.indexOf('/', 4)
	if (slash < 0) return null
	const slug = model.slice(4, slash)
	const tool = model.slice(slash + 1)
	return isMcpServerSlug(slug) && tool.trim() ? { slug, tool } : null
}

/** Read the precision-preserving safe tree so nested secrets never enter the summary. */
export function mcpInvocationSummary(log: InvocationLog): {
	slug: string | null
	tool: string | null
	label: string
	argumentSummary: string | null
} {
	const identity = mcpInvocationIdentity(log.model_id)
	let request: Record<string, LogJsonValue> | null = null
	try {
		if (log.request_body?.trim())
			request = asLogJsonObject(parseSafeLogJson(log.request_body))
	} catch {
		// Truncated or malformed payloads retain only the model identity.
	}
	const name = request?.name
	const toolText =
		typeof name === 'string' && name.trim()
			? safeLogText(name.trim())
			: identity?.tool && safeLogText(identity.tool)
	let tool = toolText || null
	if (tool && tool.length > 256) tool = `${tool.slice(0, 253)}…`
	const args = asLogJsonObject(request?.arguments)
	const parts = args
		? Object.entries(args)
				.slice(0, 3)
				.map(([key, value]) => {
					const valueText =
						typeof value === 'string' ? value : formatLogJson(value, false)
					const text = /^(?:key|auth)$/iu.test(key)
						? '[redacted]'
						: safeLogText(valueText)
					const clipped = text.length > 80 ? `${text.slice(0, 77)}…` : text
					return `${safeLogText(key).slice(0, 80)}=${clipped}`
				})
		: []
	const slug = identity?.slug ?? null
	return {
		slug,
		tool: tool || null,
		label:
			[slug, tool].filter(Boolean).join(' / ') ||
			safeLogText(log.model_id ?? '—').slice(0, 512),
		argumentSummary: parts.join(' ') || null,
	}
}
