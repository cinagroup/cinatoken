# Cloudflare AI Gateway 多出口数据平面架构 V2.1

> 架构版本：V2.1\
> 文档状态：设计基线；Phase 0 安全只读部分已完成，尚未授权实施\
> 核对日期：2026-09-02\
> 适用场景：对外 SaaS AI 网关和 OpenRouter 类共享凭据平台，兼顾 ZDR、统一计费、海量 BYOK/共享凭据、故障逃逸、流式请求和可审计计费\
> 控制与数据面：OctaFuse\
> 可选存储：D1、PostgreSQL、MySQL；若使用 PlanetScale，须明确选择 Postgres 或 Vitess/MySQL 产品线

## 1. V2.1 结论

V2.1 保留三种上游出口，但不再把它们定义为固定的合规层级：

| 出口 | 传输方式 | 计费方式 | 是否天然 ZDR | 主要作用 |
| --- | --- | --- | --- | --- |
| Cloudflare Unified Billing | Cloudflare AI Gateway | Unified Billing | 否；必须逐供应商、模型和证据验证 | 优先统一账单与可用的 ZDR 路由 |
| Cloudflare BYOK | Cloudflare AI Gateway provider-native endpoint | BYOK | 否；取决于厂商合同、账号和端点 | 替代凭据与计费路径 |
| Provider Direct | OctaFuse 直连厂商 | 厂商直付 | 否；取决于厂商合同、账号和端点 | 绕过 AI Gateway 的独立出口 |

V2.1 的核心决策是：

1. **先做合规资格过滤，再做可用性和成本排序**；
2. **合规能力绑定到具体 Route Target 及其证据，不绑定到 UB/BYOK/direct 标签**；
3. **按故障域决定下一跳，不再无条件执行 `UB → BYOK → direct`**；
4. **任何非 ZDR 降级必须在请求发出前已有租户授权，事后响应头不能替代授权**；
5. **预算预留、结算和调整必须耐久化，不能用内存或 KV 余额作为权威账本**；
6. **上游结果未知、收到成功响应头或开始向客户端输出后，禁止跨目标重放**；
7. **复用 OctaFuse 现有路由池、ZDR 证据、请求日志和原子预算机制，不另建平行数据面**；
8. **Cloudflare Secret Store 只保存少量基础设施根秘密，不为每个用户或上游 Token 创建一个 secret**；
9. **海量 Gateway Key 只存不可逆摘要；海量 BYOK、共享 Key 和平台上游凭据进入 Credential Vault，以信封加密保存**；
10. **路由热路径只查询 Top-K 凭据元数据、原子取得一把 lease，并只解密最终选中的凭据，禁止全池加载、全池解密和全池展开**；
11. **高保障路径由 Key Broker 持有短时明文并直接发起上游请求，全球边缘 Worker 不获得任意凭据的批量解密能力**。

V2.1 相对 V2.0 的主要变化，是把“Secret 管理”提升为独立的可扩展凭据控制面。Cloudflare 当前账号级 Secret Store 额度为 100，且 Worker 变量/secret binding 也有单 Worker 上限；即使未来可申请提额，逐 Token 绑定、部署和轮换仍不适合作为共享平台的凭据模型。

## 2. 目标与非目标

### 2.1 目标

- 为 `zdr_required` 请求提供可证明、可过期、可撤销的 ZDR 路由资格；
- 在符合租户政策的候选中优先 Unified Billing，并在故障时安全切换；
- 区分 AI Gateway、Cloudflare 账号、厂商账号、模型和本地出口等故障域；
- 防止 POST/SSE 请求因不安全重放造成重复生成和重复计费；
- 保持高并发下预算不超卖、结算可幂等、偏差可追溯；
- 支持 Workers 与 Node 两种运行时，但明确各自数据库和后台任务边界；
- 支持从数百到百万级 Gateway Key、BYOK 和共享上游凭据增长，而不让 Cloudflare secret 数量随租户或凭据数量线性增长；
- 把凭据选择、租约、解密、轮换、吊销、上游账号故障域和合规证据纳入统一数据模型；
- 允许通过灰度、影子流量、故障注入和对账逐阶段上线。

### 2.2 非目标

- 不承诺依靠堆叠 AI Gateway 实例绕过账号级或模型级限速；
- 不把 Cloudflare 配置开关视为完整的法律或合同合规证明；
- 不在一次已开始输出的 SSE 中拼接另一个供应商的续流结果；
- 不承诺仅靠 AI Gateway 日志或 token 估算实现财务级对账；
- 不用多 Cloudflare 账号、复制 Provider 或堆叠 Gateway 作为突破 Secret Store/供应商限额的常规方案；
- 不使用共享 Token 池规避上游供应商的账号限额、转售条款、地域限制或风控策略；
- 不在 V2.1 设计阶段修改现有代码、数据库或生产 Cloudflare 配置。

## 3. 必须成立的架构不变量

### 3.1 合规不变量

1. 未知证据等同不合格，`zdr_required` 必须 fail closed；
2. ZDR 证据必须绑定：供应商、上游模型、端点、凭据主体、账号/项目、区域、请求协议和关键配置指纹；
3. 任何影响上述主体的变更都使旧证据立即失效；
4. ZDR 与日志留存是两个独立控制面，二者必须分别验证；
5. 客户端不得通过自带 `cf-aig-*`、provider authorization 或 alias 头改变服务端合规决策；
6. DLP、Guardrail、缓存和 Logpush 都属于数据处理链的一部分，必须纳入租户政策和子处理方清单；
7. 共享凭据不能继承另一个 Provider 账号的 ZDR/数据留存证据；每个 credential subject 必须独立绑定账号、项目和合同证据。

### 3.2 凭据不变量

1. 客户调用 OctaFuse 的 Gateway Key 只保存 Hash/HMAC 和安全预览，服务端不得保留可恢复明文；
2. 上游 BYOK、共享 Key 和平台运营 Key 只以应用层密文持久化，数据库加密 at rest 不能替代信封加密；
3. Cloudflare Secret Store 不随租户数、Gateway Key 数或上游 credential 数增长，只保存 KMS/Broker 鉴权、签名/pepper 和少量基础设施 secret；
4. 调度器只能读取凭据元数据；只有最终获 lease 的 credential 才能进入解密路径；
5. 明文不得出现在数据库、缓存持久层、日志、trace、错误、队列、Logpush、前端状态或管理 API 响应；
6. CMK/KEK、DEK、credential 和 lease 都必须版本化；轮换、吊销和 rewrap 可审计且不中断其他凭据；
7. Key Broker/KMS 不可用时 fail closed，不允许退回数据库明文、环境变量批量 Token 或旧的全池解密路径；
8. 401/403 只隔离已归因的 credential；429 必须区分 credential、provider account 和 provider 故障域，不通过轮换 Token 规避供应商政策。

### 3.3 计费不变量

