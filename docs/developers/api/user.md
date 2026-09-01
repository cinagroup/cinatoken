# 用户接口

需要用户 API Key 认证的 OpenAI / Anthropic / Gemini 兼容 API。以下路径均部署在 **Proxy Worker**（`GATEWAY_URL`），与 Admin 的 `/api/admin/*` 无关。

## 认证

默认使用 `Authorization: Bearer <USER_API_KEY>`。

```bash
Authorization: Bearer sk-xxx...
```

针对不同协议兼容入口，也支持以下认证位置：

- `POST /v1/messages`：支持 `x-api-key: <USER_API_KEY>`（Anthropic SDK 常用）
- `POST /v1beta/models/...`：支持 `?key=<USER_API_KEY>` 或 `x-goog-api-key: <USER_API_KEY>`（Gemini SDK 常用）

---

## Workspace 上下文（Phase 2）

登录用户可通过控制面读取服务端确认有权访问的 Workspace，以及当前请求采用的 Workspace 上下文：

```http
GET /api/user/workspaces
```

响应的 `data` 包含 `workspaces`、`currentWorkspace` 与 `preferredWorkspaceAvailable`。可访问集合包括个人 Default Workspace、用户仍为有效成员的组织 Default Workspace，以及显式分配给该用户的自定义组织 Workspace。

用户可切换当前偏好：

```http
PUT /api/user/workspaces/current
Content-Type: application/json

{"workspace_id":"organization:org-id"}
```

服务端只接受同一请求中已复验为可访问的 Workspace，并将选择保存为 `HttpOnly; SameSite=Lax` 的浏览器偏好 Cookie；Cookie 不是授权凭据。每个普通用户 API 请求的中间件都会重新校验本地 `user_id` 与 CinaAuth `subject` 的精确绑定，并重新解析服务端 Workspace 权限。组织成员关系被撤销后，旧偏好立即失效并安全回退到个人 Default Workspace。读取和切换响应均为 `Cache-Control: private, no-store`，退出登录会清除此偏好。

用户中心的桌面侧栏与移动端顶部已经提供同一套切换器。Gateway Key、Activity、Preset、Guardrail 与共享预算已具备 Workspace 边界；BYOK 与 Routing 个性化仍未完成。Workspace 创建、归档、成员管理与完整 CinaAuth 组织角色映射也尚未开放。

### Workspace Gateway Key（Phase 3 首个切片）

`/account/keys` 可在当前 Workspace 内创建、列出和撤销当前登录成员本人创建的 Gateway Key：

```http
GET /api/user/gateway-keys
POST /api/user/gateway-keys
DELETE /api/user/gateway-keys/{id}
```

完整 `sk-` 密钥只在创建成功响应中返回一次，页面只保存在内存中；列表仅返回掩码。所有查询和撤销同时约束当前服务端 Workspace 与创建者，不能通过 Key ID 跨 Workspace 操作。旧 Key 在迁移时确定性归入创建者的个人 Default Workspace；新用户与个人 Default Workspace 在同一数据库事务中创建。Workspace 归档，或所属组织进入 suspended/deleted 状态后，该 Workspace 下的 Key 在数据面鉴权时立即 fail closed。

组织管理员跨成员管理 Key 尚未开放：CinaAuth 组织角色目前仍作为不透明值处理，在正式定义 role/permission 映射前不会猜测角色字符串。管理员全局 Key 管理也尚未提供 Workspace 选择器。

### Management API Key 与 Gateway Key 自动化

`/account/keys` 同时提供账户级 Management API Key。它使用独立的 `sk-cina-mgmt-` 凭据命名空间和独立数据库表，可调用 Proxy Worker 的只读 `GET /api/v1/key`、Gateway Key 管理 `/api/v1/keys` 与 Workspace 预算 `/api/v1/workspaces/{id_or_slug}/budgets`，不能调用 Chat、Responses、Images 等推理入口；普通 `sk-` Gateway Key 只能读取自身的 `/api/v1/key` 元数据，不能反向调用 Management API。

Management Key 完整明文只在门户创建响应中返回一次，数据库只保存 SHA-256 hash 与安全预览。可设置未来的 UTC 过期时间，也可随时吊销；每次认证都会复验状态、过期时间和所属个人/组织生命周期。创建和吊销与 `user_audit_logs` 审计记录在同一数据库事务中，审计载荷不包含明文凭据。

个人账户只有所有者可以签发；组织账户只有当前 Workspace 的本地 `admin` 角色可以签发。该授权不会从未知 CinaAuth 角色字符串推断。Management API 对 Gateway Key 的列表、单条读取、改名、启停和删除都在服务端按账户与 Workspace 约束；存在用量历史或 `reserved` / `dispatched` 请求时拒绝硬删除，调用方应禁用 Key，以保留 Workspace 历史消费归属。

当前返回真实的总计、日、周、月 `charged_cost` 用量。Gateway Key 可在门户或 Management API 创建时设置严格的未来 UTC `expires_at`，三库持久化且每次数据面鉴权复验；过期 Key 保留在列表供审计，但不能继续推理。门户和 Management API 也可配置非负 `limit` 及 lifetime/daily/weekly/monthly `limit_reset`；统一账本在推理准入时原子预留、在完成时按实际费用结算、失败时释放，三库事务都会复验 Key 配置版本，避免并发超支或旧配置穿透。BYOK 尚未启用，因此 `include_byok_in_limit` 只接受 `false`。完整接口见 [Management API](management.md)。

---

## 用户中心 Activity 与预算总览

普通用户通过 CinaAuth 会话访问 Admin Worker 上的 `/account/activity`。该页面展示当前 Workspace 的请求数、成功率、Token、实际扣费、平均延迟和请求明细，并展示 daily/weekly/monthly/lifetime 四档 Workspace 共享预算。成员只读，Workspace owner/admin 可配置或删除；服务端严格校验层级顺序。页面原有的账户预算剩余、已结算消费和进行中预留仍是账户级视图，与 Workspace 共享预算分别展示，不能相互替代。

控制面接口：

```http
GET /api/user/activity?range=7d&page=1&page_size=20&status=success&api_key_id=...&model_id=...
GET /api/user/activity/export.csv?range=30d&status=error&api_key_id=...&model_id=...
```

| 参数 | 约束 | 说明 |
| --- | --- | --- |
| `range` | `7d` / `30d` / `90d`，默认 `7d` | 统计和明细时间窗 |
| `page` | 1–100000，默认 1 | 明细页码 |
| `page_size` | 1–100，默认 20 | 每页明细数 |
| `status` | `success` / `error` / `incomplete` / `cancelled` | 可选状态筛选 |
| `api_key_id` | 最长 128 字符 | 可选 Gateway Key 精确筛选 |
| `model_id` | 最长 256 字符 | 可选模型 ID 精确筛选 |

服务端始终从 CinaAuth 会话主体和逐请求复验的当前 Workspace 同时写入 `user_id` 与 Workspace 查询条件；Workspace 通过日志所关联 Gateway Key 的服务端归属解析。客户端传入其他用户或其他 Workspace 的 Key ID 只会得到空结果。明细响应采用字段白名单，不返回 Provider/Route 内部标识、上游地址或请求正文、错误详情、密钥指纹、上游请求 ID、pricing audit 等运维信息。

CSV 导出同样强制当前用户作用域，最多导出 1,000 行，并通过响应头返回实际行数、总数、是否截断和计费币种：

```text
X-CinaToken-Export-Count
X-CinaToken-Export-Total
X-CinaToken-Export-Truncated
X-CinaToken-Billing-Currency
```

导出列中的金额标题带币种后缀（例如 `charged_cost_usd`）；所有单元格均进行 CSV 转义，并中和 `=`, `+`, `-`, `@` 开头的公式输入。页面和接口均返回 `Cache-Control: private, no-store`。

预算剩余值按 `max(0, budget_max - budget_spent - budget_reserved_micros / 1,000,000)` 展示。`budget_max = null` 表示无限制；预留只代表尚未结算的并发请求，不是第二份消费账本。

---

## 模型 ID 与路由组（route group）

网关按 `models` 表中的 **模型 ID** 解析路由；客户端通过请求里的 **`model` 字符串**（或 Gemini 路径中的模型段）选择 **计费/供应商通道**（`model_routes.route_group`，如 `default`、`free`）。

### 1. `baseId` 或 `baseId:group`

与 OpenAI 一样传入 `model` 字段（或 Gemini 路径中的模型段），解析规则由 `resolveModelRouting` 实现：

1. **整串命中** `models.id`：视为基础模型 ID；**无显式路由组**，选路时使用 **`default`** 路由组（等价于未写后缀时请求 `baseId:default`）。
2. **整串未命中**：按 **最后一个 `:`** 拆成 `prefix` + `suffix`。若 `prefix` 命中 `models.id`，则 **基础模型** = `prefix`，**显式路由组** = `suffix`（trim 后非空）。

示例：

| 传入 `model` | 基础模型 ID | 显式路由组 / 有效组 |
|--------------|-------------|---------------------|
| `deepseek-v3.2` | `deepseek-v3.2` | 无后缀 → 有效组 **`default`** |
| `deepseek-v3.2:free` | `deepseek-v3.2` | `free` |
| `deepseek-v3.2:default` | `deepseek-v3.2` | `default` |

**注意**：若数据库里存在 **本身含 `:`** 的 `models.id` 且与整串完全一致，会优先按 **整条** 当作模型 ID 匹配，不再拆分。生产环境应避免模型 ID 与 `base:group` 语法冲突。

### 2. 有效路由组与选路

请求使用的 **有效路由组** 为：

- 客户端传入 **`baseId:group`** 且 `group` 非空 → 有效组 = 该 `group`（trim，比较时 **忽略大小写**）。
- 仅传入 **`baseId`**（整串命中 `models.id`）→ 有效组 = **`default`**。

2.0 会根据 `model_id + route_group + request_protocol + request_operation` 解析 Request Surface：先查精确 operation，再回退迁移生成的 `*` Surface。Surface 指向一个 Route Pool，Proxy 仅在该 Pool 内选择 active Target，并跳过 **disabled / 无 api_key** 的 Provider。Pool 内按 **priority（DESC）分层** + **有效策略 + weight** 做 failover；Pool 策略优先于模型与全局策略。当前版本只支持 `adapter=passthrough`，因此 Target 的上游协议必须与请求协议一致。

