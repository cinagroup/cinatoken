'use client';

import { useTranslations } from 'next-intl';

/** Fail visibly instead of rendering empty totals as if they were successful reads. */
export function DataLoadError({ onRetry }: { onRetry: () => void }) {
	const t = useTranslations('common');
	return (
		<div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
			<p>{t('dataLoadFailed')}</p>
			<button type="button" onClick={onRetry} className="mt-3 rounded-md border border-current px-3 py-2 font-medium">
				{t('retry')}
			</button>
		</div>
	);
}
