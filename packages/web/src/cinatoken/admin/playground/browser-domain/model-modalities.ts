/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** Browser classifications consume the safe context's already resolved kind. */
export type ModelKindFields = {
	kind?: 'llm' | 'image' | 'audio' | 'rerank'
	output_modalities?: string | readonly string[] | null
	input_modalities?: string | readonly string[] | null
}
export function modalities(
	value: string | readonly string[] | null | undefined
): string[] {
	if (Array.isArray(value))
		return value.filter((item): item is string => typeof item === 'string')
	if (typeof value !== 'string') return []
	try {
		const parsed: unknown = JSON.parse(value)
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === 'string')
			: []
	} catch {
		return []
	}
}
export function isImageGenerationModel(model: ModelKindFields): boolean {
	return (
		model.kind === 'image' ||
		modalities(model.output_modalities).includes('image')
	)
}
export function isAudioModel(model: ModelKindFields): boolean {
	return (
		model.kind === 'audio' ||
		modalities(model.output_modalities).some((value) =>
			['audio', 'speech', 'transcription'].includes(value)
		)
	)
}
export function isAudioTranscriptionModel(model: ModelKindFields): boolean {
	return modalities(model.output_modalities).includes('transcription')
}
export function isRerankModel(model: ModelKindFields): boolean {
	return (
		model.kind === 'rerank' ||
		modalities(model.output_modalities).includes('rerank')
	)
}
