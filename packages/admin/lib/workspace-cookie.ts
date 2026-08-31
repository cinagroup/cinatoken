/** Untrusted browser preference for the currently selected gateway Workspace. */
export const WORKSPACE_COOKIE = 'cinatoken_workspace';
export const WORKSPACE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const MAX_WORKSPACE_ID_LENGTH = 600;

function validWorkspaceId(value: string): string | null {
	const trimmed = value.trim();
	return trimmed && trimmed.length <= MAX_WORKSPACE_ID_LENGTH ? trimmed : null;
}

export function readPreferredWorkspaceId(request: Request): string | null {
	const cookieHeader = request.headers.get('cookie');
	if (!cookieHeader) return null;
	let selected: string | null = null;
	for (const part of cookieHeader.split(';')) {
		const [name, ...rest] = part.trim().split('=');
		if (name !== WORKSPACE_COOKIE) continue;
		try {
			selected = validWorkspaceId(decodeURIComponent(rest.join('=')));
		} catch {
			return null;
		}
	}
	return selected;
}

export function workspaceCookieHeader(workspaceId: string, request: Request): string {
	const valid = validWorkspaceId(workspaceId);
	if (!valid) throw new Error('workspace id is invalid');
	const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
	return `${WORKSPACE_COOKIE}=${encodeURIComponent(valid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${WORKSPACE_COOKIE_MAX_AGE_SECONDS}${secure}`;
}

export function clearWorkspaceCookieHeader(request: Request): string {
	const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
	return `${WORKSPACE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
