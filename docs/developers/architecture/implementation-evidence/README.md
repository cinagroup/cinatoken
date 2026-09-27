# V2.1 有序实施：证据索引

对应 [实施 Checklist](../v2.1-openrouter-implementation-checklist.md)。证据文件只记录已发生的实现/核验，不把清单勾选当作独立证明。

## 当前进度

| 工作包 | 状态 | 执行 Owner / 复核 | 证据 / 下一步 |
| --- | --- | --- | --- |
| C00 | LOCAL_PASS | Codex（当前任务）/ Codex 本地自检 | [当前基线](./C00-baseline.md)；未获得独立生产签核 |
| C01 | DOING（Google Cloud KMS / cinatoken 项目已确认；Workers 首发优先） | 用户确认厂商/项目；Codex 只读核验；安全/财务/运维 owner 待指定 | [当前决定与 CLI 核验](./C01-google-cloud-kms-selection.md)：项目 ACTIVE、CLI 活跃登录，KMS API 已启用（2026-09-06 后续只读复核，保留历史观察）；location/保护级别/IAM 待定，未操作真实密钥。[CinaAuth 核查](./C01-secret-store-cinaauth-assessment.md)未发现现成资金账本；另确认 [Workers 首发 / Node 备选](./C02-workers-first-runtime.md)，不等于数据库 / 能力 / SLO 全部冻结；C01.G 未通过 |
| C02 | DOING | Codex（当前任务）/ 本地及 staging 子集；独立签核待定 | [V3 真实 Workers 试验与关闭读回](./C02-images-sse-peer-live-v228.md)（v1.127，STAGING_PARTIAL）：V3 已封闭部署并执行一次真实 Workers 试验；唯一推理后 8 次观察 Upgrade 均明确 mismatch，零样本 / 标记，试验保持 FAILED。原生取消、一次账务恢复和原 350 秒安全期后的严格清理通过；56 表回到基线、入口关闭、自有 token/tail 撤销、生产配置未漂移。最终只读复核 PASS，保留 Access updated_at 导致的首次严格复核失败及离线校验器修正；1,918 条摘要核验。历史 2,274 项回归本轮未重跑。新增公开 HTTP 16、累计 406，模型/KMS 0/0、US$2 不重置。下一步定位实例 / epoch 不匹配及可靠观察方式，禁止重放已消费 v227 尝试；完整容量、unknown/幂等、C02.G、C01 和 C03–C20 仍开放。 [机器证据](./C02-images-sse-peer-live-v228-results.json) |
| C03 | DOING | Codex（当前任务）/ 本地 PostgreSQL 子集；独立验收待定 | [v330 旧库升级、删除兼容与保留期只读审查](./C03-postgres-old-upgrade-retention-v330.md)：旧库 0068–0073、Key/工作区/用户删除兼容及只读阻断盘点有本地证据；实际 recovery 回填/保留期、生产授权/容量、真实 Workers／Hyperdrive／Queue 和 C03.G 仍开放 |
| C04–C20 | TODO | 本任务按依赖推进本地工作；启动时登记具体 owner | 不从其他工作包或子集测试结果推断它们已完成 |

本地 self-review 与组织正式 Reviewer 不同。外部基础设施、支付、合规和发布验收需要项目负责人指定对应责任人与授权；缺少这些不阻塞安全的本地基线工作，但不能升级为 STAGING_PASS/CANARY_PASS/ACCEPTED。

## 单工作包模板

```text
# Cxx — 标题
日期 / 状态：
Owner / Reviewer：真实身份或明确“待指定”；不要写已获未发生的审批。
前置依赖：每个依赖的编号、验证层级和证据。
基线：HEAD + 相关 dirty 文件摘要；说明是否有并行外部修改。
实现范围：本包改动的源码、测试、迁移、配置、接口。
能力边界：本地/真实 DB/Workers/生产分别是否验证；未支持项默认关闭。
功能开关：当前存在还是计划新增；默认值、owner、关闭后的在途处理。
验证：完整命令、退出码、断言、fixtures、环境与原始结果摘要。
未完成：明确缺失证据和发布阻断项。
外部动作：目标、授权、预算上限、实际费用及清理；没有则填“不涉及”。
停止/回滚：不能退回明文/全池解密或删除账务事实。
下一工作包：唯一推荐编号与所需验证层级。
```

## 快照复核

`C00-baseline-snapshot.json` 为写入本轮证据前的源码基线。后续改动应按实际任务更新新的快照，而不是覆盖历史摘要来隐藏差异。

以下为只读检查示例，在仓库根目录执行。它不读取 secret 值，不执行源码，也不恢复文件：

```powershell
$evidenceSnapshot = Get-Content -LiteralPath docs/developers/architecture/implementation-evidence/C00-baseline-snapshot.json -Raw | ConvertFrom-Json
foreach ($evidenceFile in $evidenceSnapshot.files) {
    if (-not (Test-Path -LiteralPath $evidenceFile.path -PathType Leaf)) {
        "MISSING: $($evidenceFile.path)"
        continue
    }
    $evidenceActual = (Get-FileHash -LiteralPath $evidenceFile.path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($evidenceActual -ne $evidenceFile.sha256) {
        "CHANGED: $($evidenceFile.path)"
    }
}
```

Checklist 的勾选/进度变动属于预期文档变化，不能据此声称业务源码发生回归。若受测业务源码发生变化，需判断其影响并重跑对应测试后生成新证据。

禁止保存：真实认证凭据、支付卡信息、数据库连接秘密、生产业务正文、未脱敏个人资料或可重用授权 token。