1. 在首个上游 dispatch 前完成耐久预算预留；
2. 一个请求 ID 只能有一个最终结算结果，重复回调必须幂等；
3. 结果未知或成功后 usage 缺失时，按预留上限保守结算；
4. 对账不能覆盖或改写历史账本，只能追加调整记录；
5. 供应成本、Cloudflare 服务费、目录标准价和用户实收必须分开记录；
6. 内存队列、KV、指标系统和 Logpush 都不是财务权威数据源。

### 3.4 重放不变量

出现下列任一条件后，禁止切换到另一个上游目标：

- 已收到成功响应头；
- 已向客户端写出任何响应字节；
- 驱动判断请求可能已被厂商接受，但未能确认结果；
- 客户端取消；
- 请求使用不可跨厂商迁移的状态句柄，例如不可路由的 `previous_response_id`；
- 模态或厂商操作不具备安全幂等语义。

## 4. 逻辑架构

```text
客户端
  │
  ▼
OctaFuse API 数据面
  ├─ 鉴权、Workspace/租户政策合并
  ├─ 请求级成本上限与耐久预算预留
  ├─ 合规资格过滤
  ├─ Route/Fault-domain attempt plan
  ├─ Credential metadata Top-K + 原子 lease
  └─ 协议驱动与流式边界
        │
        ├─ Credential Vault（密文 + wrapped DEK + 状态）
        ├─ Key Broker / KMS（仅解密最终选中的一把）
        │
        ├─ Cloudflare Unified Billing Targets
        ├─ Cloudflare BYOK Targets
        └─ Provider Direct Targets
  │
  ▼
原子结算 + 请求日志 + Attempt 事实 + Outbox
  │
  ├─ 异步指标/告警
  ├─ Cloudflare/厂商账单对账
  └─ 长期归档与审计
```

OctaFuse 控制台仍负责管理模型、Provider、Route Target、租户策略和证据；Proxy 是真正执行鉴权、预算、选路、出站和结算的数据面。Credential Vault 是凭据权威数据源，Key Broker 是受控解密与可选 direct dispatch 边界，两者都不能形成绕开现有 Route Pool、预算和账本的第二套路由系统。三种出口仍作为同一 Route Pool 中的不同 Target 类型存在。

## 5. Route Target 属性模型

每个可调度 Target 至少需要以下逻辑属性。字段名为设计语义，不代表已经确定数据库列名。

```text
transport:
  cloudflare_ai_gateway | provider_direct

billing_mode:
  unified | byok | provider_direct

data_policy_class:
  zdr_verified | non_zdr_verified | unknown

payload_logging_policy:
  disabled | metadata_only | payload_allowed

failure_domain:
  cf_ai_gateway:<account>
  cf_gateway:<gateway_id>
  provider_account:<provider>:<account_ref>
  credential_broker:<broker_or_region>
  credential_kms:<key_domain>
  direct_egress:<cluster_or_region>

credential_ref:
  可选的 Credential Vault 不可逆凭据 ID；Unified Billing 使用 Cloudflare 托管主体引用

credential_delivery:
  cloudflare_managed | cloudflare_stored_alias | request_header | broker_dispatch

credential_subject:
  owner、provider、上游账号/项目、区域和 key version 的稳定指纹

policy_evidence_id:
  指向已审核、未过期且主体指纹匹配的证据
```

其他调度属性包括：

- `priority`、`weight` 和层内策略；
- 支持的公开协议、operation、上游协议和 adapter；
- 区域、数据驻留和网络出口；
- 可用的定价证据与价格版本；
- 是否支持安全重试、厂商幂等键和最大请求体；
- 是否允许缓存、DLP、Guardrail 或工具调用；
- 账号级、模型级和 Target 级容量上限。

## 6. 租户政策模型

### 6.1 合规级别

| 模式 | 合格 Target | 非 ZDR 降级 | 无候选时行为 |
| --- | --- | --- | --- |
| `zdr_required` | 仅 `zdr_verified` 且 payload logging 合规 | 禁止 | 返回策略型不可用错误 |
| `zdr_preferred` | 优先 `zdr_verified` | 仅租户已显式授权时允许 | 按授权决定拒绝或降级 |
| `zdr_not_required` | 允许已验证的非 ZDR Target | 允许 | 按可用性策略处理 |

`zdr_preferred` 的授权必须包含版本、操作者、适用 Workspace/Key、允许的供应商/区域、有效期和审计时间。不能把“客户端收到 `X-Upstream-Tier`”视为授权。

### 6.2 政策合并

有效政策按最严格结果合并：

```text
Account Default
  ∩ Workspace Default
  ∩ User Policy
  ∩ Gateway Key Policy
  ∩ Request-level narrowing
```

请求只能进一步收紧，不能通过请求参数放宽账户或 Workspace 的政策上限。

## 7. 路由与降级状态机

### 7.1 请求阶段

1. 生成服务端 `request_id` 和 trace；
2. 鉴权并计算有效租户政策；
3. 解析 Request Surface、Route Pool 和候选 Target；
4. 根据模型、operation、区域、ZDR 证据、日志策略、价格证据和租户授权过滤候选；
5. 根据请求最大成本完成耐久预算预留；
6. 按 priority、故障域、近期健康、限速水位、性能和成本生成 attempt plan；
7. 对需要动态凭据的 Target，仅查询合格 credential metadata Top-K，并原子取得一个短期 lease；
8. 将 request ID、Target、credential 和政策版本绑定后，请求 Key Broker 解密或代发；
9. 执行有界尝试；
10. 返回或流式转发结果；
11. 原子写入结算、请求日志、attempt 和 credential lease 事实；
12. 异步发布指标、告警和对账 outbox。

### 7.2 Attempt 预算

默认设计建议采用以下上限，最终数值必须经压测校准：

- 总上游 dispatch 不超过 3 次；
- 跨计费方式或故障域切换不超过 1 次；
- 单个 Target 不在同一请求中重复 dispatch；
- 每次尝试必须受请求绝对 deadline 约束；
- 客户端显式禁止 fallback 时只允许 1 次 dispatch；
- streaming 的 TTFT 超时只在尚未收到成功响应头时允许下一次尝试。

这些是防止尾延迟和重复计费的安全上限，不是容量扩展机制。

### 7.3 错误分类

