// Review only: an independently fetched OpenRouter generation is a supplier
// cost *candidate*. It is never a final provider_bill, a zero-charge proof, or
// authority to settle a buyer. No production path imports this module.
import { createHash } from 'node:crypto';

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_ORIGIN = 'https://openrouter.ai';
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const GEN_ID = /^gen-[A-Za-z0-9_-]{1,128}$/u;
const MAX_SOURCE_BYTES = 16_384;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object'
	&& !Array.isArray(value);

export class OpenRouterCostCandidateRejectedV372 extends Error {
	constructor(code) {
		super(`OpenRouter generation cost candidate rejected: ${code}`);
		this.name = 'OpenRouterCostCandidateRejectedV372';
		this.code = code;
	}
}

const reject = code => { throw new OpenRouterCostCandidateRejectedV372(code); };

function boundedString(value, max = 512) {
	return typeof value === 'string' && value.length >= 1
		&& value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function checkedInput(input) {
	if (!plain(input) || !plain(input.pin) || !plain(input.grant)
		|| !plain(input.observation) || typeof input.fetchImpl !== 'function'
		|| !boundedString(input.managementKey, 512)
		|| /\s/u.test(input.managementKey)) reject('invalid_input');
	const { pin, grant, observation } = input;
	if (!boundedString(pin.providerId) || !boundedString(pin.routeTargetId)
		|| !boundedString(pin.endpointId) || !boundedString(pin.credentialId)
		|| !boundedString(pin.model) || !UUID.test(pin.workspaceId ?? '')
		|| !SHA256.test(pin.sendApiKeyHash ?? '')
		|| !GEN_ID.test(observation.generationId ?? '')
		|| !UUID.test(grant.grantId ?? '')
		|| !UUID.test(grant.sendStartId ?? '')
		|| !UUID.test(grant.holderRunId ?? '')
		|| !UUID.test(grant.requestCorrelationId ?? '')
		|| !boundedString(grant.requestId, 128)
		|| !boundedString(grant.externalUser, 128)
		|| grant.credentialClass !== 'platform'
		|| grant.custodyCommitted !== true
		|| grant.sendStartCommitted !== true
		|| !SHA256.test(grant.outboundBodySha256 ?? '')
		|| !SHA256.test(grant.upstreamUrlSha256 ?? '')
		|| grant.upstreamUrlSha256 !== sha256(CHAT_URL)
		|| grant.providerId !== pin.providerId
		|| grant.routeTargetId !== pin.routeTargetId
		|| grant.endpointId !== pin.endpointId
		|| grant.credentialId !== pin.credentialId
		|| grant.model !== pin.model
		|| grant.sendApiKeyHash !== pin.sendApiKeyHash
		|| sha256(input.managementKey) === pin.sendApiKeyHash
		|| observation.sendStartId !== grant.sendStartId
		|| observation.grantId !== grant.grantId) reject('route_or_send_not_pinned');
	// This must be a server-generated, per-attempt value already frozen into the
	// exact outbound body. The current v360/v365 path does not yet provide one.
	if (grant.externalUser !== `ct-${grant.requestCorrelationId}`
		|| grant.outboundUserField !== grant.externalUser)
		reject('attempt_correlation_missing');
	return { pin, grant, observation };
}

async function readJson(response) {
	if (!response || response.status !== 200 || response.redirected === true) {
		await response?.body?.cancel?.().catch(() => {});
		reject('source_http_status');
	}
	const type = response.headers?.get?.('content-type') ?? '';
	if (!/^application\/json(?:;|$)/iu.test(type)) {
		await response.body?.cancel?.().catch(() => {});
		reject('source_content_type');
	}
	const length = response.headers?.get?.('content-length');
	if (length !== null && length !== undefined
		&& (!/^\d+$/u.test(length) || Number(length) > MAX_SOURCE_BYTES)) {
		await response.body?.cancel?.().catch(() => {});
		reject('source_body_size');
	}
	if (!response.body?.getReader) reject('source_body_missing');
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_SOURCE_BYTES) reject('source_body_size');
			chunks.push(value);
		}
	} finally { await reader.cancel().catch(() => {}); }
	const bytes = Buffer.concat(chunks, size);
	let json;
	try { json = JSON.parse(bytes.toString('utf8')); }
	catch { reject('source_json'); }
	if (!plain(json) || !plain(json.data)) reject('source_schema');
	return { data: json.data, sha256: sha256(bytes), bytes: size };
}

async function sourceGet(fetchImpl, url, key) {
	let response;
	try {
		response = await fetchImpl(url, {
			method: 'GET', redirect: 'error', cache: 'no-store',
			headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
			signal: AbortSignal.timeout(5_000),
		});
	} catch { reject('source_transport'); }
	return readJson(response);
}

/**
 * The caller must supply a registry pin and committed grant from a privileged
 * read-only store, plus a separate management credential unavailable to the
 * holder. This function performs two authenticated GETs and no DB write.
 */
export async function inspectOpenRouterGenerationCostCandidateV372(input) {
	const { pin, grant, observation } = checkedInput(input);
	const keyUrl = `${API_ORIGIN}/api/v1/keys/${pin.sendApiKeyHash}`;
	const key = await sourceGet(input.fetchImpl, keyUrl, input.managementKey);
	if (key.data.hash !== pin.sendApiKeyHash
		|| key.data.workspace_id !== pin.workspaceId
		|| key.data.disabled !== false) reject('send_key_account_mismatch');
	const generationUrl = `${API_ORIGIN}/api/v1/generation?id=${encodeURIComponent(observation.generationId)}`;
	const source = await sourceGet(input.fetchImpl, generationUrl, input.managementKey);
	const row = source.data;
	if (row.id !== observation.generationId
		|| row.external_user !== grant.externalUser
		|| row.model !== pin.model
		|| row.api_type !== 'completions'
		|| row.is_byok !== false
		|| !boundedString(row.request_id, 256))
		reject('generation_identity_mismatch');
	if (observation.providerRequestId !== undefined
		&& row.request_id !== observation.providerRequestId)
		reject('provider_request_mismatch');
	if (typeof row.total_cost !== 'number'
		|| !Number.isFinite(row.total_cost) || row.total_cost < 0)
		reject('cost_missing_or_invalid');
	const common = Object.freeze({
		grantId: grant.grantId,
		sendStartId: grant.sendStartId,
		providerId: pin.providerId,
		workspaceId: pin.workspaceId,
		generationId: row.id,
		providerRequestId: row.request_id,
		model: row.model,
		costObserved: row.total_cost,
		sourceDocumentSha256: source.sha256,
		sendKeyMetadataSha256: key.sha256,
		sourceUrl: generationUrl,
		// Source response has no documented finality, adjustment, currency or
		// generation-to-key/workspace field. Never return provider_bill fields.
		financialAuthority: false,
	});
	return Object.freeze({
		status: row.total_cost === 0 ? 'zero_unproven' : 'positive_cost_candidate',
		...common,
	});
}
