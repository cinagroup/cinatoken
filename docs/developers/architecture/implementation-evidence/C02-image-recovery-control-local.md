# C02.B2.2 — 恢复控制入口本地证据

日期：2026-09-07；Checklist v1.55。状态：**LOCAL_PASS 子集，不是 STAGING_PASS；C02.G 继续未通过。**

接续 [v1.54 私有恢复 RPC / host](./C02-image-recovery-trigger-local.md)，新增专用控制 Worker；没有发布、远端迁移或修改生产路径。机器结果与文件摘要见 [结果 JSON](./C02-image-recovery-control-local-results.json)。历史 [5 次成功仅 4 条日志](./C02-staging-image-storage.md) 仍开放，不将本地恢复外推到已部署版本。

## 1. 控制与授权边界

调用关系：专用 Access 应用 → 控制 Worker → 命名 `UsageRecovery.run()` → 隔离 staging D1。目前只有本地接线；专用 Access 应用/策略未创建或核验。

- 控制代码只信任运行时提供的 `ctx.access.aud`，必须精确匹配已配置的 audience；未配置、错误环境或未启用均拒绝。64 位小写十六进制是本原型的配置合同，不宣称所有未来 Access audience 都必然同格式。实际 audience 仍为空，不能从旧 gateway/account 应用直接复制后当作授权完成。
- 部署前必须核验专用应用的精确目标与最小 service-auth 策略，不允许 everyone/bypass 或借用一般用户 gateway 应用。**只比对 audience 不等于代码自行验证了远端策略。** 此门禁尚待实现/云端取证。
- 不自行解析 JWT，不用 `Authorization`、`Cf-Access-Jwt-Assertion`、Cookie 或自报角色 Header 认证，也不引入共享管理密钥。不调用 `getIdentity()`，不取回用户邮箱/分组等身份资料。
- 下游不接收 Access 上下文，依靠显式授予的命名 service binding；不向公共 gateway、Admin 或租户 Worker 转授。接收 Worker 仍只有既有 staging D1 管理能力，不是表级/租户级 IAM。