| 分类 | 示例 | 是否可换 Target | 熔断范围 | 说明 |
| --- | --- | --- | --- | --- |
| 调用方错误 | 400、参数缺失、模型不存在 | 否 | 不熔断上游 | 原样返回稳定错误码 |
| 租户策略拒绝 | 无合格 ZDR Target、未授权非 ZDR | 否 | 不熔断上游 | 与基础设施 503 区分 |
| 本地预算拒绝 | 预算不足、预留失败 | 否 | 不熔断上游 | 必须发生在 dispatch 前 |
| 凭据控制面拒绝 | 无合格 credential、lease 冲突、政策不匹配 | 可重新选一把，但不得越过政策 | credential pool | 发生在解密/dispatch 前 |
| Key Broker/KMS 故障 | Broker 不可达、unwrap 超时、key version 未知 | 仅可换独立 Broker/KMS 故障域 | broker/KMS | 禁止回退为数据库明文或全池解密 |
| Gateway 实例容量 | 已确认属于单 gateway 的 UB 429 | 是 | `cf_gateway` | 可换另一 gateway |
| Cloudflare Spend Limit | AI Gateway spend limit 429 | 视租户政策 | gateway/规则维度 | 不能按普通厂商 429 处理 |
| Cloudflare 账号余额/鉴权 | 经实测确认的错误码与 body | 视租户政策 | Cloudflare account | 不依赖假设的 402 |
| 厂商账号限流 | Provider 429、账号配额 | 是 | provider account | 换同账号 gateway 无效 |
| Target 凭据失败 | 401/403 且已归因到凭据 | 是，但仅限其他凭据主体 | credential/target | 高优先级告警 |
| 上游 5xx | 明确未成功接受 | 是 | target/provider | 遵守 attempt 上限 |
| 连接前失败 | DNS/TLS/连接建立失败 | 是 | transport/target | 必须能证明未 dispatch 成功 |
| 结果未知 | 写出请求后连接断开、无法确认接受状态 | 否 | target/provider | 保守结算，禁止重放 |
| 已开始 SSE 后断流 | stream error、idle timeout | 否 | target/provider | 返回流错误并记 incomplete |
| 客户端取消 | downstream abort | 否 | 不记为供应商故障 | 尝试有限 drain 获取 usage |

分类必须优先使用稳定错误码、响应头和已解析的产品错误结构，不允许只依靠 HTTP 状态码。

### 7.4 故障域跳转

线性 `UB → BYOK → direct` 只是一种候选顺序，不是固定状态机：

- 单个 UB gateway 限速：优先切换同一模式的另一 gateway；
- Cloudflare AI Gateway 级故障：直接跳过所有 Cloudflare BYOK Target；
- Provider 账号级限速：不得通过同账号下的另一个 gateway 假装恢复容量；
- Provider 区域故障：可切换到政策允许的其他区域或厂商；
- direct 出口集群故障：可切换另一独立 egress cluster；
- 所有跳转都必须重新执行合规资格检查。
- Credential 级 401/403：吊销或隔离该 credential，不影响独立账号；
- Provider account 级 429：同一账号下的其他 credential 不得被当作独立容量；
- Key Broker/KMS 故障：只允许切换预先配置且密钥域独立的 Broker/KMS，不得把边缘 Worker 提升为批量解密器；

## 8. SSE 与长请求规则

1. TTFT timeout 只约束成功响应头/首个响应片段到达前的等待；
2. 一旦开始向客户端输出，后续 idle timeout 只能中止当前流，不得换上游续流；
3. 每次准备换 Target 前必须取消并释放旧 response body；
4. 客户端断开后，可在有限 drain 窗口内只读上游 usage，不再向客户端写数据；
5. usage 缺失、断流、取消或超大响应均进入保守结算；
6. 对 Responses、Messages、Gemini、Images、Audio 分别定义可重放边界，不能只按 Chat SSE 推断；
7. 不向客户端承诺跨厂商流式内容语义连续性。

现有流式计费和取消语义参见 [streaming-billing.md](../reference/streaming-billing.md)。

## 9. Cloudflare AI Gateway 规划

### 9.1 当前需要持续核验的产品事实

截至核对日期，官方文档给出的主要限制包括：

- 付费账号最多 20 个 AI Gateway；
- Unified Billing 为每 gateway 200 requests / 60 seconds；
- BYOK 不受上述 Unified Billing gateway 限额；
- Logpush jobs 每账号最多 4 个；
- Secret Store 免费和付费计划通常为每账号 100 个 secret，但应通过 quota API 读取实际额度；
- Workers Paid 单 Worker 的变量/secret binding 仍有上限，因此 Secret Store 提额也不能把逐 Token 绑定变成可扩展方案；
- Unified Billing ZDR 当前只明确支持部分供应商，且不支持时可能使用普通非 ZDR 配置；
- ZDR 不会自动关闭 AI Gateway 日志。

权威链接：

