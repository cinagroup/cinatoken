export const CINATOKEN_AUTH_POPUP_MESSAGE_TYPE =
	'cinatoken:cinaauth-popup-complete';
export const CINATOKEN_AUTH_POPUP_STORAGE_PREFIX =
	'cinatoken:cinaauth-popup:';
export const CINATOKEN_AUTH_POPUP_CHANNEL = 'cinatoken:cinaauth-popup:v1';
export const CINATOKEN_AUTH_POPUP_TIMEOUT_MS = 10 * 60 * 1000;

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/u;

export type CinaAuthPopupResult = {
	type: typeof CINATOKEN_AUTH_POPUP_MESSAGE_TYPE;
	requestId: string;
	ok: boolean;
	error?: string;
};

export function isCinaAuthPopupRequestId(value: unknown): value is string {
	return typeof value === 'string' && UUID_V4.test(value);
}

export function cinaAuthPopupStorageKey(requestId: string): string {
	if (!isCinaAuthPopupRequestId(requestId)) {
		throw new TypeError('CinaAuth popup request id is invalid');
	}
	return `${CINATOKEN_AUTH_POPUP_STORAGE_PREFIX}${requestId}`;
}

export function parseCinaAuthPopupResult(
	value: unknown,
	expectedRequestId: string,
): CinaAuthPopupResult | null {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value)
	) {
		return null;
	}
	const candidate = value as Record<string, unknown>;
	if (
		candidate.type !== CINATOKEN_AUTH_POPUP_MESSAGE_TYPE ||
		candidate.requestId !== expectedRequestId ||
		!isCinaAuthPopupRequestId(candidate.requestId) ||
		typeof candidate.ok !== 'boolean'
	) {
		return null;
	}
	if (
		candidate.error !== undefined &&
		(typeof candidate.error !== 'string' || !ERROR_CODE.test(candidate.error))
	) {
		return null;
	}
	if (candidate.ok && candidate.error !== undefined) return null;
	return {
		type: CINATOKEN_AUTH_POPUP_MESSAGE_TYPE,
		requestId: candidate.requestId,
		ok: candidate.ok,
		...(candidate.error === undefined ? {} : { error: candidate.error }),
	};
}

export function buildCinaAuthStartPath(options: {
	intent: 'admin' | 'portal';
	callbackPath: string;
	register: boolean;
	popupRequestId?: string;
}): string {
	const params = new URLSearchParams({
		intent: options.intent,
		callbackURL: options.callbackPath,
	});
	if (options.register) params.set('mode', 'register');
	if (options.popupRequestId) {
		if (!isCinaAuthPopupRequestId(options.popupRequestId)) {
			throw new TypeError('CinaAuth popup request id is invalid');
		}
		params.set('presentation', 'popup');
		params.set('request', options.popupRequestId);
	}
	return `/api/auth/cinaauth/login?${params.toString()}`;
}

export function buildCenteredPopupFeatures(viewport: {
	screenX: number;
	screenY: number;
	outerWidth: number;
	outerHeight: number;
}): string {
	const width = 520;
	const height = 760;
	const left = Math.max(
		0,
		Math.round(viewport.screenX + (viewport.outerWidth - width) / 2),
	);
	const top = Math.max(
		0,
		Math.round(viewport.screenY + (viewport.outerHeight - height) / 2),
	);
	return [
		'popup=yes',
		`width=${width}`,
		`height=${height}`,
		`left=${left}`,
		`top=${top}`,
		'resizable=yes',
		'scrollbars=yes',
	].join(',');
}
