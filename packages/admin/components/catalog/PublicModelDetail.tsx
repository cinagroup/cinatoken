"use client";

import {
	ArrowLeftIcon,
	ArrowTopRightOnSquareIcon,
	CheckCircleIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type {
	PublicCatalogModel,
	PublicCatalogModelResult,
} from "@/lib/public-catalog";
import { CINATOKEN_GITHUB_DOCS_INDEX } from "@/lib/brand";
import { PublicCatalogPricingDetails } from "./PublicCatalogPricing";

function formatTokenCount(value: number | null, locale: string): string {
	if (value == null) return "—";
	return new Intl.NumberFormat(locale, {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}

function codeSample(model: PublicCatalogModel): string {
	let lines: string[];
	if (model.recommendedProtocol === "anthropic") {
		lines = [
			"curl https://api.cinatoken.com/v1/messages \\",
			'  -H "x-api-key: $CINATOKEN_API_KEY" \\',
			'  -H "anthropic-version: 2023-06-01" \\',
			'  -H "content-type: application/json" \\',
			`  -d '{"model":"${model.id}","max_tokens":512,"messages":[{"role":"user","content":"Hello"}]}'`,
		];
	} else if (model.recommendedProtocol === "gemini") {
		lines = [
			`curl "https://api.cinatoken.com/v1beta/models/${encodeURIComponent(
				model.id
			)}:generateContent" \\`,
			'  -H "x-goog-api-key: $CINATOKEN_API_KEY" \\',
			'  -H "content-type: application/json" \\',
			'  -d \'{"contents":[{"parts":[{"text":"Hello"}]}]}\'',
		];
	} else {
		lines = [
			"curl https://api.cinatoken.com/v1/chat/completions \\",
			'  -H "Authorization: Bearer $CINATOKEN_API_KEY" \\',
			'  -H "content-type: application/json" \\',
			`  -d '{"model":"${model.id}","messages":[{"role":"user","content":"Hello"}]}'`,
		];
	}
	return lines.join("\n");
}

export default function PublicModelDetail({
	result,
}: {
	result: PublicCatalogModelResult;
}) {
	const t = useTranslations("publicModelDetail");
	const locale = useLocale();

	if (result.status !== "ready" || !result.model) {
		return (
			<main className="mx-auto max-w-5xl px-4 py-20 sm:px-8">
				<Link
					href="/models"
					className="home-muted home-hover-text inline-flex items-center gap-2 text-sm"
				>
					<ArrowLeftIcon className="h-4 w-4" />
					{t("back")}
				</Link>
				<div className="home-catalog-card mt-8 rounded-xl border px-6 py-12 text-center">
					<h1 className="home-text text-xl font-semibold">
						{t("unavailableTitle")}
					</h1>
					<p className="home-muted mx-auto mt-2 max-w-xl text-sm leading-6">
						{t("unavailableDescription")}
					</p>
				</div>
			</main>
		);
	}

	const model = result.model;
	return (
		<main className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
			<Link
				href="/models"
				className="home-muted home-hover-text inline-flex items-center gap-2 text-sm"
			>
				<ArrowLeftIcon className="h-4 w-4" />
				{t("back")}
			</Link>

			<div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_290px]">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2 text-sm">
						<Link
							href={`/models?vendors=${encodeURIComponent(model.vendor)}`}
							className="home-muted home-hover-text"
						>
							{model.vendor}
						</Link>
						<span className="home-faint">/</span>
						<span className="home-faint font-mono text-xs">{model.id}</span>
					</div>
					<h1 className="home-text mt-4 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">
						{model.displayName}
					</h1>
					<p className="home-muted mt-5 max-w-3xl text-base leading-7">
						{model.description ?? t("noDescription")}
					</p>
					<div className="mt-6 flex flex-wrap gap-2">
						{[...model.tags, ...model.protocols].map((value) => (
							<span
								key={value}
								className="rounded-full border border-[var(--home-border-strong)] px-3 py-1 text-xs home-muted"
							>
								{value}
							</span>
						))}
						{model.dataPolicySummary.zdrAvailable ? (
							<span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
								ZDR
							</span>
						) : null}
					</div>

					<section className="mt-12">
						<h2 className="home-text text-lg font-semibold">
							{t("pricingTitle")}
						</h2>
						<p className="home-muted mt-1 text-sm">{t("pricingDescription")}</p>
						<div className="home-catalog-card mt-4 overflow-hidden rounded-xl border">
							<PublicCatalogPricingDetails
								profile={model.pricingProfile}
								currency={result.billingCurrency}
							/>
						</div>
					</section>

					<section className="mt-10">
						<h2 className="home-text text-lg font-semibold">{t("apiTitle")}</h2>
						<p className="home-muted mt-1 text-sm">
							{t("apiDescription", { protocol: model.recommendedProtocol })}
						</p>
						<pre className="home-catalog-card home-text mt-4 overflow-x-auto rounded-xl border p-5 text-xs leading-6">
							<code>{codeSample(model)}</code>
						</pre>
					</section>
				</div>

				<aside>
					<div className="home-catalog-card rounded-xl border p-5 lg:sticky lg:top-24">
						<h2 className="home-text text-sm font-semibold">
							{t("capabilitiesTitle")}
						</h2>
						<dl className="mt-4 space-y-4 text-sm">
							{[
								[t("context"), formatTokenCount(model.contextWindow, locale)],
								[t("maxOutput"), formatTokenCount(model.maxTokens, locale)],
								[t("released"), model.releasedAt ?? "—"],
								[t("routeGroups"), model.routeGroups.join(", ") || "—"],
								[
									t("dataPolicy"),
									model.dataPolicySummary.zdrAvailable
										? t("zdrAvailable", {
												count: model.dataPolicySummary.verifiedRouteCount,
										  })
										: t("zdrUnavailable"),
								],
							].map(([label, value]) => (
								<div key={label}>
									<dt className="home-faint text-xs">{label}</dt>
									<dd className="home-text mt-1 break-words">{value}</dd>
								</div>
							))}
						</dl>
						<div className="home-border mt-5 border-t pt-5">
							<p className="home-faint text-xs">{t("modalities")}</p>
							<div className="mt-2 space-y-2 text-sm">
								<p className="home-muted flex gap-2">
									<CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
									{t("inputModalities", {
										values: model.inputModalities.join(", ") || "—",
									})}
								</p>
								<p className="home-muted flex gap-2">
									<CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
									{t("outputModalities", {
										values: model.outputModalities.join(", ") || "—",
									})}
								</p>
							</div>
						</div>
						<Link
							href="/account/settings"
							className="home-action home-action-primary mt-6 inline-flex h-10 w-full items-center justify-center rounded-lg px-4 text-sm font-medium"
						>
							{t("getKey")}
						</Link>
						<a
							href={CINATOKEN_GITHUB_DOCS_INDEX}
							target="_blank"
							rel="noreferrer"
							className="home-muted home-hover-text mt-3 inline-flex w-full items-center justify-center gap-1.5 text-sm"
						>
							{t("docs")}
							<ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
						</a>
					</div>
				</aside>
			</div>
		</main>
	);
}
