# Model Endpoint backfill / reverify 生产运行手册

本文定义 `model_endpoints` 与 `model_endpoint_routes` 的 manifest-driven `plan`、受审计 `apply`、报告恢复、核对和真实 Provider canary 流程。当前仓库本地实现支持 PostgreSQL 与 MySQL apply；D1 仅支持只读 plan，apply 必须 fail closed。

本文描述代码与本地合同，不表示迁移已经应用到远端数据库、Endpoint 已回填、Workers 已部署，或真实 Provider 已通过验收。示例 manifest 位于 [`scripts/db/model-endpoints/manifest.example.json`](../../../scripts/db/model-endpoints/manifest.example.json)。

## 1. 角色分离与安全不变量

一次生产变更至少包含以下互不相同的主体与 Ed25519 公钥：

- `manifest_actor`：创建并签署 manifest，principal 必须等于 `manifest.actor_id`。
- 每个 `evidence_reviewer`：审核 manifest 中以其 principal 命名的全部 Endpoint 证据。每个不同的 `evidence.reviewed_by` 都需要自己的签名。
- `apply_approver`：批准本次写入，必须与 actor、所有 reviewer 使用不同 principal 和不同公钥。
- 数据库 apply identity：执行 migration/bootstrap/apply 的受控数据库身份。它必须与公共 Worker runtime role 分离。

必须保持以下不变量：

1. 私钥只存在于受控签名器、HSM 或 KMS；manifest、approval、环境变量、报告和日志中都不得出现私钥、Provider credential、DSN、Cloudflare token 或加密 secret。
2. `plan` 永远只读。D1、PostgreSQL 和 MySQL plan 使用有界双读检测并发漂移；它不是数据库事务快照，报告会标记 `snapshot_consistent: false` 和 `database_identity_verified: false`。
3. `apply` 必须同时使用 `apply` 子命令和显式 `--apply`，并且只接受 PostgreSQL 或 MySQL。D1 apply 固定拒绝，直到部署并单独审计 Worker-bound `D1Database.batch` writer。
4. PostgreSQL/MySQL apply 在同一 serializable 事务中取得非等待式单写者锁、验证数据库持久身份和 signer trust root、读取数据库时钟、重新规划、执行 CAS、写 Endpoint/Route、写追加式 run/evidence ledger，并在提交边界再次检查审批与证据有效期。
5. legacy `providers.endpoints`、`model_routes.routing_metadata`、`price_override` 和 `models.pricing_profile` 不能成为 Endpoint 权威证据。Route + Provider subject 漂移、缺少事实、过期证据或 revision 冲突一律 fail closed。
6. 报告路径必须是父目录已存在的新绝对路径。apply 在第一次可能写数据库前独占预留最终路径；任何已有文件都不会被覆盖。
7. 数据库提交和本地报告发布是两个故障域。退出码 `7` 表示数据库已提交而报告待恢复，绝不能把它当作回滚或安全重放信号。
8. 账本只能追加。禁止更新或删除数据库 identity、signer trust root、apply run 和 evidence attestation；修正生产事实只能使用新的 manifest、证据、审批和前向 apply。

## 2. Migration、持久数据库身份与账本

### 2.1 Migration 门槛

manifest 的 `target.required_migration` 仍绑定 Endpoint/audio capability 的最低读取合同；apply 另外要求 evidence ledger migration：

| Driver | manifest 的 plan 最低 migration | evidence ledger migration | Apply 状态 |
| --- | --- | --- | --- |
| D1 | `0049_model_endpoint_audio_capabilities.sql` | `0050_model_endpoint_evidence_ledger.sql` | 禁用；仅 plan |
| PostgreSQL | `0048_model_endpoint_audio_capabilities.sql` | `0049_model_endpoint_evidence_ledger.sql` | 本地实现 |
| MySQL | `0045_model_endpoint_audio_capabilities.sql` | `0046_model_endpoint_evidence_ledger.sql` | 本地实现 |

