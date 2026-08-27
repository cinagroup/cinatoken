'use client';

import Link from 'next/link';
import {
	ArrowsRightLeftIcon,
	CpuChipIcon,
	GlobeAltIcon,
} from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';

type SetupStep = 'provider' | 'model' | 'route';

const STEPS: Array<{
	key: SetupStep;
	href: string;
	Icon: typeof GlobeAltIcon;
}> = [
	{ key: 'provider', href: '/admin/providers', Icon: GlobeAltIcon },
	{ key: 'model', href: '/admin/models', Icon: CpuChipIcon },
	{ key: 'route', href: '/admin/routes', Icon: ArrowsRightLeftIcon },
];

export function GatewaySetupGuide({ activeStep }: { activeStep: SetupStep }) {
	const t = useTranslations('gatewaySetup');

	return (
		<section
			aria-labelledby="gateway-setup-title"
			className="mb-5 rounded-xl border border-cyan-200 bg-white p-4 shadow-sm sm:mb-6 sm:p-5"
		>
			<div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
				<div>
					<h2 id="gateway-setup-title" className="text-sm font-semibold text-gray-900">
						{t('title')}
					</h2>
					<p className="mt-1 max-w-3xl text-xs leading-5 text-gray-600">
						{t('description')}
					</p>
				</div>
				<span className="mt-1 shrink-0 rounded-full bg-cyan-50 px-2.5 py-1 text-[11px] font-semibold text-cyan-700">
					{t('badge')}
				</span>
			</div>

			<ol className="mt-4 grid gap-2 md:grid-cols-3">
				{STEPS.map(({ key, href, Icon }, index) => {
					const active = key === activeStep;
					return (
						<li key={key}>
							<Link
								href={href}
								aria-current={active ? 'step' : undefined}
								className={`group flex h-full items-start gap-3 rounded-lg border px-3 py-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
									active
										? 'border-cyan-300 bg-cyan-50 text-cyan-950'
										: 'border-gray-200 bg-gray-50/70 text-gray-700 hover:border-cyan-200 hover:bg-cyan-50/60'
								}`}
							>
								<span
									className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
										active ? 'bg-cyan-600 text-white' : 'bg-white text-gray-500 shadow-sm'
									}`}
								>
									<Icon className="h-4 w-4" aria-hidden />
								</span>
								<span className="min-w-0">
									<span className="block text-xs font-semibold">
										{t('stepLabel', { step: index + 1 })} · {t(`steps.${key}.title`)}
									</span>
									<span className="mt-0.5 block text-[11px] leading-4 text-gray-500">
										{t(`steps.${key}.description`)}
									</span>
								</span>
							</Link>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
