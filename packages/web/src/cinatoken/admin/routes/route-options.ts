/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	getAdapterByPresetIntent,
	requestOperationsFromRegistry,
	upstreamOperationsFromRegistry,
	requiredCapabilitiesForUpstreamOperation,
	type AdapterModelKind,
	type AdapterPresetIntent,
} from '@octafuse/core/adapters/registry'
import {
	isAudioSpeechModel,
	isAudioTranscriptionModel,
	isEmbeddingModel,
	isImageGenerationModel,
	isRerankModel,
	isTextLlmModel,
} from '@octafuse/core/db/model-modalities'
import {
	isDashScopeRealtimeAsrModelOperationCompatible,
	isRouteAdapterCompatible,
} from '@octafuse/core/route-topology'
import type { UpstreamProtocol } from '@octafuse/core/upstream-protocol'
import type { AdminModel } from '../model-contracts'
import type { AdminProvider } from '../provider-contracts'
import {
	normalizeProviderEndpoints,
	PROVIDER_CAPABILITIES,
	type ProviderEndpoints,
} from '../provider-endpoints'
import {
	routeAdapters,
	draftFromRoute,
	routeProtocols,
	type RouteDraft,
	type RouteRow,
} from './route-domain'

export function isRouteProtocol(value: string): value is UpstreamProtocol {
	return (routeProtocols as readonly string[]).includes(value)
}

export function routeModelKind(
	model: AdminModel | undefined
): AdapterModelKind | null {
	if (!model) return null
	if (isImageGenerationModel(model)) return 'image'
	if (isAudioTranscriptionModel(model)) return 'asr'
	if (isAudioSpeechModel(model)) return 'tts'
	if (isTextLlmModel(model)) return 'llm'
	return null
}
function filterRealtimeOperations(
	operations: readonly string[],
	providerModelName: string
): readonly string[] {
	return operations.filter((operation) =>
		isDashScopeRealtimeAsrModelOperationCompatible(providerModelName, operation)
	)
}
/** The registry owns selectable public operations; display-only legacy paths stay read-only. */
export function requestOperationsForModel(
	model: AdminModel | undefined,
	protocol: string,
	providerModelName = ''
): readonly string[] {
	if (!model || !isRouteProtocol(protocol)) return []
	if (isEmbeddingModel(model))
		return protocol === 'openai'
			? ['embeddings']
			: protocol === 'gemini'
				? ['models.embed']
				: []
	if (isRerankModel(model)) return protocol === 'openai' ? ['rerank'] : []
	const kind = routeModelKind(model)
	if (!kind) return []
	const operations = requestOperationsFromRegistry(protocol, kind)
	return kind === 'asr' && protocol === 'dashscope'
		? filterRealtimeOperations(operations, providerModelName)
		: operations
}

/** Provider endpoints are already validated/redacted by the browser DTO. Never infer capabilities from a redacted config. */
export function configuredProviderCapabilities(
	provider: AdminProvider | undefined,
	protocol: string
): readonly string[] {
	if (
		!provider ||
		provider.endpointsState !== 'available' ||
		!isRouteProtocol(protocol)
	)
		return []
	let endpoints: ProviderEndpoints
	try {
		endpoints = normalizeProviderEndpoints(provider.endpoints)
	} catch {
		return []
	}
	const config = endpoints[protocol]
	if (!config) return []
	if (config.base)
		return protocol === 'gemini'
			? ['models.generate']
			: PROVIDER_CAPABILITIES[protocol]
	const configured = Object.entries(config.endpoints ?? {})
		.filter(([, url]) => Boolean(url))
		.map(([key]) => key)
	if (protocol === 'gemini')
		return configured.some((key) =>
			['models.generate', 'generateContent', 'streamGenerateContent'].includes(
				key
			)
		)
			? ['models.generate']
			: []
	return configured
}

export function upstreamOperationsForProviderModel(
	provider: AdminProvider | undefined,
	model: AdminModel | undefined,
	protocol: string,
	providerModelName = ''
): readonly string[] {
	if (!model || !isRouteProtocol(protocol)) return []
	const capabilities = new Set(
		configuredProviderCapabilities(provider, protocol)
	)
	const kind = routeModelKind(model)
	if (kind && kind !== 'llm') {
		const operations = upstreamOperationsFromRegistry(protocol, kind).filter(
			(operation) =>
				requiredCapabilitiesForUpstreamOperation(protocol, operation).every(
					(capability) => capabilities.has(capability)
				)
		)
		return kind === 'asr' && protocol === 'dashscope'
			? filterRealtimeOperations(operations, providerModelName)
			: operations
	}
	return requestOperationsForModel(model, protocol, providerModelName).filter(
		(operation) => capabilities.has(operation)
	)
}

