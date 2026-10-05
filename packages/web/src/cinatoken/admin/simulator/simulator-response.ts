/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	imageRequestMetaFromBody,
	parseImagesGenerationsResponse,
} from '../playground/browser-domain/image-generations'
import {
	inferPlaygroundParseMode,
	mergeAssistantTextParts,
} from '../playground/browser-domain/merge-assistant-text'
import {
	extractUsageFromStreamChunk,
	parseLastStreamUsage,
	tryParseUsageSummary,
} from '../playground/browser-domain/usage-parsing'
import {
	buildRequestLogsHref,
	buildToolsInvocationsHref,
	prettyJsonBody,
} from './simulator-utils'
import type { SimulatorResponse, SimulatorSnapshot } from './use-simulator'

export function safeImageSource(src: string): boolean {
	if (
		/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/u.test(src)
	)
		return true
	try {
		const url = new URL(src)
		return (
			(url.protocol === 'https:' || url.protocol === 'http:') &&
			!url.username &&
			!url.password
		)
	} catch {
		return false
	}
}
export function snapshotLogsHref(snapshot: SimulatorSnapshot): string {
	if (snapshot.selection.kind === 'tool')
		return buildToolsInvocationsHref({ toolId: snapshot.selection.toolId })
	return buildRequestLogsHref({
		apiKeyId: snapshot.keyId,
		modelId: snapshot.selection.modelId,
		routeGroup: snapshot.selection.routeGroup,
		protocol: snapshot.selection.protocol,
	})
}
export function simulatorResponseView(response: SimulatorResponse) {
	const selection = response.snapshot.selection
	const mode = inferPlaygroundParseMode(response.meta.contentType)
	const parts = mergeAssistantTextParts(
		response.raw,
		selection.protocol,
		mode ?? 'text'
	)
	let usage =
		tryParseUsageSummary(response.raw, selection.protocol) ??
		parseLastStreamUsage(response.raw, selection.protocol)
	if (!usage && mode === 'ndjson') {
		for (const line of response.raw.trim().split(/\r?\n/).reverse()) {
			try {
				const parsed: unknown = JSON.parse(line)
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
					usage = extractUsageFromStreamChunk(
						parsed as Record<string, unknown>,
						selection.protocol
					)
			} catch {
				/* Ignore incomplete streaming frames. */
			}
			if (usage) break
		}
	}
	const imageResult =
		selection.kind === 'image'
			? parseImagesGenerationsResponse(
					response.raw,
					imageRequestMetaFromBody(response.snapshot.requestBody)
				)
			: { images: [], usageHint: null }
	const images = imageResult.images.filter((item) => safeImageSource(item.src))
	const budgetError =
		response.meta.status === 402 ||
		/(?:budget_exceeded|budget exceeded|insufficient_(?:credits|balance)|key_budget|user_budget|workspace_budget)/i.test(
			response.raw
		)
	return {
		reasoning: parts.reasoning,
		body: parts.body || prettyJsonBody(response.raw),
		usage: imageResult.usageHint ?? usage,
		images,
		budgetError,
	}
}
