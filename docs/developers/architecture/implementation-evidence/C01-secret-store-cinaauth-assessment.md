# C01 — Secrets Store 可行性与 CinaAuth 资金能力核查

日期：2026-09-05。状态：**DOING；两项调研已完成，用户最新选择 Google Cloud KMS（取代先前 AWS），其余部署/权限和商业规则尚未全部冻结。**

当前决定：[Google Cloud KMS 选型记录](./C01-google-cloud-kms-selection.md)；[AWS 记录](./C01-aws-kms-selection.md)已取代。下文保留软件 Vault 的可行性分析作为历史比较，不表示仍需用户在两条路线间选择；当前不采用软件 KEK 或 AWS 作为自动回退。

执行 / 本地复核：Codex。业务、财务、安全和发布签核人：待指定。本文件是决策输入，不是已批准的 ADR，也不是生产验收。

## 1. 结论

1. **Cloudflare Secrets Store 可以作为 Vault 的少量根秘密存储，但不能直接等同于 KMS/HSM。** 如果根密钥经 binding 读入 Worker，由应用执行加解密，这是软件密钥服务方案，需要单独接受其安全边界。
2. **大量供应商 Token 应留在数据库的逐凭据信封密文中，不逐条放入 Secrets Store。** 根密钥数量随环境、风险域和轮换版本增长，不随每个 Token 增长；这解决 Secret 数量耦合，但不自动解决数据库容量、调度或安全问题。
3. **CinaAuth 当前不是可直接对接的 Token 预付资金账本。** 已发现身份/组织权限、条件启用的订阅计费及 SIWE 钱包地址管理；未发现完整充值、可用余额、资金预留/扣款、退款和卖家支付合同。
4. 本地实现建议继续遵守 CinaToken 已有领域边界：CinaAuth 管身份和组织；CinaToken 管推理计量、预算、价格、产品权益与资金账本。支付渠道及未来集团资金服务的选择仍须确认，不能以“已有 Stripe 插件”视为资金接入完成。

## 2. 核验范围与限制

| 项目 | 核验基线 | 核验方法 |
| --- | --- | --- |
| CinaToken | `7eb59008f7d8e156e81fd18a57658fdef2553264`，含既有未提交改动 | 阅读当前 checklist、V2.1 相关约束和身份领域边界；保留 C00 证据 |
| CinaAuth | `ddaf304ed86c9c3f3f93a3044efc3cff638e52f3`；核查时工作树 clean | 在 `C:/cinagroup/cinaauth` 阅读 Auth Worker 注册、订阅路由/schema、权益合同和钱包 schema |
| Cloudflare | 2026-09-05 读取官方文档 | 核对额度、读取方式、权限、轮换管理和审计范围 |

未读取 `.env` / `.dev.vars` 的真实值、数据库记录或生产用户正文；未访问付费 API、支付后台或云账号配置；未部署、迁移、创建 secret 或运行 CinaAuth 业务测试。源码存在不代表线上已启用，文档描述也不替代真实交易/权限测试。

CinaAuth 的否定结论范围是当前本地仓库中受版本控制的实现，不扩展为“集团其他项目或远端分支一定没有资金服务”。检索覆盖 `workers`、`apps`、`packages`、`docs`，并沿命中的入口追踪后端；没有仅凭文件名或关键词缺失下结论。

## 3. Secrets Store：能承担什么

### 3.1 官方事实

| 事实 | 对本方案的影响 |
| --- | --- |
| 当前公开 Beta 文档仍为每账号 100 个生产 secret、一个 store、单 secret 不超过 1024 bytes | 不能一 Token 一 secret，也不能把全池 JSON 打包成一个 secret；账号实际使用量需另行核验 |
| 关联的 Worker 可通过 `binding.get()` 取得 secret 值；管理 REST API / Dashboard 不提供明文读取 | 能保存软件 KEK，但明文会进入获授权 Worker；管理界面不显示不代表运行时代码无法读取 |
| 权限和服务 scope 共同决定绑定/使用；Read 为元数据，Edit 涵盖绑定所需权限 | 部署身份也在根密钥信任边界内，不能只限制运行时路由 |
| Secrets Store 目前集成 Workers、AI Gateway；文档描述全球存储 | 不能假设 Node 可通过管理 API 直接取值，也不能由此证明指定区域驻留 |
| 审计文档列出 Access/Create/Update/Delete | 仍需自己的 credential/attempt 级授权与解密审计，不能推断平台日志已包含每次业务授权上下文 |

