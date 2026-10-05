import type { PublicCatalogPricingProfile } from "../../lib/public-catalog";

export type CatalogPriceUnit = "token" | "image" | "second" | "character";
export type CatalogPriceRow = {
	unit: CatalogPriceUnit;
	input: number | null;
	output: number | null;
};

export function hasImageTokenPrices(
	profile: PublicCatalogPricingProfile
): boolean {
	if (profile.image_billing_mode) return profile.image_billing_mode === "token";
	return profile.tiers.some(
		(tier) =>
			(tier.image_input_price ?? 0) > 0 || (tier.image_output_price ?? 0) > 0
	);
}

export function catalogPriceRows(
	profile: PublicCatalogPricingProfile | null
): CatalogPriceRow[] {
	if (!profile) return [];
	const rows: CatalogPriceRow[] = [];
	if (profile.image_billing_mode === "per_image" && profile.image) {
		rows.push({
			unit: "image",
			input: profile.image.input?.default ?? null,
			output: profile.image.default,
		});
	}
	if (
		profile.audio_billing_mode === "per_second" &&
		profile.audio?.price_per_second !== undefined
	) {
		rows.push({
			unit: "second",
			input: profile.audio.price_per_second,
			output: null,
		});
	}
	if (
		profile.audio_billing_mode === "per_character" &&
		profile.audio?.price_per_character !== undefined
	) {
		rows.push({
			unit: "character",
			input: profile.audio.price_per_character,
			output: null,
		});
	}
	if (
		profile.image_billing_mode !== "per_image" &&
		profile.audio_billing_mode !== "per_second" &&
		profile.audio_billing_mode !== "per_character"
	) {
		const tier = profile.tiers[0];
		if (tier)
			rows.push({
				unit: "token",
				input: tier.input_price,
				output: tier.output_price,
			});
	}
	return rows;
}

/** Values from different units cannot be compared numerically. Mixed/unknown
 * profiles sort after the unit groups; callers break ties by actual model name. */
export function compareCatalogPrices(
	a: PublicCatalogPricingProfile | null,
	b: PublicCatalogPricingProfile | null
): number {
	const left = catalogPriceRows(a);
	const right = catalogPriceRows(b);
	const leftUnit = left.length === 1 ? left[0].unit : "unknown";
	const rightUnit = right.length === 1 ? right[0].unit : "unknown";
	if (leftUnit !== rightUnit) return leftUnit.localeCompare(rightUnit);
	if (leftUnit === "unknown") return 0;
	return (
		(left[0].input ?? left[0].output!) - (right[0].input ?? right[0].output!)
	);
}

export function formatCatalogMoney(
	value: number,
	currency: string,
	locale: string
): string {
	return new Intl.NumberFormat(locale, {
		style: "currency",
		currency,
		currencyDisplay: "code",
		maximumSignificantDigits: 8,
	}).format(value);
}