先由独立迁移流程应用目标数据库对应的 migration，再运行本工具。不要让 backfill CLI 自动迁移。plan 会核验 manifest 指定的最低 migration 是否存在并记录实际 head；缺失或 ledger 顺序异常会阻断，head 更晚时会产生兼容性复核警告。apply 还会在事务中再次确认 PostgreSQL `0049` 或 MySQL `0046` 已存在。

D1 `0050` 只建立与未来 writer 对齐的 identity、空 trust-root slot、run 和 attestation 表及不可变触发器；它不会启用 D1 apply。

### 2.2 数据库生成的持久 fingerprint

ledger migration 创建 singleton `model_endpoint_backfill_database_identity` 并由数据库生成一次 `sha256:<64 lowercase hex>` fingerprint。该值是非秘密实例标识，不是 DSN 的摘要：

- PostgreSQL 同时持久化 database name、database OID、`cinatoken_gateway` schema 和执行 migration 的 `apply_role`。
- MySQL 同时持久化 database name、server UUID 和执行 migration 的 `apply_user`。
- D1 仅预置 fingerprint；因为 writer 未启用，它不能作为 apply 放行证据。

通过受控数据库控制台读取 singleton 行，不在聊天或普通 CI 日志中输出连接信息：

```sql
-- PostgreSQL
SELECT singleton, database_fingerprint, database_name, database_oid,
       gateway_schema, apply_role, created_at
FROM cinatoken_gateway.model_endpoint_backfill_database_identity
WHERE singleton = 1;
```

```sql
-- MySQL；先确认当前 database 是目标 CinaToken database。
SELECT singleton, database_fingerprint, database_name, server_uuid,
       apply_user, created_at
FROM model_endpoint_backfill_database_identity
WHERE singleton = 1;
```

把读取到的 fingerprint 精确写入 manifest 和秘密管理器注入的 `ENDPOINT_BACKFILL_DATABASE_FINGERPRINT`。plan 只比较这两个操作者输入；apply 才会在锁内把它们与持久行、当前 database/schema/server UUID 和当前数据库身份逐项比较。PostgreSQL 连接的 current schema 必须是 `cinatoken_gateway`，PostgreSQL `current_user` 或 MySQL `CURRENT_USER()` 必须等于 migration 保存的 apply identity。

任何 identity 行缺失、多行、字段不符或 fingerprint 不符都必须停止。不得删除或重建 identity 来适配错误连接。

### 2.3 一次性 signer trust-root bootstrap

三套 ledger migration 都会创建**空的** `model_endpoint_backfill_trust_registry`。`trusted_signers_sha256` 是规范 signer registry 的原始 64 位小写十六进制 SHA-256；它不带 `sha256:` 前缀，也不是某一把 key 的 fingerprint。

bootstrap 顺序如下：

1. 在仓库外建立并双人审核严格 registry JSON，规则见第 3 节。
2. 使用本仓库的 registry parser/digest 实现或等价的受审计离线工具计算规范 digest。规范投影包含版本，以及按派生 key ID 排序的 `key_id`、`principal` 和排序后的 `roles`；PEM 文本本身不进入 digest。
3. 两名操作者独立重算并确认同一个 raw 64hex digest。
4. 在目标 PostgreSQL/MySQL 上先确认 trust registry 表为空。
5. 通过支持参数绑定的受控数据库客户端执行唯一一次 INSERT。下面的 placeholder 必须作为参数绑定，不得拼接为动态 SQL：

```sql
-- PostgreSQL：:trusted_signers_sha256 表示绑定参数。
INSERT INTO cinatoken_gateway.model_endpoint_backfill_trust_registry
  (singleton, trusted_signers_sha256, initialized_at, initialized_by)
VALUES
  (1, :trusted_signers_sha256, clock_timestamp(), current_user);
```

```sql
-- MySQL：? 表示绑定参数。
INSERT INTO model_endpoint_backfill_trust_registry
  (singleton, trusted_signers_sha256, initialized_at, initialized_by)
VALUES
  (1, ?, UTC_TIMESTAMP(6), CURRENT_USER());
```

6. 在同一受控会话读回 singleton 行并与两个离线计算结果比较。若 INSERT 因 singleton 已存在而失败，立即停止；只能核对现有值，不能 UPDATE、DELETE 或再次 INSERT。

