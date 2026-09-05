'use client';

import {
	AdjustmentsHorizontalIcon,
	ChevronDownIcon,
	ListBulletIcon,
	MagnifyingGlassIcon,
	TableCellsIcon,
	XMarkIcon,
} from '@heroicons/react/24/outline';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import type {
	PublicCatalogModel,
	PublicCatalogPricingProfile,
	PublicCatalogResult,
} from '@/lib/public-catalog';

type SortMode = 'newest' | 'context' | 'price' | 'name';
type OutputMode =
	| 'all'
	| 'text'
	| 'image'
	| 'embeddings'
	| 'audio'
	| 'video'
	| 'rerank'
	| 'speech'
	| 'transcription';
type ContextMode = 'all' | '128k' | '1m';
type ViewMode = 'list' | 'table';

const OUTPUT_MODES: OutputMode[] = [
	'all',
	'text',
	'image',
	'embeddings',
	'video',
	'audio',
	'rerank',
	'speech',
	'transcription',
];
const SORT_MODES: SortMode[] = ['newest', 'context', 'price', 'name'];
const CONTEXT_MODES: ContextMode[] = ['all', '128k', '1m'];
const VIEW_MODES: ViewMode[] = ['list', 'table'];

function parseListParam(name: string): string[] {
	if (typeof window === 'undefined') return [];
	return (new URLSearchParams(window.location.search).get(name) ?? '')
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean);
}

function parseEnumParam<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
	if (typeof window === 'undefined') return fallback;
	const value = new URLSearchParams(window.location.search).get(name);
	return value && allowed.includes(value as T) ? value as T : fallback;
}

function firstCatalogPrice(profile: PublicCatalogPricingProfile | null): number {
	if (!profile) return Number.POSITIVE_INFINITY;
	if (profile.image?.default != null) return profile.image.default;
	if (profile.audio?.price_per_second != null) return profile.audio.price_per_second;
	if (profile.audio?.price_per_character != null) return profile.audio.price_per_character;
	return profile.tiers[0]?.input_price ?? Number.POSITIVE_INFINITY;
}

function toggleItem(values: string[], value: string): string[] {
	return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function modelHref(model: PublicCatalogModel): string {
	return `/models/${encodeURIComponent(model.vendor)}/${encodeURIComponent(model.slug)}`;
}

function formatTokenCount(value: number | null, locale: string): string {
	if (value == null) return '—';
	return new Intl.NumberFormat(locale, {
		notation: 'compact',
		maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
	}).format(value);
}

function formatMoney(value: number, currency: string, locale: string): string {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency,
		currencyDisplay: 'narrowSymbol',
		minimumFractionDigits: value < 0.01 ? 4 : 2,
		maximumFractionDigits: value < 0.01 ? 6 : 2,
	}).format(value);
}

function PriceSummary({
	profile,
	currency,
	locale,
}: {
	profile: PublicCatalogPricingProfile | null;
	currency: string;
	locale: string;
}) {
	const t = useTranslations('publicModels');
	if (!profile) return <span className="home-faint">{t('pricing.unavailable')}</span>;
	if (profile.image?.default != null) {
		return (
			<span>
				{formatMoney(profile.image.default, currency, locale)}
				<span className="home-faint ml-1">{t('pricing.perImage')}</span>
			</span>
		);
	}
	if (profile.audio?.price_per_second != null) {
		return (
			<span>
				{formatMoney(profile.audio.price_per_second, currency, locale)}
				<span className="home-faint ml-1">{t('pricing.perSecond')}</span>
			</span>
		);
	}
	if (profile.audio?.price_per_character != null) {
		return (
			<span>
				{formatMoney(profile.audio.price_per_character, currency, locale)}
				<span className="home-faint ml-1">{t('pricing.perCharacter')}</span>
			</span>
		);
	}
	const tier = profile.tiers[0];
	if (!tier) return <span className="home-faint">{t('pricing.unavailable')}</span>;
	return (
		<span className="whitespace-nowrap">
			{formatMoney(tier.input_price, currency, locale)}
			<span className="home-faint mx-1">/</span>
			{formatMoney(tier.output_price, currency, locale)}
			<span className="home-faint ml-1">{t('pricing.perMillion')}</span>
		</span>
	);
}

