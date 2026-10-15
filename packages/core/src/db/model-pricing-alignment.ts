import { parsePricingProfile } from './pricing-profile';
import {
	catalogScheduleKeysEqual,
	isEveryIsoWeekday,
	parseRoutePricingSchedule,
	type DailyScheduleWindow,
} from './pricing-schedule';

export type ModelPricingRouteSnapshot = { id: string; price_override: string | null };
export type ModelPricingRouteAlignment = ModelPricingRouteSnapshot & { next: string };

/** No extra reads for unrelated patches or catalogs without official time windows. */
export function modelPricingScheduleUpdate(rest: Record<string, unknown>): DailyScheduleWindow[] | null {
	if (!Object.hasOwn(rest, 'pricing_profile') || typeof rest.pricing_profile !== 'string') return null;
	const windows = parsePricingProfile(rest.pricing_profile)?.schedule ?? [];
	return windows.length ? windows : null;
}
export function modelPricingScheduleChanged(previous: string | null, next: DailyScheduleWindow[]): boolean {
	return !catalogScheduleKeysEqual(parsePricingProfile(previous)?.schedule ?? [], next);
}
export function modelPricingRouteAlignments(
	rows: readonly ModelPricingRouteSnapshot[],
	next: DailyScheduleWindow[],
): ModelPricingRouteAlignment[] {
	const windows = next.map((window) => ({
		start: window.start,
		end: window.end,
		factor: 1,
		...(window.days && !isEveryIsoWeekday(window.days) ? { days: [...window.days] } : {}),
	}));
	return rows.flatMap((row) => {
		const parsed = parseRoutePricingSchedule(row.price_override);
		if (!parsed.charged.length && !parsed.metered.length && !parsed.provider.length) return [];
		const root: Record<string, unknown> = JSON.parse(row.price_override!);
		for (const key of ['metered', 'charged', 'input_price', 'output_price', 'cache_read_price', 'cache_write_price'])
			delete root[key];
		root.schedule = {
			mode: 'override',
			charged: windows,
			metered: windows,
			...(parsed.provider.length ? { provider: windows } : {}),
		};
		return [{ ...row, next: JSON.stringify(root) }];
	});
}
