# C02 — Images 传输异常尝试事实与耐久恢复

日期：2026-09-08；Checklist v1.83。本地修复，尚未部署；C02.B2.2 / C02.G 保持开放。

接续 [v1.82 结果不明合同](./C02-images-outcome-metadata.md)发现的 `C02-image-transport-attempt-facts` 缺口。两条普通 Images 驱动 catch 把传输异常转成响应，绕过调度器的抛错记录路径；在响应头到达前出错，原先只有 attempt count，没有最终 provider attempt，导致严格 snapshot 身份校验失败，留下无快照的已认领意图。

## 修复与事实边界

`openai-images-driver.ts` 的 generations / edits 两处 catch 增加相同条件：**fetch 已实际开始，且尚未观察到 HTTP 状态**，调用现有 `markAttemptError` 记录 `unavailable / network_error / httpStatus=null`。不把合成 502/504 伪装成供应商实际 HTTP 状态，不改 codec、预算或价格算法。

- 客户端取消仍优先保留 `excluded / client_cancelled`；已有真实 HTTP 状态不被新分支覆盖。
- 认证/准备/准入失败、出站前取消，不新增供应商尝试事实。
- 2xx 后 body 失败保留已观察的 200；明确 400 后 body 失败仍保留 400/`client_error`，不误标为未知网络结果。
- 普通无响应头传输异常现可持久化快照，公开返回带 `outcome_unknown=true`、`retry_safe=false`、`request_id` 的 502；不再因缺少审计事实退化为持久化未确认 503。
- 保持禁止模型重放。买家名义费用为零，预算按原预留保守消费；客户端取消 / 网关 deadline 的既有零费用与零预算消费政策不变。这不是新增退款政策或真实模型账单确认。

本次只补请求所有的有界尝试事实，未引入新的响应读取、长值副本或后台任务。依据 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)保持现有流所有权与异步工作边界。最新类型包查询再次被网络 EACCES 拒绝，回退检查缓存的 5.20260907.1 类型，未升级依赖。

## 本地验证

专项已通过：更新的 4 项完整 Worker handler + SQLite 出站/取消合同；新增 12 项直接 driver 事实边界；新增 8 项传输错误持久化/恢复合同。

完整版本化 staging 本地链 704/704 通过（既有 656 + 结果不明合同 24 + 本轮传输尝试合同 24）；另行 driver / 生命周期 / 错误物化回归 508/508 通过。完整 Proxy 与 staging 类型检查退出码均为 0，各测试组无失败/取消/跳过。132 个源码摘要从本轮完整测试开始至发布保持不变。首次专项与完整重跑不累加成新的唯一测试数量。

[机器结果与摘要](./C02-images-transport-attempt-recovery-results.json)记录 132 个源码、161 个操作 artifact、15 个历史证据依赖，共 308 个摘要；完整输出为 `.wrangler/staging/images-v183-verification.json`。本轮修复与验证通过，不意味着所有 Images/SSE 或真实 Workers 门禁通过。

12 项 driver 测试覆盖两条操作的无响应头传输失败、deadline、出站前取消、准入抛错、明确 400 body 错误、2xx body 错误。deadline 使用确定性 mock clock，不声称真实 Workers 时钟验收。

8 项完整链覆盖两条操作的 ledger 写前失败、batch ACK 丢失、lease ACK 丢失及 typed deadline stop signal。核对 snapshot 中的 attempt/provider/route 身份、零名义费用、原预留结算、一次性日志/回执/attempt/audit、恢复后 job committed、重复 recovery 及直接 repository.commit 无重复计费/推理。完整 handler 的 deadline 为注入受信停止信号，不是平台定时器或网络交付证明。

普通传输失败样本原预留为 100,000 micros：结算后 spent=100,000、reserved=0；取消/超时样本两者为零。所有样本只有一次合成出站，没有真实模型或 KMS 请求。

## 历史与未完成项

修改前的驱动与 v1.82 诊断测试按原字节归档在 `.wrangler/staging/images-before-v183-0.txt`、`images-before-v183-1.txt`，映射记录为 `images-v183-baseline.json`。上一版 298 项摘要已按历史源码映射逐项复核，旧证据不冒充新实现验收。

本轮没有配置/依赖/迁移/云资源或部署变更。最近实际远端验证仍是 v1.77；累计公开测试 HTTP 263、首轮累计新增 US$2 上限不重置，最终增量云账单未核验。

下一顺序：修复/验证 SSE 流内结果不明与禁止重试合同，再冻结更新后的 staging 候选并进行隔离、预算与真实 wire / 交付 / 持久化验收。完整物理容量、生产 SLO、KMS/IAM、客户端幂等及退款政策仍未完成，不关闭 C02 或总目标。
