import type { MiddlewareHandler } from "hono";
import type { UserEnv } from "@/lib/user-env";

export const USER_PRINCIPAL_PRECONDITION_HEADER =
	"X-CinaToken-Expected-User-Id";
const MAX_USER_ID_LENGTH = 600;

function containsControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || (code >= 127 && code <= 159);
	});
}

/** The optional header compares identity; it never authenticates or selects a user. */
export function rejectUserPrincipalPrecondition(
	request: Request,
	authorizedUserId: string
): Response | null {
	const raw = request.headers.get(USER_PRINCIPAL_PRECONDITION_HEADER);
	if (raw === null) return null;
	let expected: string;
	try {
		// Fetch joins repeated headers with commas. A literal comma in an ID must be encoded.
		if (raw.length > MAX_USER_ID_LENGTH * 9 || raw.includes(",")) {
			throw new TypeError("invalid user precondition");
		}
		expected = decodeURIComponent(raw);
		if (
			!expected ||
			expected.length > MAX_USER_ID_LENGTH ||
			expected.trim() !== expected ||
			containsControlCharacter(expected) ||
			encodeURIComponent(expected) !== raw
		) {
			throw new TypeError("invalid user precondition");
		}
	} catch {
		return Response.json(
			{
				success: false,
				code: "invalid_user_precondition",
				message: "Expected user header is invalid",
			},
			{ status: 400, headers: { "Cache-Control": "private, no-store" } }
		);
	}
	if (expected === authorizedUserId) return null;
	return Response.json(
		{
			success: false,
			code: "user_mismatch",
			message: "User changed; refresh your session before retrying",
		},
		{ status: 409, headers: { "Cache-Control": "private, no-store" } }
	);
}

/** Runs after trusted authentication, before workspace resolution and domain operations. */
export const userPrincipalPrecondition: MiddlewareHandler<UserEnv> = async (
	c,
	next
) => {
	const principal = c.get("principal");
	if (!principal) {
		return c.json({ success: false, message: "Unauthorized" }, 401, {
			"Cache-Control": "private, no-store",
		});
	}
	const rejection = rejectUserPrincipalPrecondition(
		c.req.raw,
		principal.userId
	);
	if (rejection) return rejection;
	await next();
};
