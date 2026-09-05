# Cloudflare AI Gateway 多出口 Phase 0 证据报告

> 对应方案：[Cloudflare AI Gateway 多出口架构 V2](./cloudflare-ai-gateway-multi-egress-v2.md)\
> 核验日期：2026-09-02\
> 执行范围：只读账号/API 核验、官方文档核验、无推理的安全探针；未修改现网配置，未产生模型推理费用\
> 当前结论：**Phase 0 尚未通过退出门禁；安全只读部分已完成**

## 1. 执行结论

本轮已完成当前 Cloudflare 账号、AI Gateway、Secret Store、Unified Billing、生产 Worker 数据面和官方产品规则的只读核验，并执行了一次不调用模型推理的 provider-native BYOK 探针。

已得到五个会直接改变实施顺序的事实：

1. 当前账号只有一个 AI Gateway：`cinaos-ai`；它启用了网关日志、关闭 ZDR，并配置了 DeepSeek `default` BYOK，不能作为严格 ZDR 或纯 Unified Billing 试点环境。
2. Unified Billing 当前余额为 0，invoice preview 返回 `Customer not onboarded`；因此账号尚不具备可验证的 Unified Billing 运行条件。
3. Cloudflare ZDR 当前只适用于 Unified Billing/Cloudflare 管理凭据，且官方仅明确支持 OpenAI、Anthropic。BYOK 不继承 Cloudflare ZDR；不支持的供应商在开启 ZDR 时会回退到普通非 ZDR Unified Billing。
4. 部署中的 `cinatoken-proxy` 已使用 PostgreSQL + Hyperdrive，D1 仍绑定用于预置/回滚；`REQUEST_BODY_LOGGING=off`。这满足 V2 对主账本数据面的预期，但本地生成的 Wrangler 配置与现网绑定存在漂移风险。
5. 现有 Cloudflare API 权限足以读取 AI Gateway、provider config、日志元数据、账单和 Secret Store quota；创建隔离 gateway、修改日志/ZDR、配置 Logpush、充值或发起付费推理仍属于未授权的外部写操作。

因此，当前可进入“准备隔离测试环境和法务证据”的工作，但不得把 Phase 0 标记为完成，也不得直接进入生产实现或严格 ZDR 租户试点。

## 2. 证据等级

| 等级 | 含义 | 可用于什么决策 |
| --- | --- | --- |
| `D` | Cloudflare 当前官方文档/API 文档 | 产品公开能力、上限和协议基线 |
| `A` | 当前账号的只读 API/部署配置快照 | 账号是否具备某项配置或额度 |
| `T` | 受控探针的实际请求/响应 | 错误结构、日志行为、路由行为 |
| `C` | 合同、DPA、供应商书面承诺或法务结论 | 面向租户宣称 ZDR/留存政策 |

合规资格至少需要 `D + A + T + C`。只有公开文档或控制台开关，不足以将 Route Target 标记为 `zdr_verified`。

## 3. 当前账号快照

### 3.1 AI Gateway