D1 保持该表为空。信任根轮换不属于 backfill apply；需要新的 schema/change-management 设计，不能改写已有 singleton。

### 2.4 Runtime grants

公共 Worker runtime 不得制造迁移证据：

- PostgreSQL 在应用 `0049` 后，以 gateway migrator 身份运行受审计的 runtime grant 流程。该流程会对 `model_endpoint_backfill_database_identity`、`model_endpoint_backfill_trust_registry`、`model_endpoint_backfill_runs` 和 `model_endpoint_evidence_attestations` 显式收回 `INSERT`、`UPDATE`、`DELETE`。
- MySQL 必须在数据库角色配置中实施等价 revoke；不要只依赖触发器，因为触发器阻止 UPDATE/DELETE，但 run/attestation 的 INSERT 本身就是高权限操作。
- 离线 apply identity 只获得完成目标 Endpoint/Route 写入、读取 identity/trust root 和追加 run/attestation 所需的最小权限。不要把该身份或 DSN 注入 Worker runtime。

迁移或 grant 尚未在远端执行时，本手册不能被解释为生产已就绪。

## 3. Strict signer registry 与多签 approval

### 3.1 `ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY`

apply 从秘密管理器注入的 `ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY` 读取 strict JSON。虽然 registry 只包含公钥，它仍是安全配置，不应作为命令行参数或普通日志输出。顶层只能包含 `version` 和 `keys`：

```json
{
  "version": "cinatoken.endpoint-backfill-approval-key-registry.v1",
  "keys": [
    {
      "principal": "cinaauth-principal-actor",
      "public_key_pem": "<Ed25519 public key PEM>",
      "roles": ["manifest_actor"]
    },
    {
      "principal": "cinaauth-principal-reviewer",
      "public_key_pem": "<different Ed25519 public key PEM>",
      "roles": ["evidence_reviewer"]
    },
    {
      "principal": "cinaauth-principal-approver",
      "public_key_pem": "<different Ed25519 public key PEM>",
      "roles": ["apply_approver"]
    }
  ]
}
```

每个 key entry 只能包含 `principal`、`public_key_pem`、`roles`；role 只能是 `manifest_actor`、`evidence_reviewer`、`apply_approver`。解析器仅接受 Ed25519 公钥，从 DER SPKI 派生 `sha256:<64hex>` key ID，不接受 registry 自报 key ID；重复 key、未知字段、重复 role、非法 PEM 或不规范值都会拒绝。registry 至少包含三把 key，实际 approval 的 actor、每个 reviewer 和 approver 必须全部使用不同 principal 与不同派生 key ID。

当前 apply verifier 不会在每次运行时在线查询 CinaAuth session；被数据库 trust root 锚定的 registry 是本流程的直接信任源。registry bootstrap 的独立审批必须验证每个 principal 与公钥确实由对应 CinaAuth 主体控制，并保存签发/吊销证据。映射不清、主体离职、key 丢失或疑似泄露时停止 apply；现有 singleton 不能被临时改写来绕过 signer 生命周期治理。

### 3.2 Digest 绑定

审核人员必须区分以下摘要：

- `manifest_sha256`：未缩小选择前的完整 manifest。
- `selected_manifest_sha256`：本次选中的 manifest 子集。
- `selection_sha256`：规范 Endpoint ID 列表。
- `execution_sha256`：对最终库存和拟执行 Endpoint/Route 效果的稳定投影；只读 plan 与 serializable apply 在最终效果相同时应得到同一个值。
- `trusted_signers_sha256`：一次性写入数据库 trust root 的 raw 64hex registry digest。
- `request_sha256`：绑定完整/选中 manifest、选择列表、数据库 fingerprint、`execution_sha256` 和 `trusted_signers_sha256` 的 apply request v2 摘要。
- `authorization_sha256`：成功 apply 后记录的已验证 signer principals/keys、reviewer coverage、审批时间窗和上述摘要的规范 provenance 摘要。

idempotency key 只由 `request_sha256` 派生，不包含审批时间和签名字节。因此相同请求可以使用新的有效 approval 恢复报告，而不会产生第二次写入。