export function compatibleAdaptersForDraft(
	draft: RouteDraft
): readonly string[] {
	if (
		!isRouteProtocol(draft.requestProtocol) ||
		!isRouteProtocol(draft.upstreamProtocol)
	)
		return []
	return routeAdapters.filter((adapter) =>
		isRouteAdapterCompatible({
			adapter,
			requestProtocol: draft.requestProtocol as UpstreamProtocol,
			requestOperation: draft.requestOperation,
			upstreamProtocol: draft.upstreamProtocol as UpstreamProtocol,
			upstreamOperation: draft.upstreamOperation,
		})
	)
}

function registryPreset(intent: AdapterPresetIntent): Partial<RouteDraft> {
	const descriptor = getAdapterByPresetIntent(intent)
	const operation = descriptor?.upstream.operations[0]
	if (!descriptor || !operation)
		throw new Error('Route preset metadata is unavailable')
	return {
		requestProtocol: descriptor.request.protocol,
		requestOperation: descriptor.request.operation,
		upstreamProtocol: descriptor.upstream.protocol,
		upstreamOperation: operation,
		adapter: descriptor.id,
	}
}
export const dashScopePresets = {
	'flash-convert': registryPreset('dashscope-asr-flash-convert'),
	'flash-passthrough': registryPreset('dashscope-asr-flash-passthrough'),
	filetrans: registryPreset('dashscope-asr-filetrans'),
	nonrealtime: registryPreset('dashscope-tts-nonrealtime'),
	realtime: registryPreset('dashscope-tts-realtime'),
	'image-qwen': registryPreset('dashscope-image-qwen'),
	'image-wan': registryPreset('dashscope-image-wan'),
} satisfies Record<string, Partial<RouteDraft>>
export type DashScopePreset = keyof typeof dashScopePresets

export function topologyAvailable(
	draft: RouteDraft,
	model: AdminModel | undefined,
	provider: AdminProvider | undefined
): boolean {
	return (
		requestOperationsForModel(
			model,
			draft.requestProtocol,
			draft.providerModelName
		).includes(draft.requestOperation) &&
		upstreamOperationsForProviderModel(
			provider,
			model,
			draft.upstreamProtocol,
			draft.providerModelName
		).includes(draft.upstreamOperation) &&
		compatibleAdaptersForDraft(draft).includes(draft.adapter)
	)
}

export function applyDashScopePreset(
	draft: RouteDraft,
	preset: DashScopePreset
): RouteDraft {
	return { ...draft, ...dashScopePresets[preset] }
}

/** Existing target fields remain manageable when redacted provider capabilities cannot be re-proved. */
export function routeTopologyRequiresVerification(
	draft: RouteDraft,
	original: RouteRow | null,
	duplicate = false
): boolean {
	if (!original || duplicate) return true
	const baseline = draftFromRoute(original)
	return (
		[
			'modelId',
			'providerId',
			'providerModelName',
			'group',
			'requestProtocol',
			'requestOperation',
			'upstreamProtocol',
			'upstreamOperation',
			'adapter',
		] as const
	).some((key) => draft[key] !== baseline[key])
}

/** Selecting a different model/provider/protocol reconciles dependent choices in one state update. */
export function reconcileRouteDraft(
	draft: RouteDraft,
	models: AdminModel[],
	providers: AdminProvider[]
): RouteDraft {
	const model = models.find((row) => row.id === draft.modelId)
	const provider = providers.find((row) => row.id === draft.providerId)
	const request = requestOperationsForModel(
		model,
		draft.requestProtocol,
		draft.providerModelName
	)
	const upstream = upstreamOperationsForProviderModel(
		provider,
		model,
		draft.upstreamProtocol,
		draft.providerModelName
	)
	const next = {
		...draft,
		requestOperation: request.includes(draft.requestOperation)
			? draft.requestOperation
			: (request[0] ?? ''),
		upstreamOperation: upstream.includes(draft.upstreamOperation)
			? draft.upstreamOperation
			: (upstream[0] ?? ''),
	}
	const adapters = compatibleAdaptersForDraft(next)
	return {
		...next,
		adapter: adapters.includes(next.adapter)
			? next.adapter
			: (adapters[0] ?? ''),
	}
}
