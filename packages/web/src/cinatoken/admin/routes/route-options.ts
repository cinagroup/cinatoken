/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
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
	routeOperations,
	routeProtocols,
	type RouteDraft,
	type RouteRow,
} from './route-domain'

export function isRouteProtocol(value: string): value is UpstreamProtocol {
	return (routeProtocols as readonly string[]).includes(value)
}

/** Public operations follow the model modality; an unknown model cannot authorize a new topology. */
export function requestOperationsForModel(
	model: AdminModel | undefined,
	protocol: string,
	providerModelName = ''
): readonly string[] {
	if (!model || !isRouteProtocol(protocol)) return []
	if (isImageGenerationModel(model))
		return protocol === 'openai' ? ['images.generations', 'images.edits'] : []
	if (isEmbeddingModel(model))
		return protocol === 'openai' ? ['embeddings'] : []
	if (isRerankModel(model)) return protocol === 'openai' ? ['rerank'] : []
	if (isAudioTranscriptionModel(model)) {
		if (protocol === 'openai') return ['audio.transcriptions']
		if (protocol !== 'dashscope') return []
		const realtime = [
			'audio.transcriptions.realtime.inference',
			'audio.transcriptions.realtime.session',
		]
		return [
			'audio.transcriptions.multimodal',
			...realtime.filter(
				(operation) =>
					!providerModelName.trim() ||
					isDashScopeRealtimeAsrModelOperationCompatible(
						providerModelName,
						operation
					)
			),
		]
	}
	if (isAudioSpeechModel(model)) {
		if (protocol === 'openai') return ['audio.speech']
		return protocol === 'dashscope' ? ['audio.speech.realtime.inference'] : []
	}
	if (isTextLlmModel(model) && protocol === 'openai')
		return ['chat', 'responses']
	return routeOperations(protocol)
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
	if (!model) return []
	const capabilities = new Set(
		configuredProviderCapabilities(provider, protocol)
	)
	if (isAudioTranscriptionModel(model) && protocol === 'dashscope') {
		const result: string[] = []
		if (capabilities.has('audio.transcriptions.multimodal'))
			result.push('audio.transcriptions.multimodal')
		if (
			capabilities.has('audio.transcriptions') &&
			capabilities.has('audio.transcriptions.tasks')
		)
			result.push('audio.transcriptions.async')
		for (const [capability, operation] of [
			['audio.realtime.inference', 'audio.transcriptions.realtime.inference'],
			['audio.realtime.session', 'audio.transcriptions.realtime.session'],
		]) {
			if (
				capabilities.has(capability!) &&
				isDashScopeRealtimeAsrModelOperationCompatible(
					providerModelName,
					operation!
				)
			)
				result.push(operation!)
		}
		return result
	}
	if (isAudioSpeechModel(model) && protocol === 'dashscope') {
		const result: string[] = []
		if (capabilities.has('audio.speech')) result.push('audio.speech')
		if (capabilities.has('audio.realtime.inference'))
			result.push('audio.speech.realtime.inference')
		return result
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

export const dashScopePresets = {
	'flash-convert': {
		requestProtocol: 'openai',
		requestOperation: 'audio.transcriptions',
		upstreamProtocol: 'dashscope',
		upstreamOperation: 'audio.transcriptions.multimodal',
		adapter: 'dashscope-asr-qwen-audio-file',
	},
	'flash-passthrough': {
		requestProtocol: 'dashscope',
		requestOperation: 'audio.transcriptions.multimodal',
		upstreamProtocol: 'dashscope',
		upstreamOperation: 'audio.transcriptions.multimodal',
		adapter: 'passthrough',
	},
	filetrans: {
		requestProtocol: 'openai',
		requestOperation: 'audio.transcriptions',
		upstreamProtocol: 'dashscope',
		upstreamOperation: 'audio.transcriptions.async',
		adapter: 'dashscope-asr-file-async',
	},
	nonrealtime: {
		requestProtocol: 'openai',
		requestOperation: 'audio.speech',
		upstreamProtocol: 'dashscope',
		upstreamOperation: 'audio.speech',
		adapter: 'dashscope-tts-speech',
	},
	realtime: {
		requestProtocol: 'dashscope',
		requestOperation: 'audio.speech.realtime.inference',
		upstreamProtocol: 'dashscope',
		upstreamOperation: 'audio.speech.realtime.inference',
		adapter: 'passthrough',
	},
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
