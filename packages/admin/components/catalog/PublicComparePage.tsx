'use client';

import { PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import type { PublicCatalogModel, PublicCatalogResult } from '@/lib/public-catalog';

function modelKey(model: PublicCatalogModel): string { return `${encodeURIComponent(model.vendor)}:${model.slug}`; }
function formatTokens(value: number | null, locale: string): string { return value == null ? '—' : new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value); }
function price(model: PublicCatalogModel, currency: string, locale: string): string {
	const profile = model.pricingProfile;
	if (!profile) return '—';
	const money = (value: number) => new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: value < 0.01 ? 6 : 2 }).format(value);
	if (profile.image?.default != null) return `${money(profile.image.default)} / image`;
	if (profile.audio?.price_per_second != null) return `${money(profile.audio.price_per_second)} / second`;
	if (profile.audio?.price_per_character != null) return `${money(profile.audio.price_per_character)} / character`;
	const tier = profile.tiers[0];
	return tier ? `${money(tier.input_price)} / ${money(tier.output_price)}` : '—';
}

export default function PublicComparePage({ catalog }: { catalog: PublicCatalogResult }) {
	const t = useTranslations('publicCompare');
	const locale = useLocale();
	const byKey = useMemo(() => new Map(catalog.models.map((model) => [modelKey(model), model])), [catalog.models]);
	const [selectedKeys, setSelectedKeys] = useState<string[]>(() => {
		if (typeof window === 'undefined') return catalog.models.slice(0, 2).map(modelKey);
		const requested = (new URLSearchParams(window.location.search).get('models') ?? '').split(',').filter(Boolean);
		const valid = requested.filter((key) => byKey.has(key)).slice(0, 4);
		return valid.length ? valid : catalog.models.slice(0, 2).map(modelKey);
	});
	const [picker, setPicker] = useState('');
	const selected = selectedKeys.map((key) => byKey.get(key)).filter((model): model is PublicCatalogModel => Boolean(model));

	useEffect(() => {
		const params = new URLSearchParams();
		if (selectedKeys.length) params.set('models', selectedKeys.join(','));
		window.history.replaceState(window.history.state, '', params.size ? `/compare?${params}` : '/compare');
	}, [selectedKeys]);

	const addModel = () => {
		if (!picker || selectedKeys.includes(picker) || selectedKeys.length >= 4) return;
		setSelectedKeys([...selectedKeys, picker]);
		setPicker('');
	};
	const rows = [
		{ key: 'provider', value: (model: PublicCatalogModel) => model.vendor },
		{ key: 'modelId', value: (model: PublicCatalogModel) => model.id },
		{ key: 'context', value: (model: PublicCatalogModel) => formatTokens(model.contextWindow, locale) },
		{ key: 'maxOutput', value: (model: PublicCatalogModel) => formatTokens(model.maxTokens, locale) },
		{ key: 'input', value: (model: PublicCatalogModel) => model.inputModalities.join(', ') || '—' },
		{ key: 'output', value: (model: PublicCatalogModel) => model.outputModalities.join(', ') || '—' },
		{ key: 'protocols', value: (model: PublicCatalogModel) => model.protocols.join(', ') },
		{ key: 'released', value: (model: PublicCatalogModel) => model.releasedAt ?? '—' },
		{ key: 'price', value: (model: PublicCatalogModel) => price(model, catalog.billingCurrency, locale) },
	];

	return <main className="mx-auto max-w-[1280px] px-4 py-8 sm:px-8 sm:py-12"><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start"><div><h1 className="home-text text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">{t('title')}</h1><p className="home-muted mt-3 max-w-2xl text-sm leading-6">{t('description')}</p></div><Link href="/account/settings" className="home-action home-action-primary inline-flex h-10 w-fit items-center rounded-lg px-4 text-sm font-medium">{t('getKey')}</Link></div>
		<div className="mt-8 flex flex-col gap-2 sm:flex-row"><select value={picker} onChange={(event) => setPicker(event.target.value)} aria-label={t('pickerLabel')} className="home-catalog-control home-text h-10 min-w-0 flex-1 rounded-lg border px-3 text-sm"><option value="">{t('pickerPlaceholder')}</option>{catalog.models.filter((model) => !selectedKeys.includes(modelKey(model))).map((model) => <option key={modelKey(model)} value={modelKey(model)}>{model.displayName} · {model.vendor}</option>)}</select><button type="button" onClick={addModel} disabled={!picker || selectedKeys.length >= 4} className="home-action home-action-secondary inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium disabled:opacity-40"><PlusIcon className="h-4 w-4" />{t('add')}</button></div>
		{catalog.status === 'unavailable' ? <div className="home-catalog-card mt-8 rounded-xl border p-10 text-center"><h2 className="home-text font-semibold">{t('unavailable')}</h2></div> : selected.length === 0 ? <div className="home-catalog-card mt-8 rounded-xl border p-10 text-center"><h2 className="home-text font-semibold">{t('empty')}</h2></div> : <div className="home-catalog-card mt-8 overflow-x-auto rounded-xl border"><table className="w-full border-collapse text-left text-sm" style={{ minWidth: `${220 + selected.length * 250}px` }}><thead><tr className="home-border border-b"><th className="home-faint sticky left-0 z-10 bg-[var(--home-secondary-bg)] px-4 py-4 text-xs font-medium">{t('attribute')}</th>{selected.map((model) => <th key={modelKey(model)} className="min-w-[250px] px-4 py-4 align-top"><div className="flex items-start justify-between gap-3"><div><Link href={`/models/${encodeURIComponent(model.vendor)}/${encodeURIComponent(model.slug)}`} className="home-text font-semibold hover:text-sky-500">{model.displayName}</Link><p className="home-faint mt-1 text-xs">{model.vendor}</p></div><button type="button" onClick={() => setSelectedKeys(selectedKeys.filter((key) => key !== modelKey(model)))} aria-label={t('remove', { model: model.displayName })} className="home-muted home-hover-text rounded p-1"><XMarkIcon className="h-4 w-4" /></button></div></th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.key} className="home-border border-b last:border-0"><th className="home-faint sticky left-0 bg-[var(--home-secondary-bg)] px-4 py-4 text-xs font-medium">{t(`rows.${row.key}`)}</th>{selected.map((model) => <td key={modelKey(model)} className="home-text px-4 py-4 align-top">{row.value(model)}</td>)}</tr>)}</tbody></table></div>}
		<p className="home-faint mt-3 text-xs">{t('priceHint', { currency: catalog.billingCurrency })}</p>
	</main>;
}
