# Management API

CinaToken 提供 OpenRouter-shaped 的当前 Key 元数据、Gateway Key 管理、私有 BYOK、Workspace 生命周期与成员管理、Workspace 共享预算、Guardrail、Generation Feedback 和 Preset 子集。基地址为 Proxy Worker 的 `/api/v1`。除“Presets”一节明确使用普通 Gateway Key 外，管理资源必须使用账户门户签发的 Management API Key：

```http
Authorization: Bearer sk-cina-mgmt-...
```

Management Key 与推理用 Gateway Key 是两个物理隔离的 principal。前者只存在于 `management_api_keys`，不能完成推理鉴权；后者只存在于 `api_keys`，不能完成 Management 鉴权。两者均只在创建成功响应中返回一次明文，持久层只保存 SHA-256 hash 和安全预览。

## Presets（Gateway Key）

```http
GET  /api/v1/presets?offset=0&limit=50
GET  /api/v1/presets/{slug}
GET  /api/v1/presets/{slug}/versions?offset=0&limit=50
GET  /api/v1/presets/{slug}/versions/{version}
POST /api/v1/presets/{slug}/chat/completions
POST /api/v1/presets/{slug}/messages
POST /api/v1/presets/{slug}/responses
Authorization: Bearer sk-...
```

Preset 接口使用当前用户的普通 Gateway Key，并严格限制在该 Key 的 Workspace。用户可读取自己拥有的 Preset，以及同 Workspace 中处于 active 状态的 public Preset；跨 Workspace、不可见和不存在资源统一返回 404。列表按更新时间倒序分页，版本按版本号升序分页；`offset` 必须为非负整数，`limit` 范围为 1–100。成功和错误响应均设置 `Cache-Control: private, no-store`，`/v1/presets` 提供相同的兼容 alias。

三个 POST 路径是配置捕获接口：它们只创建 Preset 或追加并指定一个不可变版本，然后返回保存后的 Preset；不会执行推理、访问上游或产生模型费用。服务端只持久化经过白名单验证的配置字段与对应协议的 system prompt，并忽略 `messages`、`input`、`prompt`、`stream`、metadata、session、trace 等请求期数据。请求体最多 2 MiB，持久化配置最多 64 KiB，system prompt 最多 32 KiB；嵌套凭据、Authorization、上游 URL、secret 和 token 等键会被拒绝。Preset 配置管理不消耗推理预算，但 Gateway Key 本身仍必须有效且归属当前 Workspace。

当前公开接口尚不提供组织角色驱动的发布治理、跨 Workspace 分享/迁移、归档、回滚或可见性修改；这些操作仍位于现有用户/管理员门户，生产发布前还需完成三数据库和真实 Gateway Key canary。

## 当前 Key 元数据

```http
GET /api/v1/key
Authorization: Bearer sk-... | sk-cina-mgmt-...
```

