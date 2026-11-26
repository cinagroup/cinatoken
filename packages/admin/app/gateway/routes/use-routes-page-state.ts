'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { useSearchParams } from 'next/navigation';
import { isAudioModel, isImageGenerationModel, isRerankModel } from '@octafuse/core/db/model-modalities';
import { useTranslations, useLocale } from 'next-intl';
import { useFeedback } from '@/components/feedback';
import { resolveModelKind } from '@octafuse/core/db/model-kind';
import { isRouteStrategyName } from '@octafuse/core/db/model-route-policy';
import { parseRoutePoolTierStrategies } from '@octafuse/core/db/route-pool-tier-strategies';
import { DEFAULT_STICKY_IDLE_TTL_SECONDS } from '@octafuse/core/db/route-pool-sticky-types';
import { useBusinessTimezone } from '@/components/BusinessTimezoneProvider';
import { getCatalogAudioPricingDisplay } from '@/lib/audio-transcriptions';
import { getCatalogImagePricingDisplay, getCatalogPricingTierRows } from '@/lib/pricing-ui';
import { normalizeModelVendorInput } from '@/lib/model-vendor';
import { EMPTY_GROUPED_SELECTION, isEmptyGroupedSelection, type GroupedSelection } from '@/lib/grouped-selection';
import type { GroupedFilterGroup } from '@/components/grouped-filter-picker';
import { readRouteCatalogFilters, writeRouteCatalogFilters } from './route-filter-query';
import { normalizeRouteGroup } from '@/lib/route-group-ui';
import {
	providerKindDisplayLabel,
	UNCLASSIFIED_PROVIDER_KIND_FILTER,
	providerKindFilterKey,
	routeProviderAccountLabel,
	sortProvidersByKindThenName,
} from '@/lib/provider-kind';
import { useBillingCurrency } from '@/lib/use-billing-currency';
import { useReplaceListPageQuery } from '@/lib/use-replace-list-query';
import { UPSTREAM_PROTOCOLS, providerSupportsUpstreamProtocol, type UpstreamProtocol } from '@/lib/upstream-protocol';
import type { GatewayModel, GatewayProvider } from '@/lib/types';
import { DEFAULT_ROUTE_KIND_FILTER, parseRouteKindFilterParam, type RouteKindFilter } from './types';
import { useModelEditModal } from '../models/use-model-edit-modal';
import { useRouteApi } from './route-api';
import {
	alignRouteFormAdapter,
	alignRouteScheduleWindowsToCatalog,
	buildFormDataFromRoute,
	catalogScheduleWindowsFromModel,
	buildRouteCardVendorGroups,
	buildRoutePolicyPatch,
	buildRoutesByModel,
	buildVendorFilterOptions,
	compatibleAdaptersForRoute,
	createInitialRouteForm,
	readRoutePolicyFormFromRaw,
	resolveEffectiveRouteStrategy,
	sortRouteCards,
	upstreamOperationsForProviderModel,
} from './route-utils';
import {
	EMPTY_ROUTE_FORM,
	type ProviderStickyDialogState,
	type ProviderStickyFormState,
	type RouteEditorTab,
	type RouteFormData,
	type RouteListRow,
	type RoutePolicyDialogState,
	type RoutePolicyFormState,
} from './types';

function normalizeRouteEditorForm(
	form: RouteFormData,
	models: GatewayModel[],
	providers: GatewayProvider[],
	showModal: boolean,
): RouteFormData {
	if (!showModal) return form;
	const provider = providers.find((row) => row.id === form.provider_id);
	const model = models.find((row) => row.id === form.model_id);
	let next = form;
	if (provider) {
		const protocols = UPSTREAM_PROTOCOLS.filter(
			(protocol) =>
				providerSupportsUpstreamProtocol(protocol, provider) &&
				upstreamOperationsForProviderModel(provider, model, protocol, form.provider_model_name).length > 0,
		);
		if (protocols.length > 0 && !protocols.includes(form.upstream_protocol)) {
			const protocol = protocols[0]!;
			const operations = upstreamOperationsForProviderModel(provider, model, protocol, form.provider_model_name);
			next = {
				...form,
				upstream_protocol: protocol,
				upstream_operation: operations[0] ?? form.upstream_operation,
			};
		}
	}
	const adapters = compatibleAdaptersForRoute(next);
	// Preserve an explicit Qwen/MiniMax choice whenever it is still compatible.
	if (adapters.length > 0 && !adapters.includes(next.adapter)) {
		next = { ...next, adapter: adapters[0]! };
	}
	return next;
}

