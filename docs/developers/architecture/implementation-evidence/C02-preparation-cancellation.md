# C02.B2.2 — 准备取消与兼容迁移等待责任（本地子集）

日期：2026-09-05。状态：**本文件列明的准备取消子集 LOCAL_PASS；C02.B2.2 / C02 整包 DOING，C02.2 / C02.G 未通过。**

Owner / 本地自检：Codex（当前任务）；独立 Reviewer 与真实环境验收责任人待指定。

## 1. 接续与边界

接续 [C02.B2.1 入口生命周期](./C02-text-ingress-lifecycle.md)。本轮推进内部取消传播，不将已有的外层有界等待当作内部停止保证。代码检查发现：provider/shared 凭据读取会兼有明文或旧密文的在线升级；这不是纯读取，必须保留已开始写入的等待责任。本文件补充该历史证据的边界，历史测试与快照不改写。

[Google Cloud KMS 选择](./C01-google-cloud-kms-selection.md)不变。本轮未接入 Credential Vault/KMS、未读取真实密钥、未创建云资源、未做远端迁移/部署、付费推理或资金操作；没有新增生产开关或启用未验收能力。

基线 HEAD：`7eb59008f7d8e156e81fd18a57658fdef2553264`。开始时已有 74 个修改/未跟踪文件，预先记录 SHA-256；本轮仅接续相关文件，未恢复或清理原有 Admin、Core、迁移文档等改动。源码、配置和测试的本轮摘要见[受测快照](./C02-preparation-cancellation-snapshot.json)。

## 2. 实现与责任

| 边界 | 当前行为 |
| --- | --- |
| 请求局部合同 | Core 新增可选 `PreparationControl`，与 HTTP runtime 解耦；三个文本协议及旧 Completions 复用入口绝对 deadline，调度器的凭据展开使用其同一局部 owner |
| 内部准备 | 模型直接/冒号回退查找、时区、surface/legacy 路由、绑定/provider、策略和性能遥测的逻辑读取前后检查截止；逐候选循环继续前也检查 |
| 错误回退 | 取消不能被 surface 的 legacy 回退、共享/BYOK 的空池降级或遥测的 `allSettled` 降级吞掉；迟到结果不启动下一查询或发送 |
| 凭据展开 | 可选 control 传过 provider 环境绑定和三类加密仓储；受控路径逐凭据处理，各 Web Crypto 步骤间检查。未受控管理读取保持既有行为；没有改变密文算法、AAD 或在线升级政策 |
| 兼容迁移 | 升级写入在启动前登记到同一 owner；取消可结束外层等待，但不遗弃已开始写入。入口/调度器退出前封闭新写入口并等待已登记 Promise 完成，成功或失败均被观察 |
| 关闭后的迟到工作 | drain 在首次 await 前封闭写入登记，dispose 后新的读/写检查拒绝；避免其他并行准备在请求退出后才发起迁移 |

`wait` 仅适用于只读操作，或每个写入均登记到同一 control 的已审查复合准备流程。认证迁移、预算重置、Guardrail 审计和财务写入没有因此变成可丢弃操作。既有准入、释放、结算协议未改动。

主要代码：[Core 合同](../../../../packages/core/src/preparation-control.ts)、[deadline owner](../../../../packages/proxy/src/services/request-deadline.ts)、[入口生命周期](../../../../packages/proxy/src/middleware/text-request-lifecycle.ts)、[模型规划](../../../../packages/proxy/src/services/model-fallback-plan.ts)、[调度器](../../../../packages/proxy/src/services/failover-dispatch.ts)。仓储接口的 control 参数可选，SQL 驱动实现本轮未修改。

## 3. 验证

环境：Windows / Node **24.14.1**；`.nvmrc` 要求 **22**，未在 Node 22 上执行。Workers types 使用已安装的 **5.20260829.1**；最新类型查询因 EACCES 失败，按技能回退核对本地类型，未更改依赖、Wrangler 配置或云环境。