该只读接口接受两种 Bearer principal，用 `is_management_key` / 兼容字段 `is_provisioning_key` 标识类型；这不会赋予跨权限域能力。Gateway Key 返回真实 total/daily/weekly/monthly `charged_cost` 用量，以及按 BYOK 请求的 Endpoint 目录标准价分别聚合的 `byok_usage*`；同时返回已配置的 `limit`、`limit_reset` 和基于已结算计限用量的 `limit_remaining`。Management Key 的推理用量均为 0，限额字段为 `null`。当前私有 BYOK 采用零网关费过渡策略，因此 `byok_usage*` 仅为估算分析值，不会增加 charged usage；deprecated `rate_limit.requests` 按官方合同返回 `-1`。响应不含明文、hash 或内部 Key ID，并设置 `Cache-Control: private, no-store`。

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
    "byok_usage": 0,
    "byok_usage_daily": 0,
    "byok_usage_weekly": 0,
    "byok_usage_monthly": 0,
    "limit": 25,
    "limit_remaining": 25,
    "limit_reset": "monthly",
    "include_byok_in_limit": false
  },
  "key": "sk-..."
}
```

`key` 只在本次响应中出现。`limit` 接受非负有限数字或 `null`；内部按六位小数精度记账。`limit_reset` 接受 `daily`、`weekly`、`monthly` 或 `null`，其中 `null` 表示从 Key 创建时间开始的 lifetime 上限。日、周、月均在 UTC 边界重置，周周期从星期一开始。推理准入将已结算消费和所有在途 reservation 一并计入，因此并发请求不能突破上限；响应中的 `limit_remaining` 来自同一权威账本的已结算与未预留消费，短暂在途请求不会提前显示为已消费，而结果不可知、已 forfeited 的上界仍被视为消费。`byok_usage*` 按同一 UTC 周期从 `is_byok=true` 请求的 `standard_cost` 聚合，不代表 CinaToken 已扣费用。`include_byok_in_limit` 接受布尔值；为 `true` 时，仅该 Gateway Key 限额按 verified Endpoint 的目录标准价计算私有 BYOK，用量未知时保守保留预留上界。开关变更只作用于变更后准入的请求，不会把当前周期的历史 BYOK 重新分类。BYOK 失败并回退共享/平台容量前，系统在同一请求账本上原子补齐普通收费预算；Workspace 与普通 Guardrail 预算仍不包含成功的私有 BYOK。

`external_user` / `external_api_key` 属于尚未实现的 Connect client-secret principal，使用 Management Key 提交时返回 403。

### 更新与删除

PATCH 当前支持 `name`、`disabled`、`limit`、`limit_reset` 和布尔型 `include_byok_in_limit`：

```json
{"name":"CI","disabled":true,"limit":10,"limit_reset":"weekly"}
```

DELETE 成功返回 `{"deleted":true}`。存在用量历史，或尚未结算的账户预算、Guardrail 预算、Workspace 预算或 Key 限额 reservation 时，硬删除稳定失败；应改用 PATCH `{"disabled":true}`。保留已使用 Key 的脱敏归属行，避免删除 Key 后历史消费脱离 Workspace、继而绕过共享预算。

## 私有 BYOK

```http
GET    /api/v1/byok?workspace_id=...&provider=deepseek&offset=0&limit=50
POST   /api/v1/byok
POST   /api/v1/byok/reorder
GET    /api/v1/byok/{id}
PATCH  /api/v1/byok/{id}
DELETE /api/v1/byok/{id}
Authorization: Bearer sk-cina-mgmt-...
```

所有资源都按 Management Key 的 personal/organization 账户与 Workspace 隔离；跨账户和不存在资源统一返回 404。列表省略 `workspace_id` 时只读取该 principal 的 Default Workspace；显式传入同账户其他 Workspace 才切换范围。列表默认 50 行、最多 100 行，`offset` 上限为 1,000,000，可按小写 Provider slug 精确筛选。请求体最多 192 KiB，凭据最多 64 KiB；每个 Workspace/Provider 最多 100 条 Key，运行时每次请求最多加载 32 条。

创建体支持 `provider`、`key`、`name`、`workspace_id`、`disabled`、`is_fallback`、CinaToken 扩展字段 `always_use_for_matching_models` / `always_use_for_provider`、`allowed_models`、`allowed_user_ids` 与 `allowed_api_key_hashes`。两个共享容量策略互斥，且只允许用于主 Key：前者仅在模型过滤也命中时禁止同 Provider 的共享容量，后者在用户与 Gateway Key hash 过滤命中后忽略模型过滤、对同 Provider 全部模型生效；两者都为 `false` 时允许共享容量。三个 allowlist 各最多 100 项；API Key hash 必须是当前账户所拥有 Gateway Key 的 64 位小写 SHA-256。PATCH 支持除 `provider` 和 `workspace_id` 外的同一组可变字段，且至少提供一项。示例：

```json
{
  "provider": "deepseek",
  "key": "<provider-api-key>",
  "name": "DeepSeek production",
  "workspace_id": "personal:user-id",
  "is_fallback": false,
  "always_use_for_matching_models": true,
  "always_use_for_provider": false,
  "allowed_models": ["deepseek/deepseek-chat"],
  "allowed_user_ids": null,
  "allowed_api_key_hashes": null
}
```

`POST /api/v1/byok/reorder` 是 CinaToken 的 Management 扩展，用于支持 OpenRouter BYOK 门户中的拖拽排序与主/兜底分区切换。请求必须提交指定 Workspace/Provider 当前全部 active Key，按所有主 Key、再所有兜底 Key 的顺序排列：

```json
{
  "workspace_id": "personal:user-id",
  "provider": "deepseek",
  "keys": [
    { "id": "11111111-1111-4111-8111-111111111111", "is_fallback": false },
    { "id": "22222222-2222-4222-8222-222222222222", "is_fallback": true }
  ]
}
```

服务端在一个事务中复验 Management Key、账户与 Workspace，锁定完整 Provider 集合，同时更新 `sort_order` 和 `is_fallback`，并写一条不含凭据的审计事件。请求列表已过期、不完整、包含额外 Key，或尝试把任一共享容量禁止策略仍为 `true` 的 Key 移入兜底分区时，返回稳定 409 `gateway.resource_conflict`，且不做部分写入；后一种情况必须先 PATCH 同时清除两个策略。成功响应回显规范化后的 Workspace、Provider、Key ID、分区与顺序。三种数据库都用事务内的唯一临时 Provider 命名空间规避交换顺序时的唯一索引碰撞，凭据密文不会被读取、解密或重写。

完整 `key` 是 write-only：创建、读取、更新和列表响应均不返回它，只返回末四位安全标签；仓储边界使用 `enc:v2` 密文，删除会清空密文并保留 tombstone。数据面只有在当前 Route 的 verified Endpoint `providerSlug`、模型、Workspace、用户与 Gateway Key hash 全部通过过滤时才注入私有凭据。请求顺序为：所有 Provider 的主 BYOK Key → 允许使用的共享/平台容量 → 所有兜底 BYOK Key；Provider sticky 只在每个分区内调整 Target 顺序，逐凭据 circuit 相互隔离。共享容量分为三档：默认允许；`always_use_for_matching_models=true` 仅在模型、用户和 Gateway Key hash 过滤都命中时跳过同 Provider 共享容量；`always_use_for_provider=true` 是最强策略，在用户与 Gateway Key hash 过滤命中后忽略 `allowed_models`，对同 Provider 全部模型生效。其他 Provider 始终可继续尝试，不会把请求锁死为“全局只能 BYOK”。策略查询按 Provider/模型分别缓存，使用独立、最多 100 条且不读取密文的元数据读取；实际凭据候选也先在完整的最多 100 条 Provider 集合上应用过滤，再截取最多 32 条，避免前 32 条均不匹配时漏掉后续合法 Key。若任一凭据或策略查询、读取、解密失败，数据面对该 Provider 的共享/平台容量失败关闭，避免意外产生平台费用。

普通用户可在 `/account/byok` 通过 CinaAuth 会话调用 `/api/user/byok` 的同等 CRUD/reorder 子集；服务端把 personal owner 或显式映射的 organization admin 固定到当前 Workspace，并复用本节的加密仓储、write-only Secret、原子排序与审计合同。当前仍不支持 Azure/AWS/Vertex 等结构化多字段凭据。严格 `zdr=true` 或 `data_collection="deny"` 请求暂不注入私有 BYOK，因为现有合规证据绑定 Route + 平台 Provider 账户，不能复用于用户私有账户；待建立逐私有凭据的证据主体后才能安全开放。计费当前按零网关费处理，保留目录价分析但不扣用户或供应商账本；仅当 Gateway Key 的 `include_byok_in_limit=true` 时，目录价计入该 Key 自身限额，Workspace 与普通 Guardrail 预算仍排除成功的私有 BYOK。这不是 OpenRouter BYOK 费率或 entitlement 的完整对等实现。三库迁移合同和本地运行时测试已通过，但本节新增策略与普通用户门户尚未完成生产迁移、Cloudflare 部署及真实会话验收；2026-09-03 的 DeepSeek 官方 Route canary 返回 HTTP 200，只证明上游连通性，不证明尚未部署的 BYOK 策略。

## Workspace 生命周期与成员

```http
GET    /api/v1/workspaces?offset=0&limit=50
POST   /api/v1/workspaces
GET    /api/v1/workspaces/{id_or_slug}
PATCH  /api/v1/workspaces/{id_or_slug}
DELETE /api/v1/workspaces/{id_or_slug}