没有匹配 Surface / active Target 或没有当前协议可用上游时，按入口返回 **400** 或 **502**。完整拓扑、operation 列表与迁移兼容路径见 [route-topology.md](../architecture/route-topology.md)。

模型 **`tags` 不参与**选组或计费。需要限定某一组时，请使用 **`baseId:your_group`**。

**免费 / 零扣费**：路由侧用户计费（Charged cost）= 模型目录价 × 有效倍率。无 `schedule.mode` 时有效倍率 = `charged_factor` × 命中窗 `factor`（未命中为 1）；`mode: "override"` 时命中窗用窗口 `factor`，未命中用 `charged_factor`。若 `users.charged_cost_factors` 含该目录模型 ID，再对路由用户计费乘一次该倍率（六位四舍五入）；缺键不改金额。若要用户侧不扣费，将路由 **Charged factor**、对应窗口 `factor`，或该用户该模型的用户计费倍率设为 `0`。智能体工具不应用用户计费倍率。

### 3. 预算校验

`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages` 与 Gemini `POST /v1beta/models/...` 在转发上游前，对 **用户 API Key** 统一执行 **`budget_max` / `budget_spent`** 校验：当 `budget_max` 非空且 `budget_spent >= budget_max` 时返回 **403** `Budget exceeded`。

路由组（`default`、`free` 等）仅影响 **选路与计费快照**（见下文用量日志），**不再**单独绕过预算或走按日免费次数表。一次性试用额度等场景请通过 **`budget_period = 'none'`** 与 `budget_max` / `budget_base` 在 **User** 上表达（经管理 API / 门户侧更新 `users`；API Key 仅用于鉴权与归集）。

### 4. 用量日志 `api_key_request_logs`

写入的 **`model_id` 为库内基础模型 ID**（不带 `:group` 后缀）；实际选用的 **`route_group`**、`request_protocol` / `request_operation`、`model_surface_id`、`route_pool_id`、`route_target_id`、`upstream_protocol` / `upstream_operation`、`adapter` 与 `route_trace` 会随请求落库。`provider_key_id` / `provider_key_label` / `provider_key_fingerprint` 为历史兼容列名，现对应 **`providers.id` / `providers.name` / fingerprint(`providers.api_key`)**。相对目录标准价的倍率请见 Target 的 **`price_override`** 中的 **`charged_factor`** / **`metered_factor`**（及兼容字段 **`provider_factor`**）。

### 5. 输出长度（`max_tokens` / `maxOutputTokens`）

- Gateway **不会**根据 D1 **`models.max_tokens`** 改写或截断用户请求；该字段在 `GET /v1/models` 等处仅作**目录/展示参考**，也不能证明任一具体 Provider endpoint 的容量。
- 实际上游请求体由 **`model_routes.custom_params`** 与客户端 JSON **深度合并**得到（实现见 `buildRouteRequestBody`）：**客户端显式提供的字段优先**于路由默认值。
- 客户端显式传入 OpenAI Chat `max_tokens` / `max_completion_tokens`、Responses `max_output_tokens` 或 Anthropic Messages `max_tokens` 时，Gateway 会在 fallback 与全局 endpoint 调度前仅保留当前 verified Endpoint snapshot 的 `max_completion_tokens` 足以覆盖该值的 Route Target；证据过期、subject 漂移、容量未知或不足的 endpoint 不会被调用，所有候选均无法证明时返回 **400**。两个 Chat 字段同时存在时按较大值校验。
- 若客户端不传上述显式输出上限，或使用尚未接入该能力合同的 Gemini `generationConfig.maxOutputTokens`，则保持原行为，由路由 JSON 中的默认值或**上游服务商的 API 默认**决定。
- 运维若希望为某条路由提供默认最大输出，可在该路由的 **`custom_params`** 中配置，例如 OpenAI/Anthropic 顶层 `"max_tokens": 4096`，Gemini 使用嵌套 `"generationConfig": { "maxOutputTokens": 8192 }`。
- **注意**：`custom_params` 和旧 Route `routing_metadata` 都不能单独作为容量证据；具体 endpoint 的可核验上限必须写入已发布且 subject 匹配的 **Endpoint evidence `max_completion_tokens`**。旧 metadata 仅参与漂移检查。Gateway 执行请求前 endpoint 资格过滤，不会替客户端重写或截断输出上限。

---

## 聊天补全

OpenAI 兼容的聊天补全接口，支持流式输出。

### 请求

```
POST /v1/chat/completions
```

### 请求体

```json
{
  "model": "glm-4",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "Hello!"
    }
  ],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 2048
}
```

`model` 可使用 **`baseId`** 或 **`baseId:route_group`**（见上文）。网关会将上游请求的 `model` 替换为路由上的 `provider_model_name`。

Chat Completions、Messages 与 Responses 支持 OpenRouter 兼容的请求级 Provider 选择：

```json
{
  "provider": {
    "order": ["OpenAI", "Azure OpenAI"],
    "only": ["OpenAI", "Azure OpenAI", "Together"],
    "ignore": ["maintenance-provider"],
    "allow_fallbacks": true,
    "require_parameters": true,
    "data_collection": "deny",
    "zdr": true,
    "enforce_distillable_text": true,
    "quantizations": ["fp8", "bf16"],
    "sort": {
      "by": "latency",
      "partition": "model"
    },
    "max_price": {
      "prompt": 2.5,
      "completion": 10
    }
  }
}
```

- 选择器可匹配 Admin 中的 Provider `id`、显示名称或当前 verified Endpoint 的公开 `endpoint_slug`，大小写不敏感。完整 slug（如 `acme/turbo`）只匹配该变体；基础 slug（`acme`）只匹配管理员显式标记 `endpoint_class="standard"` 的 slash 变体。`endpoint_class="service_tier"` 与未分类的历史 slash 变体默认永不进入候选，只有在 `provider.order` 或 `provider.only` 中提供完整 slug 才会放行；不会从 `fast`、`flex` 等任意后缀猜测层级。旧 Route `routing_metadata` 只参与漂移检查。当前尚未实现统一的顶层 `service_tier` 路由语义，传入该字段会明确返回 **400**，不会静默透传上游。`region` 不充当 endpoint 变体。
- `only` 先建立允许集合，`ignore` 再排除；`order` 覆盖本次请求的 Provider 顺序。
- `allow_fallbacks=false` 且提供 `order` 时，只保留 `order` 明确列出的 Provider/endpoint，并仍可在该有序集合内故障转移；未提供 `order` 时才收敛到首个 Provider。请求级偏好存在时不会被 Provider sticky 绑定改写。
- `provider` 是网关控制字段，转发上游前会被删除。单个列表最多 32 项，单项最长 120 字符。
- `require_parameters=true` 会依据 Route Target 当前 verified Endpoint snapshot 的 `supported_parameters` 硬过滤；证据无效或未声明能力按不支持处理。未显式要求时，`tools`、`response_format` 与 `verbosity` 能力作为软偏好，不会消灭全部 fallback。
- 显式输出 token 上限会依据 Route Target 当前 verified Endpoint snapshot 的 `max_completion_tokens` 硬过滤；目录级 `models.max_tokens`、旧 Route `routing_metadata`、路由默认 `custom_params` 和未知容量都不会被单独当作 endpoint 能力证明。
- `quantizations` 会依据 Route Target 当前 verified Endpoint snapshot 的 `quantization` 硬过滤。支持 `int4`、`int8`、`fp4`、`mxfp4`、`nvfp4`、`fp6`、`fp8`、`mxfp8`、`fp16`、`bf16`、`fp32`、`unknown`。
- `data_collection="deny"` 只接受经过有效证据核验、零保留且禁止训练的 Route Target；`zdr=true` 还要求明确支持 ZDR。未知、过期或证据缺失均 fail closed。
- `enforce_distillable_text=true` 只保留模型 `metadata.distillable_text=true` 的候选；未声明时 fail closed。
- `sort` 接受 `price`、`latency`、`throughput`，也接受带 `by`、`partition="model" | "none"` 和百分位/阈值的对象形式。性能排序使用最近 5 分钟成功请求的有界路由样本；阈值是软偏好，所有路由均未达标时仍保留 fallback。`partition="none"` 会把最多 8 个 fallback model 的 endpoint 放入同一个全局排序与一次 failover 调度链，避免分模型重启调度器改变顺序或重放状态。
- Chat、Responses、Messages、Gemini text 与 Embeddings 的 `max_price` 安全支持 `prompt`、`completion` 与 `request`，比较值来自所选 verified Endpoint 的权威价格、Route charged factor 及同一请求开始时点；阶梯价按最贵配置档执行上限，因此可能保守拒绝，但不会低估。Image 的 verified 按张安全子集支持 `max_price.image`（单张输出价）、`max_price.request`（当前请求的固定 request fee）和 `sort="price"`（按本次完整请求价）；比较与最终计费复用同一 Endpoint、Route charged factor、请求事实及冻结时点，未知价路由不会参与价格排序。Image 的 `prompt`/`completion` 价格维度，以及 Audio/DashScope 的任何 `max_price` 或 `sort=price`，仍会在 dispatch 前返回 **400**。
- `region` 是管理员声明的供应端点位置标签；只开放于 `GET /v1/models?region=eu|us` 的目录发现过滤，不约束实际推理路径，也不构成端到端数据驻留保证。推理请求中的未知 Provider 字段返回 400，不会静默忽略或透传上游。
- Provider 路由决策以脱敏摘要写入请求日志 `route_trace.provider_routing`；不包含提示词、上游地址或凭据。

Chat Completions 与 Responses 同时支持 OpenRouter 兼容的跨模型 fallback：