| 项目 | 实测值 | 证据 | 影响 |
| --- | --- | --- | --- |
| Gateway 数量 | 1 | `A` | 距付费账号公开上限 20 仍有空间，但应保留 canary/迁移余量 |
| Gateway ID | `cinaos-ai` | `A` | 当前唯一环境，不适合做破坏性或限流实验 |
| Gateway 鉴权 | 开启 | `A` | 探针必须使用独立的 AI Gateway token |
| Gateway rate limit | fixed，50 requests / 60 seconds | `A` | 与 Unified Billing 公布的 200/60 产品限额是不同控制，需要在隔离环境验证优先级和错误体 |
| `collect_logs` | `true` | `A` | 默认会保存 prompt/response；严格链路不合格 |
| 日志管理 | 最多 10,000,000 条，`DELETE_OLDEST` | `A` | 这是留存容量策略，不等同于合规留存期限 |
| Logpush | 关闭 | `A` | 尚未验证 job 权限、目标端和字段脱敏 |
| ZDR | 关闭 | `A` | 当前 gateway 不能作为 Cloudflare ZDR 证据 |
| Cache TTL | 300 秒 | `A` | 仅看到 TTL 配置，不能据此断言生成式请求正在缓存；严格链路仍应显式禁用并实测 |
| Wholesale / Unified Billing 能力标志 | 开启 | `A` | 仅表示 gateway 配置能力，不代表账单账号已完成 onboarding |
| Workers AI billing mode | `postpaid` | `A` | 不能推导其他供应商的余额或结算行为 |
| Cloudflare 自动 retry | 未配置 | `A` | 当前没有可观察到的 gateway retry 策略；未来仍需阻止与 OctaFuse 重试叠加 |
| Spend limits | 功能开启、规则为空 | `A` | 当前不会产生可用于实测的 Spend Limit 429 |

### 3.2 Provider config 与 BYOK

| 项目 | 实测值 | 证据 | 结论 |
| --- | --- | --- | --- |
| Provider config 数量 | 1 | `A` | 仅 DeepSeek |
| Provider slug | `deepseek` | `A` | 当前主要验证对象是 DeepSeek BYOK，而非 ZDR Unified Billing |
| Alias | `default` | `A` | 按 Cloudflare 凭据优先级，可能优先于 Unified Billing |
| Provider-native 路径 | `/v1/{account}/cinaos-ai/deepseek` | `A` | 可使用 `cf-aig-byok-alias`，但当前尚未创建/验证非 default alias |
| 无推理探针 | `GET /models` 返回 HTTP 200、3 个模型、233 bytes | `T` | 证明当前 gateway token、DeepSeek default BYOK 和 provider-native 路径可用；不证明 chat/completions、流式或 ZDR |
| 探针日志控制 | 请求带 `cf-aig-collect-log:false` | `T` | 以该请求 Ray ID 搜索日志元数据为 0；这是支持性证据，仍需用隔离 gateway 和唯一标记完成强验证 |

账号内共有 17 条 AI Gateway 日志元数据。本轮没有读取任何请求或响应正文。

### 3.3 Secret Store 与账单

| 项目 | 实测值 | 证据 | 结论 |
| --- | --- | --- | --- |
| Secret Store | 已用 11 / 额度 100 | `A` | 当前仍有余量；实施时仍需按环境和故障域拆分 secret |
| Unified Billing credit | 0 | `A` | 不能假设实际推理一定返回 402，也不能假设一定拒绝请求 |
| Invoice preview | HTTP 400，Cloudflare code 1000，`Customer not onboarded` | `T` | 这是账单 onboarding 错误，不是推理余额不足协议 |
| Invoice history | 0 条 | `A` | 尚无可用于对账的历史样本 |
| Usage history | 无历史 | `A` | 尚无 Unified Billing usage 样本 |
| Auto top-up | 关闭 | `A` | 隔离测试前必须明确预算和最大损失边界 |
| Payment method | 账号报告已配置 | `A` | 因可能出现后付费或延迟结算，未授权前禁止用真实推理“试探”零余额行为 |

### 3.4 生产 Proxy 数据面

部署中的 `cinatoken-proxy` 只读设置显示：

| 绑定/变量 | 状态 | 结论 |
| --- | --- | --- |
| `DATABASE_DRIVER` | `postgres` | 生产权威数据面已选择 PostgreSQL |
| `HYPERDRIVE` | 已绑定 | Workers 通过 Hyperdrive 访问 PostgreSQL |
| `DB` | D1 仍绑定 | 可用于预置或回滚，但不得与 PostgreSQL 同时充当余额/账本真相源 |
| `REQUEST_BODY_LOGGING` | `off` | OctaFuse 侧当前未开启请求正文日志 |
| Provider key / encryption key | 以 secret binding 存在 | 本轮只核验名称和类型，没有读取 secret 值 |

