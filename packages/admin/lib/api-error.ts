/**
 * `/api/admin/*` 等 BFF 的兜底错误处理：打结构化日志并返回 500（响应体含 `requestId` 便于对齐日志）。
 */
type GatewayApiErrorOptions = {
  /** 用于日志定位，如 `gateway.keys.GET` */
  route: string;
  error: unknown;
  context?: Record<string, unknown>;
};

type ErrorDetails = {
  name: string;
  message: string;
  stack?: string;
  cause?: ErrorDetails;
};

function redactSensitiveErrorText(value: string): string {
  return value
    .replace(/(\bparams:\s*)[^\r\n]*/giu, '$1[redacted]')
    .replace(/(\bauthorization:\s*bearer\s+)[^\s,;]+/giu, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, 'sk-[redacted]')
    .replace(/((?:postgres(?:ql)?|mysql):\/\/[^:\s/]+:)[^@\s/]+@/giu, '$1[redacted]@');
}

/** 将 `unknown` 规范为可序列化日志字段。 */
function toErrorDetails(error: unknown, seen = new Set<unknown>(), depth = 0): ErrorDetails {
  if (error instanceof Error) {
    const details: ErrorDetails = {
      name: error.name,
      message: redactSensitiveErrorText(error.message),
      stack: error.stack ? redactSensitiveErrorText(error.stack) : undefined,
    };
    if (error.cause != null && depth < 4 && !seen.has(error)) {
      seen.add(error);
      details.cause = toErrorDetails(error.cause, seen, depth + 1);
    }
    return details;
  }

  return {
    name: 'UnknownError',
    message: redactSensitiveErrorText(
      typeof error === 'string' ? error : JSON.stringify(error)
    ),
  };
}

/** 统一 500 JSON，不向客户端暴露堆栈；详情见服务端日志。 */
export function handleGatewayApiError({ route, error, context }: GatewayApiErrorOptions) {
  const requestId = crypto.randomUUID();
  const details = toErrorDetails(error);

  console.error('Gateway API error', {
    requestId,
    route,
    error: details,
    ...(context ? { context } : {}),
  });

  return Response.json(
    {
      success: false,
      message: 'Internal server error',
      error: { requestId },
    },
    { status: 500 }
  );
}