```json
{
  "model": "primary/model",
  "models": ["fallback/model-a", "fallback/model-b"],
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

- 只传 `models` 时，数组第一项是主模型；同时传 `model` 与 `models` 时，`model` 先尝试，数组按顺序作为后备。
- 去重后最多 8 个模型。所有模型身份、Request Surface、Route、Provider 偏好和路由策略会在第一次上游调用前完成预检；未知模型始终直接失败。`partition="model"` 下任一候选没有可用路由即失败；`partition="none"` 下可跳过无符合 endpoint 的候选，但所有候选均为空时失败。
- `partition="model"` 时每个模型先完成其 Route Pool 内的 Provider failover，再进入下一个模型；`partition="none"` 时所有符合条件的 endpoint 按请求级全局顺序由同一调度器执行。用户+模型熔断中的候选会被跳过；未知上游结果或禁止重放的失败会终止整条链。
- `models` 与 `provider` 都是网关控制字段，不会发送给上游。成功响应中的 `model`（包括 SSE 事件）会改写为最终使用的 cinatoken 公共模型 ID，不泄露 `provider_model_name`。
- 路由推理的计费只使用最终选中 Route 所绑定的 verified Endpoint 价目与该 Route 的价格倍率；`models.pricing_profile` 仅保留作目录/离线兼容事实，不能替代 Endpoint 运行时证据。`route_trace.model_fallback` 记录原始模型、最终模型、每次候选状态与规范化错误码；不记录上游错误正文、提示词、上游地址或密钥。

### 响应

**非流式响应：**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1705800000,
  "model": "glm-4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 10,
    "total_tokens": 30
  }
}
```

**流式响应（SSE）：**

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1705800000,"model":"glm-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1705800000,"model":"glm-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1705800000,"model":"glm-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### 公开 Web Chat 边界

`https://cinatoken.com/chat` 经同源 `POST /api/public/chat` 调用该接口，并强制使用 SSE。BFF 不记录或持久化用户 API Key，直接透传上游响应流并设置 `Cache-Control: no-store, no-transform`。

- 公开 Chat 只展示目录中已发布、支持 OpenAI 协议且输出包含 `text` 的模型；只有 `input_modalities` 包含 `image` 的模型可添加图片。
- 图片会转换为 OpenAI `image_url` Data URL 内容块；只接受 PNG/JPEG/WebP/GIF，单张最多 4 MiB、整段会话最多 4 张且合计最多 8 MiB。BFF 不接受远程图片 URL。
- 助手输出以安全 GFM Markdown 增量渲染，不启用原始 HTML，也不加载模型输出中的远程图片。
- “在本地保存本次对话”默认关闭；启用后 Local Storage 只保存文字记录与模型 ID。API Key 和图片数据始终不持久化。

### 错误响应

| 场景 | HTTP | 示例 `error` |
|------|------|----------------|
| 请求体非法 JSON | 400 | `Invalid JSON body` |
| 缺少 `model` | 400 | `Missing model` |
| Provider 偏好格式非法、字段不支持或无匹配路由 | 400 | `Unsupported provider preference: ...` / `No configured route matches ...` |
| `/v1/images/edits` Content-Type 非 `multipart/form-data` | 400 | `Unsupported Content-Type for /v1/images/edits: expected multipart/form-data, got "…"` |
| `/v1/images/edits` multipart 解析失败 | 400 | `Invalid multipart body` |
| 有效路由组下无活跃路由（含未写后缀时的 **`default`**） | 400 | `No active routes for route group "default" for this model` |
| 预算超限 | 403 | `Budget exceeded` |
| 模型不存在 | 404 | `Model not found` |
| 路由解析失败等 | 502 | 具体错误信息 |
| 无 OpenAI 协议路由（有效组内无可用上游） | 502 | `No OpenAI route in route group "default" for this model`（组名随有效组变化） |

Images 入参校验失败会打结构化 `console.warn('[Gateway Images] request rejected', …)`（含 `contentType` / `bodyKeys` / `hasModel` 等，**不含** prompt / 图片字节）。Proxy 另有通用 4xx 短错误体日志 `[Gateway] client error response`。

### 示例

**非流式请求：**

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4",
    "messages": [
      {"role": "user", "content": "Say hello in 3 languages"}
    ]
  }'
```

**指定 free 路由组：**

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx..." \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v3.2:free","messages":[{"role":"user","content":"hi"}]}'
```

---

## Responses

OpenAI Responses 兼容入口，支持非流式 JSON 与 `stream=true` 的 typed SSE。上游必须配置 `openai.responses` 请求入口，并使用同协议 `passthrough`。

### 请求

```
POST /v1/responses
```

### 请求体

```json
{
  "model": "gpt-4.1",
  "input": [
    { "role": "user", "content": "Hello" }
  ],
  "stream": true,
  "store": false
}
```

`model` 可使用 **`baseId`** 或 **`baseId:route_group`**（见上文）。网关会将上游请求的 `model` 替换为路由上的 `provider_model_name`，其余字段默认原样透传。

`previous_response_id` 仅在单一模型、单一上游目标（或不会切换目标的路由池）下透传。多模型 fallback 或多目标无法保证回到同一上游时返回 **409** `responses.state_route_unavailable`。当前不提供 Conversations、background retrieve/cancel 或 Chat ↔ Responses 转换。

### 示例

```bash
curl http://localhost:8787/v1/responses \
  -H "Authorization: Bearer sk-xxx..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "input": [{"role": "user", "content": "Hello"}],
    "store": false
  }'
```

---

## Anthropic Messages 兼容接口

Anthropic 兼容入口，支持 `messages` 与流式。

### 请求

```
POST /v1/messages
```

### 请求体示例

```json
{
  "model": "claude-3-7-sonnet",
  "max_tokens": 1024,
  "messages": [
    { "role": "user", "content": "Write a haiku about coding." }
  ],
  "stream": true
}
```

`model` 同样支持 `baseId:route_group`；仅 **Anthropic**（`upstream_protocol = anthropic`）路由会参与转发。

Messages 支持 Anthropic/OpenRouter 的 `fallbacks` 形式：

```json
{
  "model": "primary/model",
  "fallbacks": [
    { "model": "fallback/model-a" },
    { "model": "fallback/model-b" }
  ],
  "max_tokens": 1024,
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

`fallbacks` 最多 3 项，每项只能包含 `model`；带 `max_tokens`、`thinking` 等逐次覆盖会返回 400。Messages 也接受共享的 `models` 数组形式，但 `fallbacks` 与 `models` 不得同时出现。Provider 选择、预检、最终模型响应改写、计费与 `route_trace.model_fallback` 语义与 Chat Completions 相同。

### 认证示例

```bash
curl http://localhost:8787/v1/messages \
  -H "x-api-key: sk-xxx..." \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-7-sonnet",
    "max_tokens": 512,
    "messages": [{"role":"user","content":"hello"}]
  }'
```

> 网关会按 `request_protocol = anthropic` 记录用量与计费。

---

## Gemini 兼容接口

Gemini 兼容入口，支持 `generateContent` 与 `streamGenerateContent`。

### 请求

```
POST /v1beta/models/:modelAction
```

其中 `:modelAction` 格式为 **`{modelSegment}:{generateContent|streamGenerateContent}`**，`modelSegment` 为传给 `resolveModelRouting` 的原始字符串（可为 **`baseId`** 或 **`baseId:routeGroup`**）。解析时以 **最后一个 `:`** 为界，后缀必须是 `generateContent` 或 `streamGenerateContent`。

示例：

- `gemini-2.5-pro:generateContent`
- `deepseek-v3.2:free:streamGenerateContent` → 模型段 `deepseek-v3.2:free` → 基础 `deepseek-v3.2`、显式组 `free`

### 请求体示例

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "Explain recursion in one paragraph." }]
    }
  ],
  "generationConfig": {
    "maxOutputTokens": 1024
  }
}
```

### 认证示例

```bash
curl "http://localhost:8787/v1beta/models/gemini-2.5-pro:generateContent?key=sk-xxx..." \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"role":"user","parts":[{"text":"hello"}]}]
  }'
```

**流式：**

```bash
curl "http://localhost:8787/v1beta/models/gemini-2.5-pro:streamGenerateContent?key=sk-xxx..." \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Write a short poem"}]}]}'
```

> 网关会按 `request_protocol = gemini` 记录用量与计费；仅 **Gemini** 协议路由参与转发。

### 上游 Provider `endpoints`（Gemini 多入口：Developer / Vertex Express / 项目级 Vertex）

Admin 中 Provider 的权威配置为 **`providers.endpoints`** JSON（迁移 `0011_provider_endpoints`）。Gemini 协议优先写：

```json
{ "gemini": { "base": "https://generativelanguage.googleapis.com/v1beta/models" } }
```

`base` 须配置到 **`{model}` 之前**的完整路径前缀（网关不再自动补 `/v1beta/models`）；出站由 `resolveUpstreamEndpoint` 派生为 `{base}/{upstreamModel}:{action}`。非标准厂商优先配置统一模板：

```json
{
  "gemini": {
    "endpoints": {
      "models.generate": "https://example.com/v1beta/models/{model}:{action}"
    }
  }
}
```

`models.generate` 模板必须同时包含 **`{model}`** 与 **`{action}`**，一次配置覆盖 `generateContent` 和 `streamGenerateContent`。旧的 `generateContent` / `streamGenerateContent` 独立模板仍可读写以兼容历史数据；运行时优先级为 `models.generate` → 对应旧 action 模板 → `base` 派生。新配置不应继续拆成两个旧键。

**客户端入口**始终为 `POST /v1beta/models/...`（与 `@google/genai` SDK 兼容）。

| 接入风格 | 示例 `endpoints.gemini.base` | 网关出站 URL 形态 |
|----------|------------------------------|-------------------|
| Developer API | `https://generativelanguage.googleapis.com/v1beta/models` | `{base}/{upstreamModel}:{action}?key=` |
| Vertex AI Express（API Key） | `https://aiplatform.googleapis.com/v1/publishers/google/models` | `{base}/{upstreamModel}:{action}?key=` |
| Vertex AI（项目级 · Bearer） | `https://aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/publishers/google/models` | `{base}/{upstreamModel}:{action}` + `Authorization: Bearer` |
| Vertex 兼容聚合（Bearer） | 写到 `{model}` 前，并设 `auth: "bearer"` | `{base}/{upstreamModel}:{action}` + `Authorization: Bearer` |
| 自定义反代 / 其他前缀 | 按上游文档写到 `{model}` 前 | 由 `auth` 决定，省略则为 `?key=` |