新增 **35 项**取消/写入责任用例：独立 [preparation-cancellation.test.ts](../../../../packages/proxy/src/services/preparation-cancellation.test.ts) 19 项，加上[入口测试](../../../../packages/proxy/src/routes/v1/request-dispatch-limit.test.ts)新增 16 项。后者覆盖 Chat、Responses、Messages、旧 Completions，以及 `/v1`、`/api/v1` 两组入口。专项 script 和专项 TypeScript 配置均收集新文件。

| 命令 | 最终结果 |
| --- | --- |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0 |
| `npm.cmd test -w @octafuse/proxy` | 完整 npm 生命周期退出 0；最终主 suite **806 tests / 134 suites，806 通过** |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | **266 tests / 17 suites，266 通过**，退出 0 |
| `npm.cmd run test:unit -w @octafuse/core` | 完整 npm 生命周期退出 0；最终主 suite **336 tests / 69 suites，336 通过** |
| `git diff --check` | 退出 0 |

各最终套件均为 0 失败/取消/跳过；计数重叠，不能相加。全量测试后仅澄清两处合同注释，并重跑专项测试及两个类型检查。新增测试的初次类型检查暴露隐式 any 和 readonly 仓储赋值，已用明确类型、结构复制修正，没有忽略诊断或关闭类型检查。

关键断言包括：取消后不进行第二次模型查找/下一渠道/下一 BYOK provider/下一遥测批次；三个加密仓储的迟到 DB 结果不启动解密，派生步骤中取消不启动下一密码步骤；时钟已超限但 timer 未执行时也停止；已开始的 provider/shared 升级在 timeout 后提交或拒绝，HTTP 响应均等待其结束，且不获取推理许可、不进行上游 fetch。

本地 fixtures 使用合成 HTTP、仓储 Promise、SQLite 或 mock 数据库合同。上述结果**不证明真实数据库查询取消、迁移原子性、资金恢复、Workers 平台生命周期或生产性能已通过**。

## 4. 剩余缺口、停止条件与唯一下一步

继续 **C02.B2.2**，不进入 C03，不勾选整个 C02：

1. 优先处理 Vertex service-account OAuth 的辅助请求、正文上限和取消。其全局 in-flight token Promise 仍需明确多请求所有权，不能让一个客户端取消别人的认证；这与 Google Cloud KMS Vault 集成是不同模块。
2. SQL/Web Crypto 已开始的底层操作不会被本控制合同物理中止；仓储/驱动内部的取消能力和时限需逐项验证。已登记迁移若挂起仍会延长 HTTP 请求，drain 不代表数据库回滚、崩溃恢复或严格墙钟上界。存储初始化、认证/Guardrail 和资金写入同样仍有未解决边界。
3. headers、首有效 token、流 idle 和总时限尚无完整分阶段实现；不能靠心跳无限续期，不能把 TTFT 超时当作供应商未接受并盲目重放。
4. 受控凭据展开仍是全池读取与逐项解密，正常路径仍为 O(N)，串行展开可能增加延迟；未实现 metadata Top-K、Credential Vault 或 GCP envelope。不能据本轮开放大量 token 池，C07–C09 仍待实施。
5. Node 22、Workers runtime、真实数据库、并发负载/内存、其他模态及 SDK/平台内部重试尚待验收。C01 的 project/location、保护级别、承载/IAM、财务和发布参数仍未冻结。

停止/回退：若发现未登记的准备写入，先保留原调用者的等待责任，再拆清合同；必要时暂停受影响入口，不用 race 丢弃迁移/资金事实，不恢复无界尝试或绕过密文校验。

本轮使用 Cloudflare Workers 最佳实践技能，促使实现采用请求局部取消状态、迟到结果检查以及显式写入等待责任；参照 [Workers 官方实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)和 [Request signal 合同](https://developers.cloudflare.com/workers/runtime-apis/request/)，不把本地 Node 测试替代平台验收。