export function useRoutesPageState() {
	const {
		deleteRoute,
		fetchRoutesPageData,
		patchModelRoutePolicy,
		patchRoutePoolPolicy,
		saveRoute,
		toggleRouteStatus,
	} = useRouteApi();

	const tModal = useTranslations('routes.modal');
	const tCommon = useTranslations('common');
	const tKind = useTranslations('providers.kind');
	const locale = useLocale();
	const { notify, confirm } = useFeedback();
	const searchParams = useSearchParams();
	const [routes, setRoutes] = useState<RouteListRow[]>([]);
	const [models, setModels] = useState<GatewayModel[]>([]);
	const [providers, setProviders] = useState<GatewayProvider[]>([]);
	const [globalRouteStrategy, setGlobalRouteStrategy] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [showModal, setShowModal] = useState(false);
	const [routeInitialTab, setRouteInitialTab] = useState<RouteEditorTab>('mapping');
	const [editingRoute, setEditingRoute] = useState<RouteListRow | null>(null);
	const [duplicateSourceRouteId, setDuplicateSourceRouteId] = useState<string | null>(null);
	const [draftFormData, setDraftFormData] = useState<RouteFormData>(EMPTY_ROUTE_FORM);
	const [filterRouteGroup, setFilterRouteGroup] = useState(() => searchParams.get('route_group') ?? '');
	const [filterStatus, setFilterStatus] = useState(() => searchParams.get('status') ?? '');
	const [filterKind, setFilterKind] = useState<RouteKindFilter>(() =>
		parseRouteKindFilterParam(searchParams.get('kind')),
	);
	const [searchQuery, setSearchQuery] = useState(() => searchParams.get('q') ?? '');
	const [filterModels, setFilterModels] = useState<GroupedSelection>(() => readRouteCatalogFilters(searchParams).models);
	const [filterProviders, setFilterProviders] = useState<GroupedSelection>(() => readRouteCatalogFilters(searchParams).providers);
	const filterVendor = filterModels.groups.length === 1 && !filterModels.items.length ? filterModels.groups[0] : '';
	const filterProviderId = filterProviders.items.length === 1 && !filterProviders.groups.length ? filterProviders.items[0] : '';
	const filterProviderKind = filterProviders.groups.length === 1 && !filterProviders.items.length ? filterProviders.groups[0] : '';
	const setFilterVendor = (value: string) => setFilterModels({groups:value?[value]:[],items:[]});
	const setFilterProviderId = (value: string) => setFilterProviders({groups:[],items:value?[value]:[]});
	const setFilterProviderKind = (value: string) => setFilterProviders({groups:value?[value]:[],items:[]});
	const [saveError, setSaveError] = useState('');
	const [isSaving, setIsSaving] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [togglingId, setTogglingId] = useState<string | null>(null);
	const [copiedModelId, setCopiedModelId] = useState<string | null>(null);
	const [strategyDialog, setStrategyDialog] = useState<RoutePolicyDialogState | null>(null);
	const [strategyForm, setStrategyForm] = useState<RoutePolicyFormState>({
		protocolStrategy: '',
		tierStrategy: '',
		capabilityStrategies: {},
	});
	const [strategySaving, setStrategySaving] = useState(false);
	const [strategyError, setStrategyError] = useState('');
	const [stickyDialog, setStickyDialog] = useState<ProviderStickyDialogState | null>(null);
	const [stickyForm, setStickyForm] = useState<ProviderStickyFormState>({
		enabled: false,
		idleTtlSeconds: DEFAULT_STICKY_IDLE_TTL_SECONDS,
	});
	const [stickySaving, setStickySaving] = useState(false);
	const [stickyError, setStickyError] = useState('');
	const { currency: billingCurrency } = useBillingCurrency();
	const businessTimezone = useBusinessTimezone();

	const search = searchParams.toString();
	const [previousSearch, setPreviousSearch] = useState(search);
	if (previousSearch !== search) {
		setPreviousSearch(search);
		const catalogFilters = readRouteCatalogFilters(searchParams);
		setFilterModels(catalogFilters.models);
		setFilterProviders(catalogFilters.providers);
		setSearchQuery(searchParams.get('q') ?? '');
		setFilterStatus(searchParams.get('status') ?? '');
		setFilterRouteGroup(searchParams.get('route_group') ?? '');
		setFilterKind(parseRouteKindFilterParam(searchParams.get('kind')));
	}

	const formData = useMemo(
		() => normalizeRouteEditorForm(draftFormData, models, providers, showModal),
		[draftFormData, models, providers, showModal],
	);
	const setFormData = useCallback(
		(action: SetStateAction<RouteFormData>) => {
			setDraftFormData((draft) => {
				const current = normalizeRouteEditorForm(draft, models, providers, showModal);
				const next = typeof action === 'function' ? action(current) : action;
				return normalizeRouteEditorForm(next, models, providers, showModal);
			});
		},
		[models, providers, showModal],
	);
	const lifetime = useRef<AbortController | null>(null);
	const loadRequest = useRef<symbol | null>(null);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useReplaceListPageQuery(() => {
		const params = new URLSearchParams();
		if (searchQuery) params.set('q', searchQuery);
		writeRouteCatalogFilters(params, filterModels, filterProviders);
		if (filterRouteGroup) params.set('route_group', filterRouteGroup);
		if (filterStatus) params.set('status', filterStatus);
		params.set('kind', filterKind);
		return params;
	}, [filterModels, filterProviders, filterRouteGroup, filterStatus, filterKind, searchQuery]);

	const applyRoutesPageData = useCallback((data: Awaited<ReturnType<typeof fetchRoutesPageData>>) => {
		setRoutes(data.routes);
		setModels(data.models);
		setProviders(data.providers);
		setGlobalRouteStrategy(data.globalRouteStrategy);
	}, []);
	const refreshRoutesPage = useCallback(async () => {
		const scope = lifetime.current;
		if (!scope || scope.signal.aborted) return;
		const request = Symbol('routes');
		loadRequest.current = request;
		try {
			const data = await fetchRoutesPageData();
			if (scope.signal.aborted || lifetime.current !== scope || loadRequest.current !== request) return;
			applyRoutesPageData(data);
		} catch (error) {
			if (scope.signal.aborted || lifetime.current !== scope || loadRequest.current !== request) return;
			console.error('Fetch data error:', error);
		} finally {
			if (!scope.signal.aborted && lifetime.current === scope && loadRequest.current === request)
				setIsLoading(false);
		}
	}, [applyRoutesPageData]);

	const modelEdit = useModelEditModal({ onChanged: refreshRoutesPage });

	useEffect(() => {
		const scope = new AbortController();
		const request = Symbol('routes');
		lifetime.current = scope;
		loadRequest.current = request;
		void fetchRoutesPageData()
			.then((data) => {
				if (scope.signal.aborted || lifetime.current !== scope || loadRequest.current !== request) return;
				applyRoutesPageData(data);
			})
			.catch((error) => {
				if (!scope.signal.aborted && lifetime.current === scope && loadRequest.current === request)
					console.error('Fetch data error:', error);
			})
			.finally(() => {
				if (!scope.signal.aborted && lifetime.current === scope && loadRequest.current === request)
					setIsLoading(false);
			});
		return () => {
			scope.abort();
			if (lifetime.current === scope) lifetime.current = null;
			if (copyTimer.current != null) clearTimeout(copyTimer.current);
		};
	}, [applyRoutesPageData]);

	const modelMeta = useMemo(() => {
		const map = new Map<string, GatewayModel>();
		for (const m of models) {
			map.set(m.id, m);
		}
		return map;
	}, [models]);

	const providerMeta = useMemo(() => {
		const map = new Map<string, GatewayProvider>();
		for (const provider of providers) map.set(provider.id, provider);
		return map;
	}, [providers]);

	const distinctRouteGroups = useMemo(() => {
		const set = new Set<string>();
		for (const r of routes) {
			set.add(normalizeRouteGroup(r.route_group));
		}
		return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
	}, [routes]);

	const routeGroupFilterOptions = useMemo(() => {
		const list = [...distinctRouteGroups];
		if (filterRouteGroup && !list.includes(filterRouteGroup)) {
			list.push(filterRouteGroup);
		}
		return list.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
	}, [distinctRouteGroups, filterRouteGroup]);

	const customKindLabel = tKind('custom');
	const unclassifiedKindLabel = tKind('unclassified');

	const modelFilterGroups = useMemo<GroupedFilterGroup[]>(() => {
		const catalog = new Map(
			models.map((model) => [
				model.id,
				{
					id: model.id,
					label: model.display_name?.trim() || model.id,
					vendor: normalizeModelVendorInput(model.vendor),
					kind: resolveModelKind(model),
				},
			]),
		);
		for (const route of routes) {
			if (!catalog.has(route.model_id)) {
				catalog.set(route.model_id, {
					id: route.model_id,
					label: route.model_name?.trim() || route.model_id,
					vendor: 'other',
					kind: 'llm',
				});
			}
		}
		return buildVendorFilterOptions({ models, routes, modelMeta })
			.map((vendor) => ({
				id: vendor.key,
				label: vendor.label,
				items: [...catalog.values()]
					.filter(
						(model) => model.vendor === vendor.key && (filterKind === 'all' || model.kind === filterKind),
					)
					.map((model) => ({ id: model.id, label: model.label, title: model.id }))
					.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
			}))
			.filter((group) => group.items.length > 0);
	}, [models, routes, modelMeta, filterKind]);

	const providerFilterGroups = useMemo(() => {
		const groups = new Map<string, GroupedFilterGroup>();
		for (const provider of sortProvidersByKindThenName(providers, locale, customKindLabel)) {
			const key = providerKindFilterKey(provider.kind);
			const group = groups.get(key) ?? {
				id: key,
				label:
					key === UNCLASSIFIED_PROVIDER_KIND_FILTER
						? unclassifiedKindLabel
						: providerKindDisplayLabel(provider, locale, customKindLabel) || key,
				items: [],
			};
			group.items.push({ id: provider.id, label: provider.name?.trim() || provider.id, title: provider.id });
			groups.set(key, group);
		}
		return [...groups.values()];
	}, [providers, locale, customKindLabel, unclassifiedKindLabel]);

	const routeGroupCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const r of routes) {
			const g = normalizeRouteGroup(r.route_group);
			counts.set(g, (counts.get(g) ?? 0) + 1);
		}
		return counts;
	}, [routes]);

	const statusCounts = useMemo(() => {
		let active = 0;
		let inactive = 0;
		for (const r of routes) {
			if (r.status === 'active') active += 1;
			else inactive += 1;
		}
		return { all: routes.length, active, inactive };
	}, [routes]);

	const kindCounts = useMemo(() => {
		const counts = { all: models.length, llm: 0, image: 0, asr: 0, tts: 0, embedding: 0, rerank: 0 };
		let rerank = 0;
		for (const m of models) {
			counts[resolveModelKind(m)] += 1;
		}
		return {...counts, audio: counts.asr + counts.tts};
	}, [models]);

	const routesByModel = useMemo(
		() =>
			buildRoutesByModel({
				routes,
				models,
				modelMeta,
				filterModels,
				filterProviders,
				providers,
				locale,
				customKindLabel: tKind('custom'),
				filterRouteGroup,
				filterStatus,
				filterKind,
				searchQuery,
			}),
		[
			routes,
			models,
			modelMeta,
			filterModels,
			filterProviders,
			providers,
			locale,
			tKind,
			filterRouteGroup,
			filterStatus,
			filterKind,
			searchQuery,
		],
	);

	const routeCards = useMemo(() => sortRouteCards(routesByModel, modelMeta), [routesByModel, modelMeta]);

	const routeCardVendorGroups = useMemo(
		() => buildRouteCardVendorGroups(routeCards, filterVendor),
		[routeCards, filterVendor],
	);

	const hasActiveFilters = Boolean(
		searchQuery ||
			!isEmptyGroupedSelection(filterModels) ||
			!isEmptyGroupedSelection(filterProviders) ||
			filterRouteGroup ||
			filterStatus ||
			filterKind !== DEFAULT_ROUTE_KIND_FILTER,
	);

	const selectedProvider = useMemo(
		() => providers.find((p) => p.id === formData.provider_id),
		[providers, formData.provider_id],
	);

	const selectedModel = useMemo(() => models.find((m) => m.id === formData.model_id), [models, formData.model_id]);

	const selectedModelKind = useMemo(() => (selectedModel ? resolveModelKind(selectedModel) : 'llm'), [selectedModel]);
	const selectedModelIsImage = selectedModelKind === 'image';
	const selectedModelIsAudio = selectedModelKind === 'asr' || selectedModelKind === 'tts';

	const catalogStandardTierRows = useMemo(() => {
		if (!selectedModel || selectedModelIsImage || selectedModelIsAudio) return [];
		return getCatalogPricingTierRows(selectedModel, billingCurrency);
	}, [selectedModel, selectedModelIsImage, selectedModelIsAudio, billingCurrency]);

	const catalogImagePricingDisplay = useMemo(() => {
		if (!selectedModel || !selectedModelIsImage) return null;
		return getCatalogImagePricingDisplay(selectedModel, billingCurrency);
	}, [selectedModel, selectedModelIsImage, billingCurrency]);

	const catalogAudioPricingDisplay = useMemo(() => {
		if (!selectedModel || !selectedModelIsAudio) return null;
		return getCatalogAudioPricingDisplay(selectedModel, billingCurrency);
	}, [selectedModel, selectedModelIsAudio, billingCurrency]);

	const allowedProtocolsForProvider = useMemo((): UpstreamProtocol[] => {
		if (!selectedProvider) return [];
		const supported = UPSTREAM_PROTOCOLS.filter(
			(proto) =>
				providerSupportsUpstreamProtocol(proto, selectedProvider) &&
				upstreamOperationsForProviderModel(selectedProvider, selectedModel, proto, formData.provider_model_name)
					.length > 0,
		);
		return supported;
	}, [selectedProvider, selectedModel, formData.provider_model_name]);

	const clearAllFilters = useCallback(() => {
		setSearchQuery('');
		setFilterKind(DEFAULT_ROUTE_KIND_FILTER);
		setFilterModels(EMPTY_GROUPED_SELECTION);
		setFilterProviders(EMPTY_GROUPED_SELECTION);
		setFilterRouteGroup('');
		setFilterStatus('');
	}, []);

	const handleCreate = useCallback(
		(presetModelId?: string, preset?: { protocol?: string; operation?: string; group?: string }) => {
			setRouteInitialTab('mapping');
			setEditingRoute(null);
			setDuplicateSourceRouteId(null);
			const initial = createInitialRouteForm(models, presetModelId);
			setFormData({
				...initial,
				upstream_protocol:
					preset?.protocol && UPSTREAM_PROTOCOLS.includes(preset.protocol as UpstreamProtocol)
						? (preset.protocol as UpstreamProtocol)
						: initial.upstream_protocol,
				request_protocol:
					preset?.protocol && UPSTREAM_PROTOCOLS.includes(preset.protocol as UpstreamProtocol)
						? (preset.protocol as UpstreamProtocol)
						: initial.request_protocol,
				request_operation: preset?.operation ?? initial.request_operation,
				upstream_operation: preset?.operation ?? initial.upstream_operation,
				route_group: preset?.group ?? initial.route_group,
			});
			setShowModal(true);
			setSaveError('');
		},
		[models, setFormData],
	);

	const handleEdit = useCallback(
		(route: RouteListRow, initialTab: RouteEditorTab = 'mapping') => {
			setRouteInitialTab(initialTab);
			setEditingRoute(route);
			setDuplicateSourceRouteId(null);
			setFormData(buildFormDataFromRoute(route, models));
			setShowModal(true);
			setSaveError('');
		},
		[models, setFormData],
	);

	const handleDuplicate = useCallback(
		(route: RouteListRow) => {
			setRouteInitialTab('mapping');
			setEditingRoute(null);
			setDuplicateSourceRouteId(route.id);
			setFormData(buildFormDataFromRoute(route, models));
			setShowModal(true);
			setSaveError('');
		},
		[models, setFormData],
	);

	const handleDelete = useCallback(
		async (id: string) => {
			const scope = lifetime.current;
			if (!scope || scope.signal.aborted) return;
			const ok = await confirm({
				title: tModal('deleteRoute'),
				message: tModal('confirmDelete'),
				confirmLabel: tCommon('delete'),
				danger: true,
			});
			if (!ok) return;

			setIsDeleting(true);
			try {
				const result = await deleteRoute(id);
				if (scope.signal.aborted || lifetime.current !== scope) return;
				if (result.success) {
					setShowModal(false);
					setEditingRoute(null);
					setDuplicateSourceRouteId(null);
					await refreshRoutesPage();
				} else {
					notify('error', result.message || tCommon('failed'));
				}
			} catch (error) {
				if (scope.signal.aborted || lifetime.current !== scope) return;
				console.error('Delete error:', error);
				notify('error', tCommon('failed'));
			} finally {
				if (!scope.signal.aborted && lifetime.current === scope) setIsDeleting(false);
			}
		},
		[confirm, notify, refreshRoutesPage, tCommon, tModal],
	);

	const handleToggleStatus = useCallback(
		async (route: RouteListRow) => {
			const scope = lifetime.current;
			if (!scope || scope.signal.aborted) return;
			const newStatus = route.status === 'active' ? 'inactive' : 'active';
			setTogglingId(route.id);
			try {
				const result = await toggleRouteStatus(route.id, newStatus);
				if (scope.signal.aborted || lifetime.current !== scope) return;
				if (result.success) {
					setRoutes((prev) => prev.map((r) => (r.id === route.id ? { ...r, status: newStatus } : r)));
				} else {
					notify('error', result.message || tCommon('updateFailed'));
				}
			} catch (error) {
				if (scope.signal.aborted || lifetime.current !== scope) return;
				console.error('Toggle status error:', error);
				notify('error', tCommon('updateFailed'));
			} finally {
				if (!scope.signal.aborted && lifetime.current === scope) setTogglingId(null);
			}
		},
		[notify, tCommon],
	);

	const copyModelId = useCallback(async (modelId: string) => {
		const scope = lifetime.current;
		if (!scope || scope.signal.aborted) return;
		try {
			await navigator.clipboard.writeText(modelId);
			if (scope.signal.aborted || lifetime.current !== scope) return;
			setCopiedModelId(modelId);
			if (copyTimer.current != null) clearTimeout(copyTimer.current);
			copyTimer.current = setTimeout(() => {
				if (!scope.signal.aborted && lifetime.current === scope)
					setCopiedModelId((current) => (current === modelId ? null : current));
			}, 2000);
		} catch (error) {
			if (scope.signal.aborted || lifetime.current !== scope) return;
			console.error('Copy model id failed:', error);
		}
	}, []);

	const handleSave = useCallback(async () => {
		const scope = lifetime.current;
		if (!scope || scope.signal.aborted) return;
		setSaveError('');
		setIsSaving(true);
		try {
			const catalog = catalogScheduleWindowsFromModel(models.find((m) => m.id === formData.model_id));
			const result = await saveRoute(
				{
					...formData,
					schedule_windows: alignRouteScheduleWindowsToCatalog(catalog, formData.schedule_windows),
				},
				editingRoute,
			);
			if (scope.signal.aborted || lifetime.current !== scope) return;
			if (result.success) {
				setShowModal(false);
				setEditingRoute(null);
				setDuplicateSourceRouteId(null);
				await refreshRoutesPage();
			} else {
				setSaveError(result.message);
			}
		} catch (error) {
			if (scope.signal.aborted || lifetime.current !== scope) return;
			console.error('Save error:', error);
			setSaveError(error instanceof Error ? error.message : 'Save failed, please try again');
		} finally {
			if (!scope.signal.aborted && lifetime.current === scope) setIsSaving(false);
		}
	}, [editingRoute, formData, models, refreshRoutesPage]);

	const handleOpenStrategyDialog = useCallback(
		(
			modelId: string,
			modelTitle: string,
			protocol: string,
			protocolLabel: string,
			group: string,
			poolId?: string | null,
			poolStrategy?: string | null,
			requestOperation?: string,
			extras?: { priority?: number; poolTierStrategies?: string | null },
		) => {
			const raw = modelMeta.get(modelId)?.route_policy ?? null;
			const poolTierStrategies = extras?.poolTierStrategies ?? null;
			const priority = extras?.priority;
			const inherited = resolveEffectiveRouteStrategy({
				poolStrategy: priority !== undefined ? poolStrategy : null,
				poolTierStrategies: null,
				routePolicyRaw: raw,
				protocol,
				requestOperation,
				routeGroup: group,
				globalStrategy: globalRouteStrategy,
			});
			const matchingTargets = routes
				.filter((route) =>
					poolId
						? route.route_pool_id === poolId
						: route.model_id === modelId &&
						  route.upstream_protocol === protocol &&
						  normalizeRouteGroup(route.route_group) === normalizeRouteGroup(group),
				)
				.map((route) => ({
					id: route.id,
					providerId: route.provider_id,
					providerName: routeProviderAccountLabel(
						route,
						providerMeta.get(route.provider_id),
						locale,
						tKind('custom'),
					),
					providerModelName: route.provider_model_name,
					priority: route.priority,
					weight: route.weight ?? 1,
					active: route.status === 'active' && providerMeta.get(route.provider_id)?.status !== 'disabled',
				}));
			const tierMap = parseRoutePoolTierStrategies(poolTierStrategies);
			const tierStrategy = priority !== undefined ? tierMap.get(priority) ?? '' : '';
			setStrategyForm(
				poolId
					? {
							protocolStrategy: poolStrategy ?? '',
							tierStrategy,
							capabilityStrategies: {},
					  }
					: readRoutePolicyFormFromRaw(raw, protocol, group),
			);
			setStrategyError('');
			setStrategyDialog({
				modelId,
				modelTitle,
				protocol,
				protocolLabel,
				group,
				poolId,
				poolStrategy,
				poolTierStrategies,
				priority,
				requestOperation,
				inheritedStrategy: inherited.strategy,
				inheritedSource: inherited.source,
				targets: matchingTargets,
			});
		},
		[globalRouteStrategy, locale, modelMeta, providerMeta, routes, tKind],
	);

	const handleSaveStrategy = useCallback(async () => {
		const scope = lifetime.current;
		if (!scope || scope.signal.aborted) return;
		if (!strategyDialog) return;
		setStrategySaving(true);
		setStrategyError('');
		try {
			let result: { success: true } | { success: false; message: string };
			if (strategyDialog.poolId) {
				if (strategyDialog.priority !== undefined) {
					const tierMap = parseRoutePoolTierStrategies(strategyDialog.poolTierStrategies);
					const next = strategyForm.tierStrategy.trim().toLowerCase();
					if (next && isRouteStrategyName(next)) {
						tierMap.set(strategyDialog.priority, next);
					} else {
						tierMap.delete(strategyDialog.priority);
					}
					const tierObj: Record<string, string> = {};
					for (const [priority, strategy] of tierMap) {
						tierObj[String(priority)] = strategy;
					}
					// Tier dialog only mutates per-priority overrides; pool/global stay elsewhere.
					result = await patchRoutePoolPolicy(strategyDialog.poolId, {
						tier_strategies: Object.keys(tierObj).length > 0 ? tierObj : null,
					});
				} else {
					result = await patchRoutePoolPolicy(strategyDialog.poolId, {
						strategy: strategyForm.protocolStrategy || null,
					});
				}
			} else {
				result = await patchModelRoutePolicy(
					strategyDialog.modelId,
					buildRoutePolicyPatch(
						modelMeta.get(strategyDialog.modelId)?.route_policy ?? null,
						strategyDialog.protocol,
						strategyDialog.group,
						strategyForm,
					),
					modelMeta.get(strategyDialog.modelId)?.route_policy ?? null,
				);
			}
			if (scope.signal.aborted || lifetime.current !== scope) return;
			if (!result.success) {
				setStrategyError(result.message);
				return;
			}
			setStrategyDialog(null);
			await refreshRoutesPage();
		} catch (error) {
			if (scope.signal.aborted || lifetime.current !== scope) return;
			setStrategyError(error instanceof Error ? error.message : 'Save failed, please try again');
		} finally {
			if (!scope.signal.aborted && lifetime.current === scope) setStrategySaving(false);
		}
	}, [modelMeta, refreshRoutesPage, strategyDialog, strategyForm]);

	const handleOpenProviderStickyDialog = useCallback(
		(
			modelId: string,
			modelTitle: string,
			protocol: string,
			protocolLabel: string,
			group: string,
			requestOperation: string,
			poolId: string | null,
			enabled: boolean,
			idleTtlSeconds: number,
			targets: Array<{
				id: string;
				providerName: string;
				priority: number;
				weight: number;
			}> = [],
			initialTargetId?: string,
		) => {
			setStickyForm({
				enabled,
				idleTtlSeconds: Number.isFinite(idleTtlSeconds) ? idleTtlSeconds : DEFAULT_STICKY_IDLE_TTL_SECONDS,
			});
			setStickyError('');
			setStickyDialog({
				modelId,
				modelTitle,
				protocol,
				protocolLabel,
				group,
				requestOperation,
				poolId,
				enabled,
				idleTtlSeconds: Number.isFinite(idleTtlSeconds) ? idleTtlSeconds : DEFAULT_STICKY_IDLE_TTL_SECONDS,
				targets,
				initialTargetId,
			});
		},
		[],
	);

	const handleSaveProviderSticky = useCallback(async () => {
		const scope = lifetime.current;
		if (!scope || scope.signal.aborted) return;
		if (!stickyDialog?.poolId) return;
		setStickySaving(true);
		setStickyError('');
		try {
			const result = await patchRoutePoolPolicy(stickyDialog.poolId, {
				sticky_routing: {
					enabled: stickyForm.enabled,
					idle_ttl_seconds: stickyForm.idleTtlSeconds,
				},
			});
			if (scope.signal.aborted || lifetime.current !== scope) return;
			if (!result.success) {
				setStickyError(result.message);
				return;
			}
			setStickyDialog(null);
			await refreshRoutesPage();
		} catch (error) {
			if (scope.signal.aborted || lifetime.current !== scope) return;
			setStickyError(error instanceof Error ? error.message : 'Save failed, please try again');
		} finally {
			if (!scope.signal.aborted && lifetime.current === scope) setStickySaving(false);
		}
	}, [refreshRoutesPage, stickyDialog, stickyForm]);

	const closeRouteModal = useCallback(() => {
		if (isSaving || isDeleting) return;
		setShowModal(false);
	}, [isDeleting, isSaving]);

	const closeStrategyDialog = useCallback(() => {
		if (strategySaving) return;
		setStrategyDialog(null);
	}, [strategySaving]);

	const closeStickyDialog = useCallback(() => {
		if (stickySaving) return;
		setStickyDialog(null);
	}, [stickySaving]);

	return {
		isLoading,
		routes,
		models,
		providers,
		globalRouteStrategy,
		modelMeta,
		providerMeta,
		billingCurrency,
		filterVendor,
		filterModels,
		setFilterModels,
		modelFilterGroups,
		providerFilterGroups,
		searchQuery,
		setSearchQuery,
		filterProviders,
		setFilterProviders,
		filterRouteGroup,
		setFilterRouteGroup,
		filterStatus,
		setFilterStatus,
		filterKind,
		setFilterKind,
		hasActiveFilters,
		clearAllFilters,
		statusCounts,
		kindCounts,
		routeGroupFilterOptions,
		routeGroupCounts,
		routesByModel,
		routeCards,
		routeCardVendorGroups,
		showModal,
		routeInitialTab,
		setShowModal,
		editingRoute,
		duplicateSourceRouteId,
		formData,
		setFormData,
		saveError,
		isSaving,
		isDeleting,
		togglingId,
		copiedModelId,
		selectedProvider,
		selectedModel,
		catalogStandardTierRows,
		catalogImagePricingDisplay,
		catalogAudioPricingDisplay,
		selectedModelIsImage,
		selectedModelIsAudio,
		allowedProtocolsForProvider,
		businessTimezone,
		strategyDialog,
		setStrategyDialog,
		strategyForm,
		setStrategyForm,
		strategySaving,
		strategyError,
		stickyDialog,
		stickyForm,
		setStickyForm,
		stickySaving,
		stickyError,
		handleCreate,
		handleEdit,
		handleDuplicate,
		handleDelete,
		handleToggleStatus,
		copyModelId,
		handleSave,
		handleOpenStrategyDialog,
		handleSaveStrategy,
		handleOpenProviderStickyDialog,
		handleSaveProviderSticky,
		closeRouteModal,
		closeStrategyDialog,
		closeStickyDialog,
		refreshRoutesPage,
		modelEdit,
	};
}
