# C01 — Google Cloud KMS 选型决定

版本：1.2；更新日期：2026-09-06。对应 C01.2、C01.4、C06、C08–C10。v1.1 登记用户指定项目及只读 CLI 核验；v1.2 补 API 已启用的后续观察，保留历史状态。

## 1. 当前决定与授权边界

用户最新明确选择：**“使用 Google Cloud KMS”**。Credential Vault 首发密钥服务改为 **Google Cloud KMS**，取代此前 AWS KMS 决定。原 [AWS 记录](./C01-aws-kms-selection.md)保留为已取代的历史依据，不再指导新实现，也不作为故障时的备用解密服务。

用户后续已指定 GCP project 为 **`cinatoken`**，CLI 核验见第 5 节。厂商与项目确认不等于确认 location、保护级别、部署位置、IAM、费用或发布。C01 仍为 **DOING**；C01.2/C01.G 未通过。执行记录：Codex；生产安全/运维验收责任人待指定。

选型切换当轮仅更新文档：C02.B 在只读检查阶段收到选型变更，当时尚未修改代码；既有 C02.A 源码、测试、CI 及历史结果保留，当轮没有访问云账号或操作云资源。后续 C02 的本地代码推进分别记入实施证据；v1.1 的云账号访问严格限于第 5 节的只读元数据检查，没有配置真实密钥、执行 KMS 密码操作、迁移或部署。

## 2. 技术基线草案

以下约束供后续本地实现与真实环境验收，不能把厂商选择扩张为全部参数获批。

| 项目 | Google Cloud KMS 路径 |
| --- | --- |
| 密钥组织 | 按环境/风险域组织少量 CryptoKey；数据库保存逐 credential/version 的密文及 wrapped DEK，不逐 Token 创建 KMS key 或 secret |
| DEK 生成 | 在受限密码服务用密码学安全随机源生成每个新 credential/version 的独立 256-bit DEK；以 AES-256-GCM 保护 Token，再调用 KMS Encrypt 包装 DEK |
| 受控读取 | 完成业务授权后只读取最终候选密文，调用 KMS Decrypt 解开 DEK，再解密 Token；不对全池预解密 |
| 材料边界 | KEK 留在 Cloud KMS；DEK 与 Token 会短暂进入受限应用内存，不声称所有明文均不出 KMS |
| 本地/故障 | 本地合成凭据与可替换 adapter；生产缺少配置或 KMS 故障时不得启用 mock、软件 KEK、旧 `.env` 池或 AWS 回退 |
| Secrets Store | 只保留必要的低基数基础设施秘密用途；不存 Vault 根密钥或其后备副本，不复用 CinaAuth 身份秘密 |

