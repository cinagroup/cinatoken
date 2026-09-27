# C02.B2.2：私有恢复 RPC 与独立 host 本地证据

2026-09-07，Checklist v1.54，LOCAL_PASS 子集。C02 DOING；完整 Workers 恢复/容量与 C02.G 仍 NOT_PASSED。Owner / 自检：Codex；独立 Reviewer 未指定。[结构化结果与源码摘要](./C02-image-recovery-trigger-local-results.json)。本轮没有云端发布、迁移或真实付费调用。

## 1. 已落地的触发与权限边界

[专用 Worker](../../../../packages/proxy/scripts/staging/usage-recovery-worker.ts)提供命名 `UsageRecovery.run()` RPC；参数数量必须为零，不能由调用者选择租户、事件、SQL、凭据、批量或执行窗口。默认入口和命名入口的 HTTP `fetch()` 都固定返回 404 / no-store，不读取正文，不信任 Authorization、Access 断言或 query 来启动任务。

授权边界是 **Cloudflare 配置中显式授予的命名 service binding 能力**，不是 URL 隐藏或 Header 字符串判断。仅专用、另行保护的控制 Worker 可持有该能力；公共 gateway、前端、租户 Worker 不应得到它。当前没有接入或部署控制调用方，也未用真实 Workers 验证 RPC 授权/撤销。因此本轮只证明代码/配置和本地接线，不能把 Node 构造器替身当作 Cloudflare 安全边界实测。

[独立配置](../../../../packages/proxy/scripts/staging/wrangler.usage-recovery.jsonc)固定 Worker `cinatoken-staging-usage-recovery`、CinaGroup 账户和既有 staging D1 ID `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`；唯一资源绑定是 `RECOVERY_DB`。无 provider/KMS/加密主密钥、出站 service binding、定时任务、Queue 或公开路由。`remote:false` 只约束本地开发绑定，不代表已发布 Worker 不访问线上 D1；D1 ID 本轮沿用历史记录，发布前必须远端重验名称/账户/ID及 SQL 定义。

这是对该 staging 数据库的管理能力，**不是 D1 表级或租户级 IAM 隔离**。`RECOVERY_ENVIRONMENT=staging` 只是服务端闭合校验，不是数据库真实身份的密码学证明。[配置验证器](../../../../scripts/deploy/validate-staging-usage-recovery.mjs)拒绝生产/额外数据库、任意服务/secret、公开入口、cron、自动接入 proposal 迁移、环境覆盖、启用开关和未批准的容量参数。它验证本地禁用源文件，不生成可直接启用配置，也不代表远端 IAM 审计。

## 2. 独立生命周期与容量持有

[恢复 host](../../../../packages/proxy/src/runtime/usage-recovery-host.ts)每个专用 isolate 仅保存数值池、配置指纹和 active 标记；不缓存 D1/env、租户、请求、DTO、Promise 或 lease。每次调用使用自己的 D1 binding。一次最多一个在途运行，重复触发立即返回 busy，没有等待队列；不同 isolate 仍依赖 D1 CAS / fencing，不把本地标记当成集群锁。

服务端参数严格按十进制正整数字符串校验、同步复制，并固定 `scope=all`。Core 既有上限为每次 50 条、并发 4、lease 300 秒、准入窗口 60,000 ms；本地禁用源值为 5 / 1 / 30 秒 / 5,000 ms。容量字节没有默认估计，源配置为 0 且开关 false；启用仍需经审查的实验/测量配置。测试的 1,024/2,048 字节只是逻辑计数，不是物理工作集。

先登记整个执行 Promise 到 `ctx.waitUntil()`，再启动任何 D1 I/O；登记抛错时任务观察到未注册状态，不做扫描或账务。实际读取、领取、事务以及确认仍未结束时，host 和容量保持占用；准入窗口过去或后续禁用开关都不能提前归还在途工作。`waitUntil` 只延长当前平台允许的持有期，不能替代下一次独立扫描、持久化事实或 RPC 调用方结束后的平台验证。

每次只调用既有有界执行器一次；不安排轮询、自动重试、定时器、推理或 KMS。返回固定状态和有界标量统计，日志仅含随机 runId、固定状态与统计；不回传原始 D1 异常、SQL、用户或快照。`finished` 表示本次执行器结束，统计中的 blocked / deferred / uncertain 必须继续处理，不表示所有账务成功。

## 3. 本地测试与构建

