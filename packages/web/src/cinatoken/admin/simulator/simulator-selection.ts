/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ImageOperation } from '../playground/browser-domain/image-generations'
import {
	isInvokeKind,
	parseGatewayToolId,
	resolveRequestOperation,
	type AudioOperation,
	type GatewayToolId,
	type InvokeKind,
	type SimulatorProtocol,
	type OpenaiLlmOperation,
	type GeminiContentAction,
} from '../playground/browser-domain/invoke-kind'
import { modalities } from '../playground/browser-domain/model-modalities'
import type { SimulatorContext, SimulatorModel } from './simulator-contracts'
import {
	bodyTemplateForSelection,
	filterMatchingActiveRoutes,
	listDashScopeAudioClientOperations,
	listSupportedClientSurfaces,
	buildModelRoutingString,
	LS_INVOKE_KIND,
	LS_MODEL_ID,
	LS_ROUTE_GROUP,
	LS_PROTOCOL,
	LS_OPENAI_LLM_OPERATION,
	LS_TOOL_ID,
	LS_PROXY,
	LS_KEY_ID,
} from './simulator-utils'

export type SimulatorSelection = {
	kind: InvokeKind
	modelId: string
	routeGroup: string
	protocol: SimulatorProtocol
	llmOperation: OpenaiLlmOperation
	geminiAction: GeminiContentAction
	imageOperation: ImageOperation
	audioOperation: AudioOperation
	dashscopeOperation: string
	toolId: GatewayToolId
}
export const DEFAULT_SELECTION: SimulatorSelection = {
	kind: 'llm',
	modelId: '',
	routeGroup: '',
	protocol: 'openai',
	llmOperation: 'chat',
	geminiAction: 'streamGenerateContent',
	imageOperation: 'generations',
	audioOperation: 'transcriptions',
	dashscopeOperation: '',
	toolId: 'web-search',
}
export type SimulatorSearch = Partial<{
	kind: string
	model_id: string
	route_group: string
	protocol: string
	tool: string
	key_id: string
	invalidTarget: boolean
}>
export function readPreference(key: string): string {
	try {
		return typeof localStorage === 'undefined'
			? ''
			: (localStorage.getItem(key) ?? '')
	} catch {
		return ''
	}
}
function protocol(value: string | undefined): SimulatorProtocol {
	if (value === 'anthropic' || value === 'gemini' || value === 'dashscope')
		return value
	return 'openai'
}
export function initialSelection(search?: SimulatorSearch): SimulatorSelection {
	const kind =
		search?.kind ?? (search?.tool ? 'tool' : readPreference(LS_INVOKE_KIND))
	return {
		...DEFAULT_SELECTION,
		kind: isInvokeKind(kind) ? kind : 'llm',
		modelId: search?.model_id ?? readPreference(LS_MODEL_ID),
		routeGroup: search?.route_group ?? readPreference(LS_ROUTE_GROUP),
		protocol: protocol(search?.protocol ?? readPreference(LS_PROTOCOL)),
		llmOperation:
			readPreference(LS_OPENAI_LLM_OPERATION) === 'responses'
				? 'responses'
				: 'chat',
		toolId:
			parseGatewayToolId(search?.tool ?? readPreference(LS_TOOL_ID)) ??
			'web-search',
	}
}
export function savePreferences(
	selection: SimulatorSelection,
	proxy: string,
	keyId: string
): void {
	try {
		if (typeof localStorage === 'undefined') return
		const values = {
			[LS_INVOKE_KIND]: selection.kind,
			[LS_MODEL_ID]: selection.modelId,
			[LS_ROUTE_GROUP]: selection.routeGroup,
			[LS_PROTOCOL]: selection.protocol,
			[LS_OPENAI_LLM_OPERATION]: selection.llmOperation,
			[LS_TOOL_ID]: selection.toolId,
			[LS_PROXY]: proxy,
			[LS_KEY_ID]: keyId,
		}
		for (const [key, value] of Object.entries(values))
			localStorage.setItem(key, value)
	} catch {
		/* Nonsecret preferences are optional when browser storage is unavailable. */
	}
}
export function audioOperationForModel(model?: SimulatorModel): AudioOperation {
	if (model?.audio_operation) return model.audio_operation
	if (
		model &&
		modalities(model.output_modalities).some((value) => value === 'speech')
	)
		return 'speech'
	return 'transcriptions'
}
export function routedModels(context?: SimulatorContext): SimulatorModel[] {
	if (!context) return []
	const active = new Set(
		context.routes
			.filter((route) => route.status.toLowerCase() === 'active')
			.map((route) => route.model_id)
	)
	return context.models.filter((model) => active.has(model.id))
}
export function simulatorModelKind(
	model: SimulatorModel
): 'llm' | 'image' | 'audio' {
	return model.kind === 'rerank' ? 'llm' : model.kind
}
export function reconcileSelection(
	selection: SimulatorSelection,
	context?: SimulatorContext
): SimulatorSelection {
	if (!context || selection.kind === 'tool') return selection
	const model = routedModels(context).find(
		(row) =>
			row.id === selection.modelId && simulatorModelKind(row) === selection.kind
	)
	if (!model)
		return { ...selection, modelId: '', routeGroup: '', dashscopeOperation: '' }
	const next = { ...selection, audioOperation: audioOperationForModel(model) }
	if (
		model.kind === 'audio' &&
		!model.audio_operation &&
		!model.output_modalities.some(
			(value) => value === 'speech' || value === 'transcription'
		)
	) {
		const operations = context.routes
			.filter(
				(route) =>
					route.model_id === model.id && route.status.toLowerCase() === 'active'
			)
			.flatMap((route) => {
				const result = [route.upstream_operation ?? '']
				try {
					const surfaces = JSON.parse(route.surfaces) as Array<{
						request_operation: string
						status: string
					}>
					result.push(
						...surfaces
							.filter((surface) => surface.status !== 'disabled')
							.map((surface) => surface.request_operation)
					)
				} catch {
					/* No credential-bearing model profile is needed for legacy routes. */
				}
				return result
			})
		if (
			operations.some((operation) => operation.startsWith('audio.speech')) &&
			!operations.some((operation) =>
				operation.startsWith('audio.transcriptions')
			)
		)
			next.audioOperation = 'speech'
	}
	const groups = context.routes
		.filter(
			(row) =>
				row.model_id === model.id && row.status.toLowerCase() === 'active'
		)
		.map((row) => row.route_group || 'default')
	if (
		next.routeGroup &&
		next.routeGroup !== 'default' &&
		!groups.includes(next.routeGroup)
	)
		next.routeGroup = ''
	const surfaces = listSupportedClientSurfaces(
		context.routes,
		model.id,
		next.routeGroup
	)
	let protocols = surfaces.protocols
	if (next.kind === 'image')
		protocols = protocols.filter((item) => item === 'openai')
	if (next.kind === 'audio')
		protocols = protocols.filter(
			(item) => item === 'openai' || item === 'dashscope'
		)
	if (!protocols.includes(next.protocol))
		next.protocol = protocols[0] ?? 'openai'
	if (
		next.protocol === 'openai' &&
		next.kind === 'llm' &&
		!surfaces.openaiLlmOperations.includes(next.llmOperation)
	)
		next.llmOperation = surfaces.openaiLlmOperations[0] ?? 'chat'
	if (
		next.kind === 'image' &&
		!surfaces.imageOperations.includes(next.imageOperation)
	)
		next.imageOperation = surfaces.imageOperations[0] ?? 'generations'
	const operations = listDashScopeAudioClientOperations(
		context.routes,
		model.id,
		next.routeGroup,
		next.audioOperation
	)
	if (!operations.includes(next.dashscopeOperation))
		next.dashscopeOperation = operations[0] ?? ''
	return next
}
export function requestOperation(selection: SimulatorSelection): string | null {
	return resolveRequestOperation({
		kind: selection.kind,
		protocol: selection.protocol,
		imageOperation: selection.imageOperation,
		audioOperation: selection.audioOperation,
		llmOperation: selection.llmOperation,
		geminiAction: selection.geminiAction,
		dashscopeRequestOperation: selection.dashscopeOperation || undefined,
	})
}
export function selectionTemplate(
	selection: SimulatorSelection,
	context?: SimulatorContext
): string {
	const candidates = filterMatchingActiveRoutes(
		context?.routes ?? [],
		selection.modelId,
		selection.routeGroup,
		selection.protocol,
		requestOperation(selection) ?? undefined
	)
	const dashscope = candidates.find(
		(route) => route.upstream_protocol === 'dashscope'
	)
	let operation = selection.dashscopeOperation
	if (
		selection.protocol === 'openai' &&
		candidates.some(
			(route) => route.upstream_operation === 'audio.transcriptions.async'
		)
	)
		operation = 'audio.transcriptions.async'
	return bodyTemplateForSelection(
		selection.protocol,
		selection.kind === 'image',
		selection.imageOperation,
		selection.kind === 'audio' ? selection.audioOperation : null,
		selection.kind === 'tool' ? selection.toolId : undefined,
		operation,
		dashscope?.provider_model_name,
		selection.llmOperation
	)
}
export function routingString(selection: SimulatorSelection): string {
	return buildModelRoutingString(selection.modelId, selection.routeGroup)
}
export function parseSimulatorBody(
	text: string
): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text)
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}
export function isRealtimeSelection(selection: SimulatorSelection): boolean {
	return (
		selection.kind === 'audio' &&
		selection.protocol === 'dashscope' &&
		selection.dashscopeOperation !== 'audio.transcriptions.multimodal'
	)
}
/** LLM model/group/Gemini URL changes keep an edited body; protocol and wire-format changes replace its template. */
export function selectionNeedsNewTemplate(
	previous: SimulatorSelection,
	next: SimulatorSelection
): boolean {
	if (
		previous.kind !== next.kind ||
		previous.protocol !== next.protocol ||
		previous.llmOperation !== next.llmOperation
	)
		return true
	if (next.kind === 'tool') return previous.toolId !== next.toolId
	return next.kind === 'image' || next.kind === 'audio'
}
