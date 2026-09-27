# C01 — AWS KMS 选型决定（已取代 / 历史记录）

版本：1.0；日期：2026-09-05。对应 C01.2、C01.4、C06、C08–C10。

**SUPERSEDED：用户随后改选 [Google Cloud KMS](./C01-google-cloud-kms-selection.md)。下文完整保留当时决定及技术草案，不再是当前实施指令；不再创建 AWS 资源或将其作为自动回退。** 本次变更不是生产迁移：此前 AWS 仅完成文档选型，未接入真实资源。

## 1. 已确认的决定与授权边界

用户明确选择：**“使用 AWS KMS”**。Credential Vault 首发密钥服务采用 AWS KMS，不再将 Cloudflare Secrets Store 软件 KEK 方案作为并列待选项或自动降级路径。

本次确认的是服务选型，不是账号/区域、部署拓扑、权限策略、费用或生产发布审批。状态为 **供应商已选定，部署与权限合同待冻结；C01 仍为 DOING**。执行记录：Codex；生产安全/运维验收责任人待指定。

本轮仅更新实施文档；未创建 AWS 资源、访问云账号、配置真实凭据、调用 KMS 密码操作、迁移数据或修改业务代码。历史 [Secrets Store / CinaAuth 核查](./C01-secret-store-cinaauth-assessment.md)保留为决策依据，本文取代其中“密钥服务尚未选择”的状态。

## 2. 后续实现采用的技术基线草案

以下是基于选型提出的实现约束，须在对应工作包验证，不把用户选择厂商扩展为所有参数均已获批。

| 项目 | 基线与边界 |
| --- | --- |
| KMS 密钥 | 建议 customer managed symmetric encryption key，使用 AWS KMS 生成的材料；不将 AWS managed service key、专属 CloudHSM 或自托管 HSM 视为本次选择 |
| 密钥数量 | 按环境、风险域和迁移生命周期划分，具体数量待定；不为每个供应商 Token 建一把 KMS key |
| 凭据存储 | 数据库保存逐 credential/version 的信封密文、wrapped DEK 和元数据；不逐 Token 创建 Secrets Store secret 或 AWS Secrets Manager secret |
| 本地开发 | 先用可替换 KMS 适配接口及合成密钥测试；mock 不得在生产配置缺失或 AWS 故障时自动启用 |
| Cloudflare Secrets Store | 仅保留必要的低基数基础设施秘密用途；不存 Vault 根密钥或其后备副本，不复用 CinaAuth 的身份秘密 |

Customer managed keys 允许客户控制策略和生命周期，区别于绑定 AWS 服务用途的 AWS managed keys。[AWS 密钥类型](https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html)

### 2.1 信封读写与绑定

建议每个新 credential/version 调用 `GenerateDataKey` 获取独立 AES-256 DEK，以认证加密保护 Token；保存返回的加密 DEK，明文 DEK 只短暂用于受控密码处理。读取时仅对最终获授权的候选调用 `Decrypt` 解开 DEK，不对全池或所有候选预解密。这遵循 AWS 的信封流程；它并不意味着 DEK 或上游 Token 永不进入应用内存。[GenerateDataKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html)

Envelope 至少包含格式/算法版本、不可混用的凭据身份与版本、风险域、实际 KMS key ARN、wrapped DEK、nonce、认证标签和密文。alias 可用于管理当前写入目标，但不作为历史密文唯一引用。字段编码、长度、AAD 规范化与 nonce 规则在 C06 固定并测试；不提前声称现有 `enc:v2` 已符合新合同。

KMS `EncryptionContext` 与应用 AEAD AAD 分别绑定一致的持久身份上下文；只使用经授权元数据重建的非敏感标识，不能盲信客户端传入的 tenant/key 引用。上下文可能以明文出现在 CloudTrail，不放 Token、邮箱、正文或敏感业务信息。请求/attempt 的短时授权与持久密文上下文分开，不能把每次变化的 attempt ID 写成历史密文的固定解密条件。[Encryption context](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html)

### 2.2 授权与承载位置

