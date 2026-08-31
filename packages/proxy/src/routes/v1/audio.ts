/**
 * 用户路由：OpenAI 兼容 Audio Transcriptions / Speech。
 * ASR 同时支持 OpenRouter JSON input_audio 与 OpenAI multipart，TTS 使用 JSON。
 * 日志只保存脱敏后的元数据，不保存音频二进制。
 */
import type {
	GatewayRepositories,
	GuardrailBudgetIntent,
	GuardrailPreflightResult,
} from '@octafuse/core';
import { getBusinessTimezone } from '@octafuse/core';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../app';
import { requireApiKey, type ApiKeyContext } from '../../middleware/auth';
import { assignGenerationId } from '../../middleware/generation-id';
import {
	buildAffinityKey,
	buildTierKeyPrefix,
} from '../../services/route-strategies';
import {
	proxyAudioSpeech,
	proxyAudioTranscriptions,
	type ProxyResult,
	type UsageFromStream,
} from '../../services/proxy';
import { finalizeRequestLogJson } from '../../services/request-log-shared';
import {
	audioGuardrailBudgetMicros,
	estimateAudioBudgetPrecheck,
	estimateAudioSpeechBudgetPrecheck,
	recordAudioUsage,
	resolveCanonicalAudioEndpointPricingOperation,
} from '../../services/audio-usage-charge';
import {
	AUDIO_MAX_BYTES_PER_FILE,
	redactAudioRequestForLog,
	resolveAudioUploadFilename,
	normalizeAudioMimeType,
	validateAudioUpload,
	type AudioTranscriptionProviderOptions,
	type AudioTranscriptionProviderOptionValue,
	type NormalizedAudioTranscriptionRequest,
} from '../../services/egress/openai-audio-driver';
import {
	OpenRouterAudioJsonError,
	parseOpenRouterAudioJson,
	type OpenRouterAudioJsonLimits,
} from '../../services/egress/openrouter-audio-json';
import {
	redactAudioSpeechRequestForLog,
	type AudioSpeechResponseFormat,
	type AudioSpeechVoice,
	type NormalizedAudioSpeechRequest,
} from '../../services/egress/audio-speech-driver';
import {
	formatHttpErrorTextForRequestLog,
	materializeNonOkResponse,
} from '../../services/request-log-record-status';
import {
	maybeBlockUserModelCircuit,
	maybeTriggerUserModelCircuitFromUpstream,
	markUserModelSuccess,
} from '../../services/user-model-circuit-route';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';
import { RequestTimingCollector } from '../../services/request-timing';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
import { stickyConfigFromSurface } from '../../services/provider-sticky-routing';
import { buildModelFallbackPlan } from '../../services/model-fallback-plan';
import {
	auditGuardrailOutputDecision,
	forfeitRequestGuardrailBudgets,
	markRequestGuardrailBudgetsDispatched,
	releaseRequestGuardrailBudgets,
	reserveRequestGuardrailBudgets,
} from '../../services/request-guardrails';
import {
	reserveOrdinaryUserBudget,
	type OrdinaryBudgetLease,
} from '../../services/ordinary-budget-lifecycle';
import {
	markMultimediaBudgetsBeforeDispatch,
	selectConservativeMultimediaBudgetEstimate,
} from '../../services/multimedia-ordinary-budget';
import { routeUsesUnsupportedMultimediaEndpointPriceSelection } from '../../services/endpoint-billing-pricing';
import {
	audioOutputGuardrailsRequirePreflightBlock,
	runAudioSpeechRequestGuardrails,
	runAudioTranscriptionRequestGuardrails,
} from '../../services/audio-request-guardrails';

type AudioEnv = Env & { Variables: { apiKey: ApiKeyContext } };
type AudioContext = Context<AudioEnv>;

export const audioRoutes = new Hono<AudioEnv>();

audioRoutes.use('*', requireApiKey);
audioRoutes.use('*', assignGenerationId);

function modelDisplayName(model: { display_name?: string | null }, baseModelId: string): string {
	return model.display_name != null && String(model.display_name).trim() !== ''
		? String(model.display_name).trim()
		: baseModelId;
}

function truncateModelIdForLog(rawModelId: string, maxLen = 200): string {
	const trimmed = rawModelId.trim();
	if (trimmed.length <= maxLen) {
		return trimmed;
	}
	return `${trimmed.slice(0, maxLen)}…`;
}

async function blockUnsupportedAudioOutputGuardrails(
	c: AudioContext,
	repos: GatewayRepositories,
	apiKey: ApiKeyContext,
	modelId: string,
	guardrail: Extract<GuardrailPreflightResult, { ok: true }>,
	correlationId: string,
): Promise<Response | null> {
	if (!audioOutputGuardrailsRequirePreflightBlock(guardrail)) return null;
	await auditGuardrailOutputDecision(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelIds: [modelId],
		trace: guardrail.trace,
		blockedBy: 'unsupported_audio_output_guardrail',
		redactionCount: 0,
		correlationId,
	}).catch((error: unknown) => {
		console.warn(
			`[Gateway Audio] output guardrail audit failed requestId=${correlationId} error=${error instanceof Error ? error.message : String(error)}`,
		);
	});
	return gatewayErrorJson(c, {
		status: 403,
		code: GatewayErrorCode.guardrailBlocked,
		message: 'Audio responses cannot safely apply the configured output guardrail',
	});
}

type AudioGuardrailBudgetLease = {
	requestId: string;
	reserved: boolean;
	dispatched: boolean;
	terminal: boolean;
	beforeUpstreamDispatch(): Promise<void>;
	release(reason: string): Promise<void>;
	forfeit(reason: string): Promise<void>;
};

async function admitAudioGuardrailBudget(
	repos: GatewayRepositories,
	params: {
		requestId: string;
		intents: GuardrailBudgetIntent[];
		reservedMicros: number;
	},
): Promise<
	| { ok: true; lease: AudioGuardrailBudgetLease }
	| { ok: false; blocked: boolean; reason?: 'gateway_key_limit' | 'workspace_budget' | 'guardrail_budget'; message: string }
