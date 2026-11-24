/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type {
	InvokeKind,
	SimulatorProtocol,
} from '../playground/browser-domain/invoke-kind'

export const SIMULATOR_PROTOCOLS: readonly SimulatorProtocol[] = [
	'openai',
	'anthropic',
	'gemini',
	'dashscope',
	'minimax',
	'volcengine',
]
export const DASHSCOPE_HTTP_AUDIO_OPERATIONS = [
	'audio.transcriptions.multimodal',
	'audio.transcriptions.async',
	'audio.speech',
	'audio.speech.stream',
	'audio.speech.multimodal',
] as const
export const DASHSCOPE_REALTIME_AUDIO_OPERATIONS = [
	'audio.transcriptions.realtime.inference',
	'audio.transcriptions.realtime.session',
	'audio.speech.realtime.inference',
] as const
export function isSimulatorProtocol(value: string): value is SimulatorProtocol {
	return SIMULATOR_PROTOCOLS.some((protocol) => protocol === value)
}
/** Public operations with registered Proxy handlers, separated from upstream capabilities. */
export function simulatorOperations(
	kind: InvokeKind,
	protocol: SimulatorProtocol
): readonly string[] {
	if (kind === 'tool') return []
	if (kind === 'llm') {
		if (protocol === 'openai') return ['chat', 'responses']
		if (protocol === 'anthropic') return ['messages']
		if (protocol === 'gemini') return ['models.generate']
		return []
	}
	if (kind === 'image') {
		if (protocol === 'openai') return ['images.generations', 'images.edits']
		if (protocol === 'gemini') return ['models.generate']
		if (protocol === 'dashscope') return ['images.generations.multimodal']
		if (protocol === 'minimax' || protocol === 'volcengine')
			return ['images.generations']
		return []
	}
	if (protocol === 'openai' || protocol === 'minimax')
		return ['audio.transcriptions', 'audio.speech']
	if (protocol === 'dashscope')
		return [
			...DASHSCOPE_HTTP_AUDIO_OPERATIONS,
			...DASHSCOPE_REALTIME_AUDIO_OPERATIONS,
		]
	return []
}
export function canonicalSimulatorOperation(
	protocol: string,
	operation: string
): string {
	if (
		protocol === 'gemini' &&
		['generateContent', 'streamGenerateContent'].includes(operation)
	)
		return 'models.generate'
	return operation
}
export function supportedSimulatorOperation(
	kind: InvokeKind,
	protocol: SimulatorProtocol,
	operation: string
): boolean {
	return simulatorOperations(kind, protocol).includes(
		canonicalSimulatorOperation(protocol, operation)
	)
}
/** Concrete native paths; no unrecognized operation can silently become Chat. */
export function dashScopeHttpPath(operation: string): string {
	if (
		[
			'images.generations.multimodal',
			'audio.transcriptions.multimodal',
			'audio.speech.multimodal',
		].includes(operation)
	)
		return '/v1/dashscope/services/aigc/multimodal-generation/generation'
	if (operation === 'audio.speech' || operation === 'audio.speech.stream')
		return '/v1/dashscope/services/audio/tts/SpeechSynthesizer'
	if (operation === 'audio.transcriptions.async')
		return '/v1/dashscope/services/audio/asr/transcription'
	throw new TypeError('Unsupported DashScope HTTP operation')
}

const conversions: Record<string, readonly [string, string, string]> = {
	'dashscope-asr-qwen-file': [
		'dashscope',
		'audio.transcriptions.multimodal',
		'audio.transcriptions',
	],
	'dashscope-asr-qwen-audio-file': [
		'dashscope',
		'audio.transcriptions.multimodal',
		'audio.transcriptions',
	],
	'dashscope-asr-fun-file': [
		'dashscope',
		'audio.transcriptions.multimodal',
		'audio.transcriptions',
	],
	'dashscope-asr-file-async': [
		'dashscope',
		'audio.transcriptions.async',
		'audio.transcriptions',
	],
	'dashscope-tts-speech': ['dashscope', 'audio.speech', 'audio.speech'],
	'dashscope-tts-qwen': [
		'dashscope',
		'audio.speech.multimodal',
		'audio.speech',
	],
	'dashscope-tts-minimax': [
		'dashscope',
		'audio.speech.multimodal',
		'audio.speech',
	],
	'dashscope-image-qwen': [
		'dashscope',
		'images.generations.multimodal',
		'images.generations',
	],
	'dashscope-image-wan': [
		'dashscope',
		'images.generations.multimodal',
		'images.generations',
	],
	'minimax-asr-file': [
		'minimax',
		'audio.transcriptions',
		'audio.transcriptions',
	],
	'minimax-tts': ['minimax', 'audio.speech', 'audio.speech'],
	'minimax-image': ['minimax', 'images.generations', 'images.generations'],
	'volcengine-image': [
		'volcengine',
		'images.generations',
		'images.generations',
	],
	'gemini-image': ['gemini', 'models.generate', 'images.generations'],
}
export function simulatorAdapterSupports(
	route: {
		adapter?: string | null
		upstream_protocol?: string | null
		upstream_operation?: string | null
	},
	protocol: string,
	operation: string
): boolean {
	const adapter = route.adapter ?? 'passthrough'
	if (adapter === 'passthrough') return true
	const conversion = conversions[adapter]
	return (
		!!conversion &&
		protocol === 'openai' &&
		route.upstream_protocol === conversion[0] &&
		route.upstream_operation === conversion[1] &&
		(operation === conversion[2] || operation === '*')
	)
}