- **`upstreamModel`** 来自路由的 `provider_model_name`（裸模型名，如 `gemini-2.5-flash`），与客户端路径中的 `modelSegment`（可含 `:route_group`）独立。
- 仅配置裸 host（如 `https://generativelanguage.googleapis.com`）会在出站时报错。
- Vertex Express 与 Developer API 的请求体、响应体、SSE、`usageMetadata` 一致。
- **项目级 Vertex** 没有免 `project` / `location` 的通用 Gemini 前缀；`locations/global` 仍须带项目 ID。凭证栏粘贴 **GCP 服务账号 JSON**（`"type": "service_account"`）；网关换成 OAuth access token 后，OpenAI 与原生 Gemini 都走 `Authorization: Bearer`。不要把服务账号 JSON 或 Vertex API Key 塞进 `?key=`。Express 的 Vertex API Key 只覆盖原生 Gemini。
- 官方 **OpenAI Chat Completions** 不走 `endpoints.gemini`，而走 `endpoints.openai`：`https://aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/endpoints/openapi/chat/completions`。Express Mode 没有这条 OpenAI 端点。生图走 chat `modalities`，不要配 `/images/generations`。OpenAI 协议的 `provider_model_name` 若缺少 `google/`，出站时会自动补上（原生 Gemini 不加）。
- 出站鉴权只认 `endpoints.gemini.auth`：`query-key`（`?key=`）或 `bearer`（`Authorization`）；省略则为 `query-key`。服务账号会强制 Bearer。任意 Vertex 兼容上游在供应商上选 Bearer 即可，不必改核心代码。

权威配置为 **`providers.endpoints`**（迁移 **`0012`** 已删除 `base_url_*` 三列）。Gemini 须在 Admin 或 API 中把 `endpoints.gemini.base` 配到 `{model}` 之前的完整路径前缀（见上表）。

---

## 获取模型列表

OpenAI 兼容的模型列表接口。返回网关中 **至少有一条活跃路由** 的模型（全量可见，不按 API Key 区分）。

面向 Chat Completions / Agent 的默认行为：**仅返回 LLM**（排除 Embeddings、文生图与独立 Audio endpoint 模型；多模态「看图」LLM 仍会返回）。Embedding 模型请使用 `GET /v1/embeddings/models`、`kind=embedding` 或 `output_modalities=embeddings`；文生图模型（如 `gpt-image-2`）请使用 `POST /v1/images/*` 或 `kind=image`；ASR/TTS 模型请使用 `kind=audio`（调用入口分别为 `/v1/audio/transcriptions` 与 `/v1/audio/speech`）；`kind=all` 不过滤。

### 请求

```
GET /v1/models
```

可选查询参数：

| 参数 | 说明 |
|------|------|
| `route_groups` | CSV，大小写不敏感。未传 → 默认 `default,free`；传入后仅保留匹配的 group（无匹配则该模型不出现） |
| `kind` | `llm`（**默认**）仅文本/多模态 LLM；`embedding`（兼容 `embeddings`）仅向量模型；`image` 仅文生图；`audio` 包含 ASR/TTS Audio endpoint 模型；`all` 不过滤 kind。非法值回退为 `llm` |
| `output_modalities` | CSV 输出模态筛选，如 `embeddings`、`text,image`；`all` 或未传表示不额外过滤 |
| `region` | 仅接受 `eu` 或 `us`（大小写不敏感）；筛选具有对应管理员声明供应端点位置的模型和 `route_groups`。其它值（含空值）返回 **400** |

`region` 仅用于**目录发现 / 供应端点位置**过滤。它不固定后续推理使用的 Route Target，不覆盖 Provider failover，不保证请求、日志、数据库或上游推理的数据驻留；需要合规驻留时必须使用另行核验的部署与路由策略。

### 响应

```json
{
  "data": [
    {
      "id": "glm-4",
      "object": "model",
      "owned_by": "octafuse",
      "model_info": {
        "display_name": "GLM-4",
        "vendor": "zhipu",
        "tags": ["pro", "general"],
        "route_groups": ["default", "free"],
        "context_window": 128000,
        "max_tokens": 4096,
        "pricing_profile": "{\"tiers\":[{\"upto\":null,\"label\":null,\"input_price\":0.01,\"output_price\":0.01,\"cache_read_price\":null,\"cache_write_price\":null}]}",
        "input_price": 0.01,
        "output_price": 0.01,
        "description": "智谱 GLM-4 通用模型",
        "input_modalities": ["text", "image", "file"],
        "output_modalities": ["text"],
        "released_at": "2024-06-05",
        "endpoint_slugs": ["zhipu/default", "zhipu/turbo"],
        "regions": ["eu", "us"],
        "metadata": {}
      }
    }
  ],
  "object": "list"
}
```

### model_info 字段说明

| 字段 | 类型 | 描述 |
|------|------|------|
| `display_name` | string \| null | 模型显示名称 |
| `vendor` | string | 模型供应商标识，如 `openai`、`anthropic`、`google` |
| `tags` | string[] | 模型标签数组，如 `["free", "general"]`（**仅展示/目录元数据**，不参与自动选组或计费公式） |
| `route_groups` | string[] | 当前模型下 **活跃路由** 的去重 `route_group` 列表，供客户端构造请求中的 `baseId:group` |
| `context_window` | number \| null | 上下文窗口大小（token 数） |
| `max_tokens` | number \| null | 目录/展示用参考（常见最大输出能力）；**转发时不用于截断**，实际输出上限见上文「输出长度」 |
| `pricing_profile` | string \| null | 模型主定价 JSON（canonical：`{ "tiers": [ { "upto", "label", "input_price", "output_price", … } ] }`）；**末档 `upto` 为 `null` 表示开放上界**；完整阶梯与 cache 价以此为准 |
| `input_price` | number \| null | **兼容展示**：由 `pricing_profile` 派生（取各档中 **最低** `input_price` 所在档的输入价）；无合法 profile 时为 `null` |
| `output_price` | number \| null | **兼容展示**：与上档同行的输出价（$/1M） |
| `description` | string \| null | 模型描述 |
| `input_modalities` | string[] \| null | 支持的输入模态（OpenRouter 风格）：`text`、`image`、`audio`、`video`、`file`；客户端可据此限制附件类型 |
| `output_modalities` | string[] \| null | 支持的输出模态：`text`、`embeddings`、`image`、`audio` |
| `released_at` | string \| null | 模型发布日期（`YYYY-MM-DD`） |
| `endpoint_slugs` | string[] | 当前查询所含活动 Route Target 的去重公开端点 slug；不包含 target ID、上游 URL 或凭据 |
| `regions` | string[] | 当前查询所含端点的管理员声明位置标签；仅用于发现，不是数据驻留声明 |
| `metadata` | object \| undefined | 扩展元数据 |

传入 `region` 时，响应顶层还会返回 `region_filter`，其中 `scope="provider_endpoint_location_discovery"` 且 `inference_data_residency_guaranteed=false`，用于防止客户端把目录过滤误解为推理驻留承诺。

### 示例

```bash
# Agent / Chat：默认仅 LLM
curl http://localhost:8787/v1/models \
  -H "Authorization: Bearer sk-xxx..."

# 仅文生图
curl "http://localhost:8787/v1/models?kind=image" \
  -H "Authorization: Bearer sk-xxx..."

# 仅 Embeddings
curl "http://localhost:8787/v1/models?kind=embedding" \
  -H "Authorization: Bearer sk-xxx..."

# 全部 kind
curl "http://localhost:8787/v1/models?kind=all" \
  -H "Authorization: Bearer sk-xxx..."

# 仅发现管理员标记为 EU 供应端点位置的模型/通道（不是推理驻留保证）
curl "http://localhost:8787/v1/models?region=eu" \
  -H "Authorization: Bearer sk-xxx..."
```

---

## Embeddings

OpenAI / OpenRouter 兼容的向量生成接口。两个端点均要求用户 Gateway API Key，并且只发现或调用存在活动 OpenAI `embeddings` Request Surface 的模型。

### 创建向量

```http
POST /v1/embeddings
Authorization: Bearer sk-xxx...
Content-Type: application/json
```

请求体：

| 字段 | 必填 | 说明 |
|------|------|------|
| `model` | 是 | 网关模型 ID，最多 240 字符 |
| `input` | 是 | 非空字符串、字符串数组、token ID 数组、token ID 二维数组或对象数组；批量最多 2048 项，容器内不可混用类型 |
| `dimensions` | 否 | 正整数；是否生效由上游模型决定 |
| `encoding_format` | 否 | `float` 或 `base64` |
| `input_type` | 否 | 1–128 字符的上游用途提示 |
| `user` | 否 | 最多 512 字符；只转发，不写入请求日志 |

`stream: true` 会返回 400；本端点不支持流式 Embeddings。响应保持 OpenAI 列表形状，并把上游 `model` 改写回公开网关模型 ID：

```json
{
  "object": "list",
  "data": [{ "object": "embedding", "index": 0, "embedding": [0.012, -0.034] }],
  "model": "text-embedding-3-small",
  "usage": { "prompt_tokens": 8, "total_tokens": 8 }
}
```

```bash
curl -sS "$GATEWAY_URL/v1/embeddings" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":["first document","second document"],"encoding_format":"float"}'
```

### 获取 Embedding 模型

```http
GET /v1/embeddings/models
Authorization: Bearer sk-xxx...
```

返回 OpenRouter 风格的模型数组，包括 `architecture`、每 token `pricing.prompt`、`supported_parameters`、`top_provider` 与详情链接。只有 `output_modalities` 包含 `embeddings` 且具备活动 Embeddings Surface 的模型会出现。

### 安全、预算与故障转移

- 请求 Guardrail、Workspace/User/API Key scope、Provider allowlist 与 ZDR 约束在上游调用前执行；向量响应不执行文本输出过滤。
- 普通预算和 Guardrail 预算使用 `context_window × input 项数` 作为保守输入 token 上界，最终按上游 `usage.prompt_tokens` 结算，输出 token 费用恒为 0。
- 请求日志不保存 `input`、`user` 或向量 `data`，只记录输入数量和容器类型。
- 同一模型内支持 Provider failover；但上游已接受且响应过大、响应体读取失败或客户端中止导致上游结果未知时禁止重放，避免重复调用和重复计费。

---

## 公开模型目录（Catalog Discovery）

面向门户、文档站等 **无需用户 API Key** 的运行时能力发现接口。基于 **active `model_routes`** 聚合各 `route_group` 支持的 **`upstream_protocol`**，不返回 provider id、API key、`provider_model_name` 等运维字段。

### 请求

```
GET /catalog/models
```

可选查询参数：

| 参数 | 说明 |
|------|------|
| `route_groups` | CSV，大小写不敏感。未传 → 包含模型下 **全部** active route group；传入后仅保留匹配的 group（无匹配则该模型不出现在列表中） |