本地 [production.env](../../../cloudflare-worker/production.env) 与现网 PostgreSQL/Hyperdrive 方向一致；本地 [packages/proxy/wrangler.jsonc](../../../packages/proxy/wrangler.jsonc) 未体现现网的 Hyperdrive 和 `DATABASE_DRIVER` 绑定。进入 IaC 阶段前必须消除这一漂移，避免一次部署把现网退回不完整配置。

## 4. 当前官方能力矩阵

| 路径 | Cloudflare ZDR | AI Gateway 日志 | 凭据选择 | Phase 0 判定 |
| --- | --- | --- | --- | --- |
| Unified Billing + OpenAI | 官方明确支持 ZDR | 与 ZDR 独立，必须另行关闭 payload 或整条日志 | 请求无 provider key、无 default BYOK 时才会落到 UB | `D` 通过，`A/T/C` 未完成 |
| Unified Billing + Anthropic | 官方明确支持 ZDR | 同上 | 同上 | `D` 通过，`A/T/C` 未完成 |
| Unified Billing + 其他供应商 | 开启 ZDR 也可能回退到普通非 ZDR UB | 同上 | 同上 | 严格链路必须 fail closed，不能依赖开关 |
| Cloudflare BYOK | Cloudflare ZDR 不适用 | 仍受 AI Gateway 日志控制 | 请求 provider key 优先，其次 `default` alias | 只能依据供应商合同另建 ZDR 证据 |
| Provider Direct | Cloudflare ZDR 不适用 | 不经过 AI Gateway；仍受 OctaFuse/供应商日志影响 | OctaFuse 管理 provider credential | 需要独立的 `A/T/C` 证据 |

关键产品事实：

- 凭据优先级为：请求携带的 provider key → BYOK `default` alias → Unified Billing。
- `cf-aig-byok-alias` 只适用于 provider-native endpoint；Unified API 不支持选择任意 alias。
- `cf-aig-collect-log:false` 禁用整条 AI Gateway 日志；`cf-aig-collect-log-payload:false` 保留元数据但不保存 payload。
- Unified Billing ZDR 不会自动关闭 AI Gateway 日志。
- Unified Billing 公开限额为每 gateway 200 requests / 60 seconds；BYOK 不受该 UB 限额，但仍可能受用户配置的 gateway/provider 限流影响。
- 付费账号公开上限为 20 个 gateways；Logpush 最多 4 个 jobs/account；日志写入上限为 500 logs/second/gateway。
- Workers 的“6 条同时外连”是单次 invocation 中等待响应头的连接数，不是整个 Worker 实例并发上限。

官方依据：

