import { useMemo } from 'react';
import { useAdvancedEditorRequest } from '@/components/routing-workbench/AdvancedEditorGate';
import { isAudioModel, isImageGenerationModel, isRerankModel } from '@octafuse/core/db/model-modalities';
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
	const isImage = isImageGenerationModel({
		output_modalities: formData.output_modalities,
	});
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

	const isImageResolved = isImageGenerationModel({
		output_modalities: formData.output_modalities,
		pricing_profile: withSchedule.json,
	});
	const isAudioResolved =
		isAudio ||
		isAudioModel({
			output_modalities: formData.output_modalities,
			pricing_profile: withSchedule.json,
		});
	const isRerankResolved = isRerankModel({
		output_modalities: formData.output_modalities,
	});
	const skipContextWindow = isImageResolved || isAudioResolved;
	const skipMaxTokens = skipContextWindow || isRerankResolved;
	const parsedMax = formData.max_tokens.trim() ? parseInt(formData.max_tokens, 10) : NaN;
	const payload = {
		...formData,
		tags: formData.tags,
		vendor: normalizeModelVendorInput(formData.vendor),
		// Image / Audio：context/max_tokens 不适用；Rerank 保留 context，仅清空生成 token 上限。
		context_window: skipContextWindow ? null : formData.context_window ? parseInt(formData.context_window, 10) : null,
		max_tokens: skipMaxTokens ? null : Number.isFinite(parsedMax) ? parsedMax : 4096,
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

export async function fetchImportCatalog(request: typeof fetch = fetch): Promise<PresetCatalogRow[]> {
	const response = await request('/api/admin/models/import/catalog');
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
			fetchImportCatalog: () => fetchImportCatalog(request),
			importModelPresets: (ids: string[]) => importModelPresets(ids, request),
			fetchModelSyncReport: () => fetchModelSyncReport(request),
			applyModelSync: (body: ModelSyncApplyBody) => applyModelSync(body, request),
		}),
		[request],
	);
}
