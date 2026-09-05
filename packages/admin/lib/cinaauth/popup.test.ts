import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	CINATOKEN_AUTH_POPUP_MESSAGE_TYPE,
	buildCenteredPopupFeatures,
	buildCinaAuthStartPath,
	cinaAuthPopupStorageKey,
	isCinaAuthPopupRequestId,
	parseCinaAuthPopupResult,
} from './popup';

const requestId = '01890d4a-2f67-4a91-8b90-bbdcd0f584b6';

describe('CinaAuth popup protocol', () => {
	it('validates and scopes popup request ids', () => {
		assert.equal(isCinaAuthPopupRequestId(requestId), true);
		assert.equal(isCinaAuthPopupRequestId('01890d4a-2f67-1a91-8b90-bbdcd0f584b6'), false);
		assert.equal(isCinaAuthPopupRequestId('not-a-uuid'), false);
		assert.equal(
			cinaAuthPopupStorageKey(requestId),
			`cinatoken:cinaauth-popup:${requestId}`,
		);
		assert.throws(() => cinaAuthPopupStorageKey('invalid'), TypeError);
	});

	it('builds a portal registration URL with signed popup correlation inputs', () => {
		const path = buildCinaAuthStartPath({
			intent: 'portal',
			callbackPath: '/account?tab=keys',
			register: true,
			popupRequestId: requestId,
		});
		const url = new URL(path, 'https://cinatoken.com');
		assert.equal(url.pathname, '/api/auth/cinaauth/login');
		assert.equal(url.searchParams.get('intent'), 'portal');
		assert.equal(url.searchParams.get('callbackURL'), '/account?tab=keys');
		assert.equal(url.searchParams.get('mode'), 'register');
		assert.equal(url.searchParams.get('presentation'), 'popup');
		assert.equal(url.searchParams.get('request'), requestId);
	});

	it('accepts only a matching, well-formed completion result', () => {
		const success = {
			type: CINATOKEN_AUTH_POPUP_MESSAGE_TYPE,
			requestId,
			ok: true,
		};
		assert.deepEqual(parseCinaAuthPopupResult(success, requestId), success);
		assert.equal(
			parseCinaAuthPopupResult({ ...success, requestId: crypto.randomUUID() }, requestId),
			null,
		);
		assert.equal(
			parseCinaAuthPopupResult({ ...success, error: 'unexpected' }, requestId),
			null,
		);
		assert.equal(
			parseCinaAuthPopupResult({ ...success, ok: false, error: '<script>' }, requestId),
			null,
		);
	});

	it('centers a bounded popup and clamps negative coordinates', () => {
		assert.equal(
			buildCenteredPopupFeatures({
				screenX: 100,
				screenY: 50,
				outerWidth: 1440,
				outerHeight: 900,
			}),
			'popup=yes,width=520,height=760,left=560,top=120,resizable=yes,scrollbars=yes',
		);
		assert.match(
			buildCenteredPopupFeatures({
				screenX: -1000,
				screenY: -1000,
				outerWidth: 320,
				outerHeight: 480,
			}),
			/left=0,top=0/u,
		);
	});
});