### 3.3 Approval v2

使用经过审计的离线签名流程调用当前 registry parser、`buildEndpointBackfillApprovalHeader` 和 role-specific signature payload 合同。不要手写摘要，不要把私钥交给 backfill CLI。

approval JSON 顶层只能包含：

- `version: "cinatoken.endpoint-backfill-approval.v2"`
- `request_sha256`
- `execution_sha256`
- `trusted_signers_sha256`
- `validation_passed: true`
- UTC RFC 3339 `approved_at` 与 `expires_at`
- `signatures`，每项只能包含 `purpose`、派生 `key_id` 和规范 base64 Ed25519 `signature`

每个签名覆盖相同 header，并额外绑定自己的 purpose 和 key ID。必须恰有一个受信 manifest actor、恰有一个受信 apply approver，以及 manifest 中每个不同 `evidence.reviewed_by` 的一个受信 reviewer。reviewer 的覆盖范围由 selected manifest 精确推导；多签不能靠自报 endpoint list 扩权。

审批时间窗必须为正且不超过 24 小时。CLI 先用受控主机时钟检查，事务又在开始和提交边界使用目标数据库时钟检查；允许的未来时钟偏差最多 5 分钟。每条 evidence 在提交边界也必须仍有效。

## 4. 准备 manifest 与只读 plan

把示例 manifest 复制到仓库外的受控目录。解析器拒绝未知/缺失字段。重点审核：

- `version` 固定为 `cinatoken.endpoint-backfill-manifest.v1`。
- `manifest_id` 对应不可变变更记录；内容变化后使用新 ID，不覆盖旧文件。
- `target.driver`、数据库持久 fingerprint 和第 2.1 节的 plan 最低 migration 精确匹配。
- `actor_id` 是将签名的 CinaAuth principal；每条 `evidence.reviewed_by` 是对应 reviewer principal。
- `expected_updated_at` 对已有 Endpoint 使用数据库返回的原始精确 revision；创建使用 `null`。MySQL 必须保留六位微秒，不要经会丢失精度的工具改写。
- evidence URL 是无 credential、query 和 fragment 的公开 HTTPS URL；SHA-256 为被审核内容的 raw 64hex。证据 observed/expiry 时间和事实必须完整。
- 每个 Endpoint 至少列一个 Route；同一 manifest 内 Route 不得属于多个 Endpoint。
- policy 只限定允许提出的动作，不替代签名授权。
- 每次选择最多 100 个 Endpoint、合计 1000 个 Route；必须二选一使用 `--all-manifest` 或重复 `--endpoint-id`。

确认所需环境只通过秘密管理器注入且不输出值：

```powershell
$required = @('ENDPOINT_BACKFILL_DATABASE_FINGERPRINT', 'DATABASE_URL')
foreach ($name in $required) {
  if (-not (Test-Path "Env:$name")) { throw "$name is not injected" }
}
if (-not (Test-Path Env:SHARED_KEY_ENCRYPTION_SECRET)) {
  Write-Warning 'Required only when referenced Provider credentials are encrypted'
}
```

D1 remote plan 另需作用域仅限目标账户/数据库 D1 Read 的 `CLOUDFLARE_API_TOKEN`。不得使用 global API key 变量。

为每次运行选择全新绝对 report 路径。以下命令不包含 DSN、token 或 key：

```powershell
$manifest = (Resolve-Path 'C:\secure\cinatoken\endpoint-backfill-manifest.json').Path
$reportDirectory = (Resolve-Path 'C:\secure\cinatoken\reports').Path
$report = Join-Path $reportDirectory 'endpoint-backfill-plan-unique.json'
if (Test-Path -LiteralPath $report) { throw 'Choose a new report path' }

npm run db:endpoint-backfill:plan -- `
  '--driver=postgres' `
  "--manifest=$manifest" `
  "--report=$report" `
  '--all-manifest'
```

MySQL 只需改为 `--driver=mysql`。D1 remote plan 使用 `--driver=d1 --d1-source=remote`；冻结的本地副本使用 `--d1-source=local --d1-persist-to=<reviewed-path>`。

