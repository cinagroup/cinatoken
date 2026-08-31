/**
 * `api_key_request_logs` 状态与上游错误摘要：供 v1 代理路由在 `waitUntil` 记账时复用。
 */
import {
  responseTextWithinLimit,
  UpstreamResponseBodyTooLargeError,
} from './egress/bounded-response-body';
import { GatewayErrorCode } from './gateway-error-codes';
import { gatewayErrorResponse } from './gateway-error-response';
import { withUpstreamErrorCodeHeader } from './upstream-error-code';
import type { OpenRouterErrorSkin } from './openrouter-error-protocol';

/** 与 `InsertRequestLogParams.status` / 白名单一致。 */
export type RequestLogRecordedStatus = 'success' | 'error' | 'incomplete' | 'cancelled';

const MAX_BODY_READ_CHARS = 8192;
const MAX_SUMMARY_CHARS = 480;
/** Bound the only error-body copy returned to clients and retained for logging. */
export const MAX_MATERIALIZED_ERROR_BODY_BYTES = 64 * 1024;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  const t = collapseWhitespace(s);
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** 从常见上游 JSON 错误体中提取一行摘要（OpenAI / Anthropic / Gemini 等）。 */
export function pickSummaryFromJsonBody(obj: unknown): string | null {
  if (obj == null) return null;
  if (typeof obj === 'string') {
    const t = collapseWhitespace(obj);
    return t.length ? truncate(t, MAX_SUMMARY_CHARS) : null;
  }
  if (typeof obj !== 'object') return null;
  const r = obj as Record<string, unknown>;

  const err = r.error;
  if (err && typeof err === 'object' && err !== null) {
    const eo = err as Record<string, unknown>;
    const em = eo.message;
    if (typeof em === 'string' && em.trim()) {
      return truncate(em, MAX_SUMMARY_CHARS);
    }
    const et = eo.type;
    if (typeof et === 'string' && et.trim()) {
      return truncate(et, MAX_SUMMARY_CHARS);
    }
  }

  for (const key of ['message', 'detail', 'error_description']) {
    const v = r[key];
    if (typeof v === 'string' && v.trim()) {
      return truncate(v, MAX_SUMMARY_CHARS);
    }
  }

  const topErr = r.error;
  if (typeof topErr === 'string' && topErr.trim()) {
    return truncate(topErr, MAX_SUMMARY_CHARS);
  }

  return null;
}

/**
 * 记账用状态：取消优先，其次明确 HTTP/流失败，再其次用量不完整，其余成功。
 */
export function computeRequestLogStatus(params: {
  cancelled: boolean;
  responseOk: boolean;
  incomplete: boolean;
  streamError?: boolean;
}): RequestLogRecordedStatus {
  if (params.cancelled) return 'cancelled';
  if (!params.responseOk || params.streamError) return 'error';
  if (params.incomplete) return 'incomplete';
  return 'success';
}

/**
 * 非 2xx 时从已物化的响应体文本解析一行摘要，供 `error_message` 持久化（长度受限）。
 */
export function formatHttpErrorTextForRequestLog(
  status: number,
  contentType: string | null,
  text: string
): string {
  const code = status;
  const ct = (contentType || '').toLowerCase();
  if (ct && !ct.includes('json') && !ct.includes('text') && !ct.includes('xml')) {
    return `HTTP ${code}`;
  }
  const slice = text.length > MAX_BODY_READ_CHARS ? text.slice(0, MAX_BODY_READ_CHARS) : text;
  if (!slice.trim()) {
    return `HTTP ${code}`;
  }
  let summary: string | null = null;
  try {
    summary = pickSummaryFromJsonBody(JSON.parse(slice) as unknown);
  } catch {
    summary = truncate(slice, MAX_SUMMARY_CHARS) || null;
  }
  if (summary) return `HTTP ${code}: ${summary}`;
  return `HTTP ${code}`;
}

/**
 * 非 2xx 上游响应：有界读取 body 一次，并重建为已清理的 OpenRouter 公开错误响应，
 * 避免客户端返回与后台日志争用同一 stream。日志只保留规范化后的有界文本；
 * 原始 provider body/header 不会直接透传。
 */
export async function materializeNonOkResponse(
  response: Response,
  options: {
    skin?: OpenRouterErrorSkin;
    requestId?: string | null;
    /** Set only from trusted driver metadata, never from an upstream header. */
    trustedGatewayError?: boolean;
  } = {},
): Promise<{
  response: Response;
  errorBodyText: string | null;
}> {
  if (response.ok) {
    return { response, errorBodyText: null };
  }
  let errorBodyText: string;
  try {
    errorBodyText = await responseTextWithinLimit(response, MAX_MATERIALIZED_ERROR_BODY_BYTES);
  } catch (error) {
    if (!(error instanceof UpstreamResponseBodyTooLargeError)) throw error;
    const bounded = gatewayErrorResponse({
      status: 502,
      code: GatewayErrorCode.upstreamResponseTooLarge,
      message: 'Upstream error response exceeded the gateway size limit',
      skin: options.skin,
      requestId: options.requestId,
    });
    return {
      response: bounded,
      errorBodyText: await bounded.clone().text(),
    };
  }
  if (options.trustedGatewayError) {
    const headers = new Headers(response.headers);
    headers.set('Content-Type', 'application/json; charset=UTF-8');
    headers.set('Cache-Control', 'no-store');
    headers.delete('Content-Length');
    headers.delete('Content-Encoding');
    headers.delete('Transfer-Encoding');
    return {
      response: new Response(errorBodyText, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
      errorBodyText,
    };
  }
  const normalized = withUpstreamErrorCodeHeader(
    new Response(errorBodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    errorBodyText,
    options.skin,
    options.requestId,
  );
  return {
    response: normalized,
    errorBodyText: await normalized.clone().text(),
  };
}

/**
 * 非 2xx 时从响应体解析一行摘要，供 `error_message` 持久化（长度受限）。
 */
export async function formatHttpErrorForRequestLog(response: Response): Promise<string> {
  try {
    const text = await responseTextWithinLimit(response.clone(), MAX_BODY_READ_CHARS);
    return formatHttpErrorTextForRequestLog(
      response.status,
      response.headers.get('content-type'),
      text
    );
  } catch {
    return `HTTP ${response.status}`;
  }
}
