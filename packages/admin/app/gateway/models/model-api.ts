import { useMemo } from 'react';
import { useAdvancedEditorRequest } from '@/components/routing-workbench/AdvancedEditorGate';
import { isAudioModel, isImageGenerationModel, isRerankModel } from '@octafuse/core/db/model-modalities';
import type { RouteListRow } from '../routes/types';
import { deleteRoute } from '../routes/route-api';
import { resolveModelKind } from '@octafuse/core/db/model-kind';
import { readApiJson } from '@/lib/api-json';
import { normalizeModelVendorInput } from '@/lib/model-vendor';
import {
	attachCatalogScheduleToProfileJson,
	serializeAudioPricingDraft,
	serializeCatalogScheduleDraft,
	serializeDraftRowsToProfileJson,
	serializeImagePricingDraft,
	type AudioPricingDraftState,
	type CatalogScheduleFormWindow,
	type ImagePricingDraftState,
	type PricingTierDraftRow,
} from '@/lib/pricing-tiers-draft';
import type { ModelSyncApplyBody, ModelSyncApplyOutput, ModelSyncReport } from '@/lib/model-sync-diff';
import { parseMetadataForSave } from './model-utils';
import type { ModelFormData, ModelImportResult, ModelListItem, PresetCatalogRow } from './types';

export async function fetchModelsList(request: typeof fetch = fetch): Promise<ModelListItem[]> {
	const response = await request('/api/admin/models');
	const data = await readApiJson<ModelListItem[]>(response);
	if (data.success && data.data) return data.data;
	throw new Error(data.message || 'Failed to load models');
}

export async function fetchModelDetail(id: string, request: typeof fetch = fetch): Promise<ModelListItem> {
	const response = await request(`/api/admin/models/${encodeURIComponent(id)}`);
	const data = await readApiJson<ModelListItem>(response);
	if (data.success && data.data) return data.data;
	throw new Error(data.message || 'Failed to load model');
}