退出码 `0` 只说明只读验证通过。plan 报告仍会显示 `mode: "dry-run"`、`authorization_verified: false`、`apply_supported: false`、`ready_to_apply: false`、`database_identity_verified: false` 和 `snapshot_consistent: false`；这是 plan 工件本身的边界，不表示独立的受审计 apply 不存在。

## 5. Plan 审核与签名

至少由 actor、对应 evidence reviewer 和 apply approver分别核对：

1. 完整 manifest、selected manifest 和 selection 摘要可独立重算，且 target driver/fingerprint/migration 与变更单一致。
2. `inventory_consistency.before` 与 `after` 相等，`drifted: false`；任何 `concurrent_inventory_drift` 都必须重新 plan。
3. `validation_passed: true`，每个 Endpoint 的 `before_sha256`、`desired_sha256`、`verification_state_sha256`、disposition、issues、Route subject 和 actions 都符合证据。
4. legacy 数据只形成警告或 blocker，未成为权威证据；报告不含 credential、endpoint URL、DSN、token、secret 或原始敏感 JSON。
5. plan 的 `execution_sha256` 与准备签署的 approval 相同。
6. registry 规范 digest 与目标数据库 singleton trust root 相同。
7. approval 的 `request_sha256` 由同一个完整 manifest、完全相同的选择、数据库 fingerprint、execution digest 和 trust digest 生成。

归档 manifest、plan 报告、registry digest、代码 revision、工具版本、审批记录和预定 apply 窗口。不要把含内部拓扑的工件上传到公开 CI artifact 或聊天。

## 6. PostgreSQL / MySQL apply

### 6.1 最后预检

在执行前确认：

- 目标数据库已应用对应 ledger migration，identity 与 trust-root singleton 均准确且不可变。
- `DATABASE_URL` 认证为 migration 保存的 apply identity，而非 Worker runtime role。
- PostgreSQL current schema 是 `cinatoken_gateway`；MySQL session 能切换为 UTC。
- `ENDPOINT_BACKFILL_DATABASE_FINGERPRINT` 与 manifest 完全相同。
- `ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY` 是已经锚定的 strict registry JSON。
- approval 尚未过期，所有 evidence 在预计提交时间仍有效。
- manifest、approval 和 report 是三个不同的绝对路径；report 不存在且父目录 ACL 已复核。
- apply 使用与已审核 plan 完全相同的 selection 参数。

### 6.2 执行

```powershell
$manifest = (Resolve-Path 'C:\secure\cinatoken\endpoint-backfill-manifest.json').Path
$approval = (Resolve-Path 'C:\secure\cinatoken\endpoint-backfill-approval.json').Path
$reportDirectory = (Resolve-Path 'C:\secure\cinatoken\reports').Path
$report = Join-Path $reportDirectory 'endpoint-backfill-apply-unique.json'
if (Test-Path -LiteralPath $report) { throw 'Choose a new report path' }

npm run db:endpoint-backfill:apply -- `
  '--apply' `
  '--driver=postgres' `
  "--manifest=$manifest" `
  "--approval=$approval" `
  "--report=$report" `
  '--all-manifest'
```

MySQL 改为 `--driver=mysql`。局部选择必须重复使用与 plan 相同的 `--endpoint-id=<id>`，不能改成 `--all-manifest`。任何 `--driver=d1` apply 都应以退出码 `2` 拒绝；不要绕过。

### 6.3 事务内部顺序

成功路径由代码固定为：

1. PostgreSQL 使用 `SERIALIZABLE` 与 `pg_try_advisory_xact_lock`；MySQL 使用 UTC session、`SERIALIZABLE` 与零等待 `GET_LOCK`。锁不可立即取得就停止，不等待到审批过期。
2. 在锁内验证 ledger migration、数据库 identity、当前 database/schema/server UUID/apply identity，以及 DB 中的 raw signer registry digest。
3. 读取数据库时钟，检查 approval 与每条 evidence 的有效期。
4. 以 `request_sha256` 派生 idempotency key；若已有完全匹配的 completed run，验证 ledger provenance 并返回 `already_applied`，不再写业务行。
5. 在同一事务中读取完整库存与已有 attestation，生成 `snapshot_consistent: true` 的 serializable plan，并要求其 `execution_sha256` 等于 approval。
6. 对每个非 noop Endpoint 以 `expected_updated_at` 做 CAS，先写 draft、同步 Route subject bindings，再发布 verified Endpoint。
7. 在同一事务中先追加 run claim，再为每个 Endpoint 追加 evidence attestation；任何异常会使业务写入和账本一起回滚。
8. 提交前再次读取数据库时钟，确认时钟未倒退且 approval/evidence 仍有效，然后提交。MySQL 最后释放 named lock。

