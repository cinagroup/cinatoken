# Management API

CinaToken 提供 OpenRouter-shaped 的当前 Key 元数据、Gateway Key 管理和 Workspace 共享预算子集。基地址为 Proxy Worker 的 `/api/v1`。管理资源必须使用账户门户签发的 Management API Key：

```http
Authorization: Bearer sk-cina-mgmt-...
```

Management Key 与推理用 Gateway Key 是两个物理隔离的 principal。前者只存在于 `management_api_keys`，不能完成推理鉴权；后者只存在于 `api_keys`，不能完成 Management 鉴权。两者均只在创建成功响应中返回一次明文，持久层只保存 SHA-256 hash 和安全预览。

## 当前 Key 元数据

```http
GET /api/v1/key
Authorization: Bearer sk-... | sk-cina-mgmt-...
```

该只读接口接受两种 Bearer principal，用 `is_management_key` / 兼容字段 `is_provisioning_key` 标识类型；这不会赋予跨权限域能力。Gateway Key 返回真实 total/daily/weekly/monthly `charged_cost` 用量以及已配置的 `limit`、`limit_reset` 和基于已结算用量的 `limit_remaining`；Management Key 的推理用量为 0，限额字段为 `null`。尚未实现的 BYOK 用量为 0；deprecated `rate_limit.requests` 按官方合同返回 `-1`。响应不含明文、hash 或内部 Key ID，并设置 `Cache-Control: private, no-store`。

## Gateway Key 管理接口

```http
GET    /api/v1/keys
POST   /api/v1/keys
GET    /api/v1/keys/{hash}
PATCH  /api/v1/keys/{hash}
DELETE /api/v1/keys/{hash}
```

`{hash}` 是响应中公开的 64 位小写十六进制 `hash`，不是完整 Gateway Key。所有成功和错误响应均为 `Cache-Control: private, no-store` 或 `no-store`。

### 列表

```http
GET /api/v1/keys?include_disabled=false&offset=0&workspace_id=personal:user-id
```

省略 `workspace_id` 时读取 Management principal 所属账户的 Default Workspace。`workspace_id` 必须仍属于同一账户；跨账户值与不存在值统一返回 404。单次最多返回 100 行，`offset` 必须为非负整数。

### 创建

```json
{
  "name": "Production",
  "workspace_id": "personal:user-id",
  "creator_user_id": "user-id",
  "limit": 25,
  "limit_reset": "monthly",
  "include_byok_in_limit": false,
  "expires_at": null
}
```

`name` 必填。`expires_at` 可为 `null`，或严格的未来 UTC ISO 8601（例如 `2027-01-01T00:00:00.000Z`）；过期后所有数据面认证立即 fail closed。个人账户的 creator 固定为账户所有者；组织账户 creator 必须是对目标 Workspace 仍有 CinaAuth-backed 访问权的 active 本地用户。成功返回 201：

```json
{
  "data": {
    "hash": "64-lowercase-hex",
    "name": "Production",
    "disabled": false,
    "workspace_id": "personal:user-id",
    "usage": 0,
    "usage_daily": 0,
    "usage_weekly": 0,
    "usage_monthly": 0,
    "limit": 25,
    "limit_remaining": 25,
    "limit_reset": "monthly",
    "include_byok_in_limit": false
  },
  "key": "sk-..."
}
```

`key` 只在本次响应中出现。`limit` 接受非负有限数字或 `null`；内部按六位小数精度记账。`limit_reset` 接受 `daily`、`weekly`、`monthly` 或 `null`，其中 `null` 表示从 Key 创建时间开始的 lifetime 上限。日、周、月均在 UTC 边界重置，周周期从星期一开始。推理准入将已结算消费和所有在途 reservation 一并计入，因此并发请求不能突破上限；响应中的 `limit_remaining` 仅基于已结算消费，短暂在途请求不会提前显示为已消费。`include_byok_in_limit` 在 BYOK 产品上线前只接受 `false`。

`external_user` / `external_api_key` 属于尚未实现的 Connect client-secret principal，使用 Management Key 提交时返回 403。

### 更新与删除

PATCH 当前支持 `name`、`disabled`、`limit`、`limit_reset` 和显式的 `include_byok_in_limit=false`：

```json
{"name":"CI","disabled":true,"limit":10,"limit_reset":"weekly"}
```

DELETE 成功返回 `{"deleted":true}`。存在用量历史，或尚未结算的账户预算、Guardrail 预算、Workspace 预算或 Key 限额 reservation 时，硬删除稳定失败；应改用 PATCH `{"disabled":true}`。保留已使用 Key 的脱敏归属行，避免删除 Key 后历史消费脱离 Workspace、继而绕过共享预算。

## Workspace 共享预算

```http
GET    /api/v1/workspaces/{id_or_slug}/budgets
PUT    /api/v1/workspaces/{id_or_slug}/budgets/{interval}
DELETE /api/v1/workspaces/{id_or_slug}/budgets/{interval}
```

`{id_or_slug}` 只会在 Management Key 所属个人或组织账户中解析；跨账户和不存在值统一返回 404。`{interval}` 为 `daily`、`weekly`、`monthly` 或 `lifetime`。PUT 请求只接受：

```json
{"limit_usd":100}
```

最多可同时配置四档，且已配置值必须严格满足 `lifetime > monthly > weekly > daily`。每日在 UTC 00:00、每周一 UTC 00:00、每月第一天 UTC 00:00 重置；lifetime 从 Workspace 创建时间开始且不重置。GET 返回 OpenRouter-shaped 的 `id`、`workspace_id`、`limit_usd`、`reset_interval`、`created_at` 与 `updated_at`，不暴露内部配置 epoch 或账本行。

数据面会将同一请求适用的账户预算、Guardrail、Workspace 四档预算和 Gateway Key 限额放入同一次原子 reservation。所有在途请求计入准入判断；配置更新通过 epoch 使旧快照 fail closed。删除预算是幂等操作，只移除后续准入限制，不破坏已有 reservation 的结算。

## 当前明确不支持

- `include_byok_in_limit=true`；
- Connect client secret、`external_user` 与 `external_api_key`；
- Management API 下的 Workspace CRUD、成员、BYOK、Guardrail、Observability 与 Credits 资源；
- Workspace budget 的 `include_byok_in_budgets`，因为私有 BYOK 产品域尚未实现。

这些字段不会被静默忽略。Gateway Key 限额与 Workspace 共享预算已经复用统一的并发 reservation/settlement 账本，并在 D1、PostgreSQL 与 MySQL 的事务边界内复验 Key/Workspace 状态、配置版本和限额。
