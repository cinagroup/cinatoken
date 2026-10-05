import type { MiddlewareHandler } from "hono";
import type { UserEnv } from "@/lib/user-env";

export const USER_WORKSPACE_PRECONDITION_HEADER = "X-CinaToken-Workspace";
const MAX_WORKSPACE_ID_LENGTH = 600;

function containsControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
}

/** An optional URI-encoded precondition, never a source of workspace membership. */
export function rejectUserWorkspacePrecondition(
	request: Request,
	authorizedWorkspaceId: string
): Response | null {
	const raw = request.headers.get(USER_WORKSPACE_PRECONDITION_HEADER);
	if (raw === null) return null;
	let expected: string;
	try {
		if (raw.length > MAX_WORKSPACE_ID_LENGTH * 9 || raw.includes(",")) {
			throw new TypeError("invalid workspace precondition");
		}
		expected = decodeURIComponent(raw);
		if (
			!expected ||
			expected.length > MAX_WORKSPACE_ID_LENGTH ||
			expected.trim() !== expected ||
			containsControlCharacter(expected)
		) {
			throw new TypeError("invalid workspace precondition");
		}
	} catch {
		return Response.json(
			{
				success: false,
				code: "invalid_workspace_precondition",
				message: "Expected workspace header is invalid",
			},
			{ status: 400, headers: { "Cache-Control": "private, no-store" } }
		);
	}
	if (expected === authorizedWorkspaceId) return null;
	return Response.json(
		{
			success: false,
			code: "workspace_mismatch",
			message: "Workspace changed; refresh your session before retrying",
		},
		{ status: 409, headers: { "Cache-Control": "private, no-store" } }
	);
}

/** Must run after the principal and current authorized workspace have been resolved. */
export const userWorkspacePrecondition: MiddlewareHandler<UserEnv> = async (
	c,
	next
) => {
	// Logout must work even after the preferred workspace is unavailable or removed.
	if (
		c.req.path !== "/user/auth/logout" &&
		c.req.header(USER_WORKSPACE_PRECONDITION_HEADER) !== undefined
	) {
		const rejection = rejectUserWorkspacePrecondition(
			c.req.raw,
			c.get("workspaceContext").currentWorkspace.id
		);
		if (rejection) return rejection;
	}
	await next();
};
