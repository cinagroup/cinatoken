"use client";

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type SetStateAction,
} from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useReplaceListPageQuery } from "@/lib/use-replace-list-query";
import { readApiJson } from "@/lib/api-json";
import {
	deleteProvider,
	importProviderPresets,
	saveProvider,
	toggleProviderStatus,
} from "./provider-api";
import {
	providerMatchesListFilter,
	providerMatchesSearch,
	providerToFormData,
	suggestDuplicateProviderId,
} from "./provider-utils";
import type {
	GatewayProvider,
	ProviderFormData,
	ProviderImportCatalogRow,
	ProviderListFilter,
} from "./types";
import {
	DEFAULT_PROVIDER_LIST_FILTER,
	EMPTY_PROTOCOL_FORM,
	EMPTY_PROVIDER_FORM,
	PROVIDER_LIST_FILTERS,
	parseProviderListFilterParam,
} from "./types";

function emptyFilterCounts(): Record<ProviderListFilter, number> {
	return {
		all: 0,
		active: 0,
		disabled: 0,
		pending: 0,
		no_key: 0,
		openai: 0,
		anthropic: 0,
		gemini: 0,
		dashscope: 0,
	};
}

export function useProvidersPageState() {
	const t = useTranslations("providers");
	const searchParams = useSearchParams();
	const [providers, setProviders] = useState<GatewayProvider[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const searchParam = searchParams.get("q");
	const filterParam = searchParams.get("filter");
	const [filters, setFilters] = useState(() => ({
		searchParam,
		filterParam,
		search: searchParam ?? "",
		filter:
			filterParam === null
				? DEFAULT_PROVIDER_LIST_FILTER
				: parseProviderListFilterParam(filterParam),
	}));
	if (
		filters.searchParam !== searchParam ||
		filters.filterParam !== filterParam
	) {
		setFilters({
			searchParam,
			filterParam,
			search: searchParam === null ? filters.search : searchParam,
			filter:
				filterParam === null
					? filters.filter
					: parseProviderListFilterParam(filterParam),
		});
	}
	const providerSearch = filters.search;
	const selectedFilter = filters.filter;
	const setProviderSearch = useCallback((value: SetStateAction<string>) => {
		setFilters((previous) => ({
			...previous,
			search: typeof value === "function" ? value(previous.search) : value,
		}));
	}, []);
	const setSelectedFilter = useCallback(
		(value: SetStateAction<ProviderListFilter>) => {
			setFilters((previous) => ({
				...previous,
				filter: typeof value === "function" ? value(previous.filter) : value,
			}));
		},
		[]
	);
	const lifetimeRef = useRef<AbortController | null>(null);
	const listRequestRef = useRef<AbortController | null>(null);
	const catalogRequestRef = useRef<AbortController | null>(null);
	const keyRequestRef = useRef<AbortController | null>(null);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isCurrentScope = useCallback(
		(scope: AbortController | null) =>
			scope !== null && !scope.signal.aborted && lifetimeRef.current === scope,
		[]
	);
	const [showModal, setShowModal] = useState(false);
	const [editingProvider, setEditingProvider] =
		useState<GatewayProvider | null>(null);
	const [duplicateSourceId, setDuplicateSourceId] = useState<string | null>(
		null
	);
	const [formData, setFormData] =
		useState<ProviderFormData>(EMPTY_PROVIDER_FORM);
	const [saveError, setSaveError] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [showImportModal, setShowImportModal] = useState(false);
	const [importCatalogRows, setImportCatalogRows] = useState<
		ProviderImportCatalogRow[]
	>([]);
	const [importCatalogSearch, setImportCatalogSearch] = useState("");
	const [importCatalogLoading, setImportCatalogLoading] = useState(false);
	const [importCatalogError, setImportCatalogError] = useState("");
	const [importSelected, setImportSelected] = useState<Record<string, boolean>>(
		{}
	);
	const [importSubmitting, setImportSubmitting] = useState(false);
	const [statusTogglingId, setStatusTogglingId] = useState<string | null>(null);

	useReplaceListPageQuery(() => {
		const params = new URLSearchParams();
		const q = providerSearch.trim();
		if (q) params.set("q", q);
		if (selectedFilter !== DEFAULT_PROVIDER_LIST_FILTER) {
			params.set("filter", selectedFilter);
		}
		return params;
	}, [providerSearch, selectedFilter]);

	const existingProviderIds = useMemo(
		() => new Set(providers.map((p) => p.id)),
		[providers]
	);

	const searchMatchedProviders = useMemo(
		() =>
			providers.filter((provider) =>
				providerMatchesSearch(provider, providerSearch)
			),
		[providerSearch, providers]
	);

	const filterCounts = useMemo(() => {
		const counts = emptyFilterCounts();
		counts.all = searchMatchedProviders.length;
		for (const provider of searchMatchedProviders) {
			for (const filter of PROVIDER_LIST_FILTERS) {
				if (filter === "all") continue;
				if (providerMatchesListFilter(provider, filter)) {
					counts[filter] += 1;
				}
			}
		}
		return counts;
	}, [searchMatchedProviders]);

	const filteredProviders = useMemo(
		() =>
			searchMatchedProviders.filter((provider) =>
				providerMatchesListFilter(provider, selectedFilter)
			),
		[searchMatchedProviders, selectedFilter]
	);

	const importSelectedCount = useMemo(
		() => Object.values(importSelected).filter(Boolean).length,
		[importSelected]
	);
	const filteredImportCatalogRows = useMemo(() => {
		const query = importCatalogSearch.trim().toLowerCase();
		if (!query) return importCatalogRows;
		return importCatalogRows.filter((row) =>
			row.name.toLowerCase().includes(query)
		);
	}, [importCatalogSearch, importCatalogRows]);

	const requestProviders = useCallback(
		async (scope: AbortController) => {
			if (!isCurrentScope(scope)) return null;
			listRequestRef.current?.abort();
			const request = new AbortController();
			listRequestRef.current = request;
			try {
				const response = await fetch("/api/admin/providers", {
					signal: request.signal,
				});
				const data = await readApiJson<GatewayProvider[]>(response);
				if (
					!isCurrentScope(scope) ||
					request.signal.aborted ||
					listRequestRef.current !== request
				)
					return null;
				if (!data.success || !data.data)
					throw new Error(data.message || "Failed to load providers");
				return {
					request,
					rows: [...data.data].sort((a, b) =>
						a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
					),
				};
			} catch (error) {
				if (isCurrentScope(scope) && !request.signal.aborted)
					console.error("Fetch providers error:", error);
				return { request, rows: null };
			}
		},
		[isCurrentScope]
	);

	const refreshProviders = useCallback(async () => {
		const scope = lifetimeRef.current;
		if (!scope || !isCurrentScope(scope)) return;
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
				const response = await fetch(
					`/api/admin/providers/${encodeURIComponent(provider.id)}/api-key`,
					{ signal: request.signal }
				);
				const data = await readApiJson<{ api_key: string }>(response);
				if (
					!isCurrentScope(scope) ||
					request.signal.aborted ||
					keyRequestRef.current !== request
				)
					return;
				if (!data.success || !data.data?.api_key)
					throw new Error(data.message || "Failed to reveal API key");
				await navigator.clipboard.writeText(data.data.api_key);
				if (
					!isCurrentScope(scope) ||
					request.signal.aborted ||
					keyRequestRef.current !== request
				)
					return;
				if (copyTimeoutRef.current !== null)
					clearTimeout(copyTimeoutRef.current);
				setCopiedId(`provider-api-key:${provider.id}`);
				copyTimeoutRef.current = setTimeout(() => {
					if (isCurrentScope(scope) && keyRequestRef.current === request)
						setCopiedId(null);
				}, 2000);
			} catch (error) {
				if (!isCurrentScope(scope) || request.signal.aborted) return;
				console.error("Copy provider API key error:", error);
				alert(
					error instanceof Error ? error.message : "Failed to copy API key"
				);
			}
		},
		[isCurrentScope]
	);

	const handleToggleStatus = useCallback(
		async (provider: GatewayProvider) => {
			const scope = lifetimeRef.current;
			if (!scope || !isCurrentScope(scope)) return;
			const nextStatus = provider.status === "disabled" ? "active" : "disabled";
			setStatusTogglingId(provider.id);
			try {
				const result = await toggleProviderStatus(provider.id, nextStatus);
				if (!isCurrentScope(scope)) return;
				if (result.success) {
					void refreshProviders();
				} else {
					alert(result.message);
				}
			} catch (error) {
				if (!isCurrentScope(scope)) return;
				console.error("Toggle provider status error:", error);
				alert("Update failed");
			} finally {
				if (isCurrentScope(scope)) setStatusTogglingId(null);
			}
		},
		[isCurrentScope, refreshProviders]
	);

	const handleCreate = useCallback(() => {
		setEditingProvider(null);
		setDuplicateSourceId(null);
		setFormData({
			...EMPTY_PROVIDER_FORM,
			id: "",
			api_key: "",
			status: "disabled",
			openai: { ...EMPTY_PROTOCOL_FORM },
			anthropic: { ...EMPTY_PROTOCOL_FORM },
			gemini: { ...EMPTY_PROTOCOL_FORM },
		});
		setShowModal(true);
		setSaveError("");
	}, []);

	const handleEdit = useCallback((provider: GatewayProvider) => {
		setEditingProvider(provider);
		setDuplicateSourceId(null);
		setFormData({
			id: provider.id,
			name: provider.name,
			...providerToFormData(provider),
			description: provider.description ?? "",
		});
		setShowModal(true);
		setSaveError("");
	}, []);

	const handleDuplicate = useCallback(
		(provider: GatewayProvider) => {
			setEditingProvider(null);
			setDuplicateSourceId(provider.id);
			setFormData({
				id: suggestDuplicateProviderId(provider.id, existingProviderIds),
				name: `${provider.name} (copy)`,
				...providerToFormData(provider),
				api_key: "",
				status: "disabled",
				description: provider.description ?? "",
			});
			setShowModal(true);
			setSaveError("");
		},
		[existingProviderIds]
	);

	const handleDelete = useCallback(
		async (id: string) => {
			const scope = lifetimeRef.current;
			if (!scope || !isCurrentScope(scope)) return;
			if (!confirm("Are you sure you want to delete this provider?")) return;

			setIsDeleting(true);
			try {
				const result = await deleteProvider(id);
				if (!isCurrentScope(scope)) return;
				if (result.success) {
					setShowModal(false);
					setEditingProvider(null);
					void refreshProviders();
				} else {
					alert(result.message);
				}
			} catch (error) {
				if (!isCurrentScope(scope)) return;
				console.error("Delete error:", error);
				alert("Delete failed");
			} finally {
				if (isCurrentScope(scope)) setIsDeleting(false);
			}
		},
		[isCurrentScope, refreshProviders]
	);

	const loadImportCatalog = useCallback(async () => {
		const scope = lifetimeRef.current;
		if (!scope || !isCurrentScope(scope)) return;
		catalogRequestRef.current?.abort();
		const request = new AbortController();
		catalogRequestRef.current = request;
		setImportCatalogLoading(true);
		setImportCatalogError("");
		try {
			const response = await fetch("/api/admin/providers/import/catalog", {
				signal: request.signal,
			});
			const data = await readApiJson<ProviderImportCatalogRow[]>(response);
			if (
				!isCurrentScope(scope) ||
				request.signal.aborted ||
				catalogRequestRef.current !== request
			)
				return;
			if (!data.success || !data.data)
				throw new Error(data.message || "Failed to load catalog");
			setImportCatalogRows(data.data);
			setImportSelected({});
		} catch (error) {
			if (!isCurrentScope(scope) || request.signal.aborted) return;
			console.error("Load provider import catalog error:", error);
			setImportCatalogError(
				error instanceof Error ? error.message : "Failed to load catalog"
			);
			setImportCatalogRows([]);
		} finally {
			if (
				isCurrentScope(scope) &&
				!request.signal.aborted &&
				catalogRequestRef.current === request
			)
				setImportCatalogLoading(false);
		}
	}, [isCurrentScope]);

	const openImportModal = useCallback(() => {
		setShowImportModal(true);
		setImportCatalogError("");
		setImportCatalogSearch("");
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
			alert(t("import.selectAtLeastOne"));
			return;
		}
		setImportSubmitting(true);
		try {
			const result = await importProviderPresets(ids);
			if (!isCurrentScope(scope)) return;
			if (result.success) {
				const {
					created,
					skipped_existing: skippedExisting,
					failed,
				} = result.data;
				const summary = [
					t("import.resultFinished"),
					t("import.resultCreated", { count: created }),
				];
				if (skippedExisting.length > 0) {
					summary.push(
						t("import.resultAlreadyInstalled", {
							count: skippedExisting.length,
						})
					);
				}
				if (failed.length > 0) {
					summary.push(
						t("import.resultFailed"),
						...failed.map((failure) => `  ${failure.id}: ${failure.message}`)
					);
				}
				alert(summary.join("\n"));
				setShowImportModal(false);
				void refreshProviders();
			} else {
				alert(result.message);
			}
		} catch (error) {
			if (!isCurrentScope(scope)) return;
			console.error("Import providers error:", error);
			alert(t("import.requestFailed"));
		} finally {
			if (isCurrentScope(scope)) setImportSubmitting(false);
		}
	}, [importSelected, isCurrentScope, refreshProviders, t]);

	const handleSave = useCallback(async () => {
		const scope = lifetimeRef.current;
		if (!scope || !isCurrentScope(scope)) return;
		if (
			!editingProvider &&
			!formData.api_key.trim() &&
			!formData.shared_channel_type
		) {
			setSaveError("API key is required (or select a shared channel)");
			return;
		}
		setSaveError("");
		setIsSaving(true);
		try {
			const result = await saveProvider(formData, editingProvider?.id ?? null);
			if (!isCurrentScope(scope)) return;
			if (result.success) {
				setShowModal(false);
				void refreshProviders();
			} else {
				setSaveError(result.message);
			}
		} catch (error) {
			if (!isCurrentScope(scope)) return;
			console.error("Save error:", error);
			setSaveError("Save failed, please try again");
		} finally {
			if (isCurrentScope(scope)) setIsSaving(false);
		}
	}, [editingProvider, formData, isCurrentScope, refreshProviders]);

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
	};
}