### 响应

```json
{
  "object": "list",
  "generated_at": "2026-05-26T13:00:00.000Z",
  "data": [
    {
      "id": "glm-4",
      "display_name": "GLM-4",
      "vendor": "zhipu",
      "context_window": 128000,
      "max_tokens": 4096,
      "pricing_profile": {
        "tiers": [
          {
            "upto": null,
            "label": null,
            "input_price": 0.01,
            "output_price": 0.01,
            "cache_read_price": null,
            "cache_write_price": null
          }
        ]
      },
      "tags": ["general"],
      "route_groups": ["default", "free"],
      "protocols": ["openai"],
      "protocols_by_group": {
        "default": ["openai"],
        "free": ["openai"]
      },
      "recommended_protocol": "openai",
      "description": "智谱 GLM-4 通用模型",
      "input_modalities": ["text", "image", "file"],
      "output_modalities": ["text"],
      "released_at": "2024-06-05",
      "endpoint_slugs": ["zhipu/default", "zhipu/turbo"],
      "regions": ["eu", "us"],
      "metadata": {}
    }
  ]
}
```

Catalog 条目同样包含 `input_modalities`、`output_modalities`、`released_at`（语义与 `model_info` 一致；`pricing_profile` 为解析后的对象），并以去重数组公开管理员显式配置的 `endpoint_slugs` 与 `regions`。这些字段不包含内部 Route Target ID、Provider URL 或凭据；其中 `regions` 仍只是供应端点位置发现标签，不是端到端数据驻留证明。

### 与 `GET /v1/models` / Admin 的差异

| 维度 | `GET /v1/models` | `GET /catalog/models` | `GET /admin/models` |
|------|------------------|------------------------|---------------------|
| 部署 | Proxy | Proxy | Admin |
| 认证 | 用户 API Key | **无** | Console Session 或具名 Admin API Key |
| 默认 `route_groups` | `default,free` | 未传 → **全部** active group | — |
| 默认 `kind` | `llm`（排除 Embeddings、文生图、ASR） | 不过滤 kind | — |
| 协议能力 | 不返回 | `protocols` / `protocols_by_group` | 不返回 |
| 主要用途 | Agent 兼容列表 | 门户 / 公开 discovery | 运维 CRUD |

