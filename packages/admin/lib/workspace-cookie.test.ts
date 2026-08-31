import assert from 'node:assert/strict';
import test from 'node:test';
import {
	clearWorkspaceCookieHeader,
	readPreferredWorkspaceId,
	WORKSPACE_COOKIE_MAX_AGE_SECONDS,
	workspaceCookieHeader,
} from './workspace-cookie';

test('Workspace preference cookie round-trips opaque ids without becoming authorization', () => {
	const workspaceId = 'organization:org/東京?production';
	const header = workspaceCookieHeader(workspaceId, new Request('https://cinatoken.com/account'));
	assert.match(header, /HttpOnly; SameSite=Lax/u);
	assert.match(header, /; Secure$/u);
	assert.match(header, new RegExp(`Max-Age=${WORKSPACE_COOKIE_MAX_AGE_SECONDS}`, 'u'));
	assert.equal(
		readPreferredWorkspaceId(new Request('https://cinatoken.com/account', {
			headers: { cookie: header.split(';')[0] },
		})),
		workspaceId,
	);
});

test('Workspace preference cookie is bounded and supports local HTTP development', () => {
	const header = workspaceCookieHeader('personal:user-1', new Request('http://localhost:8789/account'));
	assert.doesNotMatch(header, /; Secure/u);
	assert.equal(readPreferredWorkspaceId(new Request('http://localhost', {
		headers: { cookie: `x=1; cinatoken_workspace=${'a'.repeat(601)}` },
	})), null);
	assert.match(clearWorkspaceCookieHeader(new Request('https://cinatoken.com')), /Max-Age=0; Secure$/u);
});
