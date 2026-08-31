'use client';

import { useTranslations } from 'next-intl';
import { parseRouteRoutingMetadata } from '@octafuse/core';
import {
	parseChargedFactorFromPriceOverride,
	parseMeteredFactorFromPriceOverride,
} from '@/lib/pricing-ui';
import {
	factorChipClassForValue,
	factorLevelForValue,
	formatFactorMultiplier,
	formatFactorMultiplierForChip,
	formatSharedScheduleWindowsHint,
	hasBasePricingInversion,
	resolveRouteScheduleDisplay,
} from '../route-utils';
import { FACTOR_CHIP_BASE } from '../types';
import type { RouteListRow } from '../types';

type Props = {
	route: RouteListRow;
	togglingId: string | null;
	onEdit: (route: RouteListRow) => void;
	onToggleStatus: (route: RouteListRow) => void;
};

function compactTokenCapacity(label: string, value: number | null): string | null {
	if (value == null) return null;
	if (value >= 1_000_000 && value % 1_000_000 === 0) return `${label} ${value / 1_000_000}m`;
	if (value >= 1_000 && value % 1_000 === 0) return `${label} ${value / 1_000}k`;
	return `${label} ${value}`;
}

export function RouteListItem(props: Props) {
	const { route, togglingId, onEdit, onToggleStatus } = props;
	const t = useTranslations('routes.listItem');
	const chargedF = parseChargedFactorFromPriceOverride(route.price_override);
	const meteredF = parseMeteredFactorFromPriceOverride(route.price_override);
	const chargedDisp = chargedF != null && Number.isFinite(chargedF) ? chargedF : 1;
	const meteredDisp = meteredF != null && Number.isFinite(meteredF) ? meteredF : 1;
	const schHint = formatSharedScheduleWindowsHint(resolveRouteScheduleDisplay(route.price_override));
	const chargedLevel = factorLevelForValue(chargedDisp);
	const meteredLevel = factorLevelForValue(meteredDisp);
	const chargedStatus = t(`factorStatus.charged.${chargedLevel}`);
	const meteredStatus = t(`factorStatus.metered.${meteredLevel}`);
	const hasPricingInversion = hasBasePricingInversion(chargedDisp, meteredDisp);
	const routingMetadata = parseRouteRoutingMetadata(route.routing_metadata);
	const routingMetadataLabel = routingMetadata
		? [
			routingMetadata.endpoint_slug,
			routingMetadata.endpoint_class === 'service_tier' ? 'service tier' : null,
			routingMetadata.quantization,
			routingMetadata.region,
				routingMetadata.supported_parameters.length > 0
				? `${routingMetadata.supported_parameters.length} params`
				: null,
			compactTokenCapacity('ctx', routingMetadata.context_length),
			compactTokenCapacity('prompt', routingMetadata.max_prompt_tokens),
			compactTokenCapacity('out', routingMetadata.max_completion_tokens),
		].filter(Boolean).join(' · ')
		: '';

	return (
		<li className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-gray-50/80">
			<div className="shrink-0 pt-0.5">
				<input
					type="checkbox"
					checked={route.status === 'active'}
					disabled={togglingId === route.id}
					onChange={() => onToggleStatus(route)}
					className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
					aria-label={route.status === 'active' ? t('routeEnabled') : t('routeDisabled')}
				/>
			</div>
			<div className="flex min-w-0 flex-1 items-start gap-3">
				<button
					type="button"
					onClick={() => onEdit(route)}
					className="-mx-1 min-w-0 flex-1 rounded-md px-1 py-0.5 text-left hover:bg-gray-100/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
				>
					<div className="flex min-w-0 flex-col gap-0.5 text-xs leading-snug">
						<div className="flex min-w-0 items-center gap-2">
							<div className="flex shrink-0 items-center gap-1.5" title={t('priorityTitle')}>
								<span className="text-[11px] font-semibold tabular-nums text-gray-600">
									P{route.priority}
								</span>
								<span className="text-[11px] font-semibold tabular-nums text-gray-500">
									W{route.weight ?? 1}
								</span>
							</div>
							<span
								className="min-w-0 flex-1 truncate font-medium text-gray-900"
								title={route.provider_name || route.provider_id}
							>
								{route.provider_name || route.provider_id}
							</span>
						</div>
						<div
							className="min-w-0 truncate text-left font-mono text-[11px] text-gray-600"
							title={route.provider_model_name}
						>
							{route.provider_model_name}
						</div>
					</div>
				</button>
				<div
					className="flex shrink-0 flex-col items-end justify-start gap-1.5 self-stretch pt-0.5 text-right"
					role="group"
					aria-label={t('factorsAria')}
				>
					<span
						className={factorChipClassForValue(chargedDisp, 'charged')}
						title={t('chargedTooltip', {
							value: formatFactorMultiplier(chargedDisp),
							status: chargedStatus,
						})}
						aria-label={t('chargedFactorAria', {
							value: formatFactorMultiplier(chargedDisp),
							status: chargedStatus,
						})}
					>
						{formatFactorMultiplierForChip(chargedDisp)}
					</span>
					<span
						className={factorChipClassForValue(meteredDisp, 'metered')}
						title={t('meteredTooltip', {
							value: formatFactorMultiplier(meteredDisp),
							status: meteredStatus,
						})}
						aria-label={t('meteredFactorAria', {
							value: formatFactorMultiplier(meteredDisp),
							status: meteredStatus,
						})}
					>
						{formatFactorMultiplierForChip(meteredDisp)}
					</span>
					{hasPricingInversion ? (
						<span
							className={`${FACTOR_CHIP_BASE} w-auto bg-rose-100 text-rose-950 ring-rose-300/90`}
							title={t('baseInversionTooltip')}
							aria-label={t('baseInversionTooltip')}
						>
							{t('baseInversionBadge')}
						</span>
					) : null}
					{schHint ? (
						<span
							className={`${FACTOR_CHIP_BASE} w-auto max-w-[7rem] truncate bg-sky-50 text-sky-900 ring-sky-200/90`}
							title={schHint}
							aria-label={t('scheduleAria', { windows: schHint })}
						>
							{t('scheduleBadge')}
						</span>
					) : null}
					{routingMetadataLabel ? (
						<span
							className={`${FACTOR_CHIP_BASE} w-auto max-w-[8rem] truncate bg-indigo-50 text-indigo-900 ring-indigo-200/90`}
							title={routingMetadataLabel}
							aria-label={routingMetadataLabel}
						>
							{routingMetadataLabel}
						</span>
					) : null}
				</div>
			</div>
		</li>
	);
}