export async function saveModel(
	formData: ModelFormData,
	pricingTierRows: PricingTierDraftRow[],
	editingModelId: string | null,
	imagePricingDraft?: ImagePricingDraftState | null,
	audioPricingDraft?: AudioPricingDraftState | null,
	catalogScheduleWindows?: CatalogScheduleFormWindow[],
	request: typeof fetch = fetch,
): Promise<{ success: true } | { success: false; message: string }> {
	const isImage = resolveModelKind({ output_modalities: formData.output_modalities }) === 'image';
	const isAudio = !!audioPricingDraft;
	const tierJson = isAudio
		? serializeAudioPricingDraft(audioPricingDraft)
		: isImage && imagePricingDraft
		? serializeImagePricingDraft(imagePricingDraft)
		: serializeDraftRowsToProfileJson(pricingTierRows);
	if (!tierJson.ok) {
		return { success: false, message: tierJson.error };
	}
	const scheduleDraft = serializeCatalogScheduleDraft(catalogScheduleWindows ?? []);
	if (!scheduleDraft.ok) {
		return { success: false, message: scheduleDraft.error };
	}
	const withSchedule = attachCatalogScheduleToProfileJson(tierJson.json, scheduleDraft.windows);
	if (!withSchedule.ok) {
		return { success: false, message: withSchedule.error };
	}
	const metaParsed = parseMetadataForSave(formData.metadata);
	if (!metaParsed.ok) {
		return { success: false, message: metaParsed.error };
	}

	const resolvedKind = resolveModelKind({
		input_modalities: formData.input_modalities,
		output_modalities: formData.output_modalities,
		pricing_profile: withSchedule.json,
	});
	const isImageResolved = resolvedKind === 'image';
	const isAudioResolved = isAudio || resolvedKind === 'asr' || resolvedKind === 'tts';
	const isEmbeddingResolved = resolvedKind === 'embedding';
	const skipTokenLimits = isImageResolved || isAudioResolved;
	const parsedMax = formData.max_tokens.trim() ? parseInt(formData.max_tokens, 10) : NaN;
	const payload = {
		...formData,
		tags: formData.tags,
		vendor: normalizeModelVendorInput(formData.vendor),
		// Image / Audio：chat context / max_tokens 不适用 — 保存时始终清空；Embedding 保留 context_window（输入上限），清空 max_tokens
		context_window: skipTokenLimits ? null : formData.context_window ? parseInt(formData.context_window, 10) : null,
		max_tokens: skipTokenLimits || (isEmbeddingResolved || resolvedKind === 'rerank') ? null : Number.isFinite(parsedMax) ? parsedMax : 4096,
		input_modalities: formData.input_modalities,
		output_modalities: formData.output_modalities,
		released_at: formData.released_at.trim() || null,
		pricing_profile: withSchedule.json,
		metadata: metaParsed.value,
	};

	let response: Response;
	if (editingModelId) {
		const { id: _unusedModelId, ...patchBody } = payload;
		void _unusedModelId;
		response = await request(`/api/admin/models/${encodeURIComponent(editingModelId)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patchBody),
		});
	} else {
		response = await request('/api/admin/models', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
	}

	const data = await readApiJson(response);
	if (data.success) return { success: true };
	return { success: false, message: data.message || 'Save failed' };
}

export async function deleteModel(
	id: string,
	request: typeof fetch = fetch,
): Promise<{ success: true } | { success: false; message: string }> {
	const response = await request(`/api/admin/models/${encodeURIComponent(id)}`, {
		method: 'DELETE',
	});
	const data = await readApiJson(response);
	if (data.success) return { success: true };
	return { success: false, message: data.message || 'Delete failed' };
}

export async function fetchImportCatalog(vendor?: string, signal?: AbortSignal, request: typeof fetch = fetch): Promise<PresetCatalogRow[]> {
	const query = vendor ? `?${new URLSearchParams({ vendor })}` : '';
	const response = await request(`/api/admin/models/import/catalog${query}`, { cache: 'no-store', signal });
	const data = await readApiJson<PresetCatalogRow[]>(response);
	if (data.success && Array.isArray(data.data)) return data.data;
	throw new Error(data.message || 'Failed to load catalog');
}

export async function importModelPresets(
	ids: string[],
	request: typeof fetch = fetch,
): Promise<{ success: true; data: ModelImportResult } | { success: false; message: string }> {
	const response = await request('/api/admin/models/import', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ids }),
	});
	const data = await readApiJson<ModelImportResult>(response);
	if (data.success && data.data) return { success: true, data: data.data };
	return { success: false, message: data.message || 'Import failed' };
}

export async function fetchModelSyncReport(request: typeof fetch = fetch): Promise<ModelSyncReport> {
	const response = await request('/api/admin/models/sync/diff');
	const data = await readApiJson<ModelSyncReport>(response);
	if (data.success && data.data) return data.data;
	throw new Error(data.message || 'Failed to load model sync diff');
}

export async function applyModelSync(
	body: ModelSyncApplyBody,
	request: typeof fetch = fetch,
): Promise<{ success: true; data: ModelSyncApplyOutput } | { success: false; message: string }> {
	const response = await request('/api/admin/models/sync/apply', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const data = await readApiJson<ModelSyncApplyOutput>(response);
	if (data.success && data.data) return { success: true, data: data.data };
	return { success: false, message: data.message || 'Sync failed' };
}

export function useModelApi() {
	const request = useAdvancedEditorRequest();
	return useMemo(
		() => ({
			fetchModelsList: () => fetchModelsList(request),
			fetchModelDetail: (id: string) => fetchModelDetail(id, request),
			saveModel: (
				formData: ModelFormData,
				pricingTierRows: PricingTierDraftRow[],
				editingModelId: string | null,
				imagePricingDraft?: ImagePricingDraftState | null,
				audioPricingDraft?: AudioPricingDraftState | null,
				catalogScheduleWindows?: CatalogScheduleFormWindow[],
			) =>
				saveModel(
					formData,
					pricingTierRows,
					editingModelId,
					imagePricingDraft,
					audioPricingDraft,
					catalogScheduleWindows,
					request,
				),
			deleteModel: (id: string) => deleteModel(id, request),
			fetchImportCatalog: () => fetchImportCatalog(undefined, undefined, request),
			importModelPresets: (ids: string[]) => importModelPresets(ids, request),
			fetchModelSyncReport: () => fetchModelSyncReport(request),
			applyModelSync: (body: ModelSyncApplyBody) => applyModelSync(body, request),
		}),
		[request],
	);
}

/** Load only the routes belonging to this model; never treat a failed request as an empty list. */
export async function fetchModelRoutes(modelId: string, signal?: AbortSignal, request: typeof fetch = fetch): Promise<RouteListRow[]> {
	const query = new URLSearchParams({ model_id: modelId });
	const response = await request(`/api/admin/routes?${query}`, { signal });
	const data = await readApiJson<RouteListRow[]>(response);
	if (data.success && Array.isArray(data.data)) return data.data.filter((route) => route.model_id === modelId);
	throw new Error(data.message || 'Failed to load routes');
}

/** Delete only selected routes owned by the current model, preserving per-route failures. */
export async function deleteModelRoutes(modelId: string, routes: RouteListRow[], ids: string[], request: typeof fetch = fetch) {
	const selected = new Set(ids);
	const targets = new Map(
		routes
			.filter((route) => route.model_id === modelId && selected.has(route.id))
			.map((route) => [route.id, route]),
	);
	const deletedIds: string[] = [];
	const failures: Array<{ route: RouteListRow; message: string }> = [];
	// Sequential requests avoid a burst of concurrent database writes for large selections.
	for (const route of targets.values()) {
		try {
			const result = await deleteRoute(route.id, request);
			if (result.success) deletedIds.push(route.id);
			else failures.push({ route, message: result.message });
		} catch (cause) {
			failures.push({ route, message: cause instanceof Error ? cause.message : '' });
		}
	}
	return { deletedIds, failures };
}
