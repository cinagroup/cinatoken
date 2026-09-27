# C02.B2.2：首轮独立 staging 云端初始化

2026-09-06。用户已明确首轮累计新增费用上限为 **US$2**，范围包含 Cloudflare、真实付费模型和 Google Cloud KMS。真实模型/KMS 可以测试，但并非必须调用；本次没有调用。该授权不包含套餐升级、自动充值、生产修改或支付/链上业务。

> 后续用户已补齐权限，[受保护基础冒烟 8 项通过](./C02-staging-access-smoke.md)，测试后恢复入口关闭、deny-all 并删除临时令牌。本文以下保留首次云端初始化及当时权限阻塞的历史证据。

结果：**独立 Worker/D1 已创建，远端初始化通过；Access 凭据创建被拒绝，应用 HTTP 冒烟尚未开始。** 不是 C02.G 或整个 staging 的验收通过。

## 资源与隔离

| 项目 | 本轮核验结果 |
| --- | --- |
| 账号 | CinaGroup，`7ea8e46d8210bad342fa7595f7935fea` |
| 现有套餐 | Workers Paid（既有 US$5/月账号订阅）、Teams Free；没有新增订阅。US$2 控制本轮新增测试费用，不是整个账号账单上限 |
| Worker | 新建 `cinatoken-proxy-staging`，真实 `packages/proxy/src/index.ts` 入口 |
| 发布版本 | `eaff1578-8e3c-43a7-bb25-67d282a87675` |
| 运行配置 | `2026-08-24`，`nodejs_compat` / `enable_request_signal`；未改变兼容合同 |
| D1 | 新建 `cinatoken-staging`，UUID `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`，APAC；测试区域不代替正式数据驻留决定 |
| 入口 | 远端再次确认 `enabled=false`、`previews_enabled=false`；无生产 routes、Cron、Queue、R2、Hyperdrive 或服务绑定 |
| 凭据 | 全新随机 staging 专用 `SHARED_KEY_ENCRYPTION_SECRET`，远端类型为 `secret_text`；未复制生产 Key、未配置上游模型 Key |
| 限流 | `60002001` / `60002002` / `60002003`，与核验到的生产编号隔离 |
| 数据 | 不克隆生产数据库，不读取生产业务数据 |

## 已执行的验证

1. 重新运行 5 项本地 staging 隔离/初始化测试及 D1 迁移链、账本约束检查，均通过。
2. 按新库实际名称、账号和 UUID 验证后，远端应用 `0001_baseline.sql` 至 `0068_batch_jobs.sql`，68 份迁移全部成功。没有修改历史迁移。
3. 仅对新库执行 staging 初始化 SQL，撤销固定演示管理员 Key；远端启用管理员 Key 数为 0。
4. 远端数据库有 51 张业务表及 `d1_migrations`。仅四张表非空：配置 12 条、数据库标识 1 条、已撤销演示管理员 Key 1 条、迁移记录 68 条。其他用户、供应商、模型、凭据、账务等表为空；外键零违规，`PRAGMA quick_check` 为 `ok`。
5. 使用唯一合成配置记录验证 D1 读写及重复写入幂等；随后精确删除该测试记录，配置表恢复为 12 条。本探针经 D1 管理 API 执行，不冒充 Worker 请求链或账务事务验收。该探针合计返回 929 rows read / 3 rows written；不包含此前迁移成本。
6. 新 D1 绑定配置的离线打包及绑定类型生成通过。Wrangler 4.127.1 发布报告 gzip 653.82 KiB，平台 startup 47 ms，首次封闭入口部署成功；启动指标不是真实请求延迟或内存峰值证明。

首次上传被 Wrangler 的必需 Secret 检查阻止，未创建 Worker。随后在仅当前 Windows 用户可读的临时目录生成新的随机材料，以 `--secrets-file` 与首个版本一并上传，临时明文文件在收尾删除。没有绕过必需 Secret 检查，也没有打印秘密。项目业务代码、本机 C++ 运行库均未修改。绑定类型使用 `--include-runtime=false`；已查到最新 workers-types 为 `5.20260906.1`，没有安装或据此声称最新运行时类型已验证。

## 当时阻塞：Access 服务令牌写权限（后续已解除）

2026-09-06 12:14:57–12:15:05 UTC，准备受保护的有限 GET 冒烟时，`POST /accounts/{account}/access/service_tokens` 返回 **HTTP 403 / code 1010**。没有创建测试令牌，尚未执行 Access 应用创建；因此应用/策略写权限也没有验证通过。

- 已再查：staging Access 应用和本轮测试令牌均不存在，Worker 的正式 workers.dev 与预览入口均关闭。
- HTTP 冒烟请求 **0**，真实模型调用 **0**，KMS 调用 **0**。这不是应用测试失败，而是测试前置访问保护未就绪。
- 需要对**本机使用的 Cloudflare API Token**补齐限定在 CinaGroup 账号的 `Access: Service Tokens Write`，并确保具有 `Access: Apps and Policies Write`（控制台可能显示为 Edit）。不需要提供 Global API Key，也不要把 Token/Secret 粘贴到对话或文档。
- 官方依据：[服务令牌权限与 Service Auth](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)、[Workers Access 保护范围](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)。只保护本次 staging 的确切主机名，不修改全账号或生产 Access 策略。

## 费用与收尾

本轮使用既有订阅，数据大小约 1.11 MB，没有模型/KMS费用。Cloudflare 最终增量账单尚未核验，不能将管理 API 成功、免费额度或未发送推理请求写成“实际总费用 US$0”。后续仍受累计 US$2 限制；估算按超额单价保守计算，不依赖共享免费额度尚有余额。定价依据：[Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)。

对照收尾时生产 Proxy/Admin/Chain 的远端修改时间及脱敏绑定元数据未变，5 份既有生产模板/生成配置 SHA-256 均与前轮相同。新 Worker/D1 保留且入口关闭；没有删除既有资源。业务代码、其他未提交修改和历史生产迁移均保留，没有提交或远程 CI。

下一步仅补齐 Access 权限，再核验现有 staging 身份和闭合配置，建立短期 Service Auth 策略，执行最多 12 次 GET 的健康/鉴权/空目录检查，并在收尾关闭入口、撤销临时令牌。不要重新创建或覆盖本次已有 Worker/D1。大请求、取消、跨消费者容量和恢复测试继续属于后续 C02.B2.2 门禁；KMS 的测试位置、服务身份及 IAM 仍需就绪，未因预算授权自动完成。
