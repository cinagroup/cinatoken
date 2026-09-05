'use client';

import { useTranslations } from 'next-intl';
import { useCinaAuthPopup } from './CinaAuthPopupProvider';

export default function CinaAuthLoginButtons({ intent, callbackPath, onAuthenticated, onError }: {
	intent: 'admin' | 'portal';
	callbackPath: string;
	onAuthenticated: () => void | Promise<void>;
	onError: (errorCode: string) => void;
}) {
	const t = useTranslations('auth');
	const { begin, isWaiting } = useCinaAuthPopup();
	return (
		<div className="space-y-3">
			<button
				type="button"
				onClick={() => begin({ intent, callbackPath, onAuthenticated, onError })}
				className="flex w-full items-center justify-center rounded-md bg-cyan-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2"
			>
				{isWaiting ? t('popupWaiting') : t('continueWithCinaAuth')}
			</button>
			<button
				type="button"
				disabled={isWaiting}
				onClick={() => begin({ intent, callbackPath, onAuthenticated, onError, register: true })}
				className="flex w-full items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2.5 font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 disabled:opacity-60"
			>
				{t('createAccount')}
			</button>
		</div>
	);
}