不要并行运行两个 endpoint backfill apply。不要在失败后手工执行报告中的 SQL 或 Admin API 动作。

## 7. 退出码、停止条件与报告状态

| 退出码 | 含义 | 是否可假定未提交 | 处置 |
| --- | --- | --- | --- |
| `0` | plan 验证通过，或 apply 返回 `applied` / `already_applied` | 依命令而定 | 校验对应规范 JSON 报告；继续第 8 节 |
| `2` | 参数/manifest/approval/registry/fingerprint/report path 无效，审批过期，或尝试 D1 apply | 通常是 | 修复输入；变更内容时重新 plan/签名，始终使用新 report path |
| `3` | Schema 或所需 migration 缺失 | 是 | 停止，由独立迁移流程处理 |
| `4` | 事实、证据或事务内 fresh plan 被 blocker 阻止 | 是 | 修复证据/manifest，重新 plan 和审批 |
| `5` | plan 双读漂移、execution mismatch 或 revision CAS conflict | 是 | 冻结相关写入，重新读取、plan、审核和签名 |
| `6` | 数据库连接/身份/信任根/锁/账本冲突或事务失败 | **不可仅凭 CLI 假定** | 进入 unknown-outcome 对账；先查 immutable run ledger，禁止换输入盲目重试 |
| `7` | `committed_report_pending`：事务已提交，本地报告发布失败 | 否，明确已提交 | 保留预留 marker，按第 9.1 节恢复；绝不能回滚或重复变更 |

plan 的并发漂移可写出最小报告。apply 在提交前失败会放弃预留文件；提交后报告发布失败则故意保留 marker。任何 report 路径都不得覆盖或追加。

## 8. 提交后核对与真实 Provider canary

退出码 `0` 的 apply 报告必须满足：

- `version: "cinatoken.endpoint-backfill-apply-report.v1"`
- `mode: "apply"`，`status` 为 `applied` 或 `already_applied`
- `apply_supported: true`、`authorization_verified: true`、`transactional: true`
- manifest/selection/request/execution/trust/authorization digest 与归档工件一致
- actor、reviewer coverage、approver、key ID、审批窗口、数据库 fingerprint、idempotency key、action/endpoint counts 完整

随后通过只读、参数化查询核对：

1. `model_endpoint_backfill_runs` 恰有该 idempotency key 的一行，所有不可变 provenance 与报告一致。
2. `model_endpoint_evidence_attestations` 对 selected manifest 每个 Endpoint 恰有一行，reviewer/key/evidence/desired/verification 摘要一致。
3. `model_endpoints` 的状态、revision、事实和 expiry 与 manifest 一致；`model_endpoint_routes` 的 Route 集合和 subject fingerprint 与 fresh Route + Provider 配置一致。
4. runtime role 对四张 identity/trust/run/attestation 表没有 INSERT/UPDATE/DELETE 权限。
5. 本地/preview 公开目录只暴露 verified、未过期、subject 匹配、可调用的事实；不泄露 Provider URL、credential、内部 ID、evidence URL 或 reviewer。

生产发布前必须独立运行真实 Provider canary；backfill CLI 不调用上游。使用最小权限、低额度、专用 canary credential，并在受控日志中完成：

- 对每个 exact operation 发起最小非流式请求；有流式能力时再验证终止事件、取消和 usage。
- 验证实际选择的 model/provider/endpoint、响应 schema、status、usage meter、预算 reservation/settlement 与上游账单可对账。
- 验证错误、timeout、fallback、ZDR/retention policy 和 credential scope 的 fail-closed 行为。
- 确认响应、日志、trace、报告和告警均无 secret；真实性能字段没有证据时继续返回 `null`，不得伪造。