> {
	const admission = await reserveRequestGuardrailBudgets(repos, params);
	if (!admission.ok) return admission;
	return {
		ok: true,
		lease: {
			requestId: params.requestId,
			reserved: admission.reserved,
			dispatched: false,
			terminal: false,
			async beforeUpstreamDispatch(): Promise<void> {
				if (this.dispatched) return;
				await markRequestGuardrailBudgetsDispatched(
					repos,
					params.requestId,
					admission.reserved,
				);
				this.dispatched = true;
			},
			async release(reason: string): Promise<void> {
				if (!admission.reserved || this.terminal) return;
				await releaseRequestGuardrailBudgets(
					repos,
					params.requestId,
					admission.reserved,
					reason,
				);
				this.terminal = true;
			},
			async forfeit(reason: string): Promise<void> {
				if (!admission.reserved || this.terminal) return;
				try {
					await forfeitRequestGuardrailBudgets(
						repos,
						params.requestId,
						admission.reserved,
						reason,
					);
					this.terminal = true;
				} catch (error) {
					console.error(
						`[Gateway Audio] guardrail budget forfeit failed requestId=${params.requestId} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
					);
				}
			},
		},
	};
}

async function terminateAudioOrdinaryBudget(
	lease: OrdinaryBudgetLease,
	requestId: string,
	reason: string,
): Promise<void> {
	try {
		await lease.terminateUnknown(reason);
	} catch (error) {
		console.error(
			`[Gateway Audio] ordinary budget cleanup failed requestId=${requestId} state=${lease.state} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function terminateAudioGuardrailBudget(
	lease: AudioGuardrailBudgetLease,
	reason: string,
): Promise<void> {
	try {
		if (lease.dispatched) await lease.forfeit(reason);
		else await lease.release(reason);
	} catch (error) {
		console.error(
			`[Gateway Audio] guardrail budget cleanup failed requestId=${lease.requestId} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function beforeAudioUpstreamDispatch(
	ordinaryLease: OrdinaryBudgetLease,
	guardrailLease: AudioGuardrailBudgetLease,
): Promise<void> {
	await markMultimediaBudgetsBeforeDispatch({
		markGuardrail: () => guardrailLease.beforeUpstreamDispatch(),
		markOrdinary: () => ordinaryLease.beforeUpstreamDispatch(),
		terminateOrdinary: () => terminateAudioOrdinaryBudget(
			ordinaryLease,
			guardrailLease.requestId,
			'pre_dispatch_failed',
		),
		terminateGuardrail: () => terminateAudioGuardrailBudget(guardrailLease, 'pre_dispatch_failed'),
	});
}

const OPENROUTER_STT_RESPONSE_FORMATS = new Set(['json', 'verbose_json']);
const AUDIO_MULTIPART_MAX_BODY_BYTES = AUDIO_MAX_BYTES_PER_FILE + 1024 * 1024;
const AUDIO_JSON_FORMATS: Readonly<Record<string, string>> = {
	wav: 'audio/wav',
	mp3: 'audio/mpeg',
	flac: 'audio/flac',
	m4a: 'audio/mp4',
	ogg: 'audio/ogg',
	webm: 'audio/webm',
	aac: 'audio/aac',
};
const AUDIO_PROVIDER_OPTION_RESERVED_FIELDS = new Set([
	'model', 'file', 'input_audio', 'provider', 'response_format',
	'duration', 'duration_seconds',
]);

type AudioTranscriptionParseFailureKind =
	| 'invalid_json'
	| 'invalid_request'
	| 'payload_too_large'
	| 'cancelled';

export type ParsedAudioTranscriptionRequest =
	| {
			ok: true;
			model: string;
			transcription: NormalizedAudioTranscriptionRequest;
			routingBody: Record<string, unknown>;
	  }
	| { ok: false; kind: AudioTranscriptionParseFailureKind; error: string };

function parseContentLength(value: string | null): number | null {
	if (value == null || value.trim() === '') return null;
	if (!/^\d+$/.test(value.trim())) return Number.NaN;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

export function audioTranscriptionRequestMediaType(contentType: string | null):
	| { ok: true; value: 'json' | 'multipart' }
	| { ok: false; error: string } {
	const raw = contentType?.trim() ?? '';
	const mediaType = raw.split(';', 1)[0]?.trim().toLowerCase() ?? '';
	if (mediaType === 'application/json') return { ok: true, value: 'json' };
	if (mediaType === 'multipart/form-data') {
		if (!/(?:^|;)\s*boundary\s*=\s*(?:"[^"]+"|[^;\s]+)/i.test(raw)) {
			return { ok: false, error: 'multipart/form-data requires a boundary parameter' };
		}
		return { ok: true, value: 'multipart' };
	}
	return {
		ok: false,
		error: `Unsupported Content-Type: ${raw || '(missing)'}. Use application/json or multipart/form-data`,
	};
}

/** Hono `parseBody({ all: true })` may yield string or string[] for text fields. */
function multipartTextField(value: unknown): string {
	if (typeof value === 'string') {
		return value.trim();
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === 'string' && item.trim() !== '') {
				return item.trim();
			}
		}
	}
	return '';
}

function multipartFileField(value: unknown): File | null {
	if (value != null && typeof value === 'object' && 'arrayBuffer' in value) {
		return value as File;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (item != null && typeof item === 'object' && 'arrayBuffer' in item) {
				return item as File;
			}
		}
	}
	return null;
}

function validatedResponseFormat(value: unknown):
	| { ok: true; value: NormalizedAudioTranscriptionRequest['clientResponseFormat'] }
	| { ok: false; error: string } {
	const format = value == null || value === ''
		? 'json'
		: typeof value === 'string'
			? value.trim().toLowerCase()
			: '';
	if (!OPENROUTER_STT_RESPONSE_FORMATS.has(format)) {
		return {
			ok: false,
			error: 'response_format must be "json" or "verbose_json"',
		};
	}
	return {
		ok: true,
		value: format as NormalizedAudioTranscriptionRequest['clientResponseFormat'],
	};
}

function validatedTimestampGranularities(value: unknown):
	| { ok: true; value: readonly string[] | undefined }
	| { ok: false; error: string } {
	if (value == null) return { ok: true, value: undefined };
	const values = Array.isArray(value) ? value : [value];
	if (values.length === 0 || values.length > 2) {
		return { ok: false, error: 'timestamp_granularities must contain word and/or segment' };
	}
	const normalized: string[] = [];
	for (const item of values) {
		if (typeof item !== 'string') {
			return { ok: false, error: 'timestamp_granularities must contain only strings' };
		}
		const granularity = item.trim().toLowerCase();
		if (granularity !== 'word' && granularity !== 'segment') {
			return { ok: false, error: 'timestamp_granularities must contain word and/or segment' };
		}
		if (!normalized.includes(granularity)) normalized.push(granularity);
	}
	return { ok: true, value: normalized };
}

function validatedLanguage(value: unknown):
	| { ok: true; value: string | undefined }
	| { ok: false; error: string } {
	if (value == null || value === '') return { ok: true, value: undefined };
	if (typeof value !== 'string') return { ok: false, error: 'language must be a string' };
	const language = value.trim();
	if (!/^[A-Za-z]{2}$/.test(language)) {
		return { ok: false, error: 'language must be an ISO-639-1 two-letter code' };
	}
	return { ok: true, value: language.toLowerCase() };
}

function validatedPrompt(value: unknown):
	| { ok: true; value: string | undefined }
	| { ok: false; error: string } {
	if (value == null || value === '') return { ok: true, value: undefined };
	if (typeof value !== 'string') return { ok: false, error: 'prompt must be a string' };
	if (Array.from(value).length > 4096) {
		return { ok: false, error: 'prompt must be at most 4096 characters' };
	}
	return { ok: true, value };
}

function validatedTemperature(value: unknown):
	| { ok: true; value: number | undefined }
	| { ok: false; error: string } {
	if (value == null || value === '') return { ok: true, value: undefined };
	const temperature = typeof value === 'number'
		? value
		: typeof value === 'string'
			? Number(value)
			: Number.NaN;
	if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
		return { ok: false, error: 'temperature must be between 0 and 1' };
	}
	return { ok: true, value: temperature };
}

function validatedModel(value: unknown):
	| { ok: true; value: string }
	| { ok: false; error: string } {
	const model = typeof value === 'string' ? value.trim() : '';
	if (!model) return { ok: false, error: 'Missing model' };
	if (model.length > 300 || /[\u0000-\u001f\u007f]/.test(model)) {
		return { ok: false, error: 'model is invalid' };
	}
	return { ok: true, value: model };
}

function parseProviderOptions(value: unknown):
	| {
			ok: true;
			routingProvider: Record<string, unknown> | undefined;
			providerOptions: AudioTranscriptionProviderOptions | undefined;
	  }
	| { ok: false; error: string } {
	if (value === undefined) {
		return { ok: true, routingProvider: undefined, providerOptions: undefined };
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, error: 'provider must be an object' };
	}
	const provider = value as Record<string, unknown>;
	const routingProvider = { ...provider };
	delete routingProvider.options;
	const rawOptions = provider.options;
	if (rawOptions === undefined) {
		return {
			ok: true,
			routingProvider,
			providerOptions: undefined,
		};
	}
	if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
		return { ok: false, error: 'provider.options must be an object keyed by provider name' };
	}
	const entries = Object.entries(rawOptions as Record<string, unknown>);
	if (entries.length === 0 || entries.length > 16) {
		return { ok: false, error: 'provider.options must contain between 1 and 16 providers' };
	}
	const normalized: Record<string, Record<string, AudioTranscriptionProviderOptionValue>> = {};
	for (const [providerName, rawFields] of entries) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(providerName)) {
			return { ok: false, error: 'provider.options contains an invalid provider name' };
		}
		if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
			return { ok: false, error: `provider.options.${providerName} must be an object` };
		}
		const fields = Object.entries(rawFields as Record<string, unknown>);
		if (fields.length > 32) {
			return { ok: false, error: `provider.options.${providerName} has too many fields` };
		}
		const normalizedFields: Record<string, AudioTranscriptionProviderOptionValue> = {};
		for (const [field, fieldValue] of fields) {
			if (
				!/^[A-Za-z][A-Za-z0-9_.\[\]-]{0,63}$/.test(field)
				|| AUDIO_PROVIDER_OPTION_RESERVED_FIELDS.has(field)
			) {
				return { ok: false, error: `provider.options.${providerName} contains an invalid field` };
			}
			if (typeof fieldValue === 'string') {
				if (fieldValue.length > 4096) {
					return { ok: false, error: `provider.options.${providerName}.${field} is too long` };
				}
				normalizedFields[field] = fieldValue;
			} else if (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) {
				normalizedFields[field] = fieldValue;
			} else if (typeof fieldValue === 'boolean') {
				normalizedFields[field] = fieldValue;
			} else if (
				Array.isArray(fieldValue)
				&& fieldValue.length <= 8
				&& fieldValue.every((item) => typeof item === 'string' && item.length <= 256)
			) {
				normalizedFields[field] = fieldValue as string[];
			} else {
				return {
					ok: false,
					error: `provider.options.${providerName}.${field} must be a bounded scalar or string array`,
				};
			}
		}
		normalized[providerName] = normalizedFields;
	}
	return {
		ok: true,
		routingProvider: Object.keys(routingProvider).length > 0 ? routingProvider : undefined,
		providerOptions: normalized,
	};
}

async function parseMultipartTranscription(request: Request): Promise<ParsedAudioTranscriptionRequest> {
	const declaredLength = parseContentLength(request.headers.get('content-length'));
	if (Number.isNaN(declaredLength)) {
		return { ok: false, kind: 'invalid_request', error: 'Invalid Content-Length header' };
	}
	if (declaredLength != null && declaredLength > AUDIO_MULTIPART_MAX_BODY_BYTES) {
		await request.body?.cancel('audio_multipart_request_too_large').catch(() => undefined);
		return {
			ok: false,
			kind: 'payload_too_large',
			error: `Audio multipart body must be at most ${AUDIO_MULTIPART_MAX_BODY_BYTES} bytes`,
		};
	}
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return request.signal.aborted
			? { ok: false, kind: 'cancelled', error: 'Audio transcription request was cancelled' }
			: { ok: false, kind: 'invalid_request', error: 'Invalid multipart body' };
	}

	const modelResult = validatedModel(multipartTextField(form.getAll('model')));
	if (!modelResult.ok) return { ...modelResult, kind: 'invalid_request' };
	const model = modelResult.value;

	const formatResult = validatedResponseFormat(multipartTextField(form.getAll('response_format')));
	if (!formatResult.ok) return { ...formatResult, kind: 'invalid_request' };
	const clientResponseFormat = formatResult.value;

	const languageResult = validatedLanguage(multipartTextField(form.getAll('language')));
	if (!languageResult.ok) return { ...languageResult, kind: 'invalid_request' };
	const language = languageResult.value;
	const promptResult = validatedPrompt(multipartTextField(form.getAll('prompt')));
	if (!promptResult.ok) return { ...promptResult, kind: 'invalid_request' };
	const prompt = promptResult.value;
	const temperatureResult = validatedTemperature(multipartTextField(form.getAll('temperature')));
	if (!temperatureResult.ok) return { ...temperatureResult, kind: 'invalid_request' };
	const temperature = temperatureResult.value;
	const timestampValues = [
		...form.getAll('timestamp_granularities[]'),
		...form.getAll('timestamp_granularities'),
	];
	const timestampsResult = validatedTimestampGranularities(
		timestampValues.length > 0 ? timestampValues : undefined,
	);
	if (!timestampsResult.ok) return { ...timestampsResult, kind: 'invalid_request' };

	const clientDurationRaw = multipartTextField(
		form.getAll('duration_seconds').length > 0
			? form.getAll('duration_seconds')
			: form.getAll('duration'),
	);
	let clientDurationSeconds: number | undefined;
	if (clientDurationRaw !== '') {
		const n = Number(clientDurationRaw);
		if (Number.isFinite(n) && n > 0) {
			clientDurationSeconds = n;
		}
	}
	const fileSourceUrlRaw = multipartTextField(form.getAll('file_url'));
	let fileSourceUrl: string | undefined;
	if (fileSourceUrlRaw) {
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(fileSourceUrlRaw);
		} catch {
			return { ok: false, kind: 'invalid_request', error: 'file_url must be a valid URL' };
		}
		if (!['http:', 'https:', 'oss:'].includes(parsedUrl.protocol)) {
			return { ok: false, kind: 'invalid_request', error: 'file_url must use http(s) or oss' };
		}
		fileSourceUrl = parsedUrl.toString();
	}

	let upload: NormalizedAudioTranscriptionRequest['file'] = null;
	const file = multipartFileField(form.getAll('file'));
	if (file) {
		const declaredSize =
			typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : null;
		if (declaredSize != null && declaredSize > AUDIO_MAX_BYTES_PER_FILE) {
			return { ok: false, kind: 'payload_too_large', error: `audio file must be at most ${AUDIO_MAX_BYTES_PER_FILE} bytes` };
		}
		if (request.signal.aborted) {
			return { ok: false, kind: 'cancelled', error: 'Audio transcription request was cancelled' };
		}
		const buf = new Uint8Array(await file.arrayBuffer());
		const mimeType = normalizeAudioMimeType(file.type || '') || 'application/octet-stream';
		upload = {
			filename: resolveAudioUploadFilename((file as { name?: string }).name || '', mimeType),
			mimeType,
			bytes: buf,
		};
		const uploadErr = validateAudioUpload(upload);
		if (uploadErr) {
			return {
				ok: false,
				kind: uploadErr.includes('at most') ? 'payload_too_large' : 'invalid_request',
				error: uploadErr,
			};
		}
	}
	if (!upload && !fileSourceUrl) {
		return { ok: false, kind: 'invalid_request', error: 'Missing audio file or file_url' };
	}
	const extra = timestampsResult.value
		? { 'timestamp_granularities[]': timestampsResult.value }
		: undefined;

	return {
		ok: true,
		model,
		transcription: {
			file: upload,
			clientResponseFormat,
			language,
			prompt,
			temperature,
			clientDurationSeconds,
			fileSourceUrl,
			extra,
		},
		routingBody: {
			model,
			...(prompt ? { prompt } : {}),
			...(language ? { language } : {}),
			...(temperature != null ? { temperature } : {}),
			response_format: clientResponseFormat,
			...(timestampsResult.value ? { timestamp_granularities: timestampsResult.value } : {}),
		},
	};
}

async function parseJsonTranscription(
	request: Request,
	limits?: OpenRouterAudioJsonLimits,
): Promise<ParsedAudioTranscriptionRequest> {
	let parsedJson: Awaited<ReturnType<typeof parseOpenRouterAudioJson>>;
	try {
		parsedJson = await parseOpenRouterAudioJson(request, limits);
	} catch (error) {
		if (error instanceof OpenRouterAudioJsonError) {
			return { ok: false, kind: error.kind, error: error.message };
		}
		throw error;
	}
	const { body, audioBytes } = parsedJson;
	const modelResult = validatedModel(body.model);
	if (!modelResult.ok) return { ...modelResult, kind: 'invalid_request' };
	const inputAudio = body.input_audio;
	if (!inputAudio || typeof inputAudio !== 'object' || Array.isArray(inputAudio)) {
		return { ok: false, kind: 'invalid_request', error: 'Missing input_audio' };
	}
	const rawFormat = (inputAudio as Record<string, unknown>).format;
	const audioFormat = typeof rawFormat === 'string' ? rawFormat.trim().toLowerCase() : '';
	const mimeType = AUDIO_JSON_FORMATS[audioFormat];
	if (!mimeType) {
		return {
			ok: false,
			kind: 'invalid_request',
			error: `input_audio.format must be one of: ${Object.keys(AUDIO_JSON_FORMATS).join(', ')}`,
		};
	}
	const formatResult = validatedResponseFormat(body.response_format);
	if (!formatResult.ok) return { ...formatResult, kind: 'invalid_request' };
	const languageResult = validatedLanguage(body.language);
	if (!languageResult.ok) return { ...languageResult, kind: 'invalid_request' };
	const promptResult = validatedPrompt(body.prompt);
	if (!promptResult.ok) return { ...promptResult, kind: 'invalid_request' };
	const temperatureResult = validatedTemperature(body.temperature);
	if (!temperatureResult.ok) return { ...temperatureResult, kind: 'invalid_request' };
	const timestampsResult = validatedTimestampGranularities(body.timestamp_granularities);
	if (!timestampsResult.ok) return { ...timestampsResult, kind: 'invalid_request' };
	const providerResult = parseProviderOptions(body.provider);
	if (!providerResult.ok) return { ...providerResult, kind: 'invalid_request' };

	const file = {
		filename: `audio.${audioFormat}`,
		mimeType,
		bytes: audioBytes,
	};
	const uploadError = validateAudioUpload(file);
	if (uploadError) {
		return {
			ok: false,
			kind: uploadError.includes('at most') ? 'payload_too_large' : 'invalid_request',
			error: uploadError,
		};
	}
	const extra = timestampsResult.value
		? { 'timestamp_granularities[]': timestampsResult.value }
		: undefined;
	return {
		ok: true,
		model: modelResult.value,
		transcription: {
			file,
			clientResponseFormat: formatResult.value,
			language: languageResult.value,
			prompt: promptResult.value,
			temperature: temperatureResult.value,
			extra,
			providerOptions: providerResult.providerOptions,
		},
		routingBody: {
			model: modelResult.value,
			...(promptResult.value ? { prompt: promptResult.value } : {}),
			...(languageResult.value ? { language: languageResult.value } : {}),
			...(temperatureResult.value != null ? { temperature: temperatureResult.value } : {}),
			response_format: formatResult.value,
			...(timestampsResult.value ? { timestamp_granularities: timestampsResult.value } : {}),
			...(providerResult.routingProvider ? { provider: providerResult.routingProvider } : {}),
		},
	};
}

export async function parseAudioTranscriptionRequest(
	request: Request,
	jsonLimits?: OpenRouterAudioJsonLimits,
): Promise<ParsedAudioTranscriptionRequest> {
	const mediaType = audioTranscriptionRequestMediaType(request.headers.get('content-type'));
	if (!mediaType.ok) return { ok: false, kind: 'invalid_request', error: mediaType.error };
	return mediaType.value === 'json'
		? parseJsonTranscription(request, jsonLimits)
		: parseMultipartTranscription(request);
}

/** Preserve the public HTTP/error-type distinction for bounded parser failures. */
export function audioTranscriptionParseFailureContract(
	kind: AudioTranscriptionParseFailureKind,
): {
	status: 400 | 413;
	code: typeof GatewayErrorCode.invalidJson
		| typeof GatewayErrorCode.invalidRequest
		| typeof GatewayErrorCode.payloadTooLarge;
} {
	if (kind === 'payload_too_large') {
		return { status: 413, code: GatewayErrorCode.payloadTooLarge };
	}
	return {
		status: 400,
		code: kind === 'invalid_json'
			? GatewayErrorCode.invalidJson
			: GatewayErrorCode.invalidRequest,
	};
}

/**
 * Every eligible fallback route must prove a finite charged-cost ceiling before
 * dispatch. This is a pricing-integrity gate, so it applies even when neither
 * the API key nor a Guardrail currently has a finite budget.
 */
export function audioPricingCeilingFailureContract(
	estimatedChargedCost: number | null,
): {
	status: 502;
	code: typeof GatewayErrorCode.routeResolutionFailed;
	message: string;
} | null {
	return estimatedChargedCost === null
		? {
				status: 502,
				code: GatewayErrorCode.routeResolutionFailed,
				message: 'Audio pricing cannot prove a finite charged-cost ceiling for every eligible route',
			}
		: null;
}

audioRoutes.post('/transcriptions', async (c) => {
	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const start = Date.now();
	const requestCorrelationId = c.get('generationId')!;
	const timing = new RequestTimingCollector();

	const parsed = await parseAudioTranscriptionRequest(c.req.raw);
	if (!parsed.ok) {
		console.warn(
			`[Gateway Audio] transcriptions parse failed kind=${parsed.kind} requestId=${requestCorrelationId}`,
		);
		const failure = audioTranscriptionParseFailureContract(parsed.kind);
		return gatewayErrorJson(c, {
			status: failure.status,
			code: failure.code,
			message: parsed.error,
		});
	}
	const {
		model: rawModelId,
		transcription: parsedTranscription,
		routingBody: parsedRoutingBody,
	} = parsed;
	const guardrail = await runAudioTranscriptionRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelId: rawModelId,
		prompt: parsedTranscription.prompt,
		providerOptions: parsedTranscription.providerOptions,
		correlationId: requestCorrelationId,
		now: new Date(start),
	});
	if (!guardrail.ok) {
		return gatewayErrorJson(c, {
			status: guardrail.status,
			code: guardrail.code === 'guardrail_invalid'
				? GatewayErrorCode.guardrailInvalid
				: GatewayErrorCode.guardrailBlocked,
			message: guardrail.message,
		});
	}
	const outputGuardrailBlock = await blockUnsupportedAudioOutputGuardrails(
		c,
		repos,
		apiKey,
		rawModelId,
		guardrail,
		requestCorrelationId,
	);
	if (outputGuardrailBlock) return outputGuardrailBlock;

	const guardedProviderOptionsResult = parseProviderOptions(
		{ options: (guardrail.body as Record<string, unknown>).provider_options },
	);
	if (!guardedProviderOptionsResult.ok) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.guardrailInvalid,
			message: 'Guardrail produced invalid audio provider options',
		});
	}
	const guardedRoutingBody = { ...parsedRoutingBody };
	if (typeof guardrail.body.prompt === 'string') guardedRoutingBody.prompt = guardrail.body.prompt;
	else delete guardedRoutingBody.prompt;
	const fallbackPlan = await buildModelFallbackPlan(repos, {
		modelIds: [rawModelId],
		body: guardedRoutingBody,
		requestProtocol: 'openai',
		requestOperation: 'audio.transcriptions',
		pricingAt: new Date(start),
	});
	if (!fallbackPlan.ok) {
		if (fallbackPlan.status !== 404) {
			console.warn(
				`[Gateway Audio] transcriptions route resolve failed status=${fallbackPlan.status} clientModel=${truncateModelIdForLog(rawModelId)} error=${fallbackPlan.message}`,
			);
		}
		return gatewayErrorJson(c, {
			status: fallbackPlan.status,
			code: fallbackPlan.code,
			message: fallbackPlan.message,
		});
	}
	const selectedPlan = fallbackPlan.candidates[0]!;
	const { model, baseModelId, effectiveRouteGroup, routes } = selectedPlan;
	if (routes.some(routeUsesUnsupportedMultimediaEndpointPriceSelection)) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'provider.max_price and provider.sort=price are unavailable for Audio until multimedia endpoint price comparison is enabled',
		});
	}
	const guardedPrompt = typeof selectedPlan.upstreamBody.prompt === 'string'
		? selectedPlan.upstreamBody.prompt
		: undefined;
	const transcription: NormalizedAudioTranscriptionRequest = {
		...parsedTranscription,
		prompt: guardedPrompt,
		providerOptions: guardedProviderOptionsResult.providerOptions,
	};
	const modelNameForLog = modelDisplayName(model, baseModelId);
	const businessTimezone = await getBusinessTimezone(repos);

	const estimateSelection = selectConservativeMultimediaBudgetEstimate(await Promise.all(
		routes.map((route) => estimateAudioBudgetPrecheck(repos, {
			endpoint: route.endpoint ?? null,
			operation: resolveCanonicalAudioEndpointPricingOperation(route.upstreamOperation),
			catalogModelId: baseModelId,
			userChargedCostFactorsJson: apiKey.chargedCostFactors,
			fileBytes: transcription.file?.bytes.byteLength ?? 0,
			mimeType: transcription.file?.mimeType,
			fileBytesForParse: transcription.file?.bytes,
			clientDurationSeconds: transcription.clientDurationSeconds,
			requestStartedAtMs: start,
			businessTimezone,
		}, [route.priceOverrideRaw])),
	));
	if (!estimateSelection) throw new Error('Audio fallback plan has no billable route estimate');
	const { estimate, estimatedChargedCost } = estimateSelection;
	const pricingCeilingFailure = audioPricingCeilingFailureContract(estimatedChargedCost);
	if (pricingCeilingFailure) return gatewayErrorJson(c, pricingCeilingFailure);

	const requestBodyForLog = finalizeRequestLogJson(
		redactAudioRequestForLog({
			model: rawModelId,
			filename: transcription.file?.filename ?? '',
			mimeType: transcription.file?.mimeType ?? '',
			byteLength: transcription.file?.bytes.byteLength ?? 0,
			language: transcription.language,
			responseFormat: transcription.clientResponseFormat,
				clientDurationSeconds: transcription.clientDurationSeconds,
				fileSourceUrl: transcription.fileSourceUrl,
			})
	);

	const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
		baseModelId,
		modelNameForLog,
		requestBodyForLog,
		requestProtocol: 'openai',
		startMs: start,
		timing,
		clientErrorCircuitEnabled: false,
	});
	if (circuitBlocked) {
		return circuitBlocked;
	}

	const ordinaryAdmission = await reserveOrdinaryUserBudget(repos, {
		requestId: requestCorrelationId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		budgetMax: apiKey.budgetMax,
		expectedBudgetEpoch: apiKey.budgetEpoch,
		estimatedChargedCost,
		now: new Date(start),
	});
	if (!ordinaryAdmission.ok) {
		return gatewayErrorJson(c, {
			status: 403,
			code: GatewayErrorCode.budgetExceeded,
			message: ordinaryAdmission.error.message,
		});
	}
	const ordinaryBudgetLease = ordinaryAdmission.lease;
	let budgetAdmission: Awaited<ReturnType<typeof admitAudioGuardrailBudget>>;
	try {
		budgetAdmission = await admitAudioGuardrailBudget(repos, {
			requestId: requestCorrelationId,
			intents: guardrail.budgetIntents,
			reservedMicros: audioGuardrailBudgetMicros(estimate.chargedCost),
		});
	} catch (error) {
		await terminateAudioOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'guardrail_budget_admission_failed',
		);
		throw error;
	}
	if (!budgetAdmission.ok) {
		await terminateAudioOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'guardrail_budget_admission_failed',
		);
		if (budgetAdmission.blocked) {
			return gatewayErrorJson(c, {
				status: 403,
				code: budgetAdmission.reason === 'gateway_key_limit' || budgetAdmission.reason === 'workspace_budget' ? GatewayErrorCode.budgetExceeded : GatewayErrorCode.guardrailBlocked,
				message: budgetAdmission.message,
			});
		}
		throw new Error(`Guardrail budget admission failed: ${budgetAdmission.message}`);
	}
	const guardrailBudgetLease = budgetAdmission.lease;
	const affinityKey = buildAffinityKey(apiKey.userId, baseModelId, effectiveRouteGroup, 'openai');
	const tierKeyPrefix = buildTierKeyPrefix(baseModelId, effectiveRouteGroup, 'openai');
	timing.markGatewayComplete();

	console.log(
		`[Gateway Audio] transcriptions baseModelId=${baseModelId} keyId=${apiKey.keyId} bytes=${transcription.file?.bytes.byteLength ?? 0}`
	);

	let proxyResult: ProxyResult;
	try {
		proxyResult = await proxyAudioTranscriptions(
			repos,
			routes,
			transcription,
			c.req.raw.signal,
			{
				affinityKey,
				tierKeyPrefix,
				strategy: selectedPlan.strategy.base,
				tierStrategies: selectedPlan.strategy.tierOverrides,
				timing,
				routePoolId: selectedPlan.surface?.route_pool_id ?? routes[0]?.routePoolId ?? null,
				sticky: selectedPlan.hasProviderPreferences ? null : stickyConfigFromSurface(selectedPlan.surface),
				beforeUpstreamDispatch: () => beforeAudioUpstreamDispatch(
					ordinaryBudgetLease,
					guardrailBudgetLease,
				),
			}
		);
	} catch (error) {
		await terminateAudioGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_failed');
		await terminateAudioOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'upstream_dispatch_failed',
		);
		throw error;
	}
	if (ordinaryBudgetLease.state === 'reserved') {
		await terminateAudioOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'upstream_dispatch_not_started',
		);
	}
	if (!guardrailBudgetLease.dispatched) {
		await terminateAudioGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_not_started');
	}

	return finalizeAudioResponse({
		c,
		proxyResult,
		apiKey,
		repos,
		baseModelId,
		effectiveRouteGroup,
		modelNameForLog,
		requestBodyForLog,
		fileBytes: transcription.file?.bytes.byteLength ?? 0,
		businessTimezone,
		start,
		timing,
		guardrailBudgetLease,
		ordinaryBudgetLease,
	});
});

const SPEECH_RESPONSE_FORMATS = new Set<AudioSpeechResponseFormat>([
	'mp3',
	'opus',
	'aac',
	'flac',
	'wav',
	'pcm',
]);

function parseSpeechVoice(value: unknown): AudioSpeechVoice | null {
	if (typeof value === 'string' && value.trim() !== '') return value.trim();
	if (
		value != null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>).id === 'string' &&
		((value as Record<string, unknown>).id as string).trim() !== ''
	) {
		return { id: ((value as Record<string, unknown>).id as string).trim() };
	}
	return null;
}

function parseSpeechRequest(body: unknown):
	| { ok: true; model: string; speech: NormalizedAudioSpeechRequest }
	| { ok: false; error: string } {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return { ok: false, error: 'JSON body must be an object' };
	}
	const value = body as Record<string, unknown>;
	const model = typeof value.model === 'string' ? value.model.trim() : '';
	if (!model) return { ok: false, error: 'Missing model' };
	const input = typeof value.input === 'string' ? value.input : '';
	const inputCharacters = Array.from(input).length;
	if (inputCharacters === 0) return { ok: false, error: 'Missing input' };
	if (inputCharacters > 4096) return { ok: false, error: 'input must be at most 4096 characters' };
	const voice = parseSpeechVoice(value.voice);
	if (!voice) return { ok: false, error: 'Missing or invalid voice' };

	const responseFormatRaw =
		typeof value.response_format === 'string' ? value.response_format.trim().toLowerCase() : 'mp3';
	if (!SPEECH_RESPONSE_FORMATS.has(responseFormatRaw as AudioSpeechResponseFormat)) {
		return { ok: false, error: `Unsupported response_format: ${responseFormatRaw}` };
	}
	const speed = value.speed == null ? 1 : Number(value.speed);
	if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
		return { ok: false, error: 'speed must be between 0.25 and 4.0' };
	}
	const streamFormatRaw =
		typeof value.stream_format === 'string' ? value.stream_format.trim().toLowerCase() : 'audio';
	if (streamFormatRaw !== 'audio' && streamFormatRaw !== 'sse') {
		return { ok: false, error: 'stream_format must be audio or sse' };
	}
	let instructions: string | undefined;
	if (value.instructions != null) {
		if (typeof value.instructions !== 'string') {
			return { ok: false, error: 'instructions must be a string' };
		}
		if (Array.from(value.instructions).length > 4096) {
			return { ok: false, error: 'instructions must be at most 4096 characters' };
		}
		if (value.instructions !== '') instructions = value.instructions;
	}

	return {
		ok: true,
		model,
		speech: {
			input,
			voice,
			responseFormat: responseFormatRaw as AudioSpeechResponseFormat,
			speed,
			streamFormat: streamFormatRaw,
			instructions,
		},
	};
}

audioRoutes.post('/speech', async (c) => {
	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const start = Date.now();
	const requestCorrelationId = c.get('generationId')!;
	const timing = new RequestTimingCollector();
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidJson,
			message: 'Invalid JSON body',
		});
	}
	const parsed = parseSpeechRequest(body);
	if (!parsed.ok) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: parsed.error,
		});
	}
	const { model: rawModelId } = parsed;
	const guardrail = await runAudioSpeechRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelId: rawModelId,
		body: body as Record<string, unknown>,
		correlationId: requestCorrelationId,
		now: new Date(start),
	});
	if (!guardrail.ok) {
		return gatewayErrorJson(c, {
			status: guardrail.status,
			code: guardrail.code === 'guardrail_invalid'
				? GatewayErrorCode.guardrailInvalid
				: GatewayErrorCode.guardrailBlocked,
			message: guardrail.message,
		});
	}
	const outputGuardrailBlock = await blockUnsupportedAudioOutputGuardrails(
		c,
		repos,
		apiKey,
		rawModelId,
		guardrail,
		requestCorrelationId,
	);
	if (outputGuardrailBlock) return outputGuardrailBlock;
	const fallbackPlan = await buildModelFallbackPlan(repos, {
		modelIds: [rawModelId],
		body: guardrail.body,
		requestProtocol: 'openai',
		requestOperation: 'audio.speech',
		pricingAt: new Date(start),
	});
	if (!fallbackPlan.ok) {
		return gatewayErrorJson(c, {
			status: fallbackPlan.status,
			code: fallbackPlan.code,
			message: fallbackPlan.message,
		});
	}
	const selectedPlan = fallbackPlan.candidates[0]!;
	const guardedParsed = parseSpeechRequest(selectedPlan.upstreamBody);
	if (!guardedParsed.ok) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: guardedParsed.error,
		});
	}
	const speech = guardedParsed.speech;
	const { model, baseModelId, effectiveRouteGroup, routes } = selectedPlan;
	if (routes.some(routeUsesUnsupportedMultimediaEndpointPriceSelection)) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'provider.max_price and provider.sort=price are unavailable for Audio until multimedia endpoint price comparison is enabled',
		});
	}
	const modelNameForLog = modelDisplayName(model, baseModelId);
	const businessTimezone = await getBusinessTimezone(repos);
	const estimateSelection = selectConservativeMultimediaBudgetEstimate(await Promise.all(
		routes.map((route) => estimateAudioSpeechBudgetPrecheck(repos, {
			endpoint: route.endpoint ?? null,
			operation: resolveCanonicalAudioEndpointPricingOperation(route.upstreamOperation),
			catalogModelId: baseModelId,
			userChargedCostFactorsJson: apiKey.chargedCostFactors,
			inputCharacters: Array.from(speech.input).length,
			requestStartedAtMs: start,
			businessTimezone,
		}, [route.priceOverrideRaw])),
	));
	if (!estimateSelection) throw new Error('Audio fallback plan has no billable route estimate');
	const { estimate, estimatedChargedCost } = estimateSelection;
	const pricingCeilingFailure = audioPricingCeilingFailureContract(estimatedChargedCost);
	if (pricingCeilingFailure) return gatewayErrorJson(c, pricingCeilingFailure);

	const requestBodyForLog = finalizeRequestLogJson(
		redactAudioSpeechRequestForLog(rawModelId, speech)
	);
	const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
		baseModelId,
		modelNameForLog,
		requestBodyForLog,
		requestProtocol: 'openai',
		startMs: start,
		timing,
		clientErrorCircuitEnabled: false,
	});
	if (circuitBlocked) return circuitBlocked;

	const ordinaryAdmission = await reserveOrdinaryUserBudget(repos, {
		requestId: requestCorrelationId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		budgetMax: apiKey.budgetMax,
		expectedBudgetEpoch: apiKey.budgetEpoch,
		estimatedChargedCost,
		now: new Date(start),
	});
	if (!ordinaryAdmission.ok) {
		return gatewayErrorJson(c, {
			status: 403,
			code: GatewayErrorCode.budgetExceeded,
			message: ordinaryAdmission.error.message,
		});
	}
	const ordinaryBudgetLease = ordinaryAdmission.lease;
	let budgetAdmission: Awaited<ReturnType<typeof admitAudioGuardrailBudget>>;
	try {
		budgetAdmission = await admitAudioGuardrailBudget(repos, {
			requestId: requestCorrelationId,
			intents: guardrail.budgetIntents,
			reservedMicros: audioGuardrailBudgetMicros(estimate.chargedCost),
		});
	} catch (error) {
		await terminateAudioOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'guardrail_budget_admission_failed',
		);
		throw error;
	}
	if (!budgetAdmission.ok) {
		await terminateAudioOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'guardrail_budget_admission_failed',
		);
		if (budgetAdmission.blocked) {
			return gatewayErrorJson(c, {
				status: 403,
				code: budgetAdmission.reason === 'gateway_key_limit' || budgetAdmission.reason === 'workspace_budget' ? GatewayErrorCode.budgetExceeded : GatewayErrorCode.guardrailBlocked,
				message: budgetAdmission.message,
			});
		}
		throw new Error(`Guardrail budget admission failed: ${budgetAdmission.message}`);
	}
	const guardrailBudgetLease = budgetAdmission.lease;
	const affinityKey = buildAffinityKey(apiKey.userId, baseModelId, effectiveRouteGroup, 'openai');
	const tierKeyPrefix = buildTierKeyPrefix(baseModelId, effectiveRouteGroup, 'openai');
	timing.markGatewayComplete();
	let proxyResult: ProxyResult;
	try {
		proxyResult = await proxyAudioSpeech(
			repos,
			routes,
			speech,
			c.req.raw.signal,
			{
				affinityKey,
				tierKeyPrefix,
				strategy: selectedPlan.strategy.base,
				tierStrategies: selectedPlan.strategy.tierOverrides,
				timing,
				routePoolId: selectedPlan.surface?.route_pool_id ?? routes[0]?.routePoolId ?? null,
				sticky: selectedPlan.hasProviderPreferences ? null : stickyConfigFromSurface(selectedPlan.surface),
				beforeUpstreamDispatch: () => beforeAudioUpstreamDispatch(
					ordinaryBudgetLease,
					guardrailBudgetLease,
				),
			}
		);
	} catch (error) {
		await terminateAudioGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_failed');
		await terminateAudioOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'upstream_dispatch_failed',
		);
		throw error;
	}
	if (ordinaryBudgetLease.state === 'reserved') {
		await terminateAudioOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'upstream_dispatch_not_started',
		);
	}
	if (!guardrailBudgetLease.dispatched) {
		await terminateAudioGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_not_started');
	}
	return finalizeSpeechResponse({
		c,
		proxyResult,
		apiKey,
		repos,
		baseModelId,
		effectiveRouteGroup,
		modelNameForLog,
		requestBodyForLog,
		inputCharacters: Array.from(speech.input).length,
		businessTimezone,
		start,
		timing,
		guardrailBudgetLease,
		ordinaryBudgetLease,
	});
});

async function finalizeSpeechResponse(params: {
	c: AudioContext;
	proxyResult: ProxyResult;
	apiKey: ApiKeyContext;
	repos: GatewayRepositories;
	baseModelId: string;
	effectiveRouteGroup: string;
	modelNameForLog: string;
	requestBodyForLog: string | null;
	inputCharacters: number;
	businessTimezone: string;
	start: number;
	timing: RequestTimingCollector;
	guardrailBudgetLease: AudioGuardrailBudgetLease;
	ordinaryBudgetLease: OrdinaryBudgetLease;
}): Promise<Response> {
	const {
		c,
		proxyResult,
		apiKey,
		repos,
		baseModelId,
		effectiveRouteGroup,
		modelNameForLog,
		requestBodyForLog,
		inputCharacters,
		businessTimezone,
		start,
		timing,
		guardrailBudgetLease,
		ordinaryBudgetLease,
	} = params;
	const {
		chosenRoute,
		upstreamRequestId,
		circuitEvents,
		suppressErrorAlert,
		stickyTrace,
		stickyMutationPromise,
	} = proxyResult;
	if (stickyMutationPromise) scheduleBackgroundWork(c, stickyMutationPromise);
	const { response, errorBodyText } = await materializeNonOkResponse(proxyResult.response).catch(
		async (error: unknown) => {
			await guardrailBudgetLease.forfeit('upstream_response_materialization_failed');
			await terminateAudioOrdinaryBudget(
				ordinaryBudgetLease,
				guardrailBudgetLease.requestId,
				'upstream_response_materialization_failed',
			);
			throw error;
		},
	);
	let userModelCircuitEvent = null;
	if (response.ok) {
		markUserModelSuccess(apiKey.userId, baseModelId);
	} else if (errorBodyText != null) {
		userModelCircuitEvent = maybeTriggerUserModelCircuitFromUpstream(
			apiKey.userId,
			baseModelId,
			response.status,
			response.headers.get('content-type'),
			errorBodyText,
			formatHttpErrorTextForRequestLog(
				response.status,
				response.headers.get('content-type'),
				errorBodyText
			),
			{ clientErrorCircuitEnabled: false }
		);
	}
	const alertCircuitEvents = userModelCircuitEvent
		? [...circuitEvents, userModelCircuitEvent]
		: circuitEvents;
	const speechErrorMessage = (usage: UsageFromStream): string | undefined => {
		if (response.ok && !usage.cancelled && !usage.stream_error) return undefined;
		if (usage.cancelled) return 'Client disconnected before speech stream completed';
		if (usage.stream_error) return `Speech stream failed: ${usage.stream_error}`;
		if (errorBodyText != null) {
			return formatHttpErrorTextForRequestLog(
				response.status,
				response.headers.get('content-type'),
				errorBodyText
			);
		}
		return `HTTP ${response.status}`;
	};

	scheduleBackgroundWork(
		c,
		proxyResult.usagePromise
			.then(
				(usage) => ({ usage, usageUnavailable: false }),
				() => ({
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_read_tokens: 0,
						cache_write_tokens: 0,
						reasoning_tokens: 0,
						total_tokens: 0,
						raw_usage: null,
					} as UsageFromStream,
					usageUnavailable: true,
				}),
			)
			.then(async ({ usage, usageUnavailable }) => {
				const ordinaryCostUnknown = proxyResult.meta?.upstreamOutcomeUnknown === true
					|| (response.ok && (
						usage.cancelled === true
							|| Boolean(usage.stream_error)
					));
				const tokenUsage =
					usage.input_tokens > 0 || usage.output_tokens > 0 || usage.total_tokens > 0
						? {
								input_tokens: usage.input_tokens,
								output_tokens: usage.output_tokens,
								total_tokens: usage.total_tokens,
								audio_tokens: usage.output_tokens,
								text_tokens: usage.input_tokens,
								raw_usage: usage.raw_usage,
							}
						: null;
				const status: 'success' | 'error' =
					response.ok && !usage.cancelled && !usage.stream_error ? 'success' : 'error';
				const errorMessage = speechErrorMessage(usage);
				const stickyTraceSnapshot = stickyTrace ? await stickyTrace() : null;
				return recordAudioUsage({
					repos,
					requestLogId: guardrailBudgetLease.requestId,
					apiKeyId: apiKey.keyId,
					workspaceId: apiKey.workspaceId,
					userId: apiKey.userId,
					userEmail: apiKey.userEmail,
					modelId: baseModelId,
					providerId: chosenRoute.providerId,
					providerModelName: chosenRoute.providerModelName,
					modelName: modelNameForLog,
					providerName: chosenRoute.providerName,
					requestBody: requestBodyForLog,
					requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
					requestProtocol: 'openai',
					requestOperation: 'audio.speech',
					upstreamProtocol: chosenRoute.upstreamProtocol,
					upstreamOperation: chosenRoute.upstreamOperation,
					modelSurfaceId: chosenRoute.modelSurfaceId,
					routePoolId: chosenRoute.routePoolId,
					routeTargetId: chosenRoute.targetId,
					adapter: chosenRoute.adapter,
					stickyTrace: stickyTraceSnapshot,
					providerRoutingTrace: chosenRoute.providerRoutingTrace ?? null,
					routeGroup: effectiveRouteGroup,
					status,
					latencyMs: Date.now() - start,
					errorMessage,
					billing: {
						endpoint: chosenRoute.endpoint ?? null,
						operation: resolveCanonicalAudioEndpointPricingOperation(
							chosenRoute.upstreamOperation,
						),
						catalogModelId: baseModelId,
						userChargedCostFactorsJson: apiKey.chargedCostFactors,
						routePriceOverrideJson: chosenRoute.priceOverrideRaw,
						durationSeconds: 0,
						requestStartedAtMs: start,
						businessTimezone,
						// Per-character TTS pricing is based on the validated request input,
						// not optional provider response metadata.
						characters: response.ok ? inputCharacters : null,
						tokenUsage: response.ok ? tokenUsage : null,
					},
					providerKeyId: chosenRoute.providerKeyId ?? null,
					providerKeyLabel: chosenRoute.providerKeyLabel ?? null,
					providerKeyFingerprint: chosenRoute.providerKeyFingerprint ?? null,
					upstreamRequestId,
					timing: timing.snapshot(),
					circuitEvents: alertCircuitEvents.length > 0 ? alertCircuitEvents : undefined,
					suppressErrorAlert: suppressErrorAlert || undefined,
					guardrailBudgetSettlement: guardrailBudgetLease.reserved
						? {
								requestId: guardrailBudgetLease.requestId,
								usageUnavailable,
								...(ordinaryCostUnknown ? { mode: 'reserved' as const } : {}),
							}
						: undefined,
					ordinaryBudgetSettlement:
						ordinaryBudgetLease.reserved && ordinaryBudgetLease.state === 'dispatched'
							? {
									requestId: guardrailBudgetLease.requestId,
									budgetEpoch: ordinaryBudgetLease.budgetEpoch!,
									reservedMicros: ordinaryBudgetLease.reservedMicros,
									unknownCost: ordinaryCostUnknown,
								}
							: undefined,
				});
			})
			.catch(async (error) => {
				console.error(
					`[Gateway Audio] record speech usage failed baseModelId=${baseModelId} error=${error instanceof Error ? error.message : String(error)}`
				);
				await guardrailBudgetLease.forfeit('request_usage_settlement_failed');
				await terminateAudioOrdinaryBudget(
					ordinaryBudgetLease,
					guardrailBudgetLease.requestId,
					'request_usage_settlement_failed',
				);
			})
	);
	return response;
}

async function finalizeAudioResponse(params: {
	c: AudioContext;
	proxyResult: ProxyResult;
	apiKey: ApiKeyContext;
	repos: GatewayRepositories;
	baseModelId: string;
	effectiveRouteGroup: string;
	modelNameForLog: string;
	requestBodyForLog: string | null;
	fileBytes: number;
	businessTimezone: string;
	start: number;
	timing: RequestTimingCollector;
	guardrailBudgetLease: AudioGuardrailBudgetLease;
	ordinaryBudgetLease: OrdinaryBudgetLease;
}): Promise<Response> {
	const {
		c,
		proxyResult,
		apiKey,
		repos,
		baseModelId,
		effectiveRouteGroup,
		modelNameForLog,
		requestBodyForLog,
		fileBytes,
		businessTimezone,
		start,
		timing,
		guardrailBudgetLease,
		ordinaryBudgetLease,
	} = params;

	const {
		chosenRoute,
		upstreamRequestId,
		circuitEvents,
		suppressErrorAlert,
		stickyTrace,
		stickyMutationPromise,
	} = proxyResult;
	if (stickyMutationPromise) {
		scheduleBackgroundWork(c, stickyMutationPromise);
	}
	const { response, errorBodyText } = await materializeNonOkResponse(proxyResult.response).catch(
		async (error: unknown) => {
			await guardrailBudgetLease.forfeit('upstream_response_materialization_failed');
			await terminateAudioOrdinaryBudget(
				ordinaryBudgetLease,
				guardrailBudgetLease.requestId,
				'upstream_response_materialization_failed',
			);
			throw error;
		},
	);
	const usageUnavailable = await proxyResult.usagePromise.then(
		() => false,
		() => true,
	);

	const latencyMs = Date.now() - start;
	const meta = proxyResult.meta;
	const durationSeconds = response.ok ? (meta?.audioDurationSeconds ?? 0) : 0;
	const durationSource =
		response.ok && meta?.audioDurationSource
			? meta.audioDurationSource
			: 'estimated';
	const tokenUsage = response.ok ? (meta?.audioTokenUsage ?? null) : null;
	const ordinaryCostUnknown = meta?.upstreamOutcomeUnknown === true
		|| meta?.responseBodyTooLarge === true
		|| (response.ok && usageUnavailable);

	let userModelCircuitEvent = null;
	if (response.ok) {
		markUserModelSuccess(apiKey.userId, baseModelId);
	} else if (errorBodyText != null) {
		userModelCircuitEvent = maybeTriggerUserModelCircuitFromUpstream(
			apiKey.userId,
			baseModelId,
			response.status,
			response.headers.get('content-type'),
			errorBodyText,
			formatHttpErrorTextForRequestLog(
				response.status,
				response.headers.get('content-type'),
				errorBodyText
			),
			{ clientErrorCircuitEnabled: false }
		);
	}
	const alertCircuitEvents = userModelCircuitEvent
		? [...circuitEvents, userModelCircuitEvent]
		: circuitEvents;

	const status: 'success' | 'error' = response.ok ? 'success' : 'error';
	const errorMessage =
		status === 'error'
			? errorBodyText != null
				? formatHttpErrorTextForRequestLog(
						response.status,
						response.headers.get('content-type'),
						errorBodyText
					)
				: `HTTP ${response.status}`
			: undefined;

	scheduleBackgroundWork(
		c,
		(async () => {
			const stickyTraceSnapshot = stickyTrace ? await stickyTrace() : null;
			await recordAudioUsage({
				repos,
				requestLogId: guardrailBudgetLease.requestId,
				apiKeyId: apiKey.keyId,
				workspaceId: apiKey.workspaceId,
				userId: apiKey.userId,
				userEmail: apiKey.userEmail,
				modelId: baseModelId,
				providerId: chosenRoute.providerId,
				providerModelName: chosenRoute.providerModelName,
				modelName: modelNameForLog,
				providerName: chosenRoute.providerName,
				requestBody: requestBodyForLog,
				requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
				requestProtocol: 'openai',
				requestOperation: 'audio.transcriptions',
				upstreamProtocol: chosenRoute.upstreamProtocol,
				upstreamOperation: chosenRoute.upstreamOperation,
				modelSurfaceId: chosenRoute.modelSurfaceId,
				routePoolId: chosenRoute.routePoolId,
				routeTargetId: chosenRoute.targetId,
				adapter: chosenRoute.adapter,
				stickyTrace: stickyTraceSnapshot,
				providerRoutingTrace: chosenRoute.providerRoutingTrace ?? null,
				routeGroup: effectiveRouteGroup,
				status,
				latencyMs,
				errorMessage,
				billing: {
					endpoint: chosenRoute.endpoint ?? null,
					operation: resolveCanonicalAudioEndpointPricingOperation(
						chosenRoute.upstreamOperation,
					),
					catalogModelId: baseModelId,
					userChargedCostFactorsJson: apiKey.chargedCostFactors,
					routePriceOverrideJson: chosenRoute.priceOverrideRaw,
					durationSeconds,
					durationSource,
					fileBytes,
					requestStartedAtMs: start,
					businessTimezone,
					tokenUsage,
				},
				providerKeyId: chosenRoute.providerKeyId ?? null,
				providerKeyLabel: chosenRoute.providerKeyLabel ?? null,
				providerKeyFingerprint: chosenRoute.providerKeyFingerprint ?? null,
				upstreamRequestId,
				timing: timing.snapshot(),
				circuitEvents: alertCircuitEvents.length > 0 ? alertCircuitEvents : undefined,
				suppressErrorAlert: suppressErrorAlert || undefined,
				guardrailBudgetSettlement: guardrailBudgetLease.reserved
					? {
							requestId: guardrailBudgetLease.requestId,
							usageUnavailable,
							...(ordinaryCostUnknown ? { mode: 'reserved' as const } : {}),
						}
					: undefined,
				ordinaryBudgetSettlement:
					ordinaryBudgetLease.reserved && ordinaryBudgetLease.state === 'dispatched'
						? {
								requestId: guardrailBudgetLease.requestId,
								budgetEpoch: ordinaryBudgetLease.budgetEpoch!,
								reservedMicros: ordinaryBudgetLease.reservedMicros,
								unknownCost: ordinaryCostUnknown,
							}
						: undefined,
			});
		})().catch(async (err) => {
			console.error(
				`[Gateway Audio] recordAudioUsage failed baseModelId=${baseModelId} keyId=${apiKey.keyId} error=${err instanceof Error ? err.message : String(err)}`
			);
			await guardrailBudgetLease.forfeit('request_usage_settlement_failed');
			await terminateAudioOrdinaryBudget(
				ordinaryBudgetLease,
				guardrailBudgetLease.requestId,
				'request_usage_settlement_failed',
			);
		})
	);

	return response;
}