官方文档说明，`ctx.access` 只属于被 Access 直接认证的调用，不随 Service Binding HTTP/RPC 传递；Static Assets 内部路由也不传递它。因此控制配置禁止 assets/Vite 自动接线及 `access.dev` 模拟。[Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

## 2. HTTP 与生命周期合同

唯一命令是 HTTPS `POST /_control/usage-recovery/run`，Header `X-CinaToken-Recovery-Command: run-once-v1`，没有请求体，Content-Length 可省略或精确为 `0`。Header 是固定命令标记/跨站防线，**不是秘密或认证**。拒绝查询/fragment、其他方法/路径、Origin、Transfer-Encoding、显式空字符串 body 或任何 body stream；URL 最多 2,048 字符，不解析/缓冲请求体。无 CORS/OPTIONS 浏览器流程。

严格 `request.body === null` 在 Node 中已验证；真实 Workers 空 POST 的表示仍需平台样本。不得为了让测试可用而放宽身份或自动读取未知流。

1. 完成配置、原生授权及命令形状检查。
2. 同一控制实例最多一个在途调用，busy 立即拒绝，不创建等待队列；标量 gate 不是跨实例锁或全局限流器。
3. 在任何 RPC 前登记 `ctx.waitUntil`；登记抛错和发起前取消都不调用下游。
4. 精确调用一次 `service.run()`，参数为空；不转发 Request、环境、租户、SQL、快照、批量或容量参数。
5. 发起后一直等待实际 RPC Promise；断连/禁用不能声称 D1 已取消，也不能提前让下一个调用绕过 gate。没有 timeout race、轮询或自动重试。

`waitUntil` 不是耐久执行或无限生命保证；真实调用方结束、平台期限、RPC 取消和接收方 D1 提交仍须线上验证。[RPC 生命周期](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)

响应只投影固定状态、UUID 和最多 50 的整数计数/两个布尔标记，不遍历、展开、序列化额外 RPC 字段或原始异常。`finished` 仅表示一次运行结束，deferred/blocked/uncertain 仍可能非零。传输/执行异常或坏结果返回固定 502 `outcome_unknown`、`retry_safe:false`；已知不可用返回固定 503，不声称可安全自动重试。全部响应 no-store，无 CORS；控制代码无日志调用，配置关闭自动 invocation URL 日志。此投影约束 HTTP 输出，**不能防御已在平台反序列化的恶意超大 RPC 返回值**；接收方固定标量结果、信任边界与工作集仍须验收。

## 3. 配置、类型与打包

新增控制配置：`packages/proxy/scripts/staging/wrangler.usage-recovery-control.jsonc`。Worker 名 `cinatoken-staging-recovery-control`，仅 `USAGE_RECOVERY → cinatoken-staging-usage-recovery#UsageRecovery`。无 D1、模型/KMS、Secrets、队列或定时器；workers.dev/preview/routes 均关闭，enabled=false、audience 空。配套校验还检查接收方配置仍关闭，拒绝额外字段或资源。

Wrangler 4.127.1 使用主/从两份配置生成准确 RPC 类型；模块边界脚本只追加类型导出，避免两个 Worker 的 Env/GlobalProps 在 TypeScript 全局合并，不手写任何绑定字段。编译期合同确认控制 Env 恰好四项、与接收 Env 无重叠且 `run` 参数严格为空。重新生成使用：

```powershell
npm run types:images:recovery:control -w @octafuse/proxy
npm run check:types:images:recovery:control -w @octafuse/proxy
```

最新 Workers 类型 5.20260907.1 已只读取得；安装版本仍为 5.20260829.1，相关 `ExecutionContext.access` / audience 类型一致，未升级依赖。绑定类型从真实 Wrangler 配置产生，符合 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。

离线控制包 **4,836 字节 / gzip 1.64 KiB**，仅控制 runtime 和 Worker 接线两个输入，唯一导出 default，无外部 import、Core/D1/provider 模块。包大小不是内存容量测量，不开启任何池或真实容量参数。

## 4. 本轮验证与失败记录

新增 **87 项**：56 项控制/协议/授权/持有期单测、4 项真实 Images 路由 → 本地 SQLite → 实际 host 恢复、27 项控制隔离配置检查。配置测试连同旧 21 项共 48 项。生成类型/模块作用域检查、staging 与 dispatch-safety 定向类型检查通过。

单测覆盖伪造 Header 无 ctx.access、错误 audience、非法开关/环境、体与路径限制、登记前无 IO、取消前无调用、悬挂 RPC/20 次 busy/禁用、绑定不缓存、固定错误、字段越界和脱敏投影。四项链路测试覆盖普通生成/编辑 × 零价/合成 US$0.1：原始推理只发送一次、原记账失败后控制入口恢复一条日志/相应预算，再运行不重复认领。金额为本地 fixture，非真实付费请求。

首次新测试全部 60 个用例断言通过，但进程报告用例结束后的一条异步 console 活动，使文件级汇总为 60 pass / 1 fail、退出 1。随后定点运行观察到 Node SQLite experimental warning；原始错误没有保留其日志正文，故不把 warning 来源当作已独立证明。修正将 SQLite 集成 fixture 移至独立测试文件，纯控制单测继续严格禁止所有 console 调用；未放宽控制或财务断言。修正后 60/60，退出 0。没有将最初失败覆盖为成功。

完整 Images staging/recovery/host/control/进程链结果见 JSON；计数与单独运行有重叠，不累加成不同场景数量。完整 Core 类型检查仍 **FAIL，32 条诊断与 v1.51 所链接基线逐项相同**；比较脚本退出 0 不是完整类型检查通过。

本地显式注入 ctx.access 和 JS 方法代替跨 Worker 传输；它们证明代码分支、接线和 SQL 效果，**不证明云端身份不可伪造、真实 RPC 安全/序列化或 Workers 物理容量**。本轮未重新运行完整 dispatch-safety 2,687 项行为 suite，不能沿用上轮结果写成本轮新通过。

## 5. 后续有限顺序与预算

下一项：核验恢复 SQL **实际表/索引/触发器定义与审阅 artifact**，不只检查名字；冻结明确的实验容量配置。然后重新核验 staging 资源身份、专用 Access 应用/策略和命名服务授权，才进入真实 Workers RPC/取消/平台终止/D1 恢复及完整工作集测试。三份 SQL 仍在 proposals，正式迁移 68 份，默认/生产/云端新路径关闭。

完整报价/权益/credential owner、卖家收益/outbox、unknown 财务政策、SSE、审计保留、告警与客户端幂等合同仍待完成。无快照不能重建实际用量，不能重试推理补账或按 TTL 自行退款；C03–C20 与 C02.G 不因此通过。

本轮云管理、部署、远端 SQL、真实模型/KMS 调用均为 **0**。历史 staging HTTP **98**、模型/KMS **0**；**首轮累计上限 US$2 不重置**，最终 Cloudflare 增量账单未核验。远端关闭状态只引用之前证据，本轮没有远端重查。没有套餐升级、充值、生产操作或系统 VC++ 修复。
