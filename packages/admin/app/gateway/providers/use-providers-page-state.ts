'use client';
import { useAdvancedEditorRequest } from '@/components/routing-workbench/AdvancedEditorGate';

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { sortProvidersByKindThenName } from '@/lib/provider-kind';
import type { ProviderSyncReport } from '@/lib/provider-sync-diff';
import { useFeedback } from '@/components/feedback';
import { useReplaceListPageQuery } from '@/lib/use-replace-list-query';
import { useProviderApi } from './provider-api';
import { providerMatchesListFilter, providerMatchesSearch, providerToFormData } from './provider-utils';
import { readApiJson } from '@/lib/api-json';
import type { GatewayProvider, ProviderFormData, ProviderImportCatalogRow, ProviderListFilter } from './types';
import {
	DEFAULT_PROVIDER_LIST_FILTER,
	EMPTY_PROTOCOL_FORM,
	EMPTY_PROVIDER_FORM,
	PROVIDER_LIST_FILTERS,
	parseProviderListFilterParam,
} from './types';

function emptyFilterCounts(): Record<ProviderListFilter, number> {
	return {
		all: 0,
		active: 0,
		disabled: 0,
		pending: 0,
		no_key: 0,
		outdated: 0,
		openai: 0,
		anthropic: 0,
		gemini: 0,
		dashscope: 0,
		minimax: 0,
		volcengine: 0,
	};
}

