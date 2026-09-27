# C02 — 鉴权响应与关闭状态复核

2026-09-08；Checklist v1.108，状态 **STAGING_PARTIAL**。操作端修复与 1,596/1,596 回归通过，新窗口原生取消、独立恢复/去重及清理通过；容量关联观察未命中原池，**容量门禁仍未通过**。未修改或部署生产代码。

## 操作端修复

新增 `staging-sse-access-response.mjs`：只对预期的认证成功响应读取 JSON（gateway 200 最多 2 KiB；controller 400 最多 512 B）。401/403/404/302 等非成功页直接取消正文，不读取 HTML，也不保存 Location、正文或任意异常消息。404/302 仅可进入调用方既有的有界传播检查，不算鉴权通过；未认证成功响应和 JSON 伪装拒绝均不能冒充 Access 拒绝。认证后 census 保留原六字段、数值、no-store 与 header/body 实例身份校验；controller 检查必须精确等于 invalid_command / command_header，不发送恢复命令。

新增 `staging-sse-ingress-confirmation.mjs`，作为既有双 Access 清理器的适配层：固定两处 staging 入口，每个入口最多一次关闭 POST，原始回执不作为关闭证据；其后最多三次 GET、每次最多 4 秒、整体确认窗口最多 15 秒，重复的只是读取。写入回执丢失、读失败、尚未关闭和后续 CLOSED 分别记录，超限保留未确认状态。每次实体 API 调用仍进入同一个管理预算；确认信号传到底层 fetch。令牌/策略操作顺序仍由旧清理器严格控制；最终读取不使用已确认的缓存值替代。未引入写入自动重试。

新脚本 `sse-access-v208-run.mjs` 以 v1.107 的累计 HTTP 367 和同一 US$2 上限为起点，在新进程重新预检。它不重跑旧 v203/v207 脚本；认证与 baseline 均通过后才 seed 本轮合成数据，只执行 after-hold 一条推理。原生取消、独立恢复与容量状态分别判定，保留原 350 秒数据清理安全窗口。

本轮使用 Cloudflare 技能核对 API 和认证文档；其超时/默认重试提示促使保留固定范围、禁用写重试，并仅增加有限状态读取。参考 [Worker subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get/) 与 [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)。15 秒是本测试操作端的止损策略，不是 Cloudflare 的传播 SLA，也不证明所有配置在此时间内必然一致。

## 本地验证

新增 50 项测试：34 项鉴权响应、16 项入口状态确认，覆盖超大/卡住/损坏正文、错误内容类型、身份与计数不一致、未认证放行、取消、旧状态、丢失 ACK、并发越序、日志失败、UTC 回退、总时限及真实双清理器的 token/策略顺序。

开发首轮 48 项中 47 通过：null 状态用例的 fixture 用 `??` 将 null 替换为关闭状态，导致测试没有收到预期拒绝；已改为仅在队列耗尽时采用默认状态，并补两项并发测试。该问题发生在测试 fixture，不是用忽略 null 的方式放宽正式状态验证。

最终合并历史回归，Node v24.14.1、受控并发 2：**1,596 tests / 1,596 pass / 0 fail / 0 cancelled / 0 skipped**。三项脚本语法检查通过。新增 CI 声明 Node 22/24，未执行远程 CI 或 Node 22；本轮不修改 Worker 运行时、金额算法、配置、迁移或依赖，不部署。

## 云端结果

本轮六项 Access 检查通过：gateway 无凭据/错误凭据均 401，有效凭据 200；controller 无凭据/错误凭据均 401，有效凭据的无命令检查为预期 400。未发生鉴权页重试，2 KiB census JSON 限额未放宽。

唯一实际推理 `gen-0f0783e5-2ae5-4239-a78a-5e2dff3911c1` 为 after-hold。真实客户端中止已发生，原生 tail 证据判定为 `native-wait-until-task-cancellation`，同进程单调时序通过，**不证明整个 isolate 被驱逐**。独立 controller 恢复提交 1 条，随后去重检查提交 0 条，六组财务事实在去重前后保持一致；不是重新推理或真实客户退款。