Admin 静态导入目录见 **`GET /admin/models/import/catalog`**（与上表无关，见 [管理接口](./admin.md#admin-vs-proxy-catalog)）。

### 示例

```bash
curl http://localhost:8787/catalog/models
curl "http://localhost:8787/catalog/models?route_groups=default,web"
```

---

## Web Search（Agent 工具）

协议无关的产品 API（与 `/v1/me` 同类），供桌面 agent 在模型发起 `web_search` tool call 后调用。**不是** OpenAI / Anthropic / Gemini 推理协议的一部分。Agent Tools 按 Active 引擎的**三账本绝对单价**计费（联网类按次；AI 检测按计费字符单元 × 单价）：catalog 存 `metered` / `standard` / `charged`（旧键 `cost` 为 `charged` 别名；仅有 `cost` 时三列相等）。成功写入日志三列；**仅 `charged_cost` 累加 `budget_spent`**。`pricing_audit` 为 v4 `fixed_tool_cost`（含 `unit_prices` / `totals`）；不应用模型 Route 的价格倍率或时段 schedule。失败请求三列均为 0。

### 请求

```
POST /v1/tools/web-search
Authorization: Bearer <USER_API_KEY>
```

### 请求体

```json
{
  "query": "latest TypeScript release notes",
  "allowed_domains": ["typescriptlang.org"],
  "blocked_domains": [],
  "count": 8
}
```

| 字段 | 说明 |
|------|------|
| `query` | 必填；至少 2 个字符 |
| `allowed_domains` / `blocked_domains` | 可选；**不可同时**提供 |
| `count` | 可选；1–10，默认 8 |

### 行为

1. 校验用户 API Key；`budget_max` 非空且额度不足 → **403** `{ "error": "Budget exceeded" }`
2. 从 Admin `system_config` 读取搜索配置（无环境变量回退）：
   - `WEB_SEARCH_ACTIVE`（白名单：`bocha` | `tavily` | `cleversee` | `tencent_wsa`；非法值 → **503**）
   - `WEB_SEARCH_CATALOG`（JSON：按引擎存 `{ "apiKey", "metered", "standard", "charged" }`；可带兼容键 `cost`（= charged）；Active 引擎必须有非空 `apiKey`，否则 **503**）
   - 默认单价（catalog 未写价格时）三列均为 **0.001**，单位随 `BILLING_CURRENCY`
   - 兼容：若尚无 `WEB_SEARCH_CATALOG`，仍可读旧三键 `WEB_SEARCH_PROVIDER` / `WEB_SEARCH_API_KEY` / `WEB_SEARCH_COST`（仅读取，Admin 不再写入）
3. 调用 Active 引擎；**仅成功**后按该引擎 **charged** 单价计入 `users.budget_spent`
4. 上游失败不扣费

运营侧在 Admin → **Tools → Configuration** 按引擎维护 catalog 并选择 Active；调用记录见 **Tools → Invocations**（与 Request Logs 同源，`provider_id=octafuse-tools`）。

### 响应

```json
{
  "data": {
    "results": [
      {
        "title": "…",
        "url": "https://…",
        "snippet": "…",
        "summary": "…"
      }
    ],
    "cost": 0.001
  }
}
```

用量日志 `api_key_request_logs` 中 `model_id` 记为 `tool:web-search`，`provider_id` 为 `octafuse-tools`。

---

## Web Fetch（Agent 工具）

协议无关的产品 API（与 `/v1/me` 同类），供桌面 agent 在模型发起 `web_fetch` tool call 后调用。**不是** OpenAI / Anthropic / Gemini 推理协议的一部分。

### 请求

```
POST /v1/tools/web-fetch
Authorization: Bearer <USER_API_KEY>
```

### 请求体

```json
{
  "url": "https://example.com/page"
}
```

| 字段 | 说明 |
|------|------|
| `url` | 必填；仅 `http` / `https`。Gateway 拒绝 localhost、私网字面量与元数据 host（不做 DNS 反查） |

未知字段可忽略。

### 行为

1. 校验用户 API Key；`budget_max` 非空且额度不足 → **403** `{ "error": "Budget exceeded" }`
2. 从 Admin `system_config` 读取抓取配置（无环境变量回退）：
   - `WEB_FETCH_ACTIVE`（白名单：`firecrawl` | `tavily` | `jina`；默认 `firecrawl`；非法值 → **503**）
   - `WEB_FETCH_CATALOG`（JSON：按引擎存 `{ "apiKey", "metered", "standard", "charged" }`；可带兼容键 `cost`；Active 引擎必须有非空 `apiKey`，否则 **503**）
   - 默认单价（catalog 未写价格时）三列均为 **0.002**，单位随 `BILLING_CURRENCY`
   - 兼容：若尚无 `WEB_FETCH_CATALOG`，仍可读旧三键 `WEB_FETCH_PROVIDER` / `WEB_FETCH_API_KEY` / `WEB_FETCH_COST`（仅读取，Admin 不再写入）
3. URL 校验失败 → **400**
4. 调用 Active 引擎；**仅成功**后按该引擎单价计入 `users.budget_spent`
5. 上游失败不扣费；上游 **401/403** 映射为 **502**（勿透出成用户 Key 无效）

运营侧在 Admin → **Tools → Configuration** 按引擎维护 catalog 并选择 Active；调用记录见 **Tools → Invocations**（与 Request Logs 同源，`provider_id=octafuse-tools`）。

### 响应

```json
{
  "data": {
    "url": "https://example.com/page",
    "title": "…",
    "content": "# markdown…",
    "cost": 0.002
  }
}
```

| 字段 | 说明 |
|------|------|
| `url` | 最终页面 URL（引擎回写时可能与请求不同） |
| `title` | 可选；页面标题 |
| `content` | Markdown 正文 |
| `cost` | 本次扣费；单位随 `BILLING_CURRENCY` |

用量日志 `api_key_request_logs` 中 `model_id` 记为 `tool:web-fetch`，`provider_id` 为 `octafuse-tools`。

---

## Web Deep Search（Agent 工具）

协议无关的产品 API，供「搜 + 读」一体的深度检索（Firecrawl Search / Jina Search）。相对普通 Web Search，结果常含页面正文，延迟与单价更高。**不是** OpenAI / Anthropic / Gemini 推理协议的一部分。

### 请求

```
POST /v1/tools/web-deep-search
Authorization: Bearer <USER_API_KEY>
```

### 请求体

```json
{
  "query": "latest TypeScript release notes",
  "count": 5
}
```

| 字段 | 说明 |
|------|------|
| `query` | 必填；至少 2 个字符 |
| `count` | 可选；1–10，默认 5 |

### 行为

1. 校验用户 API Key；额度不足 → **403** `{ "error": "Budget exceeded" }`
2. 从 Admin `system_config` 读取配置（无环境变量回退）：
   - `WEB_DEEP_SEARCH_ACTIVE`（白名单：`firecrawl` \| `jina`；非法值 → **503**）
   - `WEB_DEEP_SEARCH_CATALOG`（JSON：按引擎 `{ "apiKey", "metered", "standard", "charged" }`；可带兼容键 `cost`；Active 必须有非空 `apiKey`，否则 **503**）
   - 默认单价三列均为 **0.01**（catalog 未写价格时），单位随 `BILLING_CURRENCY`
3. 调用 Active 引擎；**仅成功**后按该引擎单价计入 `users.budget_spent`
4. 上游失败不扣费；上游 **401/403** 映射为 **502**

运营侧在 Admin → **Tools → Configuration** 配置；调用记录见 **Tools → Invocations**（`model_id=tool:web-deep-search`）。

### 响应

```json
{
  "data": {
    "results": [
      {
        "title": "…",
        "url": "https://…",
        "snippet": "…",
        "content": "# markdown…"
      }
    ],
    "cost": 0.01
  }
}
```

| 字段 | 说明 |
|------|------|
| `results[].content` | 可选；页面正文（deep search 核心字段） |
| `cost` | 本次扣费；单位随 `BILLING_CURRENCY` |

用量日志 `api_key_request_logs` 中 `model_id` 记为 `tool:web-deep-search`，`provider_id` 为 `octafuse-tools`。

---

## AI Detection（Agent 工具）

协议无关的产品 API，供门户或 Agent 检测文本 AI 生成概率。**不是** OpenAI / Anthropic / Gemini 推理协议的一部分。

计费与上游调用次数解耦：

| 概念 | 计算 |
|------|------|
| 上游调用次数 | `ceil(总字数 / driver.segmentMaxChars)`（技术分段，随 Active 引擎变化） |
| 计费单元数 | `ceil(总字数 / billingUnitChars)`（默认 2000；与引擎无关） |
| 扣费（用户） | `计费单元数 × charged`（`budget_spent` 仅累加此项） |
| 供应 / 目录 | 同理分别写 `metered_cost` / `standard_cost` |

换引擎时调整三账本单价即可，价格量纲保持一致。响应**不暴露** Active 引擎名，避免客户端产生引擎耦合；响应体 `cost` 字段仍为本次 **charged** 总额。

### 引擎支持矩阵

多 provider 架构（`AI_DETECTION_CATALOG` + `AI_DETECTION_ACTIVE` + proxy driver 注册表）。当前白名单仅一项：

| Provider | 状态 | 凭证 | 技术分段上限 | 分数 |
|----------|------|------|--------------|------|
| `tencent_tms` | 已实现 | `secretId` + `secretKey`（可选 `region` / `bizType`） | 2000 字 | TMS `Score` 0–100 |

新增引擎时扩展白名单、`requiredCredentials` 与 driver 即可；未实现引擎不可设为 Active。

### 请求

```
POST /v1/tools/ai-detection
Authorization: Bearer <USER_API_KEY>
```

### 请求体

```json
{
  "text": "待检测正文…"
}
```

| 字段 | 说明 |
|------|------|
| `text` | 必填；trim 后非空 |

### 行为

1. 校验用户 API Key；额度不足支付预计费用 → **403** `{ "error": "Budget exceeded" }`
2. 从 Admin `system_config` 读取配置：
   - `AI_DETECTION_ACTIVE`（白名单当前：`tencent_tms`；须为已实现引擎）
   - `AI_DETECTION_CATALOG`（JSON：按引擎存可选凭证字段并集 + `metered` / `standard` / `charged`（或兼容 `cost`）+ 可选 `billingUnitChars`）
   - 默认单价三列均为 **0.01**、默认计费粒度 **2000** 字符，单位随 `BILLING_CURRENCY`
3. 按 Active 引擎切段并并发检测（并发 10）；字符加权得 `overall_score`（0–100）
4. **仅成功**后按计费单元数 × 三账本单价写入日志，并仅用 **charged** 扣费；上游失败写 error 日志、**不扣费**
5. 请求日志不含原文 / excerpt：`requestBody` 仅 `{ total_chars, billing_units }`；`pricing_audit`（v4 `fixed_tool_cost`）含 `unit_prices` / `totals` / `provider` / `billing_units`

运营侧在 Admin → **Tools → Configuration** 配置；调用记录见 **Tools → Invocations**（`model_id=tool:ai-detection`）。

### 响应

```json
{
  "data": {
    "overall_score": 87,
    "total_chars": 5321,
    "segments": [
      { "index": 0, "chars": 2000, "score": 91, "excerpt": "…" }
    ],
    "billing_units": 3,
    "cost": 0.03
  }
}
```

| 字段 | 说明 |
|------|------|
| `overall_score` | 0–100；字符加权 |
| `segments` | 展示分块（含短 excerpt）；日志侧不含 excerpt |
| `billing_units` | 计费单元数 |
| `cost` | 本次扣费；单位随 `BILLING_CURRENCY` |

---

## Tools Pricing（定价只读）

用户 Key 可读各工具单价，供门户费用预估。**不返回** provider 密钥与 Active 引擎名。余额仍从 `GET /v1/me` 获取。

### 请求

```
GET /v1/tools/pricing
Authorization: Bearer <USER_API_KEY>
```

### 响应

```json
{
  "data": {
    "billing_currency": "USD",
    "tools": [
      { "id": "web-search", "unit": "request", "cost": 0.001, "metered": 0.001, "standard": 0.001, "charged": 0.001 },
      { "id": "web-fetch", "unit": "request", "cost": 0.002, "metered": 0.002, "standard": 0.002, "charged": 0.002 },
      { "id": "web-deep-search", "unit": "request", "cost": 0.01, "metered": 0.01, "standard": 0.01, "charged": 0.01 },
      { "id": "ai-detection", "unit": "chars", "unit_chars": 2000, "cost": 0.01, "metered": 0.01, "standard": 0.01, "charged": 0.01 }
    ]
  }
}
```

| 字段 | 说明 |
|------|------|
| `billing_currency` | 与 `system_config.BILLING_CURRENCY` 一致 |
| `tools[].unit` | `request`（按次）或 `chars`（按字符计费单元） |
| `tools[].unit_chars` | 仅 `ai-detection`：计费粒度字符数 |
| `tools[].charged` | Active 引擎用户单价（扣费） |
| `tools[].metered` / `standard` | 供应成本 / 目录标准单价 |
| `tools[].cost` | 兼容别名，等于 `charged`；未配置时回退代码默认值 |

---

## Images（图片生成 / 编辑）

> 模型清单、Provider、参数对照、计费折算与验收清单见权威整理：[文生图模型（Image Models）](../reference/image-models.md)。

OpenAI 兼容 Images API，供桌面 Agent 的 `generate_image` 等工具调用。鉴权与 Chat 相同（用户 API Key）；模型须在目录中配置 **OpenAI 协议**路由及有效的 `image_billing_mode`：`token` 模式需在 `pricing_profile.tiers` 配置 Image token 单价，`per_image` 模式需配置 `pricing_profile.image` 按张单价（见 Admin 模型页与 [文生图模型说明](../reference/image-models.md)）。

### 生成

```
POST /v1/images/generations
Authorization: Bearer <USER_API_KEY>
Content-Type: application/json
```

```json
{
  "model": "gpt-image-2",
  "prompt": "A watercolor book cover of a coastal lighthouse at dusk",
  "n": 1,
  "size": "auto",
  "quality": "auto",
  "background": "auto"
}
```

国内 Seedream（火山方舟）示例（catalog id 与上游同名）：

```json
{
  "model": "doubao-seedream-5-0",
  "prompt": "海边灯塔水彩封面",
  "n": 1,
  "size": "2K",
  "watermark": false
}
```

| 字段 | 说明 |
|------|------|
| `model` | 必填；支持 `id:route_group` 后缀 |
| `prompt` | 必填；最长 4000 字符 |
| `n` | **1..10**；`n>1` 仅在候选 Endpoint 明确证明参数范围且按张计费可预检时开放 |
| `size` / `quality` / `background` | 可选；GPT Image 常用 `auto` / `1024x…`；Seedream 常用 `2K` / `4K` |
| `response_format` | 可选；**仅当调用方显式传入时透传**。默认由上游决定（GPT Image 系列通常直接返回 `b64_json`，且不接受该参数） |
| `watermark` / `sequential_image_generation` / `optimize_prompt_options` | 可选；Seedream 等兼容扩展，**显式传入时透传**；也可由路由 `custom_params` 注入默认值 |
| `image` | 可选；Seedream **图生图 / 多图融合**用 JSON 字符串或字符串数组（URL / data URL），走本 generations 端点，**不是** multipart `/edits` |
| `provider` | 可选；支持 Image 安全价格选择，例如 `{ "sort": "price", "max_price": { "image": 0.05 } }`；只在 Gateway 内使用，不转发上游 |

### 编辑（参考图）

```
POST /v1/images/edits
Authorization: Bearer <USER_API_KEY>
Content-Type: multipart/form-data
```

表单字段：`model`、`prompt`、`n=1`、可选 `size`/`quality`/`background`，以及最多 **5** 个 `image` 文件（`image/png` \| `image/jpeg` \| `image/webp`，单文件 ≤ 20MB）。如需 Provider 价格控制，`provider` 表单字段须为 JSON 对象字符串，例如 `{"sort":"price","max_price":{"image":0.05,"request":0.01}}`；该字段只用于 Gateway 选路，不会进入上游 multipart。

**必须**使用 `Content-Type: multipart/form-data`（含 boundary）。若客户端误发 `application/json` 或其它类型，Gateway 在读 body 前即返回 400 `Unsupported Content-Type for /v1/images/edits…`（不会再误报成 `Missing model`）。Seedream 图生图请走 generations + JSON `image`，不要用本端点。

### 计费与审计

Image 模型支持两种 `pricing_profile.image_billing_mode`（再乘路由 `charged_factor` / `metered_factor`）：

| 模式 | 最终费用 | `pricing_audit.kind` |
|------|----------|----------------------|
| **`token`**（GPT Image / Gemini） | usage 分项 × `$/1M`（对齐 [OpenAI Image Cost](https://platform.openai.com/docs/guides/image-generation)） | `image_tokens` |
| **`per_image`**（Seedream / GLM / Grok） | `output_unit × 确认输出张数 + input_unit × 参考图数` | `image_per_image` |

1. **预检额度**：token 模式用 quality×size **估算** tokens；per_image 模式用请求张数 × 单价；均取全候选路由最高 `charged_factor`。预检只决定能不能打上游，**不**等于最终扣费
2. **成功出图**：token 按 **`usage` 真实分项**；per_image 按 **有效返回图片数**（忽略 usage tokens）
3. **客户端取消 / Gateway 超时**（请求已发出，合成 504）：token / per_image **均零费用**。合成 504 **不** failover
4. **明确上游 4xx/5xx、网络合成 502、空结果**：零费用日志
5. Request log **不**保存 prompt 原文、参考图或 Base64；列含 `billing_kind`、`input_image_count`、`output_image_count`；`raw_usage` / `pricing_audit` 供审计
6. 须配置对应模式目录价；无合法 mode/价格则不计费。详见 [image-models.md](../reference/image-models.md)

`pricing_profile` 示例（`gpt-image-2` **token**，USD/1M）：

```json
{
  "image_billing_mode": "token",
  "tiers": [{
    "upto": null,
    "input_price": 5,
    "output_price": 0,
    "cache_read_price": 1.25,
    "image_input_price": 8,
    "image_input_cache_price": 2,
    "image_output_price": 30
  }]
}
```

短 prompt generations 的费用通常由 **image_output** 主导；edits 会额外计入 **image_input**。

`pricing_profile` 示例（Seedream **per_image**，CNY/张）：

```json
{
  "image_billing_mode": "per_image",
  "image": {
    "default": 0.22
  }
}
```

`uncertain_result_policy` 仍可写入 profile，但取消 / 超时不再按它扣费。

Admin 中为图片模型配置 `output_modalities: ["image"]` 及对应 mode 价目即可。

---

## 语音合成（Audio Speech / TTS）

OpenAI 兼容语音合成入口，支持完整音频响应与流式输出。鉴权、预算、路由与日志沿用用户 API Key 链路；请求入口为 `openai` + `audio.speech`。

```text
POST /v1/audio/speech
Authorization: Bearer <USER_API_KEY>
Content-Type: application/json
```

| 字段 | 说明 |
|------|------|
| `model` | 必填；支持 `id:route_group` 后缀 |
| `input` | 必填；合成文本，最多 4096 个字符 |
| `voice` | 必填；字符串或 `{ "id": "..." }` |
| `response_format` | 可选；`mp3`（默认）/ `opus` / `aac` / `flac` / `wav` / `pcm` |
| `speed` | 可选；`0.25`–`4.0`，默认 `1` |
| `stream_format` | 可选；`audio`（默认）或 `sse` |
| `instructions` | 可选；风格指令，最多 4096 个字符 |

同协议 OpenAI 上游使用 `passthrough`；转到 DashScope SpeechSynthesizer、Qwen-TTS 或 MiniMax 时，必须选择对应的显式 adapter。TTS 计费要求 chosen verified Endpoint 在实际上游 operation 下声明 `audio_capabilities` 的 `characters` + `unicode_code_point` meter；网关以已校验的请求 `input` Unicode code point 数作为权威数量，并应用 Endpoint 的 minimum/increment、request fee、discount 与 Route 倍率。缺失或 operation 不匹配时在 dispatch 前 fail closed。

```bash
curl -sS "$GATEWAY_URL/v1/audio/speech" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-tts-model","input":"你好，cinatoken。","voice":"your-voice"}' \
  --output speech.mp3
```

### DashScope 同步 ASR HTTP 透传

`qwen-audio-3.0-asr-flash` 也可走原生 JSON，不经过 OpenAI multipart：

```
POST /v1/dashscope/services/aigc/multimodal-generation/generation
Authorization: Bearer <USER_API_KEY>
Content-Type: application/json
```

请求/上游都是 `dashscope` + `audio.transcriptions.multimodal`，adapter 必须是 `passthrough`。网关只替换 `model` 为路由里的供应商模型名，返回上游原生 JSON（`output.text` / `usage.duration`）。契约见 [非实时语音识别](https://help.aliyun.com/zh/model-studio/non-real-time-speech-recognition-for-fun-asr-flash)。Qwen3-ASR 与 Qwen-Audio-3.0 同 URL、不同字段，转换链必须用对应 adapter。

### DashScope 原生实时音频

实时 ASR / TTS 使用 WebSocket 入口：

```text
wss://<gateway>/v1/dashscope/realtime?model=<gateway-model>&operation=<operation>
Authorization: Bearer <USER_API_KEY>
```

请求与上游都使用 `dashscope` 协议及同名 operation，事件和二进制音频帧保持原生语义。可用 operation、浏览器子协议鉴权、计费与部署边界见 [DashScope 音频架构](../architecture/dashscope-audio.md)。

---

## 语音转写（Audio Transcriptions）

OpenAI 兼容 Audio Transcriptions API，供桌面 Agent 语音输入等场景调用。鉴权与 Chat 相同（用户 API Key）；模型须配置 **OpenAI 协议**入口路由，且 Route 绑定的 verified Endpoint 必须为实际上游 operation 提供有效 `audio_capabilities`。

```
POST /v1/audio/transcriptions
Authorization: Bearer <USER_API_KEY>
Content-Type: multipart/form-data
```

表单字段：

| 字段 | 说明 |
|------|------|
| `model` | 必填；支持 `id:route_group` 后缀 |
| `file` | 同步转换链必填；音频文件（如 `webm` / `mp3` / `wav` / `ogg` / `m4a`）；Gateway 硬上限约 **25MB** |
| `file_url` | 异步 filetrans（`dashscope-asr-file-async`）必填；公网 HTTP(S)/OSS URL。有 `file_url` 时可不传 `file` |
| `language` | 可选；ISO-639-1（如 `zh`、`en`） |
| `response_format` | 可选；`json`（默认）/ `text` / `srt` / `verbose_json` / `vtt` / `diarized_json`（说话人分离模型） |
| `prompt` / `temperature` | 可选；透传上游 |

### Endpoint 计费与审计

运行时按候选/最终 Route 的**实际上游 operation**读取 `model_endpoints.audio_capabilities.pricing_by_operation`；入口 operation 与 adapter 转换后的上游 operation 不同也不能借用另一项价目。请求日志**不**落音频二进制。

| meter | 当前状态 | 扣费权威 | 费用口径 |
|-------|----------|----------|----------|
| `duration` / `second` | 支持 | 上游明确返回的 duration，或网关成功解析出的媒体/已验证 PCM 时长 | `ceil_to_increment(max(actual, minimum)) × price + request fee`，再应用 Endpoint discount、Route factor 与用户倍率 |
| `characters` / `unicode_code_point` | TTS 支持 | 已校验请求文本的 Unicode code point 数 | 同上；不会依赖供应商可选的 `usage.characters` |
| `tokens` / `token` | Schema 可声明，数据面暂不支持 | 要求五维权威 token breakdown | 当前无法稳定取得所需分项，因此在 dispatch 前返回 502，不会回退到目录价或估算扣费 |

时长预检仅使用可证明的媒体时长或协议硬上限；最终结算只接受权威上游/媒体事实，不再按文件字节猜测时长。缺失 Endpoint、价目、exact operation 或计量事实时 fail closed。`models.pricing_profile` 和 Admin 静态 Audio preset 只用于目录/迁移兼容，不是路由推理的计费权威；旧 Endpoint 的 `audio_capabilities={}` 必须由管理员显式回填并重新核验。

按秒转写 Endpoint 示例见 [Admin Model Endpoints](./admin.md#model-endpointsadminendpoints)。

示例：

```bash
curl -sS "$GATEWAY_URL/v1/audio/transcriptions" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -F model=whisper-1 \
  -F file=@recording.webm \
  -F language=zh \
  -F response_format=json
```

默认 `GET /v1/models` **不含** ASR 模型；列表可用 `kind=audio` / `kind=all`。目录兼容层仍可依据 legacy `pricing_profile.audio_billing_mode` 识别 kind，但真实可调用与可计费性以 Route 绑定的 verified Endpoint exact-operation 能力为准。
---

## 请求预设（Presets）

Preset 把可复用的模型、Provider、工具与生成参数保存为不可变版本。配置存储在网关数据库中；`messages`、`input`、`prompt`、`stream` 以及协议正文不会写入 Preset。

三种引用方式均可用于 `POST /v1/chat/completions`、`POST /v1/messages` 与 `POST /v1/responses`：

```json
{ "model": "@preset/coding", "messages": [{ "role": "user", "content": "hello" }] }
```

```json
{ "preset": "coding", "model": "openai/gpt-5", "messages": [{ "role": "user", "content": "hello" }] }
```

```json
{ "model": "openai/gpt-5@preset/coding", "messages": [{ "role": "user", "content": "hello" }] }
```

请求字段浅覆盖 Preset；`tools` 例外，会按工具身份合并：同名请求工具覆盖预设工具，预设顺序保持不变，请求新增工具追加。Chat、Messages、Responses 的系统提示分别映射到 system message、顶层 `system`、`instructions`，请求显式提供时以请求为准。

“保存配置并执行”的兼容入口：

```
POST /api/v1/presets/{slug}/chat/completions
POST /api/v1/presets/{slug}/messages
POST /api/v1/presets/{slug}/responses
```

也接受 `/v1/presets/{slug}/...`。新 slug 创建 Preset；调用自己已有的 slug 会创建并指定一个新版本。slug 全局唯一，私有 Preset 只有所有者可调用，公开 Preset 可被其他已认证用户显式引用。无权限或不存在统一按 `gateway.preset_not_found` 处理，避免枚举私有资源。

门户 `/account/presets` 使用 CinaAuth 会话管理自己的 Preset；对应控制面 API 是 `/api/user/presets`（列表/创建版本）、`/:id/versions`、`/:id/designate` 与 `PATCH /:id`。管理员在 `/admin/presets` 通过 `/api/admin/presets` 治理全局可见性、状态与指定版本。

## Guardrails 与零数据保留

门户 `/account/guardrails` 可创建不可变版本的 Guardrail，并绑定当前 CinaAuth 用户或其 Gateway API Key。控制面入口是 `/api/user/guardrails`；支持创建、创建新版本、查看历史与绑定、指定历史版本、归档。普通用户只能操作自己的资源和 scope；管理员下发的绑定不能被普通用户覆盖、解绑、改版或归档。

配置支持：

```json
{
  "allowed_models": ["anthropic/claude-sonnet"],
  "allowed_providers": ["Anthropic"],
  "input_filters": [{ "id": "secret", "pattern": "api[_-]?key", "action": "redact" }],
  "output_filters": [{ "id": "internal", "pattern": "internal only", "action": "block" }],
  "budget": { "limit": 100, "period": "monthly" },
  "zdr": { "anthropic": true }
}
```

过滤器使用保守的线性时间正则子集：不允许分组、懒惰量词或无界 `+`/`*`；每个顶层 `|` 分支最多使用一个 `?` 或 `{min,max}`，其中 `max` 不超过 256；固定次数 `{n}` 不超过 4096。需要重复匹配时请使用有界范围，例如 `[a-z]{1,64}@example\\.com`。

用户级与 Key 级策略同时生效：allowlist 取交集，过滤器取并集且 block 优先，预算分别检查，`require_zdr`/模型组 ZDR 取更严格结果。输入过滤发生在上游调用前；非流式输出过滤发生在返回客户端前。流式请求若配置输出过滤会返回 `gateway.guardrail_blocked`，不会先发送未经检查的片段。

调用方也可在 Chat、Messages 或 Responses 请求中显式要求 ZDR：

```json
{ "model": "anthropic/claude-sonnet", "provider": { "zdr": true }, "messages": [] }
```

Gateway 只选择管理员已核验、核验时 Route/Provider trust subject fingerprint 与当前配置精确匹配、证据未过期、保留期为 0、禁止训练且明确支持 ZDR 的具体路由。Provider endpoint/API Key/共享渠道，或 Route 上游模型、协议/operation、adapter、`custom_params` 变化后，旧断言立即失效；缺失 fingerprint 的历史记录也 fail closed。共享渠道会在选路后注入不同用户账号，当前没有逐 shared key 的独立证据，因此要求 ZDR 或 `data_collection=deny` 时一律排除共享渠道路由。没有合规路由返回 `gateway.zdr_no_route`；ZDR 请求携带第三方 `tools` 时返回 `gateway.zdr_tools_unsupported`。公开 `/catalog/models` 的 `data_policy_summary` 只统计 subject 仍匹配且非共享渠道的核验路由，且只包含核验路由数、ZDR 是否可用和最近核验时间，不暴露合同、fingerprint 或内部备注。

---

## 获取当前用户预算状态

获取当前认证用户的预算使用情况。

### 请求

```
GET /v1/me
```

### 响应

```json
{
  "workspace_id": "personal:user-id",
  "budget_max": 100.00,
  "budget_spent": 15.50,
  "budget_period": "monthly",
  "budget_reset_at": "2024-02-01T00:00:00.000Z",
  "billing_currency": "USD",
  "metadata": {
    "plan": "pro",
    "source": "account-service"
  }
}
```

### 字段说明

| 字段 | 类型 | 描述 |
|------|------|------|
| `workspace_id` | string | 当前 Gateway Key 的服务端 Workspace 归属 |
| `budget_max` | number \| null | 预算上限；`null` 表示无限制 |
| `budget_spent` | number | 当前周期已消费金额 |
| `budget_period` | string | 预算周期: `"none"` \| `"daily"` \| `"weekly"` \| `"monthly"` |
| `budget_reset_at` | string \| null | 下次预算重置时间 (ISO 8601) |
| `billing_currency` | string | 计费币种：来自 `system_config.BILLING_CURRENCY` 的 **ISO 4217** 三字码（如 `USD`、`CNY`）；与 `pricing_profile` 单价及本接口预算数值同币；未配置或非法时回退 `USD` |
| `metadata` | object \| null | 优先返回 User metadata，并以 Key metadata 回退或补全（由管理端写入） |

### 示例

```bash
curl http://localhost:8787/v1/me \
  -H "Authorization: Bearer sk-xxx..."
```

> 即使预算已超限，此端点仍然可以访问。客户端可使用此端点显示用户的预算状态。

---

## 注意事项

### 预算控制

如果用户 Key 设置了预算限制（`budget_max`），当累计消费达到或超过预算时，请求将被拒绝并返回 **403** `Budget exceeded`。周期性套餐使用 `budget_period` 为 `daily` / `weekly` / `monthly` 等并由 `budget_reset_at` 驱动重置；**一次性额度**使用 `budget_period = 'none'`，不会在网关内按日历自动“补发”，由上游门户/管理 API 更新 `budget_max` / `budget_base`。

### 定价模型

币种由 **`system_config.BILLING_CURRENCY`** 声明（管理后台 **Gateway Config** 或迁移种子默认 `USD`）。Endpoint 价目、legacy `pricing_profile` 与 `users` 的预算字段均按该币种计量；运行时仍会校验 Endpoint currency 与系统币种一致。

LLM 及 token 模式的价格以每百万 token 为单位（per-million-token pricing）：

```
费用 = (常规输入 * input_price
     + 缓存读取 * cache_read_price
     + 缓存写入 * cache_write_price
     + 输出 * output_price) / 1,000,000
```

- `cache_read_price` 和 `cache_write_price` 默认等于 `input_price`
- Images 当前支持安全的按张/参考图 Endpoint 计价；Audio 支持时长和 Unicode 字符 Endpoint 计价，Audio token 及 Image token/megapixel/variant/font/text 暂时 fail closed；Agent Tools 使用固定按次单价。分别见上文对应章节。
- 路由 **`price_override`** 以 **`charged_factor` / `metered_factor`**（及可选分时 **`schedule`**，窗口可带 ISO `days`）相对 Endpoint 标准价计费；嵌套 `metered`/`charged` tiers 忽略。
- 路由级 **`route_group`** 会写入 `api_key_request_logs` 快照。
  - **`standard_cost`（Endpoint 标准价）**：按 chosen verified Endpoint 的权威价目计算，不乘 Route 倍率
  - **`metered_cost`（供应成本）** / **`charged_cost`（用户扣费）**：Endpoint 标准价 × 有效倍率（无 `schedule.mode` 时叠乘；`override` 时窗内用窗口 factor）。Endpoint discount 只进入用户扣费基数；若用户另有计费倍率，只对 Route 算出的用户扣费再乘一次，供应成本与标准价不变。详见 `docs/developers/reference/streaming-billing.md`
- `users.budget_spent` 仅按最终 `charged_cost` 累加

### 使用量追踪

每次请求会记录到 `api_key_request_logs`，主要包括：

- Token 使用量（输入/输出/缓存读取/缓存写入/推理等）
- `metered_cost` / `standard_cost` / `charged_cost`（目录选档 × 路由倍率；用户扣费再可选乘用户计费倍率；见上）
- `route_group`（请求时选用的路由快照）
- `request_protocol` / `request_operation` 与 `upstream_protocol` / `upstream_operation`
- `model_surface_id`、`route_pool_id`、`route_target_id`、`adapter`、`route_trace`
- 跨模型 fallback 请求在 `route_trace.model_fallback` 中记录 `original_model`、`requested_models`、`final_model`、`fallback_count` 与脱敏 attempts
- 延迟、状态（success/error/incomplete/cancelled 等）
- 原始 usage（`raw_usage`）

### 提供商故障转移

同一 Request Surface 指向一个 Route Pool，Pool 内支持多条 **model_routes** Target（每条指向一个 Provider；**一个 Provider = 一把 `api_key`**）。调度由 `failoverDispatch` + `buildRouteAttemptPlan` 完成；拓扑见 [route-topology.md](../architecture/route-topology.md)，完整分支与场景表见 [proxy-request-lifecycle.md](../architecture/proxy-request-lifecycle.md)。

**排序与 failover**：

- **层**：按 `model_routes.priority` **降序**（数字越大越先试）。
- **同层**：按生效策略排序（默认 **`hash_affinity`**：加权 Rendezvous，利于 prompt cache；另有 `weighted_random` / `weight_priority` / `weighted_round_robin`），权重为 `model_routes.weight`。
- **跳过**：`providers.status = disabled`、无 `api_key`，或处于 **provider 熔断** 的候选不参与本次 attempt。
- **全部不可用**（均熔断）：网关直接返回 **429**，响应体为 `{ "error": { "code": "upstream_capacity_exhausted", ... } }`，并带 `Retry-After`；**不调用上游**。
- **有可试路由时**：按序打上游；可重试失败则换下一 Provider；全部 attempt 失败则返回**最后一次**上游响应。

客户端显式提供 `models` / `fallbacks` 时，完成当前模型内 Provider failover 后可继续尝试下一模型。跨模型切换计入 timing metadata 的 `model_fallback_count`，最终日志与计费归属于实际选中的模型。

**可重试并换 Provider**：上游 `429`、`5xx`、`401`、`403`、网络/`fetch` 失败（524 / fetch 仅同次 failover，不跨请求熔断）。熔断按 **`providers.id`**：429 优先读 `Retry-After` 或递增退避；401/403 约 **5min**；普通 5xx 连续 3 次后约 10s。

**User+model 熔断**（与 provider 熔断独立，按 `userId + modelId`，退避 **20s → 1min → 3min → 5min → 10min**；见 [proxy-request-lifecycle.md](../architecture/proxy-request-lifecycle.md) §2.2）：

- **敏感内容**（上游错误文案命中内容安全关键词）：chat / messages / gemini / images / audio **均**触发；短路 **429** `circuit.sensitive_content`。
- **普通上游 400**：chat / messages / gemini 触发；短路 **400** `circuit.client_error`（回放原文）。**`/v1/images/*`、`/v1/audio/transcriptions` 不记、不短路**普通 400，便于客户端修正尺寸/格式等后立即重试。

**不重试**（立即返回）：`400`、`404` 等请求本身错误；Images 客户端取消 / Gateway 超时合成的 504。

**策略配置**（运维侧，对客户端透明）：Route Pool 可用 `route_pools.strategy` 精确覆盖；其后依次解析 `models.route_policy` 与全局 `system_config.ROUTE_STRATEGY`。解析顺序见 [route-strategies.md](../reference/route-strategies.md)。

用量日志会写入最终选用（或最后失败）的 Surface / Pool / Target，以及 **`provider_key_id`**（= provider id）、**`provider_key_label`**（= provider name）、**`provider_key_fingerprint`**（密钥指纹，不含明文）。

### Route 默认参数合并

<a id="route-默认参数合并"></a>

`model_routes` 支持 route 级默认参数字段 **`custom_params`**（JSON 对象字符串）：可包含协议常规字段（如 `temperature`）与厂商/渠道专有字段（如 `provider_options`、`eca_thinking_config`）。

网关在转发到上游前会进行两层合并（优先级从低到高）：

1. `custom_params`
2. 用户请求体

合并规则：

- 对象：递归深度合并
- 数组：用户传入数组时整体替换默认数组
- 标量：用户值优先
- `model` 始终由 route 的 `provider_model_name` 强制覆盖

示例（`model_routes.custom_params` 列中存放的 JSON 对象；OpenAI 风格）：

```json
{
  "temperature": 0.7,
  "response_format": { "type": "json_object" },
  "provider_options": { "foo": "bar" }
}
```

如果用户请求：

```json
{
  "model": "gpt-4.1",
  "messages": [{ "role": "user", "content": "hi" }],
  "temperature": 0.2
}
```

则最终上游请求中的 `temperature` 为 `0.2`（用户覆盖默认），`provider_options` 会保留。

各厂商 `thinking` / `reasoning` / `reasoning_effort` 等字段的 JSON 形态见 **[渠道模型思考参数配置说明](../reference/provider-thinking-configs.md)**。在 Route 的 `custom_params` 中写入默认值后，客户端未传该字段时会合并进上游请求；客户端显式传入时以客户端为准。