逐对象本地生成 DEK、由少量 KMS KEK 包装的结构遵循 Google 的[信封加密流程](https://docs.cloud.google.com/kms/docs/envelope-encryption)，不是把 AWS `GenerateDataKey` 接口改个名称。

### 2.1 保护级别与资源引用

对称加密是当前基线方向；`SOFTWARE` 与 `HSM` 的实际密码操作保障不同。**选择 Cloud KMS 不自动等于选择 Cloud HSM**，保护级别须结合原方案安全要求、区域、容量与费用单独冻结；本轮不默认采购 HSM，也不默认接受较低保障。[保护级别](https://docs.cloud.google.com/kms/docs/protection-levels)

Envelope 至少记录格式/算法版本、`keyProvider`、风险域、credential/owner/环境/凭据版本、完整 CryptoKey resource name、实际加密的 CryptoKeyVersion resource name、wrapped DEK、nonce、认证标签与 Token 密文。资源名使用 `projects/.../locations/.../keyRings/.../cryptoKeys/...` 层级，不使用 AWS ARN/alias。

`Encrypt` 可指定 CryptoKey 或版本，指定 CryptoKey 时采用 primary version；应检查并记录响应 `name` 返回的真实版本。`Decrypt` 使用 CryptoKey，由服务选择密文对应版本；不要把仅记录的 primary 指针当成所有历史密文的版本，也不要把版本路径当作普通对称 Decrypt 的请求资源。[Encrypt API](https://docs.cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys/encrypt)、[Decrypt API](https://docs.cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys/decrypt)

适配器还需验证请求/响应 CRC32C、返回资源和 protection level；校验失败拒绝使用结果。DEK/密文/AAD 都是有上限的字节值，按已选保护级别验证长度，不套用无限字符串接口。这是后续 C06 测试要求，尚未实现。

### 2.2 AAD 与授权

KMS 的 `additionalAuthenticatedData` 和 Token 层 AES-GCM AAD 分别绑定经授权元数据重建的持久身份上下文；规范化编码与用途区分在 C06 固定。必须在解密时重建相同字节，不能盲信客户端提供的 AAD、tenant 或 key reference。每次变化的 attempt 授权与持久密文身份分开。

Google 的 AAD 不包含在 KMS 密文内，官方说明也不由 Cloud Audit Logs 记录；仍应避免放入 Token、邮箱、正文等秘密或个人信息。**AAD 是完整性绑定，不是独立的租户授权，更不能照搬 AWS EncryptionContext 的 IAM 条件语义。** 持有过宽 Decrypt 权限且能重建上下文的被攻破服务仍可能滥用解密。[AAD 合同](https://docs.cloud.google.com/kms/docs/additional-authenticated-data)

### 2.3 身份、最小权限与审计

- 调度器只读 metadata；Broker 不直接持有全域解密权限或全库密文枚举能力。受限 Vault 服务独立验证 tenant/grant、credential/version、Target、attempt 和请求摘要后才解密，不暴露任意密文解密/批量 reveal API。
- 写入身份可按目标 key 授予 `roles/cloudkms.cryptoKeyEncrypter`，运行时读取身份按所需 key 授予 `roles/cloudkms.cryptoKeyDecrypter`；密钥管理和迁移身份分开。避免在整个 project/key ring 授予超出风险域的密码权限，也不赋予运行身份 IAM 修改、禁用或销毁权限。[KMS 角色权限](https://docs.cloud.google.com/iam/docs/roles-permissions/cloudkms)、[资源级 IAM](https://docs.cloud.google.com/kms/docs/iam)
- GCP 承载与 Workers/其他云直连均仍是待选拓扑，不据此迁移整个网关。外部工作负载优先评估 Workload Identity Federation 短期身份；必须验证可信 issuer、subject、audience、属性条件及刷新。不能假设 Workers 天然拥有可被 GCP 接受的工作负载身份，不默认下发长期 service-account JSON key。[Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation)
- Encrypt/Decrypt 属于 Data Access 审计范围，需要配置并实测相应日志、保留与访问控制；另建脱敏 credential/attempt 业务授权审计。云审计不替代业务授权，也不证明每条业务上下文已自动记录。[KMS 审计](https://docs.cloud.google.com/kms/docs/audit-logging)

### 2.4 轮换、迁移与故障

1. **KMS key rotation** 创建新版本供新写使用，不自动重加密历史数据，也不会自动停用旧版本。应用 envelope/credential 版本与 KMS key version 分开管理；停旧前必须验证当前数据和保留备份。[轮换说明](https://docs.cloud.google.com/kms/docs/key-rotation)
2. **wrapped DEK rewrap** 按 Google 的 Decrypt → Encrypt 流程设计，在受限迁移进程内短暂取得 DEK 后重新包装；不照搬 AWS `ReEncrypt` 的服务端零明文返回假设。迁移身份只在授权窗口持有源 key 解密及目标 key 加密权限，不保存/打印 DEK，采用有界批量、CAS 与 checkpoint。仅重包 DEK 不要求解密 Token；但改变 Token 层 AAD 或 DEK 则需要受控重加密。[重加密流程](https://docs.cloud.google.com/kms/docs/re-encrypt-data)
3. **泄漏处置** 与常规轮换分开：DEK 泄漏需要新 DEK；Token 泄漏需要供应商撤销/换 Key，重新包装数据库中的 DEK 不能使已泄漏 Token 失效。现有 `enc:v2` 也不是可直接提交 KMS 的 wrapped DEK，C09 另做格式迁移。
4. **缓存/不可用**：跨请求明文 DEK/Token 缓存先禁用；每次新 dispatch 仍检查权威授权。KMS 不可用时拒绝需要新解密的发送，保留已接纳请求的查询与结算；重试 KMS 不能触发结果未知的模型请求重放。
5. **容量与预算**：按密码操作次数、活动密钥版本、保护级别、调用配额、跨云尾延迟和审计成本验收，不以 Token 数直接等同 KMS key 数或调用量；具体价格/预算/SLO 未冻结。本轮没有价格或区域容量实测。

## 3. 剩余决策与验收顺序

| 次序 | 必需输入/证据 | 通过前的限制 |
| --- | --- | --- |
| 1 | project 已指定为 `cinatoken`；仍需 KMS location、保护级别、数据驻留要求及运维 owner | 不根据用户时区推断区域，不创建资源 |
| 2 | Vault/Broker 承载、风险域、服务身份与独立授权合同 | 不默认迁移全部应用或分发长期凭据 |
| 3 | IAM、Data Access 审计、轮换/销毁保护、恢复与调用/费用上限 | 不执行真实密码操作、数据迁移或云切流 |
| 4 | C03/C06 的 schema、Google adapter、信封、AAD/资源替换、完整性、轮换与故障测试 | 本地合成密钥通过不启用生产新写 |
| 5 | 获授权后的 C06/C08/C09 真实隔离环境验收，再进入 C10 | mock 不替代真实 IAM、撤权、数据库角色、配额与恢复验证 |

本次仅更换尚未落地的厂商合同，不需要 AWS→GCP 生产迁移，也不增加两套并存 Vault。主 Checklist 的 C02.B 本地 deadline 工作顺序不变，C01 其他账务/商业决策继续待确认；不再询问选择哪家 KMS。

## 4. 首轮公开资料核验范围（历史）

2026-09-05 核验上述 Google 官方公开资料；只检查文档链接、当前选型一致性、工作树摘要及 C02.A 受测源码哈希。无 GCP/AWS 账号、IAM、真实密钥、性能或账单实测，也未重跑业务测试来冒充本轮 KMS 实现完成。

## 5. 后续 CLI 与项目就绪核验（v1.1）

2026-09-05，用户说明已安装登录，并明确 Project ID 为 `cinatoken`。本地 PATH 尚不能解析 `gcloud`，在标准用户安装路径发现 CLI；默认沙箱拒绝启动后，经工具审批执行以下只读命令，最终均退出 0：

| 检查 | 命令（省略本机绝对 CLI 路径） | 实际结果 |
| --- | --- | --- |
| 本机登录 | `gcloud auth list --filter=status:ACTIVE --format='value(account)' --quiet` | 返回一个活跃账号；不在文档记录邮箱，不读取或输出访问令牌 |
| 默认项目 | `gcloud config get-value project --quiet` | `(unset)`；未修改全局 CLI 配置 |
| 指定项目 | `gcloud projects describe cinatoken --format='json(projectId,projectNumber,lifecycleState)' --quiet` | projectId 为 `cinatoken`、lifecycleState 为 `ACTIVE` |
| KMS API | `gcloud services list --enabled --project=cinatoken --filter='config.name:cloudkms.googleapis.com' --format='value(config.name)' --quiet` | 没有返回匹配服务，当前未列入已启用服务 |

这仅证明 CLI 登录、项目元数据可访问及该时点 API 列表状态，不证明应用 ADC、生产 workload identity、KMS CryptoKey IAM、计费账号、配额或数据驻留已就绪。未执行 `services enable`、`config set`、key ring/key 创建、IAM 修改或任何真实 Encrypt/Decrypt。已经向用户询问 location/保护级别；后续外部操作仍需明确目标、风险/费用与相应授权。无需再询问厂商或 Project ID。

## 6. 2026-09-06 后续只读复核（v1.2）

用户再次确认 `cinatoken` 后，经工具审批在已安装 CLI 上复核：活跃登录仍存在；默认 project 仍为 `(unset)`；指定项目为 `cinatoken` / `ACTIVE`；已启用服务列表现在返回 **`cloudkms.googleapis.com`**。四项命令的组合进程退出 0。登录检查只输出 `status`，不记录账号邮箱或令牌。

因此第 5 节“API 未列入启用服务”是历史观察，**当前 API 已启用**。本任务未执行启用操作，也不推断变更的操作者或时间。仍未创建 KeyRing/CryptoKey、修改 IAM、设置默认项目或执行密码操作。location、SOFTWARE/HSM、运行身份和真实集成门禁不因 API 启用而通过。
