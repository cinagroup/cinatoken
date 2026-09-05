import { NextResponse } from 'next/server';
import {
	CINATOKEN_AUTH_POPUP_MESSAGE_TYPE,
	CINATOKEN_AUTH_POPUP_CHANNEL,
	cinaAuthPopupStorageKey,
	type CinaAuthPopupResult,
} from '@/lib/cinaauth/popup';

const scriptJson = (value: unknown): string =>
	JSON.stringify(value)
		.replaceAll('<', '\\u003c')
		.replaceAll('>', '\\u003e')
		.replaceAll('&', '\\u0026');

export function createCinaAuthPopupCompletionResponse(options: {
	requestId: string;
	appOrigin: string;
	callbackPath: string;
	ok: boolean;
	error?: string;
}): NextResponse {
	const result: CinaAuthPopupResult = {
		type: CINATOKEN_AUTH_POPUP_MESSAGE_TYPE,
		requestId: options.requestId,
		ok: options.ok,
		...(options.error === undefined ? {} : { error: options.error }),
	};
	const storageKey = cinaAuthPopupStorageKey(options.requestId);
	const nonce = crypto.randomUUID().replaceAll('-', '');
	const script = `(() => {
		const result = ${scriptJson(result)};
		try { localStorage.setItem(${scriptJson(storageKey)}, JSON.stringify(result)); } catch {}
		try { window.opener?.postMessage(result, ${scriptJson(options.appOrigin)}); } catch {}
		try {
			const channel = new BroadcastChannel(${scriptJson(CINATOKEN_AUTH_POPUP_CHANNEL)});
			channel.postMessage(result);
			channel.close();
		} catch {}
		window.setTimeout(() => window.close(), 75);
		window.setTimeout(() => {
			if (!window.closed) window.location.replace(${scriptJson(options.callbackPath)});
		}, 750);
	})();`;
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CinaToken</title></head><body><script nonce="${nonce}">${script}</script></body></html>`;
	return new NextResponse(html, {
		status: 200,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
		},
	});
}
