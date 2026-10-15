import { useMemo } from 'react';
import { useAdvancedEditorRequest } from '@/components/routing-workbench/AdvancedEditorGate';
import type { ProviderQuotaSnapshot } from '@octafuse/core/provider-quota';
import { readApiJson } from '@/lib/api-json';
import { sortProvidersByKindThenName } from '@/lib/provider-kind';
import type { GatewayProvider } from '@/lib/types';
import { formDataToEndpointsMap } from './provider-utils';
import type { ProviderSyncApplyBody, ProviderSyncApplyOutput, ProviderSyncReport } from '@/lib/provider-sync-diff';
import type { ProviderFormData, ProviderImportCatalogRow, ProviderImportResult } from './types';

export async function fetchProvidersList(request: typeof fetch = fetch): Promise<GatewayProvider[]> {
	const response = await request('/api/admin/providers');
	const data = await readApiJson<GatewayProvider[]>(response);
	if (data.success && data.data) {
		return sortProvidersByKindThenName(data.data, 'en', 'Custom');
	}
	throw new Error(data.message || 'Failed to load providers');
}

export async function saveProvider(
	formData: ProviderFormData,
	editingProviderId: string | null,
	request: typeof fetch = fetch,
): Promise<{ success: true } | { success: false; message: string }> {
	const payload: Record<string, unknown> = {
		name: formData.name,
		kind: formData.kind,
		description: formData.description,
		endpoints: formDataToEndpointsMap(formData),
		status: formData.status === 'disabled' ? 'disabled' : 'active',
		shared_channel_type: formData.shared_channel_type || null,
	};

	const apiKey = formData.api_key.trim();
	if (apiKey) {
		payload.api_key = apiKey;
	}

	let response: Response;
	if (editingProviderId) {
		response = await request(`/api/admin/providers/${encodeURIComponent(editingProviderId)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
	} else {
		if (!apiKey && !formData.shared_channel_type) {
			return {
				success: false,
				message: 'api_key is required (or select a shared channel)',
			};
		}
		payload.api_key = apiKey;
		response = await request('/api/admin/providers', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
	}

	const data = await readApiJson(response);
	if (data.success) return { success: true };
	return { success: false, message: data.message || 'Save failed' };
}

export async function deleteProvider(
	id: string,
	request: typeof fetch = fetch,
): Promise<{ success: true } | { success: false; message: string }> {
	const response = await request(`/api/admin/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
	const data = await readApiJson(response);
	if (data.success) return { success: true };
	return { success: false, message: data.message || 'Delete failed' };
}

export async function fetchImportCatalog(request: typeof fetch = fetch): Promise<ProviderImportCatalogRow[]> {
	const response = await request('/api/admin/providers/import/catalog');
	const data = await readApiJson<ProviderImportCatalogRow[]>(response);
	if (data.success && data.data) return data.data;
	throw new Error(data.message || 'Failed to load catalog');
}

export async function importProviderPresets(
	ids: string[],
	request: typeof fetch = fetch,
): Promise<{ success: true; data: ProviderImportResult } | { success: false; message: string }> {
	const response = await request('/api/admin/providers/import', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ids }),
	});
	const data = await readApiJson<ProviderImportResult>(response);
	if (data.success && data.data) return { success: true, data: data.data };
	return { success: false, message: data.message || 'Import failed' };
}

export async function fetchProviderApiKeyPlaintext(providerId: string, request: typeof fetch = fetch): Promise<string> {
	const response = await request(`/api/admin/providers/${encodeURIComponent(providerId)}/api-key`);
	const data = await readApiJson<{ api_key: string }>(response);
	if (data.success && data.data?.api_key) return data.data.api_key;
	throw new Error(data.message || 'Failed to reveal API key');
}

export async function toggleProviderStatus(
	providerId: string,
	nextStatus: 'active' | 'disabled',
	request: typeof fetch = fetch,
): Promise<{ success: true } | { success: false; message: string }> {
	const response = await request(`/api/admin/providers/${encodeURIComponent(providerId)}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ status: nextStatus }),
	});
	const data = await readApiJson(response);
	if (data.success) return { success: true };
	return { success: false, message: data.message || 'Update failed' };
}

export async function fetchProviderQuota(
	providerId: string,
	request: typeof fetch = fetch,
): Promise<{ success: true; data: ProviderQuotaSnapshot } | { success: false; message: string }> {
	const response = await request(`/api/admin/providers/${encodeURIComponent(providerId)}/quota`);
	const data = await readApiJson<ProviderQuotaSnapshot>(response);
	if (data.success && data.data) return { success: true, data: data.data };
	return { success: false, message: data.message || 'Failed to query provider quota' };
}

export async function fetchProviderSyncReport(request: typeof fetch = fetch): Promise<ProviderSyncReport> {
	const response = await request('/api/admin/providers/sync/diff');
	const data = await readApiJson<ProviderSyncReport>(response);
	if (data.success && data.data) return data.data;
	throw new Error(data.message || 'Failed to load provider sync diff');
}

export async function applyProviderSync(
	body: ProviderSyncApplyBody,
	request: typeof fetch = fetch,
): Promise<{ success: true; data: ProviderSyncApplyOutput } | { success: false; message: string }> {
	const response = await request('/api/admin/providers/sync/apply', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const data = await readApiJson<ProviderSyncApplyOutput>(response);
	if (data.success && data.data) return { success: true, data: data.data };
	return { success: false, message: data.message || 'Sync failed' };
}

/** 模板改名后把旧 kind 迁移到新模板名；只改 `kind`。 */
export async function migrateProviderKind(
	providerId: string,
	kind: string,
	request: typeof fetch = fetch,
): Promise<{ success: true } | { success: false; message: string }> {
	const response = await request(`/api/admin/providers/${encodeURIComponent(providerId)}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ kind }),
	});
	const data = await readApiJson(response);
	if (data.success) return { success: true };
	return { success: false, message: data.message || 'Update failed' };
}

export function useProviderApi() {
	const request = useAdvancedEditorRequest();
	return useMemo(
		() => ({
			fetchProvidersList: () => fetchProvidersList(request),
			saveProvider: (formData: ProviderFormData, editingProviderId: string | null) =>
				saveProvider(formData, editingProviderId, request),
			deleteProvider: (id: string) => deleteProvider(id, request),
			fetchImportCatalog: () => fetchImportCatalog(request),
			importProviderPresets: (ids: string[]) => importProviderPresets(ids, request),
			fetchProviderApiKeyPlaintext: (providerId: string) => fetchProviderApiKeyPlaintext(providerId, request),
			toggleProviderStatus: (providerId: string, nextStatus: 'active' | 'disabled') =>
				toggleProviderStatus(providerId, nextStatus, request),
			fetchProviderQuota: (providerId: string) => fetchProviderQuota(providerId, request),
			fetchProviderSyncReport: () => fetchProviderSyncReport(request),
			applyProviderSync: (body: ProviderSyncApplyBody) => applyProviderSync(body, request),
			migrateProviderKind: (providerId: string, kind: string) => migrateProviderKind(providerId, kind, request),
		}),
		[request],
	);
}
