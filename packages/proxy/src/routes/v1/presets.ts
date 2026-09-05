import { Hono, type Context } from 'hono';
import {
	captureRequestPresetConfig,
	normalizeRequestPresetSlug,
	publicRequestPreset,
	publicRequestPresetVersion,
	saveRequestPresetVersion,
	type RequestPresetProtocol,
} from '@octafuse/core';
import type { Env } from '../../app';
import { requireApiKey, type ApiKeyContext } from '../../middleware/auth';
import {
	BoundedJsonRequestError,
	readBoundedJsonObject,
} from '../../services/egress/bounded-json-request';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';

type PresetEnv = Env & { Variables: { apiKey: ApiKeyContext } };

const MAX_PRESET_CAPTURE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_OFFSET = 1_000_000;

const CAPTURE_TARGETS: Record<string, RequestPresetProtocol> = {
	'chat/completions': 'chat',
	messages: 'messages',
	responses: 'responses',
};

function invalid(c: Context<PresetEnv>, message: string) {
	return gatewayErrorJson(c, {
		status: 400,
		code: GatewayErrorCode.invalidRequest,
		message,
	});
}

function notFound(c: Context<PresetEnv>) {
	return gatewayErrorJson(c, {
		status: 404,
		code: GatewayErrorCode.presetNotFound,
		message: 'Preset not found',
	});
}

function internal(c: Context<PresetEnv>) {
	return gatewayErrorJson(c, {
		status: 500,
		code: GatewayErrorCode.internalError,
		message: 'Preset storage is unavailable',
	});
}

function parseIntegerQuery(
	raw: string | undefined,
	field: 'offset' | 'limit',
	fallback: number,
): number {
	if (raw === undefined) return fallback;
	if (!/^(?:0|[1-9]\d*)$/u.test(raw)) throw new TypeError(`${field} must be an integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be an integer`);
	if (field === 'offset' && value > MAX_PAGE_OFFSET) {
		throw new TypeError(`offset must be no greater than ${MAX_PAGE_OFFSET}`);
	}
	if (field === 'limit' && (value < 1 || value > 100)) {
		throw new TypeError('limit must be between 1 and 100');
	}
	return value;
}

function page(c: Context<PresetEnv>) {
	return {
		offset: parseIntegerQuery(c.req.query('offset'), 'offset', 0),
		limit: parseIntegerQuery(c.req.query('limit'), 'limit', 50),
	};
}

function slug(c: Context<PresetEnv>): string | null {
	return normalizeRequestPresetSlug(c.req.param('slug'));
}

function boundedBodyFailure(c: Context<PresetEnv>, error: unknown) {
	if (!(error instanceof BoundedJsonRequestError)) return null;
	return gatewayErrorJson(c, {
		status: error.kind === 'payload_too_large' ? 413 : 400,
		code: error.kind === 'payload_too_large'
			? GatewayErrorCode.payloadTooLarge
			: error.kind === 'invalid_json'
				? GatewayErrorCode.invalidJson
				: GatewayErrorCode.invalidRequest,
		message: error.message,
	});
}

function validateCaptureEnvelope(
	body: Record<string, unknown>,
	protocol: RequestPresetProtocol,
): string | null {
	if (protocol === 'chat' && !Array.isArray(body.messages)) {
		return 'messages must be an array';
	}
	if (protocol === 'messages') {
		if (!Array.isArray(body.messages)) return 'messages must be an array';
		if (typeof body.model !== 'string' || !body.model.trim()) return 'model is required';
	}
	return null;
}

export const presetRoutes = new Hono<PresetEnv>();

presetRoutes.use('*', async (c, next) => {
	c.header('Cache-Control', 'private, no-store');
	await next();
});
presetRoutes.use('*', requireApiKey);

