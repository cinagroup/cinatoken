/**
 * 门户前端 JSON 解析小工具：`/api/user/*` 返回 `{ success, data?, message?, total? }`。
 * 401 由 PortalGate 会话检查兜底，这里仅做安全解析。
 */
export type PortalResponse<T> = {
  success?: boolean;
  data?: T;
  message?: string;
  total?: number;
};

export async function readPortalJson<T>(response: Response): Promise<PortalResponse<T> | null> {
  try {
    return (await response.json()) as PortalResponse<T>;
  } catch {
    return null;
  }
}
