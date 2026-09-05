'use client';

import { useTranslations } from 'next-intl';
import { formatGatewayMoneyCompact } from '@/lib/format-gateway-currency';

export type ActivityGroup = {
	id: string;
	name: string | null;
	requestCount: number;
	successCount: number;
	errorCount: number;
	totalTokens: number;
	chargedCost: number;
};

type ActivityBreakdownProps = {
	models: ActivityGroup[];
	apiKeys: ActivityGroup[];
	providers: ActivityGroup[];
	limit: number;
	currency: string;
	locale: string;
	onSelectModel: (id: string) => void;
	onSelectApiKey: (id: string) => void;
	onSelectProvider: (name: string) => void;
};

function ActivityBreakdownList({
	title,
	groups,
	currency,
	locale,
	onSelect,
}: {
	title: string;
	groups: ActivityGroup[];
	currency: string;
	locale: string;
	onSelect: (id: string) => void;
}) {
	const t = useTranslations('portal.activity');
	const maxCost = Math.max(0, ...groups.map((group) => group.chargedCost));
	const maxRequests = Math.max(1, ...groups.map((group) => group.requestCount));

	return (
		<div className="min-w-0 p-4 sm:p-5">
			<h3 className="text-sm font-semibold">{title}</h3>
			{groups.length === 0 ? (
				<div className="console-muted py-8 text-center text-sm">{t('noGroupData')}</div>
			) : (
				<div className="mt-3 space-y-1">
					{groups.map((group) => {
						const displayName = group.name || group.id;
						const successRate = group.requestCount > 0
							? Math.round((group.successCount / group.requestCount) * 1_000) / 10
							: 0;
						const ratio = maxCost > 0
							? group.chargedCost / maxCost
							: group.requestCount / maxRequests;
						return (
							<button
								key={group.id}
								type="button"
								onClick={() => onSelect(group.id)}
								aria-label={t('filterByGroup', { name: displayName })}
								className="group relative block w-full overflow-hidden rounded-lg px-3 py-2.5 text-left transition hover:bg-[var(--console-panel-subtle)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500"
							>
								<span
									aria-hidden="true"
									className="absolute inset-y-0 left-0 bg-cyan-500/10 transition-all group-hover:bg-cyan-500/15"
									style={{ width: `${Math.max(2, ratio * 100)}%` }}
								/>
								<span className="relative flex min-w-0 items-start justify-between gap-3">
									<span className="min-w-0">
										<span className="block truncate text-sm font-medium" title={displayName}>{displayName}</span>
										{group.name && group.name !== group.id && (
											<code className="console-muted block truncate text-[11px]" title={group.id}>{group.id}</code>
										)}
										<span className="console-muted mt-1 block text-xs">
											{t('groupUsage', {
												requests: group.requestCount.toLocaleString(locale),
												tokens: group.totalTokens.toLocaleString(locale),
											})}
											{' · '}{t('successRate', { rate: successRate })}
										</span>
									</span>
									<span className="shrink-0 font-mono text-xs font-semibold tabular-nums">
										{formatGatewayMoneyCompact(group.chargedCost, currency)}
									</span>
								</span>
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

export default function ActivityBreakdown({
	models,
	apiKeys,
	providers,
	limit,
	currency,
	locale,
	onSelectModel,
	onSelectApiKey,
	onSelectProvider,
}: ActivityBreakdownProps) {
	const t = useTranslations('portal.activity');
	return (
		<section aria-labelledby="activity-breakdown-title" className="border-b" style={{ borderColor: 'var(--console-border)' }}>
			<div className="border-b px-4 py-3" style={{ borderColor: 'var(--console-border)' }}>
				<h2 id="activity-breakdown-title" className="text-sm font-semibold">{t('breakdown')}</h2>
				<p className="console-muted mt-0.5 text-xs">{t('topByChargedCost', { count: limit })}</p>
			</div>
			<div className="grid divide-y divide-[var(--console-border)] xl:grid-cols-3 xl:divide-x xl:divide-y-0">
				<ActivityBreakdownList
					title={t('topModels')}
					groups={models}
					currency={currency}
					locale={locale}
					onSelect={onSelectModel}
				/>
				<ActivityBreakdownList
					title={t('topApiKeys')}
					groups={apiKeys}
					currency={currency}
					locale={locale}
					onSelect={onSelectApiKey}
				/>
				<ActivityBreakdownList
					title={t('topProviders')}
					groups={providers}
					currency={currency}
					locale={locale}
					onSelect={onSelectProvider}
				/>
			</div>
		</section>
	);
}