上游 completed-enqueued / done-enqueued / terminal 各一次，窗口为 completed-and-done；原生成功快照经 after-INSERT 持有边界后，由独立消费者完成结算。恢复后的唯一日志 status=success、charged_cost=0.1、budget_charged_micros=100000，预算预留为 settled / settled_micros=100000。这里的 0.1 是合成 fixture 账务金额，不是真实模型账单。后续客户端取消没有撤销已确认的成功费用；completed-only 与 intent-only/unknown 的政策不因此改变。

### 容量观察不能升级为成功

| 观察 | 相对原请求池的结果 |
| --- | --- |
| baseline | 空闲，池 ID 与随后实际推理的响应头相同 |
| held | different-instance |
| post-cancel，第 1–3 次 | 均 different-instance；三次复用了同一个其他池 ID |
| post-recovery | different-instance |

六次 census 传输和格式校验通过，但五次关联观察均未命中原池，最终容量判定为 **INCONCLUSIVE_HELD**。不能据此推断原池空闲、永久占用或物理内存回收。源码复核中，组合工厂只在模块构造时创建池，UUID 首次调用后复用，没有发现每次 fetch 重建池；三次复用另一个 ID 的实际观察与此一致。

Cloudflare 明确不保证两个用户请求路由到同一或不同 Worker 实例，见 [Workers 运行方式](https://developers.cloudflare.com/workers/reference/how-workers-works/)。本次跨实例观察与该模型一致，但不是具体调度决策、实例驱逐或内存释放的证明。不得通过重置计数、TTL 释放、部署新版本或不断追加 census 来把本次结果改写为通过。

### 最终清理与计数

本轮结束于 **2026-09-08T12:59:42.118Z**，原执行报告 result=PASS、cleanupPassed=true。双入口各一次关闭 POST 后，第一次 GET 即确认 enabled=false / previews_enabled=false；第二/三次复核和丢失 ACK 路径本轮只在本地测试覆盖，不冒称线上出现。双 Access 恢复 deny-all / redirect-off，唯一临时 service token 与 tail 已删除。

保留并实际执行原请求 headers 后至少 350 秒的单调时钟安全窗口，再持久化完整财务/探针事实，通过全字段 CAS 守卫的原子清理删除本轮合成 fixture。删除的是测试数据，不是客户退款；报告保留原财务事实，之后的新测试需生成新身份而非恢复旧令牌或重跑旧推理。清理后核对 295 schema 项/56 表计数等于原基线，恢复控制行不存在。四个 staging Worker 的版本、设置、入口/预览关闭及无 custom domain / Cron 均复核，三个生产设置指纹未变。

| 项目 | 本轮实际值 |
| --- | --- |
| 管理 API | 137 次 |
| 公共测试 HTTP | 15 次：鉴权 6、census 6、合成推理 1、恢复 RPC 2 |
| 首轮累计 HTTP | **382**（367 + 15） |
| D1 管理计数 | rows_read **1,719** / rows_written **160**；不含 Worker 原生查询 |
| 真实模型 / KMS 累计 | **0 / 0** |
| 部署 / 生产写入 | **0 / 0** |
| 预算 | 首轮累计 **US$2，不重置**；预检 192 条延迟费用记录不等于最终增量账单 |

gateway 保持 `448e313a-7fef-4712-bde0-412173954b65`；本轮未重新下载模块，继承 v1.106 字节核验，新增当前版本/设置/隔离复核。完整来源及摘要见 [v1.108 清单](./C02-images-sse-access-confirmation-results.json)。v1.107 的线上 FAIL 和补充清理记录未覆盖。

## 下一项（有限顺序）

1. 设计并本地验证仅 staging 的同池并发观察合同：让观察请求在原请求被原生取消后仍可运行，且必须在实际派发前验证关联池身份；命中其他实例只能明确拒绝或停止，不得进行不确定推理重放。仅保留数值状态，不把 Request/Response/Promise 存进跨请求全局状态。
2. 证明新观测方式不会将“合成取消”伪装成平台取消，不会提前释放容量或改变成功结算点；它测量的是有其他请求仍活动的场景，而非承诺实例驱逐。保持 before-/after-hold 和物理内存证据的区别。
3. 冻结新候选并重新预检后再决定云端验证；不增加生产容量默认值，不把版本一致误认为实例一致。不得直接重跑 v208 脚本。

这是一项后续观测设计，不代表已经实现同池观察器。完整物理工作集、其他消费者、unknown/幂等政策、C02.G、C01 剩余决定、Node 22/远程 CI 及 C03–C20 均保持开放。