只有远端 migration、权限复核、apply 对账、Workers preview、真实 Provider canary 和生产冒烟全部完成后，才能另行批准部署。本仓库当前文档不声称这些生产步骤已经执行。

## 9. 恢复与前向修正

### 9.1 退出码 `7`: `committed_report_pending`

CLI 会输出非秘密 idempotency key，并保留原 report 路径的预留 marker。处置如下：

1. 不删除、不覆盖 marker；把终端输出、路径和 idempotency key 加入事件记录。
2. 只读查询 `model_endpoint_backfill_runs` 和 attestations，确认 transaction 已提交且 provenance 与原请求一致。
3. 生成**新的、当前仍有效** approval。它必须绑定同一个完整/选中 manifest、selection、database fingerprint、`execution_sha256` 和 `trusted_signers_sha256`；签名时间可以更新。
4. 在 evidence 仍有效时，使用完全相同 manifest/selection 和一个新的绝对 report 路径重新运行 apply。idempotency key 不包含审批时间，CLI 会验证已有 immutable run 并返回 `already_applied`，不会再次修改 Endpoint/Route。
5. 验证新报告后，把旧 marker、退出码 `7` 事件和恢复报告一起归档。是否删除 marker由事件保留策略决定，不由 CLI 自动处理。

若 evidence 已过期、ledger provenance 不匹配或恢复仍失败，停止自动恢复并升级人工事件处置。不得修改 evidence 日期、request digest 或 ledger 以生成报告。

### 9.2 退出码 `6` 或连接中断的 unknown outcome

数据库驱动报告失败不能证明 COMMIT 未发生。先按预期 request digest/idempotency key 查询 immutable run ledger：

- 找到完整匹配 run：按 `committed_report_pending` 流程使用 fresh approval 和新路径恢复。
- 没有 run：确认 Endpoint/Route 与 attestation 也没有部分写入；由于它们位于同一事务，任何部分状态都视为严重数据库合同事件。确认无提交后才允许用同一受审请求重试。
- run 存在但 provenance 不匹配：立即停止。这是 ledger conflict，不能通过新 manifest、删除行或换 idempotency key 绕过。

### 9.3 业务事实需要撤回或修正

已提交 run/attestation 没有破坏式 rollback。需要降级、撤回或修正 Endpoint 时：

1. 先在运行时 fail closed 或按事件流程隔离受影响 Route。
2. 收集新的权威证据和当前精确 revision。
3. 创建新的 manifest ID，重新 plan、多签并执行前向 apply。
4. 保留原 run、attestation 和新 run 的因果关联，不改写历史。

## 10. 生产放行清单

- [ ] 目标 driver 的 plan 最低 migration 和 ledger migration 均已远端应用并核对实际 head
- [ ] 数据库持久 identity 由目标数据库生成，当前 database/schema/server/apply identity 全部匹配
- [ ] strict signer registry 已双人审核，raw 64hex digest 已一次性写入空 trust-root singleton
- [ ] Worker runtime 对 identity/trust/run/attestation 的 INSERT/UPDATE/DELETE 已显式撤销
- [ ] manifest、证据、selection、plan execution digest 通过独立复核
- [ ] actor、每个 evidence reviewer、apply approver 使用不同 CinaAuth principal 和不同 Ed25519 key
- [ ] approval v2 绑定 request/execution/trust digest，且审批与 evidence 在提交窗口内有效
- [ ] apply 使用新 report 路径，serializable/try-lock/DB-clock/CAS/append-only ledger 合同未被绕过
- [ ] apply 报告与 run/attestation/Endpoint/Route 已只读对账；任何退出码 `6`/`7` 已完成恢复
- [ ] Workers preview、目录 DTO、权限边界和无 secret 日志已验收
- [ ] 独立真实 Provider exact-operation canary、usage/账单核对、故障注入和生产冒烟已通过
- [ ] 部署由单独变更批准；本文没有被用作“已部署”证明