GET  /api/v1/workspaces/{id_or_slug}/members?offset=0&limit=50
POST /api/v1/workspaces/{id_or_slug}/members/add
POST /api/v1/workspaces/{id_or_slug}/members/remove
```

所有路径只在当前 Management principal 的 personal/organization 账户内解析；跨账户与不存在资源统一为 404。列表分页单次最多 100 行。创建要求 `name` 为 1–100 字符，`slug` 为最多 50 字符的小写字母数字连字符段，`description` 最多 500 字符。创建与更新可持久化 `default_text_model`、`default_image_model`、`default_provider_sort`（`price | throughput | latency | exacto`）和 `io_logging_sampling_rate`。尚未有真实产品后端的 `io_logging_api_key_ids` 只能是 `null`，三个 logging/broadcast/data-discount 开关只能是 `false`；服务端会拒绝虚假的启用值，不会静默接受。

Workspace 请求体上限 32 KiB，成员批量请求体上限 64 KiB，且都必须使用 `application/json`。成员请求只接受：

```json
{"user_ids":["cinaauth-subject-1","cinaauth-subject-2"]}
```

每批 1–100 个不重复 CinaAuth subject，必须全部是当前组织的 active member，否则整批不写入。自定义组织 Workspace 使用显式成员关系；Default Workspace 的成员来自组织投影，是隐式成员，不能通过 Workspace API 移除。个人 Workspace 列表只投影个人 owner，并固定返回 `admin`。组织角色依据部署变量 `CINAAUTH_ORGANIZATION_ADMIN_ROLES` 实时映射为 `admin`，未匹配或配置非法时 fail closed 为 `member`；持久成员行不会缓存管理员角色，避免角色撤销后残留权限。成员增删和 Workspace CRUD 都写脱敏审计事件。

有 active Gateway Key 的成员不能从该 Workspace 移除；有任意 active Gateway Key 的 Workspace 不能删除。Default Workspace 还要求查询参数 `confirm_default_workspace_deletion=true`。确认删除后，服务端先级联清理 Workspace 子资源，再保留 archived deterministic tombstone，防止 CinaAuth lazy provisioning 在下一次登录时无意复活已确认删除的 Default Workspace。

当前 CinaAuth 投影尚未携带“此成员由 SCIM 管理”的权威标记，因此无法单独识别并阻止 SCIM-managed member 的显式 Workspace 移除；在该标记、同步传播与端到端审计完成前，不应把成员接口声明为完整 SCIM 对等。生产启用前仍须在目标 D1/PostgreSQL/MySQL 上完成 Management Key、账户隔离、成员角色撤销、并发删除和真实 CinaAuth subject canary。

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

## Guardrail 与分配

```http
GET    /api/v1/guardrails?workspace_id=...&offset=0&limit=50
POST   /api/v1/guardrails
GET    /api/v1/guardrails/{id}
PATCH  /api/v1/guardrails/{id}
DELETE /api/v1/guardrails/{id}