- [AI Gateway Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
- [Unified Billing 与 ZDR](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- [Bring Your Own Keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [AI Gateway Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Rate Limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)
- [Spend Limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)
- [Troubleshooting / 鉴权头](https://developers.cloudflare.com/ai-gateway/reference/troubleshooting/)
- [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [AI Gateway REST API](https://developers.cloudflare.com/api/resources/ai_gateway/)

## 5. 已执行验证

| ID | 验证 | 结果 | 等级 | 是否满足退出门禁 |
| --- | --- | --- | --- | --- |
| `P0-R01` | Wrangler 当前身份和账号读取 | 通过 | `A` | 是，限只读权限 |
| `P0-R02` | Gateway 配置、限流、日志、ZDR、retry、spend limit | 通过 | `A` | 是 |
| `P0-R03` | Provider config 与 alias 清单 | 通过 | `A` | 是 |
| `P0-R04` | Secret Store quota | 11 / 100 | `A` | 是 |
| `P0-R05` | Unified Billing 余额、invoice、usage | 余额 0；未 onboarding；无历史 | `A/T` | 否，运行态尚不可测 |
| `P0-R06` | DeepSeek provider-native `GET /models` | HTTP 200，无模型推理 | `T` | 仅满足 default BYOK 基础路径 |
| `P0-R07` | 请求级禁日志支持性检查 | Ray ID 搜索 0 条；账号总计 17 条日志 | `T` | 否，仍需双模式强验证 |
| `P0-R08` | 生产 Proxy 数据库与正文日志 | PostgreSQL + Hyperdrive；正文日志关闭 | `A` | 是 |
| `P0-R09` | 仓库内合同/DPA/ZDR 证据检索 | 未发现 Cloudflare/供应商法务证据 | `C` | 否 |

## 6. 错误协议：已知与未知

| 场景 | 当前证据 | 允许写入状态机吗 |
| --- | --- | --- |
| Billing customer 未 onboarding | 实测 HTTP 400 / code 1000 | 只能用于控制面 readiness，不能映射成推理余额不足 |
| Spend Limit 超限 | 官方文档为 HTTP 429 | 尚不能按 body/错误码细分，需实测 |
| Gateway rate limit | 官方文档为 HTTP 429 | 尚不能区分账号、gateway、规则维度，需实测 |
| Unified Billing gateway 产品限额 | 官方文档 200/60/gateway | 尚未取得真实 429 响应结构 |
| Provider rate limit | 未实测 | 禁止只凭 429 推断故障域 |
| Credit 为 0/不足 | 仅账号余额快照 | **禁止假设 402**；实际状态码、body、扣费结果都未知 |
| 不支持供应商 + ZDR | 官方说明会使用普通非 ZDR UB | 严格请求应在 dispatch 前过滤，不能等待响应识别 |

在完成隔离实测前，V2 状态机必须保留 `cloudflare_error_unclassified`，并对 `zdr_required` fail closed。

## 7. 剩余受控测试计划

所有 prompt 必须是无敏感信息的合成文本，并使用独立 gateway、独立 token、最低额度和可删除的测试数据。

| ID | 测试 | 方法 | 外部影响/前置条件 | 退出证据 |
| --- | --- | --- | --- | --- |
| `P0-T01` | 隔离 gateway | 创建 `octafuse-phase0-*`，开启 gateway auth，默认禁缓存 | Cloudflare 写操作，占用 1 个 gateway slot | 配置快照和可重复脚本 |
| `P0-T02` | 日志双模式 | 唯一 marker 分别发送 `collect-log:false` 与 `collect-log-payload:false`，延迟后读取 metadata/body API | 会创建测试日志；需允许读取合成 payload | 完全无日志 vs 仅 metadata 的可复现差异 |
| `P0-T03` | OpenAI/Anthropic UB ZDR | 完成 billing onboarding 后，各执行一笔最小非流式和一笔最小流式请求 | 需要充值/可能后付费；需要成本上限 | 请求、配置、日志和账单四方证据 |
| `P0-T04` | 不支持供应商 + ZDR | 仅用公开合成 prompt 验证普通非 ZDR fallback | 可能产生一笔费用；严禁敏感数据 | 证明其不能进入严格候选集 |
| `P0-T05` | 非 default BYOK alias | 创建 `phase0-canary` alias，经 provider-native `/models` 或最小请求访问 | 修改 provider config；需要测试 secret | alias 选择、错误和日志证据 |
| `P0-T06` | Gateway rate limit | 隔离 gateway 临时设为 1/60，连续发送 2 次安全请求 | 临时配置变更 | HTTP、headers、body、恢复时间 |
| `P0-T07` | Spend Limit | 设置 API 允许的最小临时规则并触发 | 临时规则；可能产生极小费用 | 与普通 429 可区分的稳定字段 |
| `P0-T08` | 余额不足 | 在明确的余额/后付费边界下执行一笔最小请求 | 必须有书面成本授权和硬上限 | 实际状态码、body、账单副作用；不得预设 402 |
| `P0-T09` | Provider 429 | 分别测试 Cloudflare provider-config 限流与真实 provider 账号限流 | 需要隔离 provider 凭据/账号 | 两类 429 的可区分字段和故障域 |
| `P0-T10` | Logpush | 配置临时 job 到批准的测试目的地，发送合成事件后删除 | 需要外部 sink 和 Cloudflare 写操作 | 字段、脱敏、延迟、重试和删除证据 |
| `P0-T11` | Gateway hard limit | 不在生产账号堆满 20 个 gateway；只在专用测试账号或 Cloudflare 提供模拟方式时验证 | 高破坏性，不建议在当前账号执行 | 将其作为 provisioning error，而非运行时路由错误 |
| `P0-T12` | 合同证据 | 收集 Cloudflare DPA、ZDR 条款、provider 项目/账号留存承诺 | 法务/安全参与 | 带 owner、有效期、主体和撤销条件的证据记录 |

## 8. Phase 0 退出门禁

| 门禁 | 当前状态 | 阻塞原因 |
| --- | --- | --- |
| Cloudflare/供应商能力矩阵 | 部分通过 | 公开规则已核验，账号/模型/合同级证据不足 |
| ZDR 支持与不支持时行为 | 未通过 | 未完成隔离 UB 推理和 unsupported provider 负向测试 |
| AI Gateway 日志行为 | 部分通过 | 当前状态与单次禁日志支持性检查已完成，payload-only 未强验证 |
| UB 余额不足错误 | 未通过 | 账号未 onboarding，且没有费用授权 |
| Spend Limit / gateway / provider 429 | 未通过 | 不能在唯一现网 gateway 上制造限流 |
| 非 default BYOK alias | 未通过 | 当前只有 `default`，新增 alias 属于写操作 |
| Secret quota / API 读取权限 | 通过 | 11 / 100，相关只读 API 可用 |
| Logpush job 与权限 | 未通过 | 未配置测试 sink，现网 Logpush 关闭 |
| 合同与法务证据 | 未通过 | 仓库内无可用材料 |
| 故障逃逸等级 | 未决 | 尚未选择仅数据面多出口、Worker 旁路或第二入口 |

**总门禁：未通过。** 未完成项均已显式列出，当前设计不再依赖未经验证的 402、QPS、日志或 ZDR 假设。

## 9. 下一步授权边界

若要完成 Phase 0，需要用户/组织另行授权以下外部动作：

1. 创建并最终删除一个隔离的 Phase 0 gateway；
2. 创建临时 BYOK alias、限流规则、Spend Limit 和 Logpush job；
3. 明确 Unified Billing onboarding、最小充值或最大可计费金额；
4. 提供批准的 Logpush 测试目的地；
5. 指定可用于 OpenAI/Anthropic/DeepSeek 测试的账号与模型；
6. 提供 Cloudflare 和上游供应商的合同/DPA/ZDR 证据 owner；
7. 决定目标故障逃逸等级。

在取得这些授权前，建议保持现网不变，并把 `cinaos-ai` 标记为 `zdr_not_required` 的 DeepSeek BYOK 证据源，而不是复用为严格链路。

## 10. 可复现接口清单

以下接口可用于重放本报告的只读部分；请求使用最小权限 token，输出必须脱敏：

- `GET /accounts/{account_id}/ai-gateway/gateways`
- `GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}`
- `GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/provider_configs`
- `GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/logs?meta_info=true`
- `GET /accounts/{account_id}/secrets_store/quota`
- AI Gateway billing balance、invoice preview、invoice history、usage history 只读接口
- `GET /accounts/{account_id}/workers/scripts/cinatoken-proxy/settings`
- `GET https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/deepseek/models`，并设置 `cf-aig-collect-log:false`

不得在证据中保存 API token、provider secret、支付卡信息、完整请求/响应 payload 或 Worker secret 值。