- 调度器只读 metadata；Broker 不持有全域 `kms:Decrypt` 权限或全库密文枚举权限。
- 受限 Vault 密码服务校验独立权威签发、绑定 credential/version/tenant/attempt/请求摘要的授权后，才读取目标密文并解密；不暴露客户端可提交任意密文的通用解密 API。
- 写入、运行时读取、密钥管理与迁移身份分离。按明确 key ARN、风险域和上下文约束最小权限；不向普通业务运行身份授予 `kms:*`、策略修改、禁用或删除密钥权限。
- EncryptionContext 不是业务授权的替代品：持有宽泛 Decrypt 权限的被攻破服务仍可能使用已知上下文解密。需以真实身份负向测试验证边界，合法在途 Token 工作集仍有泄漏风险。

建议优先评估由 AWS 承载受限 Vault 服务并使用 workload IAM role；这是候选拓扑，不是已经批准迁移 Broker 或整个网关。若从 Workers/其他云直接调用 KMS，必须另验短期身份来源、信任链、签名与权限，不能假定天然具有 AWS IAM role，也不默认分发长期 Access Key。AWS 推荐工作负载通过 IAM role 使用临时凭据，外部工作负载还需要适当的凭据交付机制。[IAM 最佳实践](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)

### 2.3 轮换、缓存与故障

1. **KMS 内部材料轮换**：逻辑 key ID 不变，历史密文由 KMS 选择相应材料解密；不等于轮换 DEK、重加密 Token 或处置 DEK 泄漏。应用 credential/envelope 版本不能冒充 KMS 材料版本。[AWS 轮换说明](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html)
2. **迁移到新 KMS key**：对原生 KMS wrapped DEK 可用 `ReEncrypt`，密码操作在 KMS 内完成；迁移身份仅在授权窗口拥有源 `ReEncryptFrom` 与目标 `ReEncryptTo`。它不是对现有应用密文格式的通用迁移器，修改应用 AAD 也不能靠重包 DEK 完成。[ReEncrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_ReEncrypt.html)
3. **泄漏处置与恢复**：DEK 泄漏需新 DEK 重加密，Token 泄漏需供应商撤销/换 Key；退役旧 KMS key 前验证当前数据和保留备份，不把“最新库已迁移”当作可删旧钥匙的充分条件。
4. **保守初始行为**：跨请求明文 DEK/Token 缓存先保持禁用；KMS 不可用时拒绝需要新解密的 dispatch，不退回 Secrets Store 根密钥、旧 `.env` 池或 mock。已接纳请求的查询/结算按原合同继续；已经发送且结果未知不能借 KMS 重试重发上游。
5. **后续容量优化**：缓存政策须单独固定 TTL、容量、epoch、撤权与故障边界，每次新 dispatch 仍验证授权。按真实 KMS 调用数、配额、费用和跨云尾延迟验收，不能只按 Token 数估算；本次未设置费用预算或生产 SLO。

## 3. 剩余决策与验证顺序

| 顺序 | 待确认 / 交付 | 通过前的限制 |
| --- | --- | --- |
| 1 | AWS 账号、目标区域、数据驻留要求、AWS 运维 owner | 不根据用户时区推断区域，不创建资源 |
| 2 | Vault/Broker 承载位置、风险域、服务身份和独立授权边界 | 不默认迁移整个应用，不把厂商选择当作权限隔离完成 |
| 3 | Key policy / IAM / 审计、备份轮换与删除保护、费用和调用上限 | 不接入真实密钥、迁移或宣称区域容灾已具备 |
| 4 | C03/C06 本地 schema、adapter、信封与篡改/跨租户/故障测试 | 只使用合成凭据；生产新格式写入仍关闭 |
| 5 | 获授权后完成 C06/C08/C09 的真实隔离环境测试，再进入 C10 门禁 | 不由 mock 通过推断真实 KMS、数据库角色或撤权验证通过 |

下一项仍是 **C01：冻结承载位置、身份与区域等相关合同**；不再重复询问选择哪个 KMS。其他 C01 账务/发布决策不因本次选型自动完成，C01.2 和 C01.G 保持未勾选。

## 4. 本轮核验范围

官方资料核验日期为 2026-09-05，仅访问公开文档；没有真实 AWS 权限、性能、价格账单或区域可用性实测。本轮校验文档链接、清单门禁一致性与变更范围，不运行业务测试来替代尚未发生的实现。

Cloudflare 技能用于核对 Secrets Store 可读 secret 的边界，促使本次明确其不再承担 Vault 根密钥或故障回退职责；未照搬技能示例中的失败后切换秘密重试模式。