- [AI Gateway Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
- [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Secrets Store account-level limits](https://developers.cloudflare.com/changelog/post/2025-05-19-paygo-updates/)
- [Secrets Store access control](https://developers.cloudflare.com/secrets-store/access-control/)

所有额度都必须视为外部配置事实，定期通过 API 或受控探针验证，不能永久硬编码进代码或容量文档。

### 9.2 凭据优先级与头部净化

Cloudflare 会按请求携带的 provider key、default BYOK、Unified Billing 顺序解析凭据。OctaFuse 必须：

- 丢弃客户端传入的 `cf-aig-*` 控制头；
- 不把客户端用于 OctaFuse 鉴权的 Authorization 误转发为 provider key；
- 由服务端根据 Target 重新生成 Cloudflare 和 provider 鉴权头；
- P0/Unified Target 显式保证不携带 provider key；
- BYOK 非 default alias 只走支持 `cf-aig-byok-alias` 的 provider-native endpoint；
- alias 由服务端 Target 决定，客户端不能选择；
- 日志只记录 alias 的内部引用或指纹，不记录 secret 值；
- Cloudflare stored alias 只用于少量平台运营凭据；高基数租户 BYOK/共享凭据由 Credential Vault 管理；
- 动态 credential 如果通过请求头进入 AI Gateway，必须由 Key Broker 为单次已授权 Target 注入，不能让客户端或通用 Worker 查询任意凭据；
- 需要把明文限制在最小信任域时，优先由 Broker 执行 provider-direct 请求，不把 credential 交回全球边缘 Worker。

### 9.3 Gateway 池不再固定 12/8

池大小由测量结果计算：

```text
required_ub_gateways =
  ceil(peak_zdr_eligible_rpm / (verified_gateway_rpm * target_utilization))
```

同时必须满足：

- 账号级/模型级/厂商级限额；
- 平均服务时间对应的并发需求；
- canary、迁移和故障时的容量余量；
- Logpush、Secret、配置管理和运维复杂度；
- Cloudflare 合同和产品使用政策。

初始设计不得占满 20 个 gateway。至少保留 canary、配置迁移和突发恢复余量。若达到产品限额，应优先申请 limit increase 或企业合同，而不是继续堆叠账号。

### 9.4 ZDR 与日志配置

对 `zdr_required` Target：

- 只允许官方明确支持且内部证据有效的供应商/模型；
- 每请求显式设置服务端控制的 ZDR 参数；
- AI Gateway payload logging 必须关闭；
- 根据租户合同决定保留 metadata-only 还是完全关闭 AI Gateway log；
- OctaFuse 自身 `REQUEST_BODY_LOGGING` 保持 `off`；
- 禁止缓存，除非单独完成合规审核；
- Logpush 只能输出政策允许的 metadata，不能把 prompt/response 重新持久化到外部系统。

### 9.5 缓存与 DLP

- 所有生成式请求默认不缓存；
- 只有确定性、无用户敏感数据、无工具调用、无会话状态的请求可以显式 opt-in；
- cache key 必须至少包含租户/Workspace、规范化请求、模型、Target 政策版本和输出参数；
- DLP 的检查内容、处置、日志和数据区域必须纳入 route evidence；
- 不能把“开启 DLP”视为可以放宽 ZDR 或日志要求的理由。

## 10. 断路器与健康状态

### 10.1 两级状态

V2.1 使用两类状态：

1. **进程内快速软熔断**：响应当前实例观察到的连续失败，避免热循环；
2. **共享健康事实**：聚合真实请求和受控探针，供多实例生成一致的 attempt plan。

共享状态若要求原子计数和严格半开并发，优先使用 Durable Object、Redis 等具备明确一致性语义的组件。KV 适合发布粗粒度健康快照，不适合作为精确断路器锁或权威余额。

### 10.2 熔断维度

- `cf_gateway_id`
- `cf_account_id`
- `provider_account_id`
- `credential_ref`
- `credential_broker_id`
- `credential_kms_domain`
- `route_target_id`
- `direct_egress_cluster`

不能只按 Provider 名称熔断，否则会把健康的独立账号和出口一起摘除；也不能只按 gateway 熔断，否则账号级限流会在多个 gateway 间抖动。

### 10.3 主动探测

- 真实业务请求的被动事实是主要信号；
- 合成 prompt 探针只用于低频端到端验证，并计入成本和配额；
- 配置/API 可读性探针与实际模型推理探针分开；
- 强合规探针本身必须遵守同一 ZDR 和日志政策；
- 429 不直接计入供应商可用率分母，但要单独进入容量指标；
- 探针不得触发用户计费或污染公开模型热度。

## 11. 数据与账本设计

### 11.1 复用现有表

不创建与 `api_key_request_logs` 平行的 `token_log`。现有请求日志已经包含路由、token、成本、状态、timing、上游请求 ID、BYOK 标记和服务等级；现有 `provider_attempt_availability` 保存最小化 attempt 事实。

设计上只补充缺失语义：

| 逻辑字段 | 用途 |
| --- | --- |
| `transport` | AI Gateway 或 direct |
| `billing_mode` | unified/byok/provider_direct |
| `cloudflare_gateway_id` | 归因到具体 gateway |
| `cloudflare_ray_id` | 与 Cloudflare 侧观测关联，若可获得 |
| `compliance_policy` | 请求的有效合规模式 |
| `compliance_decision` | verified/authorized_exception/rejected/unknown |
| `policy_evidence_id` | 最终路由证据版本 |
| `fallback_reason` | 稳定、低基数的原因码 |
| `upstream_outcome_certainty` | known_success/known_rejected/unknown |

Attempt 表应记录每次真正 dispatch 的 Target、billing mode、故障域、开始时间、HTTP 状态、结果分类和是否导致下一跳，但不保存 prompt、响应体、URL 凭据或 secret alias 原文。

### 11.2 预算预留与结算

```text
admit
  └─ reserve(request_id, budget_epoch, ceiling)
       ├─ dispatch 未发生且失败 → release
       ├─ usage 权威可得 → settle(actual)
       └─ 结果/usage 不确定 → settle(reserved ceiling)
```

- reservation 与 request ID 一一对应；
- dispatch 前把 reservation 标记为 dispatched；
- 结算事务同时更新 reservation、用户预算、请求日志和必要的审计事实；
- 迟到的权威 usage 只能通过幂等 late settlement 或 adjustment 处理；
- 不允许先返回成功、仅在内存中排队等待未来写账。

### 11.3 成本维度

每个已结算请求至少区分：

- `provider_inference_cost`
- `cloudflare_credit_purchase_fee_allocated`
- `metered_cost`
- `standard_cost`
- `charged_cost`
- 币种、价格版本、舍入策略和税费处理

Unified Billing 的 credit purchase fee 不是天然的请求级费用。若业务需要分摊到请求，必须记录分摊规则、批次和版本；不能把它混入 token 单价后失去审计来源。

### 11.4 PlanetScale 约束

若选择 PlanetScale Vitess/MySQL：

- 每张表必须有稳定的非空唯一键，优先使用服务端生成的请求 ID 主键；
- 不直接复制 V1 的分区 DDL；
- 是否使用 RANGE 分区应以目标数据库的 schema lint 和 deploy request 为准；
- 分区方案必须包含自动创建未来分区、兜底分区、归档和失败告警；
- 高频低选择性单列索引会增加写放大，应优先使用与真实查询匹配的复合索引；
- 大规模原始 telemetry 应归档到对象存储或分析系统，OLTP 只保留结算和近期审计所需数据。

### 11.5 对账模型

新增逻辑对象：

```text
reconciliation_runs
  id, source, period, status, started_at, completed_at, summary

reconciliation_items
  run_id, request_id/time_bucket, expected, observed, delta,
  match_confidence, reason_code, review_state

billing_adjustments
  id, reconciliation_item_id, account, amount, currency,
  reason, approved_by, created_at
```

对账匹配优先级：

1. 厂商/Cloudflare 上游 request ID；
2. gateway、provider account、model、时间窗口和 token/cost 组合；
3. 仅能按时间桶匹配时标记较低置信度，不伪造请求级精确性。

小额、已定义容差内的偏差可自动生成审计调整；超过阈值、跨租户或置信度不足的偏差进入 maker-checker 人工审批。任何情况下都不直接覆盖历史余额。

### 11.6 凭据分类与权威数据源

凭据按是否需要恢复明文和运行职责分为以下类别：

| 凭据类型 | 权威数据源 | 持久化内容 | Cloudflare Secret Store 用途 |
| --- | --- | --- | --- |
| 客户调用 OctaFuse 的 Gateway Key | PostgreSQL/MySQL/D1 | Hash/HMAC、prefix/preview、owner、状态、权限和预算 | 只保存可选 HMAC pepper，不保存逐用户 Key |
| 用户 BYOK | Credential Vault | 应用层密文、wrapped DEK、凭据主体和生命周期 | 不逐 Key 占用 secret |
| 卖家共享上游 Key | Credential Vault | 同上，另带 seller、报价和结算引用 | 不逐 Key 占用 secret |
| 平台运营上游 Key | 少量可留 Cloudflare alias；大池进入 Credential Vault | 由规模和风险域决定 | 只适合低基数、人工治理的稳定凭据 |
| KMS/Broker/签名基础设施凭据 | Cloudflare Secret Store 或对应运行时 secret manager | 少量根秘密或工作负载鉴权 | 主要用途 |
| OAuth 短期 access token | Key Broker 受控内存缓存 | 不作为长期 secret 持久化 | 不占用 |

数据库自身的 encryption at rest 只保护底层介质，不能替代应用层信封加密。KV、R2、D1、Durable Object 或 Redis 也不能因为“平台已加密”而直接保存上游 Token 明文。

### 11.7 Credential Vault 逻辑模型

字段名为逻辑语义，不预先锁定迁移 SQL：

```text
credential_records
  id
  credential_kind: operator | tenant_byok | shared_seller
  owner_type / owner_id
  provider / provider_account_ref / project_ref / region
  ciphertext / nonce / wrapped_dek
  encryption_algorithm / envelope_version / kms_key_ref / kms_key_version
  fingerprint / credential_subject_fingerprint
  status: validating | active | quarantined | paused | revoked | expired
  expires_at / validated_at / last_used_at / rotated_from_id
  created_at / updated_at

credential_capacity_state
  credential_id / provider_account_ref
  rpm_limit / tpm_limit / concurrency_limit
  reserved_rpm / reserved_tpm / active_leases
  cooldown_until / last_401_at / last_429_at / last_5xx_at
  health_epoch / updated_at

credential_leases
  id / request_id / route_target_id / credential_id
  policy_version / health_epoch
  state: reserved | dispatched | released | expired
  expires_at / dispatched_at / released_at

credential_security_events
  id / credential_id / event_type / actor / reason
  old_version / new_version / evidence_ref / created_at
```

设计要求：

- `fingerprint` 用于去重和审计，不允许作为解密材料；跨租户关联敏感时使用带 pepper 的 HMAC；
- `provider_account_ref` 是限流和故障域，不等同于单个 credential；同一上游账号内轮换 Token 不能伪装成新增容量；
- lease 只表达短期调度占用，不替代财务 reservation；两者用同一 request ID 关联但分属不同不变量；
- `credential_security_events` 是安全生命周期审计，不创建第二套 token 用量或收益账本；
- ciphertext 可以与业务元数据同库，但密文、wrapped DEK 和可查询元数据必须使用独立权限和最小列投影；
- 高规模部署按 provider/account/region 等稳定维度分片，不按单次请求动态建表或创建 Cloudflare binding。

现有 `shared_keys` 可作为迁移来源，但平台运营大池不应通过复制 Provider 实体实现；应统一迁入 credential 逻辑对象，并通过 Route Target/credential policy 关联。

### 11.8 信封加密、KMS 与轮换

推荐模式：

1. 每个 credential 生成独立的随机 DEK；
2. 使用 AES-256-GCM 加密 Token，AAD 至少绑定 owner、provider、credential ID、用途和 envelope version；
3. 使用不可导出的 KMS CMK/KEK 包装 DEK，数据库只保存 `wrapped_dek`；
4. CMK 按环境、区域或监管风险域设置，不创建百万个 CMK；
5. CMK 轮换优先 rewrap DEK，不批量暴露 Token 明文；
6. credential 轮换采用新版本验证、灰度、旧版本撤销，旧 ID 保留审计引用；
7. Broker 可以短时缓存已解包 DEK/明文，但必须有严格 TTL、最大条目数、主动吊销和进程退出清零；
8. 缓存失效依赖 credential/key version，不能只依赖时间；
9. 当前 `SHARED_KEY_ENCRYPTION_SECRET` 单 KEK 模式只作为迁移兼容，不作为百万级目标状态。

### 11.9 Top-K、lease 与按需解密

热路径不得读取或解密指定渠道的所有 active credential：

```text
Target 合规过滤
  → credential metadata SQL 过滤
  → bounded Top-K（默认设计 4–16，最终压测确定）
  → 按故障域/容量/健康/价格进行有界选择
  → 原子 credential lease
  → Key Broker 验证 request + target + policy + lease
  → 只读取并解密最终选中的一把
  → Broker dispatch 到 AI Gateway/provider direct，或在批准的运行时边界内单次注入
```

- Top-K 查询只投影 ID、故障域、状态、容量、价格和证据，不投影 ciphertext；
- 选择应避免固定全局排序导致头部 Key 过热，可使用优先级分层后的 weighted random、power-of-two choices 或其他可解释策略；
- 一个请求不得把数千 credential 展开为 attempt array；credential 尝试仍受总 attempt budget 约束；
- lease 必须原子复验 status、health epoch、并发和容量水位；冲突时只在剩余 Top-K 中有限重选；
- 401/403 触发 credential 隔离和异步复验；429 根据已验证错误结构更新 credential 或 provider-account 容量状态；
- Key Broker 最好直接完成 AI Gateway 或 provider-direct 请求，使静态 API Key 不返回边缘 Worker；只有协议确需其他运行时注入时，才允许在已审计信任域内短时获取单个凭据；
- 管理面默认只允许创建、替换、轮换和吊销，不提供管理员明文 reveal；原 owner 也只能重新提交，不能读取已保存明文。

## 12. 部署拓扑

### 12.1 Workers 数据面

适合：

- 全球边缘入口；
- 网络等待占主导的流式代理；
- D1 或 Hyperdrive PostgreSQL 数据面；
- 轻量后台任务通过 Cron/Queue/Workflow 分解。

限制与要求：

- 当前仓库的 Worker 数据库只支持 D1 或 Hyperdrive PostgreSQL，不支持直接选择 MySQL；
- 每次 invocation 同时等待响应头的外连有平台限制，但不是 Worker 全局并发上限；
- HTTP streaming 没有固定 wall-time 上限，但仍受 CPU、内存、客户端连接和运行时更新影响；
- `waitUntil` 不能替代耐久队列和财务事务。

### 12.2 Node/Docker 数据面

适合：

- 需要完整 Node 运行时或自定义网络出口；
- 需要独立于 Cloudflare Workers 的 AI Gateway 故障逃逸；
- 长连接、常驻 reconciler 或自定义 secret manager；
- PostgreSQL 或 MySQL 数据面。

数据库选择必须一致：

- PlanetScale Postgres：Node 使用其 PgBouncer 连接；
- PlanetScale Vitess/MySQL：Node 使用 MySQL 驱动，不使用 PgBouncer；
- Workers 若连接 PlanetScale，应优先评估 PlanetScale Postgres + Hyperdrive；
- 迁移进程、应用连接和分析任务使用不同凭据与连接方式。

Node 同样需要负载均衡、连接池、超时、优雅退出、自动扩容、跨可用区和容量保护，不能表述为“无并发或 CPU 限制”。

### 12.3 逃逸等级

| 目标 | 所需拓扑 |
| --- | --- |
| 只绕过 AI Gateway | Worker 或 Node 中直接调用 Provider 即可 |
| 绕过 Cloudflare AI 产品面 | 独立 Node direct egress 服务 |
| 绕过 Cloudflare 整体入口故障 | 需要独立 Node ingress、DNS/客户端切换和独立鉴权依赖 |

必须在 SLO 中明确要实现哪一级逃逸。仅部署 P2 direct 服务并不能在入口 Worker 不可达时自动接管客户端流量。

### 12.4 Key Broker 拓扑

Key Broker 是独立的安全边界，不是普通 Admin API：

- 仅接受服务到服务身份，优先使用 service binding、mTLS、私网或短时工作负载身份；
- 调用必须携带服务端 request ID、Route Target、credential lease、政策版本和防重放证明；
- Broker 只可获取被 lease 绑定的单个 credential，不能提供任意 ID 批量 reveal/list API；
- Broker 若承担上游 dispatch，必须复用协议 adapter、超时、流式边界、request ID 和 attempt/结算事实，不建立隐形重试；
- KMS key policy、Broker 身份和数据库列权限相互独立；攻破其中一层不能直接导出全库明文；
- 生产至少跨可用区，是否跨云/跨区域取决于真正的 Cloudflare 逃逸目标；
- Broker/KMS 延迟、错误率和缓存命中率进入容量模型，但不能通过无限缓存明文换取低延迟。

Workers 数据面可以通过受控内部调用使用 Broker；Node direct 数据面也必须使用同一 Credential Vault 和安全事件模型，不能维护另一份 `.env` Token 池。

## 13. Secret 与访问控制

### 13.1 Cloudflare Secret Store 的职责边界

Secret Store 只保存低基数、需要部署时绑定的基础设施秘密，例如：

- Key Broker 的服务身份或 mTLS/Access 鉴权材料；
- KMS 客户端的最小权限凭据；若可使用不可导出的工作负载身份则优先不用长期 access key；
- Gateway Key HMAC pepper、内部签名 key、webhook secret；
- Cloudflare API token、AI Gateway auth 和少量平台运营 BYOK alias；
- 新旧双版本轮换窗口所需的临时根秘密。

禁止把下列对象逐条写入 Secret Store 或 Worker secret：用户 Gateway Key、用户 BYOK、卖家共享 Key、平台大规模 Token 池、credential lease、短期 OAuth access token。

当前账号实测 Secret Store 使用量为 11/100。该额度需要持续通过 quota API 读取并告警，但容量规划目标不是把 89 个空位填满，而是让 Secret Store 用量与系统组件/故障域近似相关、与用户和 credential 数量无关。多 Cloudflare 账号只用于真实的法律主体、环境、区域或故障域隔离，不作为 `100 × 账号数` 的扩容技巧。

### 13.2 权限与明文边界

- Cloudflare API token、AI Gateway auth、KMS/Broker 身份、BYOK 和 direct provider credential 分开管理；
- Unified、Cloudflare BYOK、Broker dispatch 使用最小权限且不同凭据主体；
- 数据面调度身份只能查询 credential metadata 和申请 lease，不能读取 ciphertext/wrapped DEK；
- Broker 身份可按 lease 读取一条密文并调用特定 KMS key，但不能修改价格、路由、预算或证据；
- 管理面可写入新密文和发起轮换，但默认不能 reveal 明文；
- KMS 管理员不能读取业务数据库，数据库管理员不能使用 KMS 解密，安全审批使用 maker-checker；
- 启动日志、错误响应、trace、Queue、Logpush、对账数据和支持工单均不得出现 secret；
- 客户端提供的 Authorization、`cf-aig-*`、alias 或 credential ID 不能直接进入 Broker 权限判断。

### 13.3 轮换、吊销与应急

- 根密钥、Broker 身份、credential、Gateway auth 分别使用独立 key version 和轮换周期；
- credential 轮换采用新版本验证、灰度、旧版本停止 lease、等待在途完成、最终吊销；
- CMK 轮换采用 rewrap ledger，并能断点续跑、幂等恢复和报告未完成项；
- 紧急吊销必须主动失效 Broker 缓存、阻止新 lease，并在共享健康状态传播前由数据库状态 fail closed；
- 已发出的上游请求不能因 credential 被吊销而自动重放；
- 发生 KEK/KMS/Broker 泄漏时按 key domain 计算影响面，保留 credential subject 与请求事实用于通知和取证；
- 迁移期旧 `SHARED_KEY_ENCRYPTION_SECRET` 与新 KMS envelope 双读时，新写只进入新格式，并设定明确移除日期。

## 14. 可观测性

### 14.1 核心指标

```text
gateway_requests_total{transport,billing_mode,outcome}
gateway_attempts_total{transport,billing_mode,result}
gateway_fallback_total{from_domain,to_domain,reason}
gateway_policy_rejections_total{policy,reason}
gateway_authorized_policy_exception_total{reason}
gateway_upstream_outcome_unknown_total{transport}
gateway_budget_reservation_total{result}
gateway_settlement_total{mode,result}
gateway_reconciliation_delta{source,currency}
gateway_ttft_seconds{transport,billing_mode}
gateway_stream_duration_seconds{transport,billing_mode}
gateway_capacity_rejections_total{scope,reason}
credential_selection_total{kind,provider,result}
credential_lease_total{provider,result}
credential_broker_requests_total{operation,result}
credential_broker_latency_seconds{operation}
credential_kms_operations_total{operation,result}
credential_pool_active{provider,kind}
credential_validation_backlog{provider}
```

指标标签必须保持低基数。tenant、request ID、credential ID、gateway ID、alias、KMS key version 和上游错误原文只进入受控日志或 trace，不作为通用指标标签。

### 14.2 告警分级

| 级别 | 事件 |
| --- | --- |
| P0 | `zdr_required` 请求实际 dispatch 到不合格 Target；账本不变量破坏；secret/DEK/KEK 泄漏；未授权批量解密 |
| P1 | 结果未知激增；无法结算；所有合格 ZDR Target 不可用；Key Broker/KMS 全故障；对账偏差超过阈值 |
| P2 | 经授权的非 ZDR 降级率超过 SLO；单故障域容量告警；凭据临近过期；validation/rewrap backlog 超阈值 |
| P3 | 单 Target 降级、探针失败、配置漂移但仍有健康候选 |

“经授权的非 ZDR 降级”与“合规违规”必须使用不同指标和告警级别。前者是可用性/SLO 事件，后者应在正确实现下保持为零。

### 14.3 客户端响应元数据

可选返回低敏感度、稳定语义的响应头：

```text
X-OctaFuse-Route-Class: unified | byok | direct
X-OctaFuse-Policy: zdr-verified | authorized-non-zdr
X-OctaFuse-Request-Id: <server-generated-id>
```

它们用于客户排障，不是审计真相。是否暴露具体 route class 应按产品和安全策略决定；内部 gateway ID、alias、账号和故障详情不应返回客户端。

## 15. 容量规划

容量模型至少包含：

```text
吞吐：peak RPM / verified per-gateway RPM
并发：arrival rate × p95 service time
流式占用：stream arrival rate × p95 stream duration
重试放大：base traffic × average attempts
探针开销：probe frequency × target count
日志开销：log rate、payload policy、Logpush limits
数据库写入：settlements + attempts + outbox + adjustments
凭据选择：metadata Top-K 查询延迟、扫描行数、lease 冲突率
Broker：请求 RPS、p95/p99、并发、streaming 占用和失败余量
KMS：unwrap/rewrap RPS、延迟、配额、成本和受控缓存命中率
生命周期：新增/验证/轮换/吊销速率、validation 与 rewrap backlog
```

凭据池容量必须是次线性热路径：请求延迟和单次解密数量不能随 active credential 总数线性增长。验收时至少在 100、10,000 和目标峰值规模下验证 SQL 扫描、Top-K、lease、Broker 内存和 KMS 调用放大；不允许通过把全部密文加载到 Worker isolate 来获得表面缓存命中。

容量验收以实测为准：

- 不能用 `12 × 3.33 QPS = 40 QPS` 直接作为 SLA；
- 必须分别压测短非流式、长 SSE、图像、音频和工具调用；
- 验证固定/滑动窗口、突发、账号级模型限制和 `Retry-After`；
- 压测必须关闭真实用户计费并使用隔离账号、模型和数据；
- 统计重试造成的成本与上游请求放大；
- 保留至少一个故障域失效后的目标容量余量。

## 16. 灰度实施计划

### Phase 0：产品事实与合同核验

执行记录：[Phase 0 证据报告](./cloudflare-ai-gateway-phase-0-evidence.md)（2026-09-02；安全只读部分已完成，总退出门禁尚未通过）

- 建立 Cloudflare/厂商能力矩阵；
- 实测 ZDR 支持范围、不支持时行为和日志行为；
- 实测 UB 余额不足、Spend Limit、gateway limit、厂商 429 的错误结构；
- 验证非 default BYOK alias 的 provider-native 路径；
- 验证 Logpush job、Secret quota 和相关 API 权限；
- 建立 Gateway Key、平台运营 Key、租户 BYOK、卖家共享 Key 和根秘密的数量/增长/owner 清单；
- 评估候选 KMS/Key Broker 的非导出密钥、配额、延迟、成本、区域、审计和灾备能力；
- 核验各 provider 是否允许聚合代理、BYOK、共享/转售和多 credential 调度，禁止把 Token 池用于规避限额；
- 确认真正需要的故障逃逸等级。

**退出门禁**：所有会影响合规和状态机的事实均有可复现证据，不使用未经验证的 402、QPS 或模型能力假设；Secret Store 用量模型不再与 credential 数量线性绑定；候选 KMS/Broker 和供应商商业权限有 owner。

### Phase 1：数据模型与配置面

- 定义 Target transport/billing/failure-domain 属性；
- 复用现有 route data policy 和 subject fingerprint；
- 建立证据过期、撤销和配置漂移检测；
- 设计请求日志扩展、attempt 事实、reconciliation 和 adjustment；
- 定义 `credential_records`、capacity state、lease 和 security event 的逻辑/物理模型；
- 定义 Gateway Key hash-only、DEK/CMK envelope、Key Broker 协议和权限矩阵；
- 设计现有 `providers.api_key`、`shared_keys` 和 `SHARED_KEY_ENCRYPTION_SECRET` 的零明文迁移与回滚；
- 将全池读取/解密/attempt 展开替换为 metadata Top-K + bounded lease 的设计；
- 建立 Cloudflare gateway 配置 IaC 和审计 diff。

**退出门禁**：配置变更会自动使不匹配证据失效；不创建平行 token 账本；新写凭据只使用新 envelope；管理 API 不提供明文 reveal；Secret Store 只包含批准的基础设施根秘密。

### Phase 2：Unified Billing 单 Target 试点

- 只接内部或测试 Workspace；
- 日志 payload 关闭；
- 不启用自动跨计费模式降级；
- 验证请求 ID、usage、成本、Cloudflare fee 和对账；
- 验证 streaming/cancel/unknown outcome 的保守结算。

**退出门禁**：账本零超卖；未知结果不重放；Cloudflare 和本地记录可在定义容差内对账。

### Phase 3：多 gateway 与故障域路由

- 增加多个 UB Target 和共享健康事实；
- 验证单 gateway、账号、模型和厂商故障的不同跳转；
- 引入有界 attempt plan；
- 验证配置漂移、凭据轮换和 gateway 摘除；
- 保留 canary 和扩容余量。

**退出门禁**：任何故障不会产生无限重试、跨故障域抖动或错误熔断扩散。

### Phase 4：Credential Vault、BYOK 与 direct

- 实现 Credential Vault、每凭据 DEK、KMS rewrap 和安全事件审计；
- 实现高可用 Key Broker、单凭据授权协议和可选 broker dispatch；
- 实现 metadata Top-K、原子 lease、provider-account 容量和分布式 credential cooldown；
- 实现 provider-native BYOK adapter；
- 实现 direct adapter 和独立 secret 管理；
- 迁移 `shared_keys`/平台运营 Key，移除全池解密、全池 attempt 展开和单一 KEK 新写；
- 按故障域而非固定层级跳转；
- 仅对 `zdr_not_required` 或已有授权的 `zdr_preferred` 租户开放非 ZDR 候选；
- 验证 direct 是否真正独立于目标 Cloudflare 故障范围。

**退出门禁**：客户端不能注入 alias/凭据；跨模式降级全部有政策依据和审计事实；1 个请求只解密有界数量的已 lease 凭据；10,000+ credential 压测不存在 O(N) 热路径；KMS/Broker 故障 fail closed；根密钥可完成无明文批量暴露的轮换。

### Phase 5：强合规租户

- 仅开放证据有效且日志策略已验证的 ZDR Target；
- 运行证据过期、配置漂移、unsupported provider、日志误开启等故障注入；
- 完成法务/安全/数据处理方审核；
- 对合规拒绝错误建立客户可理解的稳定协议。

**退出门禁**：所有负向测试均 fail closed，`zdr_required` 到非合格 Target 的 dispatch 数保持为零。

## 17. 强制测试矩阵

至少覆盖：

1. Cloudflare ZDR 对不支持供应商的行为；
2. gateway 日志关闭与 payload-only 关闭的差异；
3. 客户端注入 `cf-aig-*`、Authorization 和 BYOK alias；
4. 单 gateway UB 429、Spend Limit 429、厂商 429；
5. 余额不足的真实状态码和错误体；
6. 成功响应头前 TTFT timeout；
7. 成功响应头后首字节延迟和流中 idle timeout；
8. 请求写出后网络结果未知；
9. 客户端取消、drain 成功和 drain timeout；
10. 同一 request ID 的重复结算和迟到 usage；
11. 预算预留后进程崩溃、恢复和过期清理；
12. Cloudflare AI Gateway 整体不可用时是否跳过 BYOK；
13. Provider 账号级限速时是否避免同账号 gateway 抖动；
14. 证据到期、Target 配置变化和凭据轮换后的 fail closed；
15. Logpush 达到存储/job/大小限制；
16. 数据库限流、事务失败、outbox 积压和对账重放；
17. 缓存 key 的租户隔离和策略版本隔离；
18. 多模态请求、工具调用和状态型 Responses 的不可重放边界；
19. 100、10,000 和目标峰值 credential 下 Top-K 查询扫描行数与延迟不线性增长；
20. 单请求无全池 ciphertext 投影、全池解密或全池 attempt 展开；
21. 高并发 credential lease 不超并发/RPM/TPM 水位，冲突只进行有界重选；
22. 同一 provider account 下多 credential 遇到账号级 429 时不会相互抖动；
23. 401/403 只隔离已归因 credential，其他独立账号仍可用；
24. Broker/KMS timeout、区域故障、错误 key version 和权限撤销均 fail closed；
25. credential 吊销能阻止新 lease、主动清理 Broker 缓存且不重放在途请求；
26. CMK 轮换/rewrap 可断点续跑、幂等恢复并验证旧 key 最终不可用；
27. Secret Store secret 数不随导入 10,000 个 credential 增长；
28. 数据库快照、日志、trace、Queue、错误和管理 API 中无明文 Token/DEK/KEK；
29. 管理员、数据库运维、KMS 运维和 Proxy 身份任一单独被攻破均不能批量导出明文；
30. 卖家共享/租户 BYOK credential 的 ZDR 和数据政策不会继承默认 Provider 账号证据。

## 18. 生产验收标准

### 合规

- `zdr_required` 请求只有证据有效的 Target 能进入 attempt plan；
- AI Gateway 与 OctaFuse payload logging 均符合政策；
- 所有非 ZDR dispatch 都有事前授权和证据版本；
- 证据过期或配置漂移在下一次请求前 fail closed。

### 正确性

- 所有 request ID 幂等结算；
- 并发预算测试无超卖；
- unknown outcome 和已开始 streaming 的请求不重放；
- 核心请求日志、attempt 和账本可关联。

### 凭据安全与规模

- Gateway Key 只存 Hash/HMAC；上游 credential 只存新 envelope 密文；
- Secret Store 用量只随系统组件、环境和根密钥轮换增长，不随用户/credential 数增长；
- 调度只读取 metadata Top-K，单请求解密和 lease 次数受严格上限约束；
- Key Broker/KMS、数据库和管理面权限分离，无通用批量 reveal；
- credential、CMK、Broker 身份和缓存均可轮换/吊销且有审计事件；
- 规模压测、故障注入和 secret 扫描均通过。

### 可用性

- 单 Target、单 gateway 和单 provider account 故障可按预期隔离；
- Cloudflare AI Gateway 级故障直接进入允许的独立故障域；
- 尾延迟和平均尝试次数不超过已批准 SLO；
- 没有健康合规候选时返回稳定、可审计的失败。

### 可运营性

- Gateway、Secret、Logpush、证据和路由配置均可审计；
- Credential Vault、KMS、Broker、lease、validation 和 rewrap backlog 可观测；
- 容量与限额来自测量/API，而非静态猜测；
- 对账偏差进入可追溯 workflow；
- 回滚不会破坏账本、证据或请求幂等性。

## 19. 与当前 OctaFuse 的衔接

V2.1 应复用：

- [路由拓扑](./route-topology.md)中的 Request Surface、Route Pool 和 Target；
- [请求生命周期](./proxy-request-lifecycle.md)中的 attempt planner、failover、未知结果和异步 usage；
- [运行时数据](./runtime-data.md)中的 D1/PostgreSQL/MySQL 部署矩阵；
- [流式计费](../reference/streaming-billing.md)中的取消、drain 和保守结算；
- [用户 Key 数据模型](./user-keys-data-model.md)中的 hash-only Gateway Key；
- 现有 Route Data Policy、ZDR evidence、预算 reservation、请求日志和共享 Key 收益账本。

V2.1 新增的是 Target transport/billing/failure-domain 语义、Cloudflare adapter、Credential Vault、Key Broker、credential lease、共享健康事实、合规决策审计和多来源对账，而不是替换现有调度与账本。

现有[共享 Key 加密包装器](../../../packages/core/src/lib/shared-key-encryption.ts)和[Provider Key 加密包装器](../../../packages/core/src/lib/provider-key-encryption.ts)已用 AES-GCM 对 `shared_keys.api_key` 与 `providers.api_key` 进行应用层加密，这是迁移起点；但当前同一 `SHARED_KEY_ENCRYPTION_SECRET` 覆盖大范围数据，且[共享池调度](../../../packages/proxy/src/services/shared-key-pool.ts)会返回并解密指定渠道的全部 active key，再展开为 attempt。该路径只能作为兼容实现，进入 Phase 4 前必须替换。现有“一个 Provider 一把自有 Key”可以保留为低基数运营配置，但平台大规模凭据必须进入独立 credential 模型，不能通过复制 Provider 扩容。

## 20. 上线前仍需决策的问题

1. 生产主数据面选择 Workers 还是 Node，真实逃逸目标是哪一级；
2. PlanetScale 选择 Postgres 还是 Vitess/MySQL；
3. `zdr_preferred` 是否允许 Workspace 管理员授权非 ZDR，还是仅平台管理员可配置；
4. 合规拒绝使用 503、422 还是产品专用错误码及其客户端兼容策略；
5. 分布式健康状态选择 Durable Object、Redis 或其他组件；
6. Credential Vault 使用哪种 KMS/HSM，CMK 按环境、区域、provider 还是监管域划分；
7. 财务对账容差、自动调整阈值和审批人角色；
8. Cloudflare metadata-only 日志是否满足强合规合同，还是必须完全关闭；
9. 是否需要独立于 Cloudflare 的第二入口和 DNS/客户端故障切换；
10. 各协议、模态和厂商的最大 attempt、TTFT、idle 和总 deadline；
11. Key Broker 部署在 Cloudflare 内部服务、独立 Node 集群还是跨云双域；
12. 静态上游 API Key 是否一律由 Broker dispatch，哪些协议允许单次交付给其他运行时；
13. 每 credential DEK 的 Broker 缓存 TTL/上限和吊销传播 SLO；
14. Top-K、lease、provider-account 容量状态和分布式 cooldown 使用 PostgreSQL、Durable Object 还是 Redis；
15. 平台是否继续运营卖家共享 Key 市场，以及各 provider 的聚合代理、共享和转售合同是否允许；
16. 是否彻底删除管理员明文 reveal，迁移期 break-glass 如何双人审批和审计；
17. CMK 灾备、KMS 配额/成本、跨区域数据驻留和紧急 rewrap 策略。

上述问题未决前，可以进行 Phase 0 事实验证和设计评审，但不应直接进入生产实现。
