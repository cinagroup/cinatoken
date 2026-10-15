'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createToolsConsoleSession, toolsConsoleReader, type ToolsConsoleState } from '@/app/gateway/tools/tools-console';
import { subscribeCinaAuthSessionChanges } from '@/lib/cinaauth/session-events';
import { ADMIN_SESSION_EXPIRED_EVENT_NAME } from '@/lib/admin-session-events';

const EditorRequestContext = createContext<typeof fetch | null>(null);
export function useAdvancedEditorRequest(): typeof fetch {
	return useContext(EditorRequestContext) ?? fetch;
}

export function AdvancedEditorLink(props: { feature: string; primary?: boolean }) {
	const t = useTranslations('common');
	return <div className="border-b border-gray-200 bg-white px-4 py-2 text-right text-sm"><Link className="text-blue-700 hover:underline" href={`/admin/${props.feature}${props.primary ? '' : '/advanced'}`}>{t(props.primary ? 'primaryWorkbench' : 'advancedEditor')}</Link></div>;
}

/** Unmount editors before rechecking identity, and bind every request to that verified scope. */
export default function AdvancedEditorGate(props: { feature: string; children: ReactNode }) {
	const t = useTranslations('common');
	const [state, setState] = useState<ToolsConsoleState>({ state: 'checking' });
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		const session = createToolsConsoleSession(toolsConsoleReader(), setState);
		const refresh = () => { void session.revalidate(); };
		const visibility = () => { if (document.visibilityState === 'visible') refresh(); else session.invalidate(); };
		const unsubscribe = subscribeCinaAuthSessionChanges(refresh);
		window.addEventListener('focus', refresh);
		window.addEventListener('pageshow', refresh);
		window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT_NAME, refresh);
		document.addEventListener('visibilitychange', visibility);
		refresh();
		return () => { session.dispose(); unsubscribe(); window.removeEventListener('focus', refresh); window.removeEventListener('pageshow', refresh); window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT_NAME, refresh); document.removeEventListener('visibilitychange', visibility); };
	}, [revision]);
	const scope = useMemo(() => new AbortController(), [state]);
	useEffect(() => () => scope.abort(), [scope]);
	const request = useMemo<typeof fetch>(() => async (input, init) => {
		if (state.state !== 'ready') throw new Error('Console identity unavailable');
		scope.signal.throwIfAborted();
		const original = new Request(input instanceof Request ? input : new URL(String(input), window.location.href), init);
		const signal = AbortSignal.any([scope.signal, original.signal]);
		const headers = new Headers(original.headers);
		if (new URL(original.url).pathname.startsWith('/api/admin/')) {
			if (!['GET', 'HEAD', 'OPTIONS'].includes(original.method.toUpperCase())) {
				const identity = await toolsConsoleReader()(signal);
				if (identity.subject !== state.subject) throw new Error('Console identity changed; reload before editing');
			}
			headers.set('X-CinaToken-Expected-Console-Subject', encodeURIComponent(state.subject));
		}
		signal.throwIfAborted();
		const response = await fetch(new Request(original, { headers, signal, cache: 'no-store' }));
		signal.throwIfAborted();
		return response;
	}, [state, scope]);
	return <><AdvancedEditorLink feature={props.feature} primary />{state.state === 'ready' ? <EditorRequestContext.Provider key={state.scopeKey} value={request}>{props.children}</EditorRequestContext.Provider> : <div className="p-6 text-sm text-gray-600" role="status">{state.state === 'checking' ? t('loading') : <button type="button" className="text-blue-700 underline" onClick={() => setRevision((value) => value + 1)}>{t('retry')}</button>}</div>}</>;
}