[39 项 host 测试](../../../../packages/proxy/scripts/staging/usage-recovery-host.test.mjs)覆盖禁用/非法配置零 I/O、waitUntil 登记顺序和登记失败、20 次重叠拒绝、配置复制与换池拒绝、部分容量准入、跨 host fencing、不缓存旧 D1、读取与已提交 batch ACK 悬挂超过逻辑窗口、关停不提前释放、异常脱敏和后续恢复。还覆盖普通 Images 生成/编辑 × 零价/0.1 合成预算：成功交付后 ledger 故障，由独立 host 扫描恢复一次且不重发推理。RPC 接线测试使用明确披露的 Node 构造器替身，仅验证导出、参数拒绝和 HTTP 不触达 DB。

[21 项隔离配置测试](../../../../scripts/deploy/validate-staging-usage-recovery.test.mjs)验证合法禁用配置及 20 种危险漂移。合计 **60 项新增测试通过**，没有失败/跳过/取消。已接入 `test:images:staging` 的 posttest 链，保留既有恢复/定价及进程测试。

Wrangler 4.127.1：从配置生成 [binding 类型](../../../../packages/proxy/scripts/staging/usage-recovery-env.d.ts)，`types --check` 通过。首次 staging 类型检查出现 TS2742（公开 RPC 推断返回类型不便移植），已补明确返回类型，复跑通过，没有忽略该诊断。`deploy --dry-run --no-autoconfig` 离线打包成功：JS **333,336 字节**，Wrangler gzip **62.71 KiB**，唯一外部 import 为 `cloudflare:workers`，导出仅 `UsageRecovery` / `default`；这不是运行时内存或实际上传。

首次完整 posttest 的进程矩阵 **21/24 PASS、3/24 FAIL**，集中在 batch-before；补入有界诊断后，四项定点复跑先 1/4、后 4/4，说明不能用偶然复跑通过抹除失败。失败记录为扫描 0、任务仍 leased，没有编造收费或重复提交。旧测试用父进程 `Date.now()+11 秒` 推断数据库租约已过期，没有以耐久边界证明准入前提；本轮改为从已保存的 available_at / lease_expires_at 选择测试时钟，断言 lease 确为 10 秒，验证消费者 SQL 时钟与输入一致，并在所有仍 leased 的退出样本增加 **到期前扫描 0、到期后恢复一次** 的独立进程对照。账务、SQL、执行器和 lease 政策没有为此修改。新时钟边界的 8 项定点测试通过；原父子进程墙钟差异的具体来源未独立证实，不据此宣称修复了操作系统或生产时钟。

最终 `test:images:staging` 全链通过：**35 + 7 + 110 + 39 + 21 + 24**，各组无失败、跳过、取消；最后 24 项真实进程测试耗时约 236 秒。调度安全回归 **2,687/2,687**，Core 意图/结算/恢复 **19 / 37 / 32** 通过。staging、dispatch-safety、Core dispatch-intent 三项定向类型检查通过；完整 Core 仍 **FAIL：32 条原诊断**，按文件/位置/代码/消息与历史完整基线完全相同。测试计数包含重叠，不加总为独立覆盖范围。

## 4. 保留的门禁与下一步

下一项是接专用受保护控制调用方，并补审查过的 SQL 定义真实性检查与显式实验容量配置；随后远端核对 staging 资源/授权，仅在已有预算内对真实 service binding、调用方终止、D1 fencing/恢复及完整工作集做小样本。控制入口、真实 RPC 授权与取消、平台回收、数据库并发、完整容量/SLO目前均未验收，不通过临时公开恢复 URL 绕过它们。

Images SSE、预算拒绝/未知结果全部组合、完整调度前报价/权益/owner、卖家收益/outbox、审计保留兼容、请求重试幂等、unknown 终结政策及其他后端仍按 [恢复合同](../image-usage-recovery-boundary.md) 继续。原 [5 次成功只有 4 条日志](./C02-staging-image-storage.md) 保持开放；没有结果快照就不编造用量、重发模型或自行退款。生产/默认 Images 工厂未启用新路径，三份 proposal SQL 未进入正式迁移，正式仍 **68** 份。

本轮 Cloudflare / Workers 最佳实践与 Wrangler 技能促使实现采用命名能力隔离、binding 而非管理 REST、提前登记平台持有和自动生成类型。[命名入口](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)、[RPC 安全边界](https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/)、[RPC 生命周期](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)、[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。只读核对最新 types 为 5.20260907.1，已安装仍 5.20260829.1；没有升级依赖或修复 Windows 系统组件。

本轮云管理/发布/远端 SQL/真实模型/KMS 调用均 **0**；历史 staging HTTP **98**、模型/KMS **0**，首轮累计 **US$2 不重置**。最终增量账单未核验；远端关闭状态仍引用历史证据，不冒充本轮复核。未提交 git，未改生产配置，C02.G / C03–C20 状态不因上述子集完成。