GET  /api/v1/guardrails/assignments/keys
GET  /api/v1/guardrails/assignments/members
GET  /api/v1/guardrails/{id}/assignments/keys
POST /api/v1/guardrails/{id}/assignments/keys
POST /api/v1/guardrails/{id}/assignments/keys/remove
GET  /api/v1/guardrails/{id}/assignments/members
POST /api/v1/guardrails/{id}/assignments/members
POST /api/v1/guardrails/{id}/assignments/members/remove
```

CRUD 与列表严格限定在 Management Key 的 personal/organization 账户及其 active Workspace 内；跨账户和不存在资源统一返回 404。每个账户有一条不可分配的 `Account Default`，作为策略上限自动继承到该账户全部 Workspace；每个 Workspace 另有一条 `Workspace <workspace-id> Default` 自动作用于该 Workspace 全部流量。迁移、账户/Workspace 创建和懒加载会幂等补齐两类默认策略。二者可通过 PATCH 更新内容并产生不可变新版本，但不能改名、删除、归档或绑定到 Key/成员。Account Default 只允许模型/Provider 允许与忽略列表、按 Provider 分组的 ZDR 和 `data_collection="deny"`，明确禁止预算、内容过滤与宽松训练/发布字段；Workspace Default 与普通 Guardrail 还支持自定义正则 block/redact、确定性内置输入检测和 daily/weekly/monthly Guardrail 预算。`content_filter_builtins` 采用 `{ "slug": "...", "action": "..." }`：`secrets`、`email`、`phone`、`ssn`、`credit-card`、`ip-address` 支持 `block | redact`，`regex-prompt-injection` 支持 `block | redact | flag`。`secrets` 覆盖 OpenRouter 文档列出的 33 种可识别格式，redact 使用 `[SECRET:<format-id>]`。普通 Guardrail 更新采用版本化 CAS，删除级联清理版本和分配；所有实际写入均记录脱敏审计事件，受保护的默认策略删除失败不会写入虚假删除审计。若删除的 Workspace 是 Account Default 的存储锚点，系统会先原子迁移到同账户另一 active Workspace；没有替代 Workspace 时拒绝删除，防止策略被级联丢失。

Key 分配体为 `{"key_hashes":["64位SHA-256"]}`，成员分配体为 `{"member_user_ids":["cinaauth-subject"]}`，每批 1–100 个，成员写入只对组织账户开放。Key 或成员最多绑定一个 Guardrail；再次分配会原子替换当前 Guardrail，但保持内部 assignment ID 稳定，避免预算窗口身份漂移。分配返回 `{"assigned_count":n}`，移除返回 `{"unassigned_count":n}`；不存在或跨账户的目标不会泄露，只计入未成功数量。列表返回 OpenRouter 字段，并支持 `offset`/`limit` 分页。

Management API 分配使用独立的 `management_source` 和 `assigned_by_user_id` 保存来源及操作者，同时继续令 `created_by_user_id=NULL` 作为“普通用户不可覆盖”的既有保护标记。D1 使用原子 batch，PostgreSQL/MySQL 按稳定顺序锁定 Guardrail、目标和现有 assignment 后 UPSERT；三库都在写事务内复验 Management Key、账户、Workspace 和操作者状态。

内置检测在上游调用前扫描受支持的请求文本字段（包括嵌套 tool arguments）；跨分配的同一 slug 按 `block > redact > flag` 合成。`flag` 只写脱敏审计事实和 Router Metadata pipeline，不修改输入；审计不保存命中的原文。`secrets` 使用有界、确定性的格式识别，不把裸 32/64 位十六进制、UUID、通用哈希或普通高熵字符串当作秘密；`person-name`、`address` 仍需要尚未接入的外部 NLP 检测器，因此会明确返回 400。BYOK 预算、限制训练或公开发布等尚无数据面强制证据的字段也会明确返回 400，不会被静默保存为虚假策略。

## Generation Feedback

```http
POST /api/v1/generation/feedback
Authorization: Bearer sk-cina-mgmt-...
Content-Type: application/json
```

请求体遵循 OpenRouter 的结构化反馈合同：

```json
{
  "generation_id": "gen-...",
  "category": "incorrect_response",
  "comment": "The model repeated the same paragraph three times."
}
```

`category` 必须是 `latency`、`incoherence`、`incorrect_response`、`formatting`、`billing`、`api_error` 或 `other`；`comment` 可省略，存在时必须是最多 1000 个 Unicode 字符的字符串。请求体最多 8 KiB，必须使用 `application/json`。成功响应为：

```json
{"data":{"success":true}}
```

服务端使用单条参数化 `INSERT … SELECT` 同时核验 Generation、Workspace 与当前 Management Key 属于同一 personal/organization 账户。组织 Management Key 可反馈该组织 Workspace 中任一成员产生的 Generation；个人 Management Key 只能反馈个人 Workspace 中账户所有者产生的 Generation。不存在、格式非法或跨账户的 Generation 统一返回 404，反馈内容和数据库错误不会进入公开错误响应。`/v1/generation/feedback` 作为兼容 alias 同样可用。

部署前必须将迁移链应用到 D1 `0068_batch_jobs.sql`、PostgreSQL `0067_batch_jobs.sql` 或 MySQL `0064_batch_jobs.sql`（其中已包含 Generation feedback、Guardrail 分配来源、Workspace Default、Account Default、provider-attempt availability、公开模型总 Token 聚合、Generation service tier、终止原因、请求头、最终上游计时、Provider 原生 Token 分项、私有 BYOK 表、三档共享容量策略、route-selective Key 限额结算、Workspace 预算用量索引及尚未开放的 Batch 元数据/请求项账本）。反馈功能只保存用户主动提交的 category/comment，不会开启或推断完整请求/响应正文留存。

## Analytics Query API

```http
GET  /api/v1/analytics/meta
POST /api/v1/analytics/query
Authorization: Bearer sk-cina-mgmt-...
```

两个端点只接受 Management Key；合法普通 Gateway Key 返回 403，缺少、无效或已撤销凭据返回 401。查询的账户范围完全取自已认证 Management principal：个人账户只读取账户 owner 在其 active personal Workspace 中产生的记录；组织账户读取该组织所有 active Workspace 的成员记录。请求体不能提交或覆盖账户边界，跨账户 Workspace/Key 即使作为过滤值出现也只会返回空集合。

`GET /meta` 是当前部署可用能力的权威发现接口，返回 `metrics`、`dimensions`、`operators` 与 `granularities`。当前实现的指标为：

- 数量：`request_count`、`tokens_total`、`tokens_prompt`、`tokens_completion`、`reasoning_tokens`、`cached_tokens`、`byok_request_count`；
- 金额：`total_usage`、`credits_usage`、`openrouter_usage`（兼容字段名，含义为 CinaToken 平台 Credits 用量）、`byok_usage`、`byok_fees`、`usage_upstream`；
- 性能/比率：`avg_latency`、`cache_hit_rate`。

`total_usage` 为非 BYOK 的实际 charged cost 与 BYOK verified Endpoint 标准目录价之和；`credits_usage` 是实际平台扣费；当前零网关费 BYOK 策略下 `byok_fees` 固定为 0。`usage_upstream` 为网关供应商 metered cost。数量指标按 OpenRouter 分析客户端的兼容约定返回十进制字符串，金额、延迟和比率返回数字。

当前维度为 `model`、`provider`、`api_key_id`、`user`、`workspace`、`app`、`generation_id`、`session_id`、`finish_reason`、`service_tier` 与 `is_byok`。其中 Key、用户和 Workspace 在响应中解析为名称/邮箱；`app` 使用请求进入时已去掉 path、query、fragment 和 URL credential 的 `HTTP-Referer` origin 快照；无 Session 的请求归入 `none`。过滤仍使用底层稳定值：`api_key_id` 只接受 `GET /api/v1/keys` 返回的 64 位小写 hash，`user` 使用内部 CinaAuth-backed user ID，`workspace` 使用 Workspace ID。

查询示例：

```json
{
  "metrics": ["request_count", "total_usage", "tokens_total", "cache_hit_rate"],
  "dimensions": ["model", "provider"],
  "granularity": "day",
  "filters": [
    { "field": "workspace", "operator": "eq", "value": "organization:org-id" }
  ],
  "order_by": { "field": "total_usage", "direction": "desc" },
  "time_range": {
    "start": "2026-08-01T00:00:00Z",
    "end": "2026-09-01T00:00:00Z"
  },
  "limit": 100,
  "group_limit": 31
}
```

请求最多两个维度、二十个过滤器，每个 `in`/`not_in` 最多一百个值，`limit` 与 `group_limit` 范围为 1–10000。过滤操作符为 `eq`、`neq`、`gt`、`gte`、`lt`、`lte`、`in`、`not_in`；`include_unset` 只对集合操作符有效。UTC 时间戳必须包含秒，结束时间为排他上界；省略时间范围时查询最近七天。普通查询最多 365 天；Provider、App、Generation、Session、finish reason、service tier 或平均延迟查询最多 31 天；minute 粒度最多三小时。请求体必须是最多 64 KiB 的 `application/json`。未知字段、未在 `/meta` 出现的指标/维度、分类器字段以及非法范围都返回 400，而不会被静默忽略。Cloudflare Workers 使用独立绑定按 Management Key 执行 64 次/分钟的查询限流；达到限制返回 429 和 `Retry-After: 60`，限流器异常时 fail closed，不执行数据库查询。

响应保持 OpenRouter 的双层 `data` 包装，并始终 `Cache-Control: private, no-store`：

```json
{
  "data": {
    "data": [
      {
        "date__day": "2026-08-31T00:00:00.000Z",
        "model": "deepseek/deepseek-chat",
        "provider": "DeepSeek",
        "request_count": "42",
        "total_usage": 0.125
      }
    ],
    "metadata": {
      "query_time_ms": 8,
      "row_count": 1,
      "truncated": false
    }
  }
}
```

D1、PostgreSQL 与 MySQL 共用 allow-list SQL builder，所有值均参数化；MySQL 查询连接在执行前固定为 UTC，三库的小时、日、周（周一开始）与月时间桶都输出 UTC。查询以 `limit + 1` 检测结果截断；调用方必须在 `metadata.truncated=true` 时缩小范围或提高上限，不能把部分结果当作完整总额。

## 当前明确不支持

- Connect client secret、`external_user` 与 `external_api_key`；
- BYOK 结构化云凭据和逐私有凭据合规证据；Guardrail 发布/回滚/跨 Workspace 分享、Preset 发布治理、Routing、Observability 与 Credits 资源，以及 SCIM-managed membership 的权威识别；
- `GET /api/v1/generation/content`；完整输入/输出读取必须先实现 Workspace 显式 opt-in、API Key 过滤、加密隔离存储、保留/删除策略和组织管理员访问控制，现有脱敏 request log 不会被当作内容存储；
- Analytics 的国家、外部用户、模型 variant、上下文长度分桶、分类器维度/过滤器、延迟与吞吐分位数和完整导出；这些字段不会出现在 `/api/v1/analytics/meta`，提交时返回 400；

Workspace DTO 中的 `include_byok_in_budgets` 固定返回 `false`，不是一个可写的 Budget 字段。Workspace shared spend budget 只统计消耗平台 Credits 的请求；使用自有 Provider Key 且不产生平台费用的 BYOK 请求不计入，只有 Gateway Key 自身的 `include_byok_in_limit` 可以选择按目录价约束这类请求。该边界与 OpenRouter 当前的 [Workspace Budgets](https://openrouter.ai/docs/guides/features/workspaces/workspace-budgets) 合同一致。

这些字段不会被静默忽略。Gateway Key 限额与 Workspace 共享预算已经复用统一的并发 reservation/settlement 账本，并在 D1、PostgreSQL 与 MySQL 的事务边界内复验 Key/Workspace 状态、配置版本和限额。
