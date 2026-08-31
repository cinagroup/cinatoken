import { Hono, type Context } from 'hono';
import {
	captureRequestPresetConfig,
	normalizeRequestPresetSlug,
	saveRequestPresetVersion,
	type RequestPresetProtocol,
} from '@octafuse/core';
import type { Env } from '../../app';
import { requireApiKey } from '../../middleware/auth';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';

type PresetEnv = Env & { Variables: { apiKey: import('../../middleware/auth').ApiKeyContext } };

type PresetForward = (
	c: Context<PresetEnv>,
	targetPath: string,
	body: Record<string, unknown>,
) => Promise<Response>;

const TARGETS: Record<string, { protocol: RequestPresetProtocol; path: string }> = {
	'chat/completions': { protocol: 'chat', path: '/v1/chat/completions' },
	messages: { protocol: 'messages', path: '/v1/messages' },
	responses: { protocol: 'responses', path: '/v1/responses' },
};

export function createPresetCaptureRoutes(forward: PresetForward): Hono<PresetEnv> {
	const routes = new Hono<PresetEnv>();
	routes.use('*', requireApiKey);

	for (const [suffix, target] of Object.entries(TARGETS)) {
		routes.post(`/:slug/${suffix}`, async (c) => {
			const apiKey = c.get('apiKey');
			const repositories = c.get('repositories');
			const slug = normalizeRequestPresetSlug(c.req.param('slug'));
			if (!slug) {
				return gatewayErrorJson(c, {
					status: 400,
					code: GatewayErrorCode.invalidPresetReference,
					message: 'Invalid preset slug',
				});
			}
			let body: Record<string, unknown>;
			try {
				body = await c.req.json<Record<string, unknown>>();
			} catch {
				return gatewayErrorJson(c, {
					status: 400,
					code: GatewayErrorCode.invalidJson,
					message: 'Invalid JSON body',
				});
			}
			const captured = captureRequestPresetConfig(body, target.protocol);
			if (!captured.ok) {
				return gatewayErrorJson(c, {
					status: 400,
					code: GatewayErrorCode.invalidRequest,
					message: captured.message,
				});
			}
			let saved;
			try {
				saved = await saveRequestPresetVersion(repositories, {
					workspaceId: apiKey.workspaceId,
					ownerUserId: apiKey.userId,
					slug,
					systemPrompt: captured.systemPrompt ?? null,
					config: captured.value,
				});
			} catch (error) {
				console.error('[Gateway Presets] save failed', error instanceof Error ? error.message : 'unknown');
				return gatewayErrorJson(c, {
					status: 409,
					code: GatewayErrorCode.presetInvalid,
					message: 'Preset could not be saved because its slug or version changed concurrently',
				});
			}
			if (!saved.ok) {
				return gatewayErrorJson(c, {
					status: saved.status,
					code: saved.status === 403 ? GatewayErrorCode.presetNotFound : GatewayErrorCode.presetInvalid,
					message: saved.message,
				});
			}
			return forward(c, target.path, { ...body, preset: slug });
		});
	}

	return routes;
}
