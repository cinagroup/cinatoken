'use client';

import {
	createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
	type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import {
	CINATOKEN_AUTH_POPUP_CHANNEL,
	CINATOKEN_AUTH_POPUP_TIMEOUT_MS,
	buildCenteredPopupFeatures,
	buildCinaAuthStartPath,
	cinaAuthPopupStorageKey,
	parseCinaAuthPopupResult,
} from '@/lib/cinaauth/popup';
import { checkCinaAuthBrowserSession } from '@/lib/cinaauth/browser-session';
import { notifyCinaAuthSessionChanged, subscribeCinaAuthSessionChanges } from '@/lib/cinaauth/session-events';

type LoginOptions = {
	intent: 'admin' | 'portal';
	callbackPath: string;
	register?: boolean;
	onAuthenticated: () => void | Promise<void>;
	onError?: (code: string) => void;
};

type Attempt = {
	options: LoginOptions;
	requestId: string;
	popup: Window;
	startedAt: number;
	verifying: boolean;
};

const PopupContext = createContext<{
	begin: (options: LoginOptions) => void;
	isWaiting: boolean;
} | null>(null);

/** One active authorization transaction per page, shared by all entry points. */
export default function CinaAuthPopupProvider({ children }: { children: ReactNode }) {
	const t = useTranslations('auth');
	const attemptRef = useRef<Attempt | null>(null);
	const [isWaiting, setIsWaiting] = useState(false);
	const [errorCode, setErrorCode] = useState('');

	const clearAttempt = useCallback(() => {
		const attempt = attemptRef.current;
		attemptRef.current = null;
		setIsWaiting(false);
		if (!attempt) return;
		try { attempt.popup.close(); } catch { /* COOP can sever the window handle. */ }
		try { localStorage.removeItem(cinaAuthPopupStorageKey(attempt.requestId)); } catch { /* Optional storage channel. */ }
	}, []);

	const failAttempt = useCallback((attempt: Attempt, code: string) => {
		if (attemptRef.current !== attempt) return;
		clearAttempt();
		if (attempt.options.onError) attempt.options.onError(code);
		else setErrorCode(code);
	}, [clearAttempt]);

	const receiveResult = useCallback(async (value: unknown) => {
		const attempt = attemptRef.current;
		if (!attempt || attempt.verifying) return;
		const result = parseCinaAuthPopupResult(value, attempt.requestId);
		if (!result) return;
		if (!result.ok) {
			failAttempt(attempt, result.error ?? 'oidc_failed');
			return;
		}
		attempt.verifying = true;
		// A cross-window signal never grants access: only the HttpOnly server session does.
		const session = await checkCinaAuthBrowserSession(attempt.options.intent);
		if (attemptRef.current !== attempt) return;
		if (session !== 'authenticated') {
			failAttempt(attempt, session === 'unavailable' ? 'session_unavailable' : 'oidc_failed');
			return;
		}
		clearAttempt();
		notifyCinaAuthSessionChanged('login');
		try {
			await attempt.options.onAuthenticated();
		} catch {
			if (attempt.options.onError) attempt.options.onError('session_unavailable');
			else setErrorCode('session_unavailable');
		}
	}, [clearAttempt, failAttempt]);

	useEffect(() => {
		const onMessage = (event: MessageEvent<unknown>) => {
			if (event.origin === window.location.origin) void receiveResult(event.data);
		};
		const onStorage = (event: StorageEvent) => {
			const attempt = attemptRef.current;
			if (!attempt || event.key !== cinaAuthPopupStorageKey(attempt.requestId) || !event.newValue) return;
			try { void receiveResult(JSON.parse(event.newValue) as unknown); } catch { /* Ignore invalid signals. */ }
		};
		let channel: BroadcastChannel | undefined;
		try {
			channel = new BroadcastChannel(CINATOKEN_AUTH_POPUP_CHANNEL);
			channel.onmessage = (event: MessageEvent<unknown>) => { void receiveResult(event.data); };
		} catch { /* Messages and storage cover browsers without BroadcastChannel. */ }
		window.addEventListener('message', onMessage);
		window.addEventListener('storage', onStorage);
		return () => {
			window.removeEventListener('message', onMessage);
			window.removeEventListener('storage', onStorage);
			channel?.close();
		};
	}, [receiveResult]);

	useEffect(() => {
		if (!isWaiting) return;
		const poll = () => {
			const attempt = attemptRef.current;
			if (!attempt) return;
			if (Date.now() - attempt.startedAt >= CINATOKEN_AUTH_POPUP_TIMEOUT_MS) {
				failAttempt(attempt, 'popup_expired');
				return;
			}
			try {
				const stored = localStorage.getItem(cinaAuthPopupStorageKey(attempt.requestId));
				if (stored) void receiveResult(JSON.parse(stored) as unknown);
			} catch { /* BroadcastChannel remains available when storage is disabled. */ }
		};
		const timer = window.setInterval(poll, 500);
		return () => window.clearInterval(timer);
	}, [failAttempt, isWaiting, receiveResult]);

	useEffect(() => () => clearAttempt(), [clearAttempt]);
	useEffect(() => subscribeCinaAuthSessionChanges(change => {
		if (change === 'logout') {
			clearAttempt();
			setErrorCode('');
		}
	}), [clearAttempt]);

	const refocus = useCallback(() => {
		try { attemptRef.current?.popup.focus(); } catch { /* Detached window. */ }
	}, []);

	const begin = useCallback((options: LoginOptions) => {
		// Do not inspect .closed: COOP can report true while the IdP popup is still open.
		if (attemptRef.current) {
			refocus();
			return;
		}
		setErrorCode('');
		const requestId = crypto.randomUUID();
		const popup = window.open('about:blank', `cinatoken-cinaauth-${requestId}`, buildCenteredPopupFeatures(window));
		if (!popup) {
			window.location.assign(buildCinaAuthStartPath({ ...options, register: options.register ?? false }));
			return;
		}
		const attempt: Attempt = { options, requestId, popup, startedAt: Date.now(), verifying: false };
		attemptRef.current = attempt;
		setIsWaiting(true);
		try {
			popup.location.replace(buildCinaAuthStartPath({
				...options, register: options.register ?? false, popupRequestId: requestId,
			}));
			popup.focus();
		} catch {
			failAttempt(attempt, 'oidc_failed');
		}
	}, [failAttempt, refocus]);

	const value = useMemo(() => ({ begin, isWaiting }), [begin, isWaiting]);
	return (
		<PopupContext.Provider value={value}>
			{children}
			{isWaiting || errorCode ? (
				<div className="console-shell console-panel fixed bottom-4 left-4 right-4 z-[100] rounded-xl border p-4 shadow-lg sm:left-auto sm:w-96" style={{ borderColor: 'var(--console-border)' }}>
					<div role={errorCode ? 'alert' : 'status'} aria-live="polite" className="text-sm">
						{errorCode
							? t(errorCode === 'admin_forbidden' ? 'adminForbidden' : errorCode === 'popup_expired' ? 'popupExpired' : errorCode === 'session_unavailable' ? 'sessionCheckUnavailable' : 'loginError')
							: t('popupWaitingHelp')}
					</div>
					<div className="mt-3 flex justify-end gap-2 text-sm">
						{isWaiting ? <button type="button" onClick={refocus} className="console-nav-link rounded-md px-3 py-1.5">{t('popupRefocus')}</button> : null}
						<button type="button" onClick={() => { clearAttempt(); setErrorCode(''); }} className="console-nav-link rounded-md px-3 py-1.5">{t(isWaiting ? 'popupCancel' : 'popupDismiss')}</button>
					</div>
				</div>
			) : null}
		</PopupContext.Provider>
	);
}

export function useCinaAuthPopup() {
	const context = useContext(PopupContext);
	if (!context) throw new Error('CinaAuthPopupProvider is missing');
	return context;
}
