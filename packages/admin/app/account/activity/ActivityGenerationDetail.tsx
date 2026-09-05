'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { XMarkIcon } from '@heroicons/react/24/outline';
import type { PortalGenerationMetadataData } from '@octafuse/core';
import { formatGatewayMoneyCode } from '@/lib/format-gateway-currency';
import { readPortalJson } from '@/lib/portal-fetch';

type ActivityGenerationDetailProps = {
	id: string;
	locale: string;
	billingCurrency: string;
	chargedCost: number;
	onClose: () => void;
};

function DetailItem({ label, value, mono = false }: {
	label: string;
	value: string;
	mono?: boolean;
}) {
	return (
		<div className="min-w-0 border-b py-3 last:border-b-0" style={{ borderColor: 'var(--console-border)' }}>
		<dt className="console-muted text-xs">{label}</dt>
		<dd className={`mt-1 break-words text-sm ${mono ? 'font-mono text-xs' : 'font-medium'}`}>{value}</dd>
		</div>
	);
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section>
			<h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-cyan-600 dark:text-cyan-400">
				{title}
			</h3>
			<dl className="grid gap-x-6 sm:grid-cols-2">{children}</dl>
		</section>
	);
}

export default function ActivityGenerationDetail({
	id,
	locale,
	billingCurrency,
	chargedCost,
	onClose,
}: ActivityGenerationDetailProps) {
	const t = useTranslations('portal.activity');
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLElement>(null);
	const [data, setData] = useState<PortalGenerationMetadataData | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState('');

	useEffect(() => {
		const controller = new AbortController();
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const previousOverflow = document.body.style.overflow;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose();
			if (event.key === 'Tab') {
				const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
					'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
				);
				if (!focusable?.length) return;
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
				}
			}
		};
		document.body.style.overflow = 'hidden';
		document.addEventListener('keydown', onKeyDown);
		closeButtonRef.current?.focus();
		setData(null);
		setError('');
		setIsLoading(true);
		void (async () => {
			try {
				const response = await fetch(`/api/user/activity/${encodeURIComponent(id)}`, {
					cache: 'no-store',
					signal: controller.signal,
				});
				const payload = await readPortalJson<PortalGenerationMetadataData>(response);
				if (!response.ok || !payload?.success || !payload.data || payload.data.id !== id) {
					throw new Error(response.status === 404 ? t('detailUnavailable') : payload?.message || t('detailLoadFailed'));
				}
				setData(payload.data);
			} catch (loadError) {
				if (controller.signal.aborted) return;
				setError(loadError instanceof Error ? loadError.message : t('detailLoadFailed'));
			} finally {
				if (!controller.signal.aborted) setIsLoading(false);
			}
		})();

		return () => {
			controller.abort();
			document.removeEventListener('keydown', onKeyDown);
			document.body.style.overflow = previousOverflow;
			previousFocus?.focus();
		};
	}, [id, onClose, t]);

	const empty = '—';
	const text = (value: string | null) => value ?? empty;
	const number = (value: number | null) => value == null ? empty : value.toLocaleString(locale);
	const milliseconds = (value: number | null) => value == null ? empty : t('milliseconds', { value: Math.round(value) });
	const boolean = (value: boolean | null) => value == null ? t('unknown') : value ? t('yes') : t('no');
	const usd = (value: number | null) => value == null
		? empty
		: new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: 'USD',
			minimumFractionDigits: 0,
			maximumFractionDigits: 8,
		}).format(value);

	return (
		<div
			className="fixed inset-0 z-[80] flex justify-end bg-black/40"
			onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
		>
			<aside
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="activity-generation-title"
				aria-describedby="activity-generation-privacy"
				className="console-panel h-full w-full max-w-2xl overflow-y-auto border-l shadow-2xl"
				style={{ borderColor: 'var(--console-border)' }}
			>
				<header
					className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b bg-[var(--console-panel)] px-5 py-4 sm:px-6"
					style={{ borderColor: 'var(--console-border)' }}
				>
					<div className="min-w-0">
						<h2 id="activity-generation-title" className="text-lg font-semibold">{t('generationDetails')}</h2>
						<code className="console-muted mt-1 block truncate text-xs" title={id}>{id}</code>
					</div>
					<button
						ref={closeButtonRef}
						type="button"
						onClick={onClose}
						aria-label={t('closeDetails')}
						className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border transition hover:bg-[var(--console-panel-subtle)]"
						style={{ borderColor: 'var(--console-border)' }}
					>
						<XMarkIcon className="h-5 w-5" />
					</button>
				</header>

				<div className="space-y-7 px-5 py-6 sm:px-6">
					<p id="activity-generation-privacy" className="console-muted text-sm leading-6">{t('detailsPrivacy')}</p>

					{isLoading && <div className="console-muted py-12 text-center text-sm">{t('detailLoading')}</div>}
					{error && (
						<div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300">
							{error}
						</div>
					)}

					{data && (
						<>
							<DetailSection title={t('detailOverview')}>
								<DetailItem label={t('createdAt')} value={new Date(data.created_at).toLocaleString(locale)} />
								<DetailItem label={t('model')} value={data.model} mono />
								<DetailItem label={t('apiType')} value={text(data.api_type)} />
								<DetailItem label={t('provider')} value={text(data.provider_name)} />
								<DetailItem label={t('dataRegion')} value={data.data_region} />
								<DetailItem label={t('serviceTier')} value={text(data.service_tier)} />
								<DetailItem label={t('finishReason')} value={text(data.finish_reason)} />
								<DetailItem label={t('nativeFinishReason')} value={text(data.native_finish_reason)} />
							</DetailSection>

							<DetailSection title={t('detailPerformance')}>
								<DetailItem label={t('latency')} value={milliseconds(data.latency)} />
								<DetailItem label={t('generationTime')} value={milliseconds(data.generation_time)} />
								<DetailItem label={t('streamed')} value={boolean(data.streamed)} />
								<DetailItem label={t('cancelled')} value={boolean(data.cancelled)} />
							</DetailSection>

							<DetailSection title={t('detailUsage')}>
								<DetailItem label={t('promptTokens')} value={number(data.native_tokens_prompt)} />
								<DetailItem label={t('completionTokens')} value={number(data.native_tokens_completion)} />
								<DetailItem label={t('cachedTokens')} value={number(data.native_tokens_cached)} />
								<DetailItem label={t('reasoningTokens')} value={number(data.native_tokens_reasoning)} />
								<DetailItem label={t('completionImageTokens')} value={number(data.native_tokens_completion_images)} />
								<DetailItem label={t('mediaInputOutput')} value={`${number(data.num_media_prompt)} / ${number(data.num_media_completion)}`} />
							</DetailSection>

							<DetailSection title={t('detailCost')}>
								<DetailItem label={t('chargedCost')} value={formatGatewayMoneyCode(chargedCost, billingCurrency)} />
								<DetailItem label={t('upstreamCostUsd')} value={usd(data.upstream_inference_cost)} />
								<DetailItem label={t('byok')} value={boolean(data.is_byok)} />
							</DetailSection>

							<DetailSection title={t('detailContext')}>
								<DetailItem label={t('origin')} value={data.origin} mono />
								<DetailItem label={t('httpReferer')} value={text(data.http_referer)} mono />
								<DetailItem label={t('sessionId')} value={text(data.session_id)} mono />
								<DetailItem label={t('upstreamId')} value={text(data.upstream_id)} mono />
								<DetailItem label={t('userAgent')} value={text(data.user_agent)} mono />
							</DetailSection>

							<section>
								<h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-cyan-600 dark:text-cyan-400">
									{t('providerAttempts')}
								</h3>
								{!data.provider_responses?.length ? (
									<p className="console-muted text-sm">{t('noProviderAttempts')}</p>
								) : (
									<div className="space-y-3">
										{data.provider_responses.map((attempt, index) => (
											<div key={`${attempt.id ?? attempt.endpoint_id ?? 'attempt'}-${index}`} className="rounded-xl border p-4" style={{ borderColor: 'var(--console-border)' }}>
												<div className="flex items-center justify-between gap-3">
													<div className="font-medium">{attempt.provider_name ?? t('providerAttempt', { number: index + 1 })}</div>
													<span className="console-badge rounded-full px-2 py-1 text-xs">{attempt.status ?? empty}</span>
												</div>
												<div className="console-muted mt-3 grid gap-2 text-xs sm:grid-cols-2">
													<div>{t('endpoint')}: <code>{attempt.endpoint_id ?? empty}</code></div>
													<div>{t('providerModel')}: <code>{attempt.model_permaslug ?? empty}</code></div>
													<div>{t('latency')}: {milliseconds(attempt.latency ?? null)}</div>
													<div>{t('serviceTier')}: {attempt.routed_service_tier ?? empty}</div>
												</div>
											</div>
										))}
									</div>
								)}
							</section>
						</>
					)}
				</div>
			</aside>
		</div>
	);
}
