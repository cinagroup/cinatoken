'use client';

import { AdjustmentsHorizontalIcon, ArrowRightIcon, BuildingOffice2Icon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import type { PublicCatalogProvider, PublicCatalogProvidersResult } from '@/lib/public-catalog';

type SortMode = 'models' | 'name' | 'newest';

function parseListParam(name: string): string[] {
	if (typeof window === 'undefined') return [];
	return (new URLSearchParams(window.location.search).get(name) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

function toggleItem(values: string[], value: string): string[] {
	return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function Facet({ checked, count, label, onChange }: { checked: boolean; count: number; label: string; onChange: () => void }) {
	return <label className="home-muted home-hover-text flex cursor-pointer items-center gap-2.5 py-1.5 text-sm"><input type="checkbox" checked={checked} onChange={onChange} className="h-4 w-4 rounded border-[var(--home-border-strong)] bg-transparent text-sky-500 focus:ring-sky-500" /><span className="min-w-0 flex-1 truncate">{label}</span><span className="home-faint text-xs tabular-nums">{count}</span></label>;
}

function FilterPanel({ providers, protocols, inputs, outputs, setProtocols, setInputs, setOutputs }: {
	providers: PublicCatalogProvider[]; protocols: string[]; inputs: string[]; outputs: string[];
	setProtocols: (value: string[]) => void; setInputs: (value: string[]) => void; setOutputs: (value: string[]) => void;
}) {
	const t = useTranslations('publicProviders');
	const facets = useMemo(() => {
		const count = (select: (provider: PublicCatalogProvider) => string[]) => {
			const map = new Map<string, number>();
			for (const provider of providers) for (const value of select(provider)) map.set(value, (map.get(value) ?? 0) + 1);
			return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
		};
		return { protocols: count((provider) => provider.protocols), inputs: count((provider) => provider.inputModalities), outputs: count((provider) => provider.outputModalities) };
	}, [providers]);
	const sections = [
		{ key: 'protocols', values: facets.protocols, selected: protocols, setter: setProtocols },
		{ key: 'inputs', values: facets.inputs, selected: inputs, setter: setInputs },
		{ key: 'outputs', values: facets.outputs, selected: outputs, setter: setOutputs },
	];
	return <div className="space-y-7">{sections.map((section, index) => <section key={section.key} className={index ? 'home-border border-t pt-6' : ''}><h2 className="home-text text-xs font-semibold uppercase tracking-[0.13em]">{t(`filters.${section.key}`)}</h2><div className="mt-3">{section.values.map(([value, count]) => <Facet key={value} label={value} count={count} checked={section.selected.includes(value)} onChange={() => section.setter(toggleItem(section.selected, value))} />)}</div></section>)}</div>;
}

export default function PublicProvidersPage({ catalog }: { catalog: PublicCatalogProvidersResult }) {
	const t = useTranslations('publicProviders');
	const [query, setQuery] = useState(() => typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('q') ?? '');
	const [sort, setSort] = useState<SortMode>(() => {
		if (typeof window === 'undefined') return 'models';
		const value = new URLSearchParams(window.location.search).get('sort');
		return value === 'name' || value === 'newest' ? value : 'models';
	});
	const [protocols, setProtocols] = useState(() => parseListParam('protocols'));
	const [inputs, setInputs] = useState(() => parseListParam('inputs'));
	const [outputs, setOutputs] = useState(() => parseListParam('outputs'));
	const [drawerOpen, setDrawerOpen] = useState(false);

	useEffect(() => {
		const params = new URLSearchParams();
		if (query.trim()) params.set('q', query.trim());
		if (protocols.length) params.set('protocols', protocols.join(','));
		if (inputs.length) params.set('inputs', inputs.join(','));
		if (outputs.length) params.set('outputs', outputs.join(','));
		if (sort !== 'models') params.set('sort', sort);
		const search = params.toString();
		window.history.replaceState(window.history.state, '', search ? `/providers?${search}` : '/providers');
	}, [inputs, outputs, protocols, query, sort]);

	useEffect(() => {
		if (!drawerOpen) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => { document.body.style.overflow = previous; };
	}, [drawerOpen]);

	const providers = useMemo(() => {
		const needle = query.trim().toLocaleLowerCase();
		return catalog.providers.filter((provider) => {
			if (needle && ![provider.id, provider.displayName, ...provider.protocols, ...provider.inputModalities, ...provider.outputModalities].some((value) => value.toLocaleLowerCase().includes(needle))) return false;
			if (protocols.length && !protocols.every((value) => provider.protocols.includes(value))) return false;
			if (inputs.length && !inputs.every((value) => provider.inputModalities.includes(value))) return false;
			if (outputs.length && !outputs.every((value) => provider.outputModalities.includes(value))) return false;
			return true;
		}).sort((a, b) => {
			if (sort === 'name') return a.displayName.localeCompare(b.displayName);
			if (sort === 'newest') return (b.latestReleasedAt ?? '').localeCompare(a.latestReleasedAt ?? '') || a.displayName.localeCompare(b.displayName);
			return b.modelCount - a.modelCount || a.displayName.localeCompare(b.displayName);
		});
	}, [catalog.providers, inputs, outputs, protocols, query, sort]);

	const filterProps = { providers: catalog.providers, protocols, inputs, outputs, setProtocols, setInputs, setOutputs };
	const activeFilters = protocols.length + inputs.length + outputs.length;
	const clearAll = () => { setQuery(''); setProtocols([]); setInputs([]); setOutputs([]); };

	return <main className="px-4 py-6 sm:px-8 lg:px-0 lg:py-0"><div className="mx-auto grid max-w-[1440px] lg:grid-cols-[230px_minmax(0,1fr)]">
		<aside className="home-border hidden min-h-[calc(100vh-4rem)] border-r px-5 py-8 lg:block"><div className="sticky top-24"><div className="mb-5 flex items-center justify-between"><p className="home-text text-sm font-semibold">{t('filters.title')}</p>{activeFilters ? <button type="button" onClick={clearAll} className="home-muted home-hover-text text-xs">{t('filters.clear')}</button> : null}</div><FilterPanel {...filterProps} /></div></aside>
		<section className="min-w-0 lg:px-8 lg:py-8 xl:px-10">
			<div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><h1 className="home-text text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">{t('title')}</h1><p className="home-muted mt-2 max-w-2xl text-sm leading-6">{t('description')}</p></div><Link href="/account/settings" className="home-action home-action-primary inline-flex h-9 w-fit shrink-0 items-center rounded-lg px-4 text-sm font-medium">{t('getKey')}</Link></div>
			<div className="mt-6 flex gap-2"><label className="relative min-w-0 flex-1"><span className="sr-only">{t('searchLabel')}</span><MagnifyingGlassIcon className="home-faint pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('searchPlaceholder')} className="home-catalog-control home-text h-10 w-full rounded-lg border pl-9 pr-10 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20" />{query ? <button type="button" onClick={() => setQuery('')} aria-label={t('clearSearch')} className="home-muted home-hover-text absolute right-2.5 top-1/2 -translate-y-1/2 p-1"><XMarkIcon className="h-4 w-4" /></button> : null}</label><button type="button" onClick={() => setDrawerOpen(true)} className="home-catalog-control home-text inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm lg:hidden"><AdjustmentsHorizontalIcon className="h-4 w-4" />{t('filters.title')}{activeFilters ? <span className="rounded-full bg-sky-500 px-1.5 text-[10px] text-white">{activeFilters}</span> : null}</button><select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} aria-label={t('sortLabel')} className="home-catalog-control home-text hidden h-10 rounded-lg border px-3 text-sm sm:block"><option value="models">{t('sort.models')}</option><option value="name">{t('sort.name')}</option><option value="newest">{t('sort.newest')}</option></select></div>
			{catalog.status === 'unavailable' ? <div className="home-catalog-card mt-8 rounded-xl border px-6 py-12 text-center"><h2 className="home-text text-lg font-semibold">{t('unavailable.title')}</h2><p className="home-muted mt-2 text-sm">{t('unavailable.description')}</p></div> : catalog.providers.length === 0 ? <div className="home-catalog-card mt-8 rounded-xl border px-6 py-12 text-center"><h2 className="home-text text-lg font-semibold">{t('publishedEmpty.title')}</h2><p className="home-muted mt-2 text-sm">{t('publishedEmpty.description')}</p></div> : providers.length === 0 ? <div className="home-catalog-card mt-8 rounded-xl border px-6 py-12 text-center"><h2 className="home-text text-lg font-semibold">{t('empty.title')}</h2><p className="home-muted mt-2 text-sm">{t('empty.description')}</p></div> : <><p className="home-faint mt-4 text-xs">{t('count', { count: providers.length })}</p>
				<div className="home-catalog-card mt-4 hidden overflow-x-auto rounded-xl border md:block"><table className="w-full min-w-[760px] text-left text-sm"><thead><tr className="home-border border-b">{['provider','models','protocols','inputs','outputs','latest'].map((key) => <th key={key} className="home-faint px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.1em]">{t(`columns.${key}`)}</th>)}</tr></thead><tbody>{providers.map((provider) => <tr key={provider.id} className="home-border border-b last:border-0"><td className="px-4 py-3"><Link href={`/models?vendors=${encodeURIComponent(provider.displayName)}`} className="home-text group flex items-center gap-2.5 font-medium hover:text-sky-500"><span className="home-catalog-icon inline-flex h-8 w-8 items-center justify-center rounded-md"><BuildingOffice2Icon className="h-4 w-4" /></span>{provider.displayName}<ArrowRightIcon className="h-3.5 w-3.5 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" /></Link></td><td className="home-text px-4 py-3 font-medium tabular-nums">{provider.modelCount}</td><td className="home-muted px-4 py-3 font-mono text-xs">{provider.protocols.join(', ') || '—'}</td><td className="home-muted px-4 py-3 text-xs">{provider.inputModalities.join(', ') || '—'}</td><td className="home-muted px-4 py-3 text-xs">{provider.outputModalities.join(', ') || '—'}</td><td className="home-muted px-4 py-3 tabular-nums">{provider.latestReleasedAt ?? '—'}</td></tr>)}</tbody></table></div>
				<div className="mt-4 grid gap-3 md:hidden">{providers.map((provider) => <Link key={provider.id} href={`/models?vendors=${encodeURIComponent(provider.displayName)}`} className="home-catalog-card group rounded-xl border p-4"><div className="flex items-center gap-3"><span className="home-catalog-icon inline-flex h-9 w-9 items-center justify-center rounded-lg"><BuildingOffice2Icon className="h-5 w-5" /></span><div className="min-w-0 flex-1"><h2 className="home-text font-semibold">{provider.displayName}</h2><p className="home-faint text-xs">{t('modelCount', { count: provider.modelCount })}</p></div><ArrowRightIcon className="home-faint h-4 w-4" /></div><div className="mt-3 flex flex-wrap gap-1.5">{[...provider.protocols, ...provider.outputModalities].slice(0, 6).map((value) => <span key={value} className="rounded-md border border-[var(--home-border)] px-2 py-1 text-[10px] home-faint">{value}</span>)}</div></Link>)}</div>
			</>}
		</section>
	</div>{drawerOpen ? <div className="fixed inset-0 z-[70] lg:hidden" role="dialog" aria-modal="true" aria-label={t('filters.title')}><button type="button" aria-label={t('filters.close')} onClick={() => setDrawerOpen(false)} className="absolute inset-0 bg-black/45" /><div className="home-catalog-drawer absolute inset-y-0 right-0 w-[min(88vw,360px)] overflow-y-auto border-l p-5"><div className="flex items-center justify-between"><h2 className="home-text font-semibold">{t('filters.title')}</h2><button type="button" onClick={() => setDrawerOpen(false)} aria-label={t('filters.close')} className="home-muted p-2"><XMarkIcon className="h-5 w-5" /></button></div><div className="mt-6"><FilterPanel {...filterProps} /></div><button type="button" onClick={() => setDrawerOpen(false)} className="home-action home-action-primary mt-8 h-10 w-full rounded-lg text-sm font-medium">{t('filters.show', { count: providers.length })}</button></div></div> : null}</main>;
}
