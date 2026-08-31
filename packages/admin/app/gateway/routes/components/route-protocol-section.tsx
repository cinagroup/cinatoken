'use client';

import { AdjustmentsHorizontalIcon } from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import { UpstreamProtocolBrandIcon } from '@/components/upstream-brand-logo';
import { parseRouteRoutingMetadata } from '@octafuse/core';
import { routePolicyRuleKey, parseModelRoutePolicy } from '@octafuse/core/db/model-route-policy';
import { protocolBadgeClass, splitRoutesByProtocolAndRouteGroup } from '../route-utils';
import { ROUTE_GROUP_CARD_BADGE_CLASS } from '../types';
import type { RouteListRow } from '../types';
import { RouteListItem } from './route-list-item';

type Props = {
	groupRoutes: RouteListRow[];
	modelId: string;
	modelTitle: string;
	routePolicy: string | null | undefined;
	togglingId: string | null;
	onEdit: (route: RouteListRow) => void;
	onToggleStatus: (route: RouteListRow) => void;
	onOpenStrategyDialog: (
		modelId: string,
		modelTitle: string,
		protocol: string,
		protocolLabel: string,
		group: string
	) => void;
};

function operationRequiresCompletionCapacity(protocol: string, operation: string): boolean {
	return (
		(protocol === 'openai' && (operation === 'chat' || operation === 'responses')) ||
		(protocol === 'anthropic' && operation === 'messages')
	);
}

export function RouteProtocolSections(props: Props) {
	const {
		groupRoutes,
		modelId,
		modelTitle,
		routePolicy,
		togglingId,
		onEdit,
		onToggleStatus,
		onOpenStrategyDialog,
	} = props;

	const t = useTranslations('routes.protocol');
	const routeSections = splitRoutesByProtocolAndRouteGroup(groupRoutes);
	const parsed = parseModelRoutePolicy(routePolicy ?? null);

	return (
		<>
			{routeSections.map((section, sectionIdx) => {
				const protocolStrategy =
					parsed?.rules.get(routePolicyRuleKey(section.protocol, null, section.group))?.strategy ??
					null;
				const missingCompletionCapacity = operationRequiresCompletionCapacity(
					section.protocol,
					section.requestOperation
				)
					? section.routes.filter(
							(route) =>
								route.status === 'active' &&
								parseRouteRoutingMetadata(route.routing_metadata)?.max_completion_tokens == null
					  ).length
					: 0;
				return (
					<div key={section.key} className={sectionIdx > 0 ? 'border-t border-gray-200/80' : ''}>
						<div
							className="flex items-center gap-2 border-b border-gray-100 bg-gray-50/60 px-4 py-1.5 transition-colors group-hover:bg-blue-50/40 group-focus-within:bg-blue-50/40"
							role="presentation"
						>
							<div
								className="flex min-w-0 flex-1 items-center gap-2"
								title={t('sectionTitle', { protocol: section.protocol, group: section.group })}
							>
								<span
									className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold leading-4 ring-1 ring-inset ${protocolBadgeClass(section.protocol)}`}
								>
									<UpstreamProtocolBrandIcon protocol={section.protocol} />
									{section.protocolLabel}
								</span>
								<span
									className={`inline-flex min-w-0 items-center rounded-md px-2 py-0.5 text-[11px] font-semibold leading-4 ${ROUTE_GROUP_CARD_BADGE_CLASS}`}
								>
									<span className="truncate">{section.group}</span>
								</span>
							</div>
							<button
								type="button"
								onClick={() =>
									onOpenStrategyDialog(
										modelId,
										modelTitle,
										section.protocol,
										section.protocolLabel,
										section.group
									)
								}
								className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold leading-4 ring-1 ring-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${
									protocolStrategy
										? 'bg-blue-50 text-blue-700 ring-blue-200 hover:bg-blue-100'
										: 'bg-white text-gray-400 ring-gray-200 hover:bg-gray-100 hover:text-gray-600'
								}`}
								title={
									protocolStrategy
										? t('strategyOn', { strategy: protocolStrategy })
										: t('strategyInherit')
								}
							>
								<AdjustmentsHorizontalIcon className="h-3 w-3" />
								{protocolStrategy
									? t('strategyLabel', { strategy: protocolStrategy })
									: t('strategyInheritLabel')}
							</button>
						</div>
						{missingCompletionCapacity > 0 ? (
							<div
								className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"
								role="status"
							>
								{t('capacityMissing', { count: missingCompletionCapacity })}
							</div>
						) : null}
						<ul className="flex flex-col divide-y divide-gray-100">
							{section.routes.map((route) => (
								<RouteListItem
									key={route.id}
									route={route}
									togglingId={togglingId}
									onEdit={onEdit}
									onToggleStatus={onToggleStatus}
								/>
							))}
						</ul>
					</div>
				);
			})}
		</>
	);
}