export function useProvidersPageState() {
	const editorFetch = useAdvancedEditorRequest();

	const {
		deleteProvider,
		fetchImportCatalog,
		fetchProviderApiKeyPlaintext,
		fetchProvidersList,
		importProviderPresets,
		saveProvider,
		toggleProviderStatus,
	} = useProviderApi();

	const t = useTranslations('providers');
	const locale = useLocale();
	const tKind = useTranslations('providers.kind');
	const tImport = useTranslations('providers.import');
	const tModal = useTranslations('providers.modal');
	const tCommon = useTranslations('common');
	const { notify, confirm } = useFeedback();
	const searchParams = useSearchParams();
	const [rawProviders, setProviders] = useState<GatewayProvider[]>([]);
	/** 管理员手动「检查官方更新」的结果；null = 还没检查过。 */
	const [officialReport, setOfficialReport] = useState<ProviderSyncReport | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const searchParam = searchParams.get('q');
	const filterParam = searchParams.get('filter');
	const [filters, setFilters] = useState(() => ({
		searchParam,
		filterParam,
		search: searchParam ?? '',
		filter: filterParam === null ? DEFAULT_PROVIDER_LIST_FILTER : parseProviderListFilterParam(filterParam),
	}));
	if (filters.searchParam !== searchParam || filters.filterParam !== filterParam) {
		setFilters({
			searchParam,
			filterParam,
			search: searchParam === null ? filters.search : searchParam,
			filter: filterParam === null ? filters.filter : parseProviderListFilterParam(filterParam),
		});
	}
	const providerSearch = filters.search;
	const selectedFilter = filters.filter;
	const setProviderSearch = useCallback((value: SetStateAction<string>) => {
		setFilters((previous) => ({
			...previous,
			search: typeof value === 'function' ? value(previous.search) : value,
		}));
	}, []);
	const setSelectedFilter = useCallback((value: SetStateAction<ProviderListFilter>) => {
		setFilters((previous) => ({
			...previous,
			filter: typeof value === 'function' ? value(previous.filter) : value,
		}));
	}, []);
	const lifetimeRef = useRef<AbortController | null>(null);
	const listRequestRef = useRef<AbortController | null>(null);
	const catalogRequestRef = useRef<AbortController | null>(null);
	const keyRequestRef = useRef<AbortController | null>(null);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isCurrentScope = useCallback(
		(scope: AbortController | null) => scope !== null && !scope.signal.aborted && lifetimeRef.current === scope,
		[],
	);
	const [showModal, setShowModal] = useState(false);
	const [editingProvider, setEditingProvider] = useState<GatewayProvider | null>(null);
	const [duplicateSourceId, setDuplicateSourceId] = useState<string | null>(null);
	const [formData, setFormData] = useState<ProviderFormData>(EMPTY_PROVIDER_FORM);
	const [saveError, setSaveError] = useState('');
	const [isSaving, setIsSaving] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [showImportModal, setShowImportModal] = useState(false);
	const [importCatalogRows, setImportCatalogRows] = useState<ProviderImportCatalogRow[]>([]);
	const [importCatalogSearch, setImportCatalogSearch] = useState('');
	const [importCatalogLoading, setImportCatalogLoading] = useState(false);
	const [importCatalogError, setImportCatalogError] = useState('');
	const [importSelected, setImportSelected] = useState<Record<string, boolean>>({});
	const [importSubmitting, setImportSubmitting] = useState(false);
	const [statusTogglingId, setStatusTogglingId] = useState<string | null>(null);
	const loadedApiKeyRef = useRef<string | null>(null);
	const apiKeyLoadGenRef = useRef(0);

	useReplaceListPageQuery(() => {
		const params = new URLSearchParams();
		const q = providerSearch.trim();
		if (q) params.set('q', q);
		if (selectedFilter !== DEFAULT_PROVIDER_LIST_FILTER) {
			params.set('filter', selectedFilter);
		}
		return params;
	}, [providerSearch, selectedFilter]);

	// 差异只在手动检查后才有；把结果合并到卡片，供徽标和「有更新」筛选使用。
	const providers = useMemo(() => {
		if (!officialReport) return rawProviders;
		const counts = new Map<string, number>();
		for (const group of officialReport.groups) {
			for (const entry of group.providers) counts.set(entry.provider_id, entry.fields.length);
		}
		const orphaned = new Set(officialReport.orphans.map((o) => o.provider_id));
		return rawProviders.map((provider) => ({
			...provider,
			official_update_count: counts.get(provider.id) ?? 0,
			kind_orphaned: orphaned.has(provider.id),
		}));
	}, [rawProviders, officialReport]);

	const customKindLabel = tKind('custom');
	const orderedProviders = useMemo(
		() => sortProvidersByKindThenName(providers, locale, customKindLabel),
		[providers, locale, customKindLabel],
	);
	const searchMatchedProviders = useMemo(
		() => orderedProviders.filter((provider) => providerMatchesSearch(provider, providerSearch)),
		[providerSearch, orderedProviders],
	);

	const filterCounts = useMemo(() => {
		const counts = emptyFilterCounts();
		counts.all = searchMatchedProviders.length;
		for (const provider of searchMatchedProviders) {
			for (const filter of PROVIDER_LIST_FILTERS) {
				if (filter === 'all') continue;
				if (providerMatchesListFilter(provider, filter)) {
					counts[filter] += 1;
				}
			}
		}
		return counts;
	}, [searchMatchedProviders]);

	const filteredProviders = useMemo(
		() => searchMatchedProviders.filter((provider) => providerMatchesListFilter(provider, selectedFilter)),
		[searchMatchedProviders, selectedFilter],
	);

	const importSelectedCount = useMemo(() => Object.values(importSelected).filter(Boolean).length, [importSelected]);
	const filteredImportCatalogRows = useMemo(() => {
		const query = importCatalogSearch.trim().toLowerCase();
		if (!query) return importCatalogRows;
		return importCatalogRows.filter((row) => row.name.toLowerCase().includes(query));
	}, [importCatalogSearch, importCatalogRows]);

	const requestProviders = useCallback(
		async (scope: AbortController) => {
			if (!isCurrentScope(scope)) return null;
			listRequestRef.current?.abort();
			const request = new AbortController();
			listRequestRef.current = request;
			try {
				const response = await editorFetch('/api/admin/providers', {
					signal: request.signal,
				});
				const data = await readApiJson<GatewayProvider[]>(response);
				if (!isCurrentScope(scope) || request.signal.aborted || listRequestRef.current !== request) return null;
				if (!data.success || !data.data) throw new Error(data.message || 'Failed to load providers');
				return {
					request,
					rows: [...data.data].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
				};
			} catch (error) {
				if (isCurrentScope(scope) && !request.signal.aborted) console.error('Fetch providers error:', error);
				return { request, rows: null };
			}
		},
		[isCurrentScope],
	);

	const refreshProviders = useCallback(async () => {
		const scope = lifetimeRef.current;
		if (!scope || !isCurrentScope(scope)) return;
		const result = await requestProviders(scope);
		if (!result || !isCurrentScope(scope) || result.request.signal.aborted || listRequestRef.current !== result.request)
			return;
		if (result.rows) setProviders(result.rows);
		setIsLoading(false);
	}, [isCurrentScope, requestProviders]);

	useEffect(() => {
		const scope = new AbortController();
		lifetimeRef.current = scope;
		void (async () => {
			const result = await requestProviders(scope);
			if (
				!result ||
				!isCurrentScope(scope) ||
				result.request.signal.aborted ||
				listRequestRef.current !== result.request
			)
				return;
			if (result.rows) setProviders(result.rows);
			setIsLoading(false);
		})();
		return () => {
			scope.abort();
			listRequestRef.current?.abort();
			catalogRequestRef.current?.abort();
			keyRequestRef.current?.abort();
			if (copyTimeoutRef.current !== null) clearTimeout(copyTimeoutRef.current);
		};
	}, [isCurrentScope, requestProviders]);

	const handleCopyApiKey = useCallback(
		async (provider: GatewayProvider) => {
			const scope = lifetimeRef.current;
			if (!scope || !isCurrentScope(scope)) return;
			keyRequestRef.current?.abort();
			const request = new AbortController();
			keyRequestRef.current = request;
			try {
				const response = await editorFetch(`/api/admin/providers/${encodeURIComponent(provider.id)}/api-key`, {
					signal: request.signal,
				});
				const data = await readApiJson<{ api_key: string }>(response);
				if (!isCurrentScope(scope) || request.signal.aborted || keyRequestRef.current !== request) return;
				if (!data.success || !data.data?.api_key) throw new Error(data.message || 'Failed to reveal API key');
				await navigator.clipboard.writeText(data.data.api_key);
				if (!isCurrentScope(scope) || request.signal.aborted || keyRequestRef.current !== request) return;
				if (copyTimeoutRef.current !== null) clearTimeout(copyTimeoutRef.current);
				setCopiedId(`provider-api-key:${provider.id}`);
				copyTimeoutRef.current = setTimeout(() => {
					if (isCurrentScope(scope) && keyRequestRef.current === request) setCopiedId(null);
				}, 2000);
			} catch (error) {
				if (!isCurrentScope(scope) || request.signal.aborted) return;
				console.error('Copy provider API key error:', error);
				notify('error', error instanceof Error ? error.message : tImport('copyFailed'));
			}
		},
		[isCurrentScope, notify, tImport],
	);

	const handleToggleStatus = useCallback(
		async (provider: GatewayProvider) => {
			const scope = lifetimeRef.current;
			if (!scope || !isCurrentScope(scope)) return;
			const nextStatus = provider.status === 'disabled' ? 'active' : 'disabled';
			setStatusTogglingId(provider.id);
			try {
				const result = await toggleProviderStatus(provider.id, nextStatus);
				if (!isCurrentScope(scope)) return;
				if (result.success) {
					void refreshProviders();
				} else {
					notify('error', result.message || tCommon('updateFailed'));
				}
			} catch (error) {
				if (!isCurrentScope(scope)) return;
				console.error('Toggle provider status error:', error);
				notify('error', tCommon('updateFailed'));
			} finally {
				if (isCurrentScope(scope)) setStatusTogglingId(null);
			}
		},
		[isCurrentScope, refreshProviders, notify, tCommon],
	);

	const handleCreate = useCallback(() => {
		loadedApiKeyRef.current = null;
		apiKeyLoadGenRef.current += 1;
		setEditingProvider(null);
		setDuplicateSourceId(null);
		setFormData({
			...EMPTY_PROVIDER_FORM,
			id: '',
			api_key: '',
			status: 'disabled',
			openai: { ...EMPTY_PROTOCOL_FORM },
			anthropic: { ...EMPTY_PROTOCOL_FORM },
			gemini: { ...EMPTY_PROTOCOL_FORM },
		});
		setShowModal(true);
		setSaveError('');
	}, []);

	const handleEdit = useCallback((provider: GatewayProvider) => {
		const loadGen = ++apiKeyLoadGenRef.current;
		loadedApiKeyRef.current = null;
		setEditingProvider(provider);
		setDuplicateSourceId(null);
		setFormData({
			id: provider.id,
			name: provider.name,
			...providerToFormData(provider),
			description: provider.description ?? '',
		});
		setShowModal(true);
		setSaveError('');
		void fetchProviderApiKeyPlaintext(provider.id)
			.then((apiKey) => {
				if (apiKeyLoadGenRef.current !== loadGen) return;
				loadedApiKeyRef.current = apiKey;
				setFormData((current) => {
					if (current.id !== provider.id || current.api_key.trim()) return current;
					return { ...current, api_key: apiKey };
				});
			})
			.catch((error) => {
				if (apiKeyLoadGenRef.current !== loadGen) return;
				console.error('Load provider API key error:', error);
			});
	}, []);

	const handleDuplicate = useCallback((provider: GatewayProvider) => {
		loadedApiKeyRef.current = null;
		apiKeyLoadGenRef.current += 1;
		setEditingProvider(null);
		setDuplicateSourceId(provider.id);
		setFormData({
			id: '',
			name: `${provider.name} (copy)`,
			...providerToFormData(provider),
			api_key: '',
			status: 'disabled',
			description: provider.description ?? '',
		});
		setShowModal(true);
		setSaveError('');
	}, []);

	const handleDelete = useCallback(
		async (id: string) => {
			const scope = lifetimeRef.current;
			if (!scope || !isCurrentScope(scope)) return;
			const ok = await confirm({
				title: tModal('deleteProvider'),
				message: tModal('confirmDelete'),
				confirmLabel: tCommon('delete'),
				danger: true,
			});
			if (!ok) return;

			setIsDeleting(true);
			try {
				const result = await deleteProvider(id);
				if (!isCurrentScope(scope)) return;
				if (result.success) {
					setShowModal(false);
					setEditingProvider(null);
					void refreshProviders();
				} else {
					notify('error', result.message || tCommon('failed'));
				}
			} catch (error) {
				if (!isCurrentScope(scope)) return;
				console.error('Delete error:', error);
				notify('error', tCommon('failed'));
			} finally {
				if (isCurrentScope(scope)) setIsDeleting(false);
			}
		},
		[isCurrentScope, refreshProviders, confirm, notify, tCommon, tModal],
	);

	const loadImportCatalog = useCallback(async () => {
		const scope = lifetimeRef.current;
		if (!scope || !isCurrentScope(scope)) return;
		catalogRequestRef.current?.abort();
		const request = new AbortController();
		catalogRequestRef.current = request;
		setImportCatalogLoading(true);
		setImportCatalogError('');
		try {
			const response = await editorFetch('/api/admin/providers/import/catalog', {
				signal: request.signal,
			});
			const data = await readApiJson<ProviderImportCatalogRow[]>(response);
			if (!isCurrentScope(scope) || request.signal.aborted || catalogRequestRef.current !== request) return;
			if (!data.success || !data.data) throw new Error(data.message || 'Failed to load catalog');
			setImportCatalogRows(data.data);
			setImportSelected({});
		} catch (error) {
			if (!isCurrentScope(scope) || request.signal.aborted) return;
			console.error('Load provider import catalog error:', error);
			setImportCatalogError(error instanceof Error ? error.message : 'Failed to load catalog');
			setImportCatalogRows([]);
		} finally {
			if (isCurrentScope(scope) && !request.signal.aborted && catalogRequestRef.current === request)
				setImportCatalogLoading(false);
		}
	}, [isCurrentScope]);

	const openImportModal = useCallback(() => {
		setShowImportModal(true);
		setImportCatalogError('');
		setImportCatalogSearch('');
		setImportSelected({});
		void loadImportCatalog();
	}, [loadImportCatalog]);

	const toggleImportPreset = useCallback((id: string) => {
		setImportSelected((prev) => ({ ...prev, [id]: !prev[id] }));
	}, []);

	const selectAllImportPresets = useCallback(() => {
		setImportSelected((prev) => {
			const next = { ...prev };
			for (const row of filteredImportCatalogRows) {
				next[row.id] = true;
			}
			return next;
		});
	}, [filteredImportCatalogRows]);

	const clearImportPresetSelection = useCallback(() => {
		setImportSelected({});
	}, []);

	const runImportSelectedPresets = useCallback(async () => {
		const scope = lifetimeRef.current;
		if (!scope || !isCurrentScope(scope)) return;
		const ids = Object.entries(importSelected)
			.filter(([, v]) => v)
			.map(([k]) => k);
		if (ids.length === 0) {
			notify('error', tImport('selectNone'));
			return;
		}
		setImportSubmitting(true);
		try {
			const result = await importProviderPresets(ids);
			if (!isCurrentScope(scope)) return;
			if (result.success) {
				const { created, skipped_existing: skippedExisting, failed } = result.data;
				const summary = [t('import.resultFinished'), t('import.resultCreated', { count: created })];
				if (skippedExisting.length > 0) {
					summary.push(
						t('import.resultAlreadyInstalled', {
							count: skippedExisting.length,
						}),
					);
				}
				if (failed.length > 0) {
					summary.push(t('import.resultFailed'), ...failed.map((failure) => `  ${failure.id}: ${failure.message}`));
				}
				notify(failed.length > 0 ? 'error' : 'success', summary.join('\n'));
				setShowImportModal(false);
				void refreshProviders();
			} else {
				notify('error', result.message || tImport('failed'));
			}
		} catch (error) {
			if (!isCurrentScope(scope)) return;
			console.error('Import providers error:', error);
			notify('error', tImport('failed'));
		} finally {
			if (isCurrentScope(scope)) setImportSubmitting(false);
		}
	}, [importSelected, isCurrentScope, refreshProviders, t, notify, tImport]);

	const handleSave = useCallback(async () => {
		const scope = lifetimeRef.current;
		if (!scope || !isCurrentScope(scope)) return;
		if (!editingProvider && !formData.api_key.trim() && !formData.shared_channel_type) {
			setSaveError('API key is required (or select a shared channel)');
			return;
		}
		if (!editingProvider && !formData.kind.trim()) {
			setSaveError(tModal('kindRequiredError'));
			return;
		}
		setSaveError('');
		setIsSaving(true);
		try {
			const unchangedKey =
				Boolean(editingProvider) &&
				loadedApiKeyRef.current !== null &&
				formData.api_key.trim() === loadedApiKeyRef.current;
			const result = await saveProvider(
				unchangedKey ? { ...formData, api_key: '' } : formData,
				editingProvider?.id ?? null,
			);
			if (!isCurrentScope(scope)) return;
			if (result.success) {
				setShowModal(false);
				void refreshProviders();
			} else {
				setSaveError(result.message);
			}
		} catch (error) {
			if (!isCurrentScope(scope)) return;
			console.error('Save error:', error);
			setSaveError('Save failed, please try again');
		} finally {
			if (isCurrentScope(scope)) setIsSaving(false);
		}
	}, [editingProvider, formData, isCurrentScope, refreshProviders, tModal]);

	const closeProviderModal = useCallback(() => {
		if (isSaving || isDeleting) return;
		setShowModal(false);
	}, [isDeleting, isSaving]);

	return {
		isLoading,
		providers,
		providerSearch,
		setProviderSearch,
		selectedFilter,
		setSelectedFilter,
		filterCounts,
		filteredProviders,
		copiedId,
		statusTogglingId,
		showModal,
		editingProvider,
		duplicateSourceId,
		formData,
		setFormData,
		saveError,
		isSaving,
		isDeleting,
		showImportModal,
		setShowImportModal,
		importCatalogRows,
		importCatalogSearch,
		setImportCatalogSearch,
		filteredImportCatalogRows,
		importCatalogLoading,
		importCatalogError,
		importSelected,
		importSelectedCount,
		importSubmitting,
		handleCreate,
		handleEdit,
		handleDuplicate,
		handleDelete,
		handleSave,
		closeProviderModal,
		openImportModal,
		toggleImportPreset,
		selectAllImportPresets,
		clearImportPresetSelection,
		runImportSelectedPresets,
		handleCopyApiKey,
		handleToggleStatus,
		refreshProviders,
		officialReport,
		setOfficialReport,
	};
}
