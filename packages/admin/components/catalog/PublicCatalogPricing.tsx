"use client";

import { useLocale, useTranslations } from "next-intl";
import type { PublicCatalogPricingProfile } from "../../lib/public-catalog";
import {
	catalogPriceRows,
	formatCatalogMoney,
	hasImageTokenPrices,
} from "./public-catalog-pricing";

const units = {
	token: "perMillion",
	image: "perImage",
	second: "perSecond",
	character: "perCharacter",
} as const;

export function PublicCatalogPriceSummary(props: {
	profile: PublicCatalogPricingProfile | null;
	currency: string;
}) {
	const t = useTranslations("publicPricing");
	const locale = useLocale();
	const rows = catalogPriceRows(props.profile);
	if (!rows.length)
		return <span className="home-faint">{t("unavailable")}</span>;
	return (
		<div className="space-y-1 text-xs">
			{rows.map((row) => (
				<div key={row.unit} className="flex flex-wrap gap-x-2 gap-y-1">
					{row.input !== null ? (
						<span className="home-text tabular-nums">
							{t("input")}:{" "}
							{formatCatalogMoney(row.input, props.currency, locale)}
						</span>
					) : null}
					{row.output !== null ? (
						<span className="home-text tabular-nums">
							{t("output")}:{" "}
							{formatCatalogMoney(row.output, props.currency, locale)}
						</span>
					) : null}
					<span className="home-faint">{t(units[row.unit])}</span>
				</div>
			))}
		</div>
	);
}

type ImageSide = NonNullable<PublicCatalogPricingProfile["image"]>;
function ImagePriceSide(props: { side: ImageSide; currency: string }) {
	const t = useTranslations("publicPricing");
	const locale = useLocale();
	return (
		<dl className="space-y-3 text-sm">
			<div className="flex flex-wrap justify-between gap-2">
				<dt className="home-muted">{t("default")}</dt>
				<dd className="home-text tabular-nums">
					{formatCatalogMoney(props.side.default, props.currency, locale)}
				</dd>
			</div>
			{(["by_quality", "by_size", "by_quality_size"] as const).map((field) =>
				props.side[field] ? (
					<div key={field} className="space-y-2">
						<dt className="home-muted">{t(field)}</dt>
						<dd>
							<dl className="space-y-2">
								{Object.entries(props.side[field]!).map(([key, value]) => (
									<div
										key={key}
										className="flex flex-wrap justify-between gap-2"
									>
										<dt className="home-faint break-all">{key}</dt>
										<dd className="home-text tabular-nums">
											{formatCatalogMoney(value, props.currency, locale)}
										</dd>
									</div>
								))}
							</dl>
						</dd>
					</div>
				) : null
			)}
		</dl>
	);
}

export function PublicCatalogPricingDetails(props: {
	profile: PublicCatalogPricingProfile | null;
	currency: string;
}) {
	const t = useTranslations("publicPricing");
	const locale = useLocale();
	const profile = props.profile;
	if (!profile)
		return <p className="home-muted p-4 text-sm">{t("unavailable")}</p>;
	const activeToken =
		profile.image_billing_mode !== "per_image" &&
		profile.audio_billing_mode !== "per_second" &&
		profile.audio_billing_mode !== "per_character";
	const imageFields = [
		"image_input_price",
		"image_input_cache_price",
		"image_output_price",
	] as const;
	const showImageFields =
		hasImageTokenPrices(profile) ||
		profile.tiers.some((tier) =>
			imageFields.some((field) => tier[field] !== null)
		);
	const tokenFields = [
		"input_price",
		"output_price",
		"cache_read_price",
		"cache_write_price",
	] as const;
	return (
		<div className="min-w-0 space-y-5 p-4">
			<p className="home-faint text-xs leading-5">
				{t("note", { currency: props.currency })}
			</p>
			{!catalogPriceRows(profile).length ? (
				<p className="home-muted text-sm">{t("unavailable")}</p>
			) : null}
			{activeToken && showImageFields && !hasImageTokenPrices(profile) ? (
				<p className="home-faint text-xs">{t("inactiveImageTokens")}</p>
			) : null}
			{activeToken
				? profile.tiers.map((tier, index) => (
						<section
							key={index}
							className="home-border space-y-3 rounded-lg border p-3"
						>
							<h3 className="home-text text-sm font-semibold">
								{tier.label || t("tier", { number: index + 1 })}
							</h3>
							<p className="home-faint text-xs">
								{tier.upto === null
									? t("unlimited")
									: t("upto", {
											count: new Intl.NumberFormat(locale).format(tier.upto),
									  })}{" "}
								· {t("perMillion")}
							</p>
							<dl className="space-y-2 text-sm">
								{[...tokenFields, ...(showImageFields ? imageFields : [])].map(
									(field) => (
										<div
											key={field}
											className="flex flex-wrap justify-between gap-x-4 gap-y-1"
										>
											<dt className="home-muted">{t(field)}</dt>
											<dd className="home-text break-words tabular-nums">
												{tier[field] === null
													? t("unknown")
													: formatCatalogMoney(
															tier[field],
															props.currency,
															locale
													  )}
											</dd>
										</div>
									)
								)}
							</dl>
						</section>
				  ))
				: null}
			{profile.image_billing_mode === "per_image" && profile.image ? (
				<section className="home-border space-y-4 rounded-lg border p-3">
					<h3 className="home-text font-semibold">{t("perImage")}</h3>
					<ImagePriceSide side={profile.image} currency={props.currency} />
					{profile.image.input ? (
						<section className="home-border space-y-3 border-t pt-3">
							<h4 className="home-text text-sm font-semibold">
								{t("reference")}
							</h4>
							<ImagePriceSide
								side={profile.image.input}
								currency={props.currency}
							/>
						</section>
					) : null}
					<p className="home-faint text-xs">
						{t("uncertain")}:{" "}
						{t(
							profile.image.uncertain_result_policy === "zero"
								? "zero"
								: "requested"
						)}
					</p>
				</section>
			) : null}
			{profile.image &&
			!profile.image_billing_mode &&
			!hasImageTokenPrices(profile) ? (
				<p className="home-faint text-xs">{t("legacyImage")}</p>
			) : null}
			{profile.audio_billing_mode === "per_second" &&
			profile.audio?.price_per_second !== undefined ? (
				<section className="home-border space-y-3 rounded-lg border p-3">
					<h3 className="home-text font-semibold">{t("perSecond")}</h3>
					<p className="home-text tabular-nums">
						{formatCatalogMoney(
							profile.audio.price_per_second,
							props.currency,
							locale
						)}
					</p>
					<p className="home-faint text-xs">
						{t("minimumSeconds", { count: profile.audio.minimum_seconds ?? 1 })}
					</p>
				</section>
			) : null}
			{profile.audio_billing_mode === "per_character" &&
			profile.audio?.price_per_character !== undefined ? (
				<section className="home-border space-y-3 rounded-lg border p-3">
					<h3 className="home-text font-semibold">{t("perCharacter")}</h3>
					<p className="home-text tabular-nums">
						{formatCatalogMoney(
							profile.audio.price_per_character,
							props.currency,
							locale
						)}
					</p>
					<p className="home-faint text-xs">
						{t("minimumCharacters", {
							count: profile.audio.minimum_characters ?? 0,
						})}
					</p>
				</section>
			) : null}
		</div>
	);
}
