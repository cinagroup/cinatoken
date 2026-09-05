/** Authenticated, tenant-scoped OpenRouter generation metadata lookup. */
import {
	GENERATION_ID_PATTERN,
	isGenerationFeedbackCategory,
	toGenerationMetadataData,
	type GenerationMetadataData,
	type ManagementApiKeyAccount,
	type ManagementApiKeyPrincipal,
} from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../../app';
import type { ApiKeyContext } from '../../middleware/auth';
import { requireApiKey } from '../../middleware/auth';
import { requireManagementApiKey } from '../../middleware/management-auth';
import {
	BoundedJsonRequestError,
	readBoundedJsonObject,
} from '../../services/egress/bounded-json-request';
import { preDispatchCancelledTextResponse } from '../../services/egress/text-json-response';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';

type GenerationEnv = Env & {
	Variables: {
		apiKey: ApiKeyContext;
		managementKey: ManagementApiKeyPrincipal;
	};
};

const GENERATION_FEEDBACK_MAX_BODY_BYTES = 8 * 1024;
export { toGenerationMetadataData };
export type { GenerationMetadataData };

function requestedGenerationId(requestUrl: string): { ok: true; id: string } | { ok: false; missing: boolean } {
	const ids = new URL(requestUrl).searchParams.getAll('id');
	if (ids.length !== 1 || ids[0] === '') return { ok: false, missing: true };
	const id = ids[0]!;
	return GENERATION_ID_PATTERN.test(id)
		? { ok: true, id }
		: { ok: false, missing: false };
}

function notFound(c: Parameters<typeof gatewayErrorJson>[0]): Response {
	return gatewayErrorJson(c, {
		status: 404,
		code: GatewayErrorCode.modelNotFound,
		message: 'Resource not found',
	});
}

function managementAccount(
	principal: ManagementApiKeyPrincipal,
): ManagementApiKeyAccount {
	return {
		accountType: principal.accountType,
		personalOwnerUserId: principal.personalOwnerUserId,
		organizationId: principal.organizationId,
	};
}

function invalidFeedback(
	c: Parameters<typeof gatewayErrorJson>[0],
	message: string,
): Response {
	return gatewayErrorJson(c, {
		status: 400,
		code: GatewayErrorCode.invalidRequest,
		message,
	});
}

export const generationRoutes = new Hono<GenerationEnv>();

generationRoutes.get('/', requireApiKey, async (c) => {
	const parsedId = requestedGenerationId(c.req.url);
	if (!parsedId.ok) {
		if (!parsedId.missing) return notFound(c);
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'id query parameter is required exactly once',
			metadata: { param: 'id' },
		});
	}

	const apiKey = c.get('apiKey');
	try {
		const row = await c.get('repositories').requestLogs.getRequestLogByIdForOwner({
			id: parsedId.id,
			userId: apiKey.userId,
			workspaceId: apiKey.workspaceId,
		});
		if (!row) return notFound(c);

		c.header('Cache-Control', 'private, no-store');
		const data = toGenerationMetadataData(row);
		if (!data) return notFound(c);
		return c.json({ data });
	} catch (error) {
		console.error(JSON.stringify({
			message: 'generation metadata lookup failed',
			error_type: error instanceof Error ? error.name : 'UnknownError',
		}));
		return gatewayErrorJson(c, {
			status: 500,
			code: GatewayErrorCode.internalError,
			message: 'Generation metadata lookup failed',
		});
	}
});

generationRoutes.post('/feedback', requireManagementApiKey, async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: GENERATION_FEEDBACK_MAX_BODY_BYTES,
			label: 'Generation feedback request',
		});
	} catch (error) {
		if (error instanceof BoundedJsonRequestError) {
			if (error.kind === 'cancelled') {
				return preDispatchCancelledTextResponse('chat');
			}
			if (error.kind === 'payload_too_large') {
				return gatewayErrorJson(c, {
					status: 413,
					code: GatewayErrorCode.payloadTooLarge,
					message: 'Generation feedback request is too large',
				});
			}
			return invalidFeedback(c, error.message);
		}
		throw error;
	}

	const generationId = body.generation_id;
	if (typeof generationId !== 'string' || generationId.length === 0) {
		return invalidFeedback(c, 'generation_id is required');
	}
	// Keep malformed and foreign generation identifiers indistinguishable after
	// the required-field/type boundary, preventing account enumeration.
	if (!GENERATION_ID_PATTERN.test(generationId)) return notFound(c);

	if (!isGenerationFeedbackCategory(body.category)) {
		return invalidFeedback(c, 'category is invalid');
	}
	let comment: string | null = null;
	if (body.comment !== undefined) {
		if (
			typeof body.comment !== 'string'
			|| Array.from(body.comment).length > 1_000
		) {
			return invalidFeedback(c, 'comment must be a string of at most 1000 characters');
		}
		comment = body.comment;
	}

	const principal = c.get('managementKey');
	try {
		const inserted = await c.get('repositories').requestLogs
			.insertGenerationFeedbackForManagementAccount({
				id: `gfb_${crypto.randomUUID()}`,
				generationId,
				managementApiKeyId: principal.keyId,
				account: managementAccount(principal),
				category: body.category,
				comment,
				createdAtIso: new Date().toISOString(),
			});
		if (!inserted) return notFound(c);
		c.header('Cache-Control', 'private, no-store');
		return c.json({ data: { success: true as const } });
	} catch (error) {
		console.error(JSON.stringify({
			message: 'generation feedback insert failed',
			error_type: error instanceof Error ? error.name : 'UnknownError',
		}));
		return gatewayErrorJson(c, {
			status: 500,
			code: GatewayErrorCode.internalError,
			message: 'Generation feedback submission failed',
		});
	}
});