function FacetCheckbox({
	ariaLabel,
	checked,
	count,
	label,
	onChange,
}: {
	ariaLabel?: string;
	checked: boolean;
	count?: number;
	label: string;
	onChange: () => void;
}) {
	return (
		<label className="home-muted home-hover-text group flex cursor-pointer items-center gap-2.5 py-1.5 text-sm transition-colors">
			<input
				type="checkbox"
				aria-label={ariaLabel}
				checked={checked}
				onChange={onChange}
				className="h-4 w-4 rounded border-[var(--home-border-strong)] bg-transparent text-sky-500 focus:ring-sky-500"
			/>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{count == null ? null : <span className="home-faint text-xs tabular-nums">{count}</span>}
		</label>
	);
}

function FilterPanel({
	context,
	inputModalities,
	models,
	protocols,
	selectedInputs,
	selectedProtocols,
	selectedVendors,
	setContext,
	setSelectedInputs,
	setSelectedProtocols,
	setSelectedVendors,
}: {
	context: ContextMode;
	inputModalities: Array<[string, number]>;
	models: PublicCatalogModel[];
	protocols: Array<[string, number]>;
	selectedInputs: string[];
	selectedProtocols: string[];
	selectedVendors: string[];
	setContext: (value: ContextMode) => void;
	setSelectedInputs: (value: string[]) => void;
	setSelectedProtocols: (value: string[]) => void;
	setSelectedVendors: (value: string[]) => void;
}) {
	const t = useTranslations('publicModels');
	const vendors = useMemo(() => {
		const counts = new Map<string, number>();
		for (const model of models) counts.set(model.vendor, (counts.get(model.vendor) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	}, [models]);

	return (
		<div className="space-y-7">
			<section>
				<h2 className="home-text text-xs font-semibold uppercase tracking-[0.13em]">{t('filters.providers')}</h2>
				<div className="mt-3 max-h-56 overflow-y-auto pr-2">
					{vendors.map(([vendor, count]) => (
						<FacetCheckbox
							key={vendor}
							ariaLabel={`${t('filters.providers')}: ${vendor}`}
							label={vendor}
							count={count}
							checked={selectedVendors.includes(vendor)}
							onChange={() => setSelectedVendors(toggleItem(selectedVendors, vendor))}
						/>
					))}
				</div>
			</section>

			<section className="home-border border-t pt-6">
				<h2 className="home-text text-xs font-semibold uppercase tracking-[0.13em]">{t('filters.input')}</h2>
				<div className="mt-3">
					{inputModalities.map(([modality, count]) => (
						<FacetCheckbox
							key={modality}
							ariaLabel={`${t('filters.input')}: ${t.has(`modalities.${modality}`) ? t(`modalities.${modality}`) : modality}`}
							label={t.has(`modalities.${modality}`) ? t(`modalities.${modality}`) : modality}
							count={count}
							checked={selectedInputs.includes(modality)}
							onChange={() => setSelectedInputs(toggleItem(selectedInputs, modality))}
						/>
					))}
				</div>
			</section>

			<section className="home-border border-t pt-6">
				<h2 className="home-text text-xs font-semibold uppercase tracking-[0.13em]">{t('filters.protocol')}</h2>
				<div className="mt-3">
					{protocols.map(([protocol, count]) => (
						<FacetCheckbox
							key={protocol}
							ariaLabel={`${t('filters.protocol')}: ${protocol}`}
							label={protocol}
							count={count}
							checked={selectedProtocols.includes(protocol)}
							onChange={() => setSelectedProtocols(toggleItem(selectedProtocols, protocol))}
						/>
					))}
				</div>
			</section>

			<section className="home-border border-t pt-6">
				<h2 className="home-text text-xs font-semibold uppercase tracking-[0.13em]">{t('filters.context')}</h2>
				<div className="mt-3 grid grid-cols-3 gap-1 rounded-lg border border-[var(--home-border-strong)] p-1">
					{CONTEXT_MODES.map((mode) => (
						<button
							key={mode}
							type="button"
							onClick={() => setContext(mode)}
							className={`rounded-md px-2 py-1.5 text-xs transition ${context === mode ? 'bg-[var(--home-menu-hover)] home-text' : 'home-muted home-hover-text'}`}
						>
							{t(`context.${mode}`)}
						</button>
					))}
				</div>
			</section>
		</div>
	);
}

function ModelBadges({ model }: { model: PublicCatalogModel }) {
	const t = useTranslations('publicModels');
	return (
		<div className="flex flex-wrap gap-1.5">
			{model.dataPolicySummary.zdrAvailable ? (
				<span className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
					ZDR
				</span>
			) : null}
			{model.inputModalities.slice(0, 4).map((modality) => (
				<span key={modality} className="rounded-md bg-[var(--home-menu-hover)] px-2 py-1 text-[11px] home-muted">
					{t.has(`modalities.${modality}`) ? t(`modalities.${modality}`) : modality}
				</span>
			))}
			{model.protocols.map((protocol) => (
				<span key={protocol} className="rounded-md border border-[var(--home-border)] px-2 py-1 font-mono text-[10px] home-faint">
					{protocol}
				</span>
			))}
		</div>
	);
}

function ModelCard({ model, billingCurrency }: { model: PublicCatalogModel; billingCurrency: string }) {
	const t = useTranslations('publicModels');
	const locale = useLocale();
	return (
		<article className="home-catalog-card group rounded-xl border px-4 py-4 transition-colors sm:px-5">
			<div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<h2 className="home-text text-base font-semibold tracking-[-0.02em] sm:text-lg">
							<Link href={modelHref(model)} className="rounded-sm outline-none transition-colors hover:text-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500">{model.displayName}</Link>
						</h2>
						{model.tags.slice(0, 2).map((tag) => (
							<span key={tag} className="rounded-full border border-[var(--home-border-strong)] px-2 py-0.5 text-[10px] font-medium home-muted">{tag}</span>
						))}
					</div>
					<p className="home-faint mt-1 truncate font-mono text-[11px]">{model.id}</p>
				</div>
				<div className="home-text shrink-0 text-right text-sm font-medium tabular-nums">
					<PriceSummary profile={model.pricingProfile} currency={billingCurrency} locale={locale} />
				</div>
			</div>

			{model.description ? <p className="home-muted mt-3 line-clamp-2 text-sm leading-5">{model.description}</p> : null}
			<div className="mt-3"><ModelBadges model={model} /></div>

			<div className="home-border mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-xs">
				<span className="home-muted">{t('byVendor', { vendor: model.vendor })}</span>
				{model.releasedAt ? <span className="home-faint tabular-nums">{model.releasedAt}</span> : null}
				<span className="home-muted">{t('contextValue', { value: formatTokenCount(model.contextWindow, locale) })}</span>
			</div>
		</article>
	);
}

function ModelsTable({ models, billingCurrency }: { models: PublicCatalogModel[]; billingCurrency: string }) {
	const t = useTranslations('publicModels');
	const locale = useLocale();
	return (
		<div className="home-catalog-card overflow-x-auto rounded-xl border">
			<table className="w-full min-w-[780px] border-collapse text-left text-sm">
				<thead>
					<tr className="home-border border-b">
						{['model', 'provider', 'context', 'pricing'].map((column) => (
							<th key={column} className="home-faint px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.12em]">{t(`columns.${column}`)}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{models.map((model) => (
						<tr key={model.id} className="home-border border-b last:border-b-0">
							<td className="px-4 py-4">
								<p className="home-text font-medium"><Link href={modelHref(model)} className="rounded-sm transition-colors hover:text-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">{model.displayName}</Link></p>
								<p className="home-faint mt-1 max-w-[340px] truncate font-mono text-[11px]">{model.id}</p>
							</td>
							<td className="home-muted px-4 py-4">
								<span>{model.vendor}</span>
								{model.dataPolicySummary.zdrAvailable ? <span className="ml-2 rounded border border-emerald-500/40 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">ZDR</span> : null}
							</td>
							<td className="home-muted px-4 py-4 tabular-nums">{formatTokenCount(model.contextWindow, locale)}</td>
							<td className="home-text px-4 py-4 font-medium tabular-nums"><PriceSummary profile={model.pricingProfile} currency={billingCurrency} locale={locale} /></td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export default function PublicModelsPage({ catalog }: { catalog: PublicCatalogResult }) {
	const t = useTranslations('publicModels');
	const [query, setQuery] = useState(() => typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('q') ?? '');
	const [output, setOutput] = useState<OutputMode>(() => parseEnumParam('output', OUTPUT_MODES, 'all'));
	const [sort, setSort] = useState<SortMode>(() => parseEnumParam('sort', SORT_MODES, 'newest'));
	const [view, setView] = useState<ViewMode>(() => parseEnumParam('view', VIEW_MODES, 'list'));
	const [context, setContext] = useState<ContextMode>(() => parseEnumParam('context', CONTEXT_MODES, 'all'));
	const [selectedVendors, setSelectedVendors] = useState(() => parseListParam('vendors'));
	const [selectedInputs, setSelectedInputs] = useState(() => parseListParam('inputs'));
	const [selectedProtocols, setSelectedProtocols] = useState(() => parseListParam('protocols'));
	const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

	useEffect(() => {
		const params = new URLSearchParams();
		if (query.trim()) params.set('q', query.trim());
		if (output !== 'all') params.set('output', output);
		if (selectedVendors.length) params.set('vendors', selectedVendors.join(','));
		if (selectedInputs.length) params.set('inputs', selectedInputs.join(','));
		if (selectedProtocols.length) params.set('protocols', selectedProtocols.join(','));
		if (context !== 'all') params.set('context', context);
		if (sort !== 'newest') params.set('sort', sort);
		if (view !== 'list') params.set('view', view);
		const search = params.toString();
		window.history.replaceState(window.history.state, '', search ? `/models?${search}` : '/models');
	}, [context, output, query, selectedInputs, selectedProtocols, selectedVendors, sort, view]);

	useEffect(() => {
		if (!mobileFiltersOpen) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => { document.body.style.overflow = previous; };
	}, [mobileFiltersOpen]);

	const facets = useMemo(() => {
		const inputs = new Map<string, number>();
		const protocols = new Map<string, number>();
		for (const model of catalog.models) {
			for (const modality of model.inputModalities) inputs.set(modality, (inputs.get(modality) ?? 0) + 1);
			for (const protocol of model.protocols) protocols.set(protocol, (protocols.get(protocol) ?? 0) + 1);
		}
		const sortEntries = (entries: Iterable<[string, number]>) => [...entries].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
		return { inputs: sortEntries(inputs.entries()), protocols: sortEntries(protocols.entries()) };
	}, [catalog.models]);

	const visibleModels = useMemo(() => {
		const needle = query.trim().toLocaleLowerCase();
		return catalog.models
			.filter((model) => {
				if (needle && ![model.id, model.displayName, model.vendor, model.description ?? '', ...model.tags]
					.some((value) => value.toLocaleLowerCase().includes(needle))) return false;
				if (output !== 'all' && !model.outputModalities.includes(output)) return false;
				if (selectedVendors.length && !selectedVendors.some((vendor) => vendor.toLocaleLowerCase() === model.vendor.toLocaleLowerCase())) return false;
				if (selectedInputs.length && !selectedInputs.every((value) => model.inputModalities.includes(value))) return false;
				if (selectedProtocols.length && !selectedProtocols.every((value) => model.protocols.includes(value))) return false;
				if (context === '128k' && (model.contextWindow ?? 0) < 128_000) return false;
				if (context === '1m' && (model.contextWindow ?? 0) < 1_000_000) return false;
				return true;
			})
			.sort((a, b) => {
				if (sort === 'context') return (b.contextWindow ?? -1) - (a.contextWindow ?? -1) || a.displayName.localeCompare(b.displayName);
				if (sort === 'price') return firstCatalogPrice(a.pricingProfile) - firstCatalogPrice(b.pricingProfile) || a.displayName.localeCompare(b.displayName);
				if (sort === 'name') return a.displayName.localeCompare(b.displayName);
				return (b.releasedAt ?? '').localeCompare(a.releasedAt ?? '') || a.displayName.localeCompare(b.displayName);
			});
	}, [catalog.models, context, output, query, selectedInputs, selectedProtocols, selectedVendors, sort]);

	const activeFilterCount = selectedVendors.length + selectedInputs.length + selectedProtocols.length + (context === 'all' ? 0 : 1);
	const clearFilters = () => {
		setQuery('');
		setOutput('all');
		setContext('all');
		setSelectedVendors([]);
		setSelectedInputs([]);
		setSelectedProtocols([]);
	};
	const panelProps = {
		context,
		inputModalities: facets.inputs,
		models: catalog.models,
		protocols: facets.protocols,
		selectedInputs,
		selectedProtocols,
		selectedVendors,
		setContext,
		setSelectedInputs,
		setSelectedProtocols,
		setSelectedVendors,
	};

	return (
		<main className="px-4 py-6 sm:px-8 lg:px-0 lg:py-0">
			<div className="mx-auto grid max-w-[1440px] lg:grid-cols-[230px_minmax(0,1fr)]">
				<aside className="home-border hidden min-h-[calc(100vh-4rem)] border-r px-5 py-8 lg:block">
					<div className="sticky top-24">
						<div className="mb-5 flex items-center justify-between">
							<p className="home-text text-sm font-semibold">{t('filters.title')}</p>
							{activeFilterCount || query || output !== 'all' ? (
								<button type="button" onClick={clearFilters} className="home-muted home-hover-text text-xs transition-colors">{t('filters.clear')}</button>
							) : null}
						</div>
						<FilterPanel {...panelProps} />
					</div>
				</aside>

				<section className="min-w-0 lg:px-8 lg:py-8 xl:px-10">
					<div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
						<div className="min-w-0">
							<h1 className="home-text text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">{t('title')}</h1>
							<p className="home-muted mt-2 max-w-3xl text-sm leading-6">{t('description')}</p>
						</div>
						<Link href="/account/settings" className="home-action home-action-primary inline-flex h-9 w-fit shrink-0 items-center justify-center rounded-lg px-4 text-sm font-medium transition">
							{t('getKey')}
						</Link>
					</div>

					<div className="mt-6 flex flex-col gap-2 xl:flex-row">
						<div className="relative min-w-0 flex-1">
							<MagnifyingGlassIcon className="home-faint pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden />
							<input
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder={t('searchPlaceholder')}
								aria-label={t('searchLabel')}
								className="home-catalog-control home-text h-10 w-full rounded-lg border pl-9 pr-10 text-sm outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20"
							/>
							{query ? (
								<button type="button" onClick={() => setQuery('')} className="home-muted home-hover-text absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1" aria-label={t('clearSearch')}><XMarkIcon className="h-4 w-4" aria-hidden /></button>
							) : null}
						</div>

						<div className="flex gap-2">
							<label className="relative min-w-0 flex-1 xl:flex-none">
								<span className="sr-only">{t('sort.label')}</span>
								<select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} className="home-catalog-control home-text h-10 w-full appearance-none rounded-lg border py-0 pl-3 pr-9 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 xl:w-[220px]">
									{SORT_MODES.map((mode) => <option key={mode} value={mode}>{t(`sort.${mode}`)}</option>)}
								</select>
								<ChevronDownIcon className="home-faint pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" aria-hidden />
							</label>
							<div className="home-catalog-control flex h-10 shrink-0 rounded-lg border p-1" role="tablist" aria-label={t('view.label')}>
								<button type="button" role="tab" aria-selected={view === 'list'} onClick={() => setView('list')} className={`rounded-md px-2 transition ${view === 'list' ? 'bg-[var(--home-menu-hover)] home-text' : 'home-muted home-hover-text'}`} aria-label={t('view.list')}><ListBulletIcon className="h-4 w-4" aria-hidden /></button>
								<button type="button" role="tab" aria-selected={view === 'table'} onClick={() => setView('table')} className={`rounded-md px-2 transition ${view === 'table' ? 'bg-[var(--home-menu-hover)] home-text' : 'home-muted home-hover-text'}`} aria-label={t('view.table')}><TableCellsIcon className="h-4 w-4" aria-hidden /></button>
							</div>
						</div>
					</div>

					<div className="home-border home-catalog-tabs mt-4 flex gap-1 overflow-x-auto border-b" role="tablist" aria-label={t('outputLabel')}>
						{OUTPUT_MODES.map((mode) => {
							const count = mode === 'all' ? catalog.models.length : catalog.models.filter((model) => model.outputModalities.includes(mode)).length;
							return (
								<button key={mode} type="button" role="tab" aria-selected={output === mode} onClick={() => setOutput(mode)} className={`relative whitespace-nowrap px-3 py-3 text-sm transition ${output === mode ? 'home-text' : 'home-muted home-hover-text'}`}>
									{t(`outputs.${mode}`)} <span className="home-faint ml-1 text-xs tabular-nums">{count}</span>
									{output === mode ? <span className="absolute inset-x-2 bottom-0 h-0.5 bg-sky-500" /> : null}
								</button>
							);
						})}
					</div>

					<div className="flex items-center justify-between gap-3 py-4">
						<div className="flex items-center gap-3">
							<button type="button" onClick={() => setMobileFiltersOpen(true)} className="home-catalog-control home-text inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm lg:hidden">
								<AdjustmentsHorizontalIcon className="h-4 w-4" aria-hidden />
								{t('filters.title')}
								{activeFilterCount ? <span className="rounded-full bg-sky-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">{activeFilterCount}</span> : null}
							</button>
							<p className="home-muted text-sm">{t('results.count', { count: visibleModels.length })}</p>
						</div>
						{activeFilterCount || query || output !== 'all' ? <button type="button" onClick={clearFilters} className="home-muted home-hover-text text-xs transition-colors lg:hidden">{t('filters.clear')}</button> : null}
					</div>

					{catalog.status === 'unavailable' ? (
						<div className="home-border-strong rounded-xl border px-6 py-12 text-center">
							<h2 className="home-text text-lg font-semibold">{t('unavailable.title')}</h2>
							<p className="home-muted mx-auto mt-2 max-w-lg text-sm leading-6">{t('unavailable.description')}</p>
						</div>
					) : catalog.models.length === 0 ? (
						<div className="home-border-strong rounded-xl border px-6 py-12 text-center">
							<h2 className="home-text text-lg font-semibold">{t('publishedEmpty.title')}</h2>
							<p className="home-muted mx-auto mt-2 max-w-lg text-sm leading-6">{t('publishedEmpty.description')}</p>
						</div>
					) : visibleModels.length === 0 ? (
						<div className="home-border-strong rounded-xl border px-6 py-12 text-center">
							<h2 className="home-text text-lg font-semibold">{t('empty.title')}</h2>
							<p className="home-muted mt-2 text-sm">{t('empty.description')}</p>
							<button type="button" onClick={clearFilters} className="home-action home-action-secondary mt-5 inline-flex h-9 items-center rounded-full border px-4 text-sm">{t('filters.clear')}</button>
						</div>
					) : view === 'table' ? (
						<ModelsTable models={visibleModels} billingCurrency={catalog.billingCurrency} />
					) : (
						<div className="space-y-2.5">
							{visibleModels.map((model) => <ModelCard key={model.id} model={model} billingCurrency={catalog.billingCurrency} />)}
						</div>
					)}
				</section>
			</div>

			{mobileFiltersOpen ? (
				<div className="fixed inset-0 z-[70] lg:hidden" role="dialog" aria-modal="true" aria-label={t('filters.title')}>
					<button type="button" className="absolute inset-0 bg-black/60" onClick={() => setMobileFiltersOpen(false)} aria-label={t('filters.close')} />
					<div className="home-catalog-drawer absolute inset-y-0 right-0 w-[min(90vw,380px)] overflow-y-auto border-l px-5 pb-8 pt-5 shadow-2xl">
						<div className="mb-6 flex items-center justify-between">
							<h2 className="home-text text-lg font-semibold">{t('filters.title')}</h2>
							<button type="button" onClick={() => setMobileFiltersOpen(false)} className="home-muted home-hover-text rounded-md p-2" aria-label={t('filters.close')}>
								<XMarkIcon className="h-5 w-5" aria-hidden />
							</button>
						</div>
						<FilterPanel {...panelProps} />
						<div className="mt-8 grid grid-cols-2 gap-3">
							<button type="button" onClick={clearFilters} className="home-action home-action-secondary h-10 rounded-lg border px-4 text-sm">{t('filters.clear')}</button>
							<button type="button" onClick={() => setMobileFiltersOpen(false)} className="home-action home-action-primary h-10 rounded-lg px-4 text-sm">{t('filters.show', { count: visibleModels.length })}</button>
						</div>
					</div>
				</div>
			) : null}
		</main>
	);
}