presetRoutes.get('/', async (c) => {
	let pagination: { offset: number; limit: number };
	try {
		pagination = page(c);
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
	const principal = c.get('apiKey');
	const result = await c.get('repositories').requestPresets.listVisibleByWorkspacePage(
		principal.workspaceId,
		principal.userId,
		pagination,
	);
	return c.json({
		data: result.data.map((row) => publicRequestPreset(row, false)),
		total_count: result.totalCount,
	});
});

presetRoutes.get('/:slug/versions/:version', async (c) => {
	const normalizedSlug = slug(c);
	if (!normalizedSlug) return invalid(c, 'Invalid preset slug');
	const rawVersion = c.req.param('version');
	if (!/^[1-9]\d*$/u.test(rawVersion)) return invalid(c, 'version must be a positive integer');
	const version = Number(rawVersion);
	if (!Number.isSafeInteger(version)) return invalid(c, 'version must be a positive integer');
	const principal = c.get('apiKey');
	const preset = await c.get('repositories').requestPresets.getVisibleBySlug(
		normalizedSlug,
		principal.workspaceId,
		principal.userId,
	);
	if (!preset) return notFound(c);
	const row = await c.get('repositories').requestPresets.getVersion(preset.id, version);
	if (!row) return notFound(c);
	try {
		return c.json({ data: publicRequestPresetVersion(row) });
	} catch (error) {
		console.error(JSON.stringify({
			message: 'preset version projection failed',
			error_type: error instanceof Error ? error.name : 'UnknownError',
		}));
		return internal(c);
	}
});

presetRoutes.get('/:slug/versions', async (c) => {
	const normalizedSlug = slug(c);
	if (!normalizedSlug) return invalid(c, 'Invalid preset slug');
	let pagination: { offset: number; limit: number };
	try {
		pagination = page(c);
	} catch (error) {
		if (error instanceof TypeError) return invalid(c, error.message);
		throw error;
	}
	const principal = c.get('apiKey');
	const preset = await c.get('repositories').requestPresets.getVisibleBySlug(
		normalizedSlug,
		principal.workspaceId,
		principal.userId,
	);
	if (!preset) return notFound(c);
	const result = await c.get('repositories').requestPresets.listVersionsPage(preset.id, pagination);
	try {
		return c.json({
			data: result.data.map(publicRequestPresetVersion),
			total_count: result.totalCount,
		});
	} catch (error) {
		console.error(JSON.stringify({
			message: 'preset version list projection failed',
			error_type: error instanceof Error ? error.name : 'UnknownError',
		}));
		return internal(c);
	}
});

for (const [suffix, protocol] of Object.entries(CAPTURE_TARGETS)) {
	presetRoutes.post(`/:slug/${suffix}`, async (c) => {
		const normalizedSlug = slug(c);
		if (!normalizedSlug) return invalid(c, 'Invalid preset slug');
		let body: Record<string, unknown>;
		try {
			body = await readBoundedJsonObject(c.req.raw, {
				maxBytes: MAX_PRESET_CAPTURE_BODY_BYTES,
				label: 'Preset capture request',
			});
		} catch (error) {
			return boundedBodyFailure(c, error) ?? internal(c);
		}
		const envelopeError = validateCaptureEnvelope(body, protocol);
		if (envelopeError) return invalid(c, envelopeError);
		const captured = captureRequestPresetConfig(body, protocol);
		if (!captured.ok) return invalid(c, captured.message);
		const principal = c.get('apiKey');
		try {
			const saved = await saveRequestPresetVersion(c.get('repositories'), {
				workspaceId: principal.workspaceId,
				ownerUserId: principal.userId,
				slug: normalizedSlug,
				systemPrompt: captured.systemPrompt ?? null,
				config: captured.value,
			});
			if (!saved.ok) {
				return gatewayErrorJson(c, {
					status: saved.status,
					code: saved.status === 403
						? GatewayErrorCode.permissionDenied
						: GatewayErrorCode.presetInvalid,
					message: saved.message,
				});
			}
			return c.json({ data: publicRequestPreset(saved.preset, true) });
		} catch (error) {
			console.error(JSON.stringify({
				message: 'preset version save failed',
				error_type: error instanceof Error ? error.name : 'UnknownError',
			}));
			return gatewayErrorJson(c, {
				status: 409,
				code: GatewayErrorCode.presetInvalid,
				message: 'Preset could not be saved because its slug or version changed concurrently',
			});
		}
	});
}

presetRoutes.get('/:slug', async (c) => {
	const normalizedSlug = slug(c);
	if (!normalizedSlug) return invalid(c, 'Invalid preset slug');
	const principal = c.get('apiKey');
	const row = await c.get('repositories').requestPresets.getVisibleBySlug(
		normalizedSlug,
		principal.workspaceId,
		principal.userId,
	);
	if (!row) return notFound(c);
	try {
		return c.json({ data: publicRequestPreset(row, true) });
	} catch (error) {
		console.error(JSON.stringify({
			message: 'preset projection failed',
			error_type: error instanceof Error ? error.name : 'UnknownError',
		}));
		return internal(c);
	}
});