来源：[限额与管理](https://developers.cloudflare.com/secrets-store/manage-secrets/)、[Workers 读取](https://developers.cloudflare.com/secrets-store/integrations/workers/)、[权限](https://developers.cloudflare.com/secrets-store/access-control/)、[产品范围](https://developers.cloudflare.com/secrets-store/)、[审计](https://developers.cloudflare.com/secrets-store/audit-logs/)。

上述额度是核验日的公开合同，不把历史 Phase 0 的账号占用值当成当前余额。本文没有查询账号配额。

### 3.2 两条候选路线，不混淆保障等级

| 路线 | 根材料与密码操作 | 优点 | 代价 / 不可宣称的保障 | 当前状态 |
| --- | --- | --- | --- | --- |
| A：Cloudflare 软件 Vault | Secrets Store 保存低基数 KEK；隔离的密码服务 Worker 执行逐凭据 DEK 的封装/解封；数据库保存密文 | 可留在 Cloudflare 技术栈；Token 数不受逐 secret 配额限制 | 根 KEK 对密码服务运行时代码可读；需自建授权、轮换和审计；不是不可导出硬件主密钥 | 技术上可行的候选；未获生产选择/风险接受 |
| B：保留 V2.1 的受管 KMS 路径 | 受管 KMS 承担密钥操作；Secrets Store 仅保存必要的低基数连接/引导秘密，优先短期服务身份 | 可按所选产品验证非导出密钥、独立权限与审计能力 | 新服务依赖、费用、配额和可用性；KMS 也不自动理解租户授权或阻止所有任意解密 | 用户最新选择 Google Cloud KMS；project/location/保护级别/部署/权限仍待冻结和验证 |

这里的 KMS 非导出性、硬件级别、地域和审计能力都需要对具体产品验证，不能只凭“KMS”名称承诺。Workers 的其他密码 binding 也不因名字相似就等于 Secrets Store，若采用需独立评估。

**当前决定：采用 B 的 Google Cloud KMS 路径，固定 envelope 和受限密钥操作合同，用本地模拟继续验证；A 仅保留为历史比较，不作为并列待选或自动回退。** 用户选定厂商不等于保护级别、真实权限或生产门禁已经通过，本文不降低原方案保障。

### 3.3 选择 A 时必须同时接受和实现的边界

这是本平台的架构建议，不是 Cloudflare 提供的现成功能：

- **调度器只读 metadata**；Broker 不绑定全域 KEK，也不持有可枚举全部凭据密文的数据库权限。
- 独立密码服务验证由独立权威签发的、绑定 credential/version/tenant/attempt/请求摘要的短时授权；禁止提供任意密文解密、批量 reveal 或返回根密钥的 API。
- 一次凭据释放不能被描述为一次外部执行的密码学保证：Broker 获得某个上游明文 Token 后，若自身已被接管，仍可能滥用该工作集。必要时将最终出站收进更小的可信服务，另验单次 dispatch 边界。
- 密码服务受攻击时，读取到的 KEK 会扩大其风险域；“只解密 Top-K”是正常程序行为，不是根密钥泄漏后的密码学隔离保证。环境/风险域要分钥，部署权限也要隔离。
- 每把 credential/version 用独立 DEK；密文保存 `envelopeVersion`、`keyProvider`、`keyDomain`、`keyVersion`、wrapped DEK、认证加密参数及 AAD 上下文。算法与 nonce 唯一性要求在 C06 固定并测试，不使用普通口令直接充当 AES 密钥。
- 不复用 CinaAuth 的登录、OIDC bridge、身份事件或 delivery secret 作为 Token Vault 根密钥；可以复用读取失败即拒绝的模式，不能复用同一秘密。
- Secrets Store 不可达时不得退回旧 `.env` 明文池；缓存只允许按已批准合同复用密码材料，新 dispatch 仍走权威授权/撤权判断。未批准缓存降级政策前不靠旧缓存扩权放行。
- 外部 Node Broker 若依赖 Cloudflare 密码服务，仍受 Cloudflare 故障影响，不能同时声称实现了完整 Cloudflare 故障逃逸；C14 必须检验整条依赖链。

### 3.4 容量、轮换和恢复

容量预算按 `环境数 × 风险域数 × 同时保留密钥版本数 + 其他基础设施 secrets + 运维余量` 估算。各域保留版本不同时按实际逐域求和。

例如两环境、四风险域、每域保留三个版本需 24 个根 secret，另加其他服务占用；这只是算术示例，不是已批准的分域方案。旧备份所需版本也要计入，不能假设永远只保留两把钥匙。Token 从一万增长到更多不会自动增加根 secret，但风险域过大、候选查询和请求吞吐仍需 C07/C10 的容量与安全证据。

常规轮换使用新名称/明确版本：准备新 KEK → 新写切新版本 → 有界 rewrap 旧 DEK → 校验当前数据和保留备份恢复能力 → 经审批退役旧版本。不能原地覆盖唯一根值后才发现历史密文无法解开。Cloudflare 支持编辑 secret 值，不代表它自动保留 Vault 所需的不可变旧版本。[管理操作](https://developers.cloudflare.com/secrets-store/manage-secrets/how-to/)

KEK 泄漏不只需要 rewrap；攻击者若已取得旧 KEK 和旧 wrapped DEK/密文，仅重包当前 DEK 不能撤回其访问能力，需按受影响范围重新生成 DEK/加密，并评估上游 Token 撤销。上游 Token 已泄漏时必须在供应商处撤销/轮换，数据库重新加密不能使旧 Token 失效。C06/C09 要分别演练正常轮换、泄漏处置及旧备份恢复。

## 4. CinaAuth：真实存在的是订阅与身份能力

### 4.1 代码证据

以下路径均对应上述 CinaAuth commit；行号为核验时的位置。

| 能力 | 已核验的实现 | 不能据此推断 |
| --- | --- | --- |
| Stripe 插件挂载 | [plugins.ts](C:/cinagroup/cinaauth/workers/auth-api/src/plugins.ts:697) 按配置挂载；订阅功能还依赖完整 plans | 生产已开通 Stripe、已有可用余额或收付款已验证 |
| 订阅生命周期 | [插件入口](C:/cinagroup/cinaauth/packages/stripe/src/index.ts:39) 注册 upgrade/cancel/restore/list/success/billing-portal | 通用充值订单、资金冻结/消费、退款账本或卖家付款 |
| Webhook | [routes.ts](C:/cinagroup/cinaauth/packages/stripe/src/routes.ts:1988) 验签并处理 Checkout 与 subscription 事件；其余为可选回调 | 已有充值入账消费者、资金事件去重和金额/币种对账；取消订阅也不是退款 |
| 持久化 | [schema.ts](C:/cinagroup/cinaauth/packages/stripe/src/schema.ts:5) 存计划、referenceId、Stripe IDs、订阅状态/周期/席位 | 双分录/平衡分录、可用/预留余额、货币精度或经济事件唯一键 |
| 权益 | [entitlements.ts](C:/cinagroup/cinaauth/packages/auth-web-contract/src/entitlements.ts:1) 列出 SSO、SCIM、成员、teams、OAuth/API Key 等功能及数量上限 | 推理模型权限、Token Credits、BYOK 服务费或供应商收益 |
| 配置完备性 | [运行时配置](C:/cinagroup/cinaauth/workers/auth-api/src/entitlements.ts:156) 需要 Stripe key、webhook secret、Price 和完整权益配置 | 单凭两项 secret 就能宣称可收费；生产状态仍 UNKNOWN |
| 钱包 | [SIWE schema](C:/cinagroup/cinaauth/packages/cinaauth/src/plugins/siwe/schema.ts:4) 存 userId/address/chainId/isPrimary/createdAt；[管理入口](C:/cinagroup/cinaauth/packages/cinaauth/src/plugins/admin/wallets.ts:36) 管地址绑定 | 托管私钥、链上余额索引、充值确认、归集、提现或支付账户 |
| Secrets Store 接入模式 | [runtime-secrets.ts](C:/cinagroup/cinaauth/workers/auth-api/src/runtime-secrets.ts:12) 已有 binding 优先、失败不回退的运行时读取模式 | 逐凭据信封 Vault、非导出主密钥或资金模块 |

文档交叉检查：[CinaAuth Entitlement contract](C:/cinagroup/cinaauth/docs/CINAAUTH_ENTITLEMENTS.md:1)。其中 `unmetered` 表示身份产品的部署默认访问模式，不是“无限 Token 余额”。该文档部分默认数量描述应以当前 `createUnmeteredEntitlementSnapshot` 源码为准，本次不把它扩用为资金规则。

关于 Polar / Creem / Dodo Payments 的搜索命中主要来自插件介绍/回调文档，不能当作 Auth Worker 已实现统一资金服务的证据。

### 4.2 建议的领域分工

| 领域 | 权威归属 / 建议 | 集成边界 |
| --- | --- | --- |
| 登录用户、组织、成员与角色 | CinaAuth 现有权威 | 使用 OIDC subject、稳定 organization ID、签名身份事件；不直读写其数据库 |
| CinaAuth 自身订阅和身份产品权益 | CinaAuth 现有实现 | 不把 Auth plan 自动换算成 CinaToken Credits |
| Token 计量、价格、策略预算、推理产品权益 | CinaToken 现有领域边界 | 复用现有 admission/reservation/usage/收益主键，补快照与 outbox |
| 买家预付 Credits、资金预留/消费/退款、卖家应付与可提现状态 | 建议在 CinaToken 领域补齐；现有实现不等于已完成 | 可先在同项目模块化实现，不要求先新建独立微服务；支付渠道通过受限适配器接入 |
| 集团统一资金服务 | 当前未证明存在 | 未来明确需要时以新 ADR、版本化接口和迁移统一权威，不双写两个可用余额 |

此建议与 [CinaToken 已有身份边界](../organization-identity-boundary.md:5) 一致。它确认领域方向，但不是支付供应商、法币/链币、费率、退款责任、提现政策或正式财务审批的替代品。

### 4.3 C11 不能遗漏的新增工作

- 资金账户、币种与精度；充值订单与可验证到账事实；平衡分录/不变量、可用/预留/冻结状态及经济事件幂等键。
- 统一资金 `reserve / capture / release / adjust` 合同及崩溃恢复；沿用推理请求/attempt/usage 事实，不能复制成两套互不一致的消费结算。
- 回调验签、事件去重与乱序、订单/账户/金额/币种匹配；成功页和订阅 active 状态都不能直接增发余额。
- 退款/拒付、负向调整、未知支付结果、审计和对账；买家付费余额、赠送权益、策略预算和卖家应付必须可区分。
- 卖家 pending/available/held/paid、结算条件、提现幂等及外部结果查询；复用现有收益结构但不能把 unknown 自动转成可提现款。

这些是待实现合同，不是对当前代码的完成声明；收费/支付/提现依然分别受 C11/C12/C15 的授权与验收限制。

## 5. 回填主 Checklist 的有限决策顺序

调研事实可以作为本地接口草案依据；下列未决项不能因为已写入文档就勾选通过。

| 次序 | 对应工作包 | 决策 / 交付物 | 完成条件 |
| --- | --- | --- | --- |
| D01 | C01.2 | 厂商已改选 Google Cloud KMS；继续冻结承载位置、project/location、保护级别、风险域与独立授权边界 | 选型决定已记录；安全 owner 仍需确认真实身份/策略、故障域及残余风险，不重复询问厂商 |
| D02 | C01.5 | 确认 CinaToken 资金领域，不以 CinaAuth subscription/walletAddress 冒充现有钱包服务 | 技术/财务 owner 确认权威、账户主体、币种/精度；支付渠道另列待定，不阻塞本地合同 |
| D03 | C01.3–C01.4、C01.7、C01.10 | 冻结有界 attempts、撤权线性化、unknown、报价和本地测试参数 | 参数有版本，安全/费用边界可测试；生产 SLO/费用仍独立审批 |
| D04 | C02–C03 | 先实现执行上限和稳定 schema/受限接口 | 只依赖已冻结且通过相关本地门禁的子集；不启用真实密钥/资金 |
| D05 | C04–C09 | 快照/outbox、对账、envelope、Top-K、授权和迁移工具 | 不用密码服务替代授权服务；不以软件模拟冒充真实权限隔离 |
| D06 | C10–C12、C15 | 核心集成、Credits/供给结算及发布 | 真实环境、资金渠道、故障恢复与费用授权证据齐备 |

主清单的 C13/C14/C17 条件分支和 C16–C20 扩展范围保持不变。原调研当轮未推进 C02 代码、不修改 V2.1 原方案或创建云资源；后续 C02.A 已有独立证据，当前下一工作以主 Checklist 为准。此次 Google 选型更新不重写原调研事实。

## 6. 本轮证据与未完成项

已完成：官方资料核验、CinaAuth 本地源码链路追踪、能力/缺口表、主 checklist 决策输入更新及文档结构/链接检查。

未完成：Google Cloud KMS/Broker 的部署与权限合同及真实权限实验、生产 Billing 启用确认、支付与资金账本实现、真实交易及供应商调用测试。厂商选型已由最新用户请求更改，见当前选型记录；C01.G 保持未勾选。

本轮文件变更只限本报告、主 checklist 和证据索引；CinaAuth 仓库与两项目业务代码均未修改。Cloudflare 技能要求的最新官方事实核验使本报告明确区分了 secret 明文读取与 KMS 密码操作，未直接套用缓存示例中的通用失败重试。
