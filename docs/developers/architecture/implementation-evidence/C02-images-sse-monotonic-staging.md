# C02 — 真实 Workers 单调时序与 SSE 独立恢复

2026-09-08；Checklist v1.103。状态：**STAGING_PARTIAL**。两个新请求的 native matrix 已通过，独立恢复提交 1、去重提交 0；不是 C02 整体、生产容量或真实付费供给验收。旧 v1.101 的 FAIL_CLOCK_ORDER 与补救过程原样保留，没有将历史请求补上虚构时钟样本。

## 实际接线

新增无导入副作用的 `staging-sse-host-expiry-session.mjs`，将上一轮纯合同接入新的在线操作脚本，而不是继续运行冻结 v201：

- 构造会话时验证并冻结整个计划，规范 tokenName 在任何 cloud 请求前生成。新鲜只读预检完成前拒绝第一处写入；超过 60 秒未开始写入则拒绝使用该预检。
- 在真实 fetch 发起、响应头到达、客户端 abort 发出、未决读取结束与 WebSocket tail message 到达处捕获同一 clockId 的单调时间。已记录的完成/收件样本不能被后续回调覆盖；禁止同一模式的实验请求重发。
- API/认证检查、90 秒实验请求、30 秒恢复 RPC 和 tail/清理等待均接入会话时钟或其 AbortSignal。结果不确定的恢复调用消耗两次额度中的一次，不自动重试或重置。
- UTC 时间只用于显示与原始样本匹配；临时合成 API Key 的绝对有效期另外对照 Cloudflare HTTP Date 检查，不把本机墙上时间当作等待期限。
- 先完成双入口关闭、临时身份及 tail 收尾，再等待保守静默窗口；完整财务与原生证据保存之后才允许原子删除本轮合成夹具。

本轮按照 Workers 最佳实践技能，复核 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[waitUntil 生命周期](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil) 与 [native tail API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/tail/methods/create/)。仅证明 HTTP 请求级后台任务取消，不外推整个 isolate 驱逐或物理内存回收。Wrangler 4.127.1 版本命令第一次因默认用户日志目录权限产生警告，改用工作区日志路径后正常返回；没有因此修改系统运行库、部署配置或启动第二入口。

## 新的云端证据

写入前重新核查了四个 staging Worker 的设置/部署、入口关闭、无 custom domain/cron，以及三个生产 Worker 的设置指纹（只读）。双 Access identity/deny-all、D1 56 表计数 / 295 schema 项、临时恢复控制不存在及历史临时 token 不存在均匹配。费用接口返回 191 条记录，选中的 Workers/D1 USD ContractedCost 均为 0；这是延迟账户记录，不是最终增量账单。

| 新请求窗口 | 原生取消后事实 | 恢复与去重 |
| --- | --- | --- |
| before-hold | 保留原始 held-before-insert、原 Request.signal 取消及 native canceled/缺省 response；仅有 intent 与 dispatched 预算预留 | 保持 intent-only/unknown，不补造用量、收费或退款 |
| after-hold | 保留原始 held-after-insert、原生提交结果、成功快照与 pending 恢复任务；native canceled/缺省 response | 独立控制 RPC 扫描/认领/提交各 1，生成唯一回执与账单；随后扫描/认领/提交均 0，六组财务行逐字段不变 |

两请求均有实际客户端 200、有效 completed 图片、私有上游探针记录的 completed + 真实上游 DONE，且客户端未决 HTTP 读取因 AbortError 结束。新 V3 oracle 同时验证 native invocation/取消/警告、原始 held 快照字节、身份与实际单调回调顺序，不通过重写 snapshot phase 或 UTC 排序让实验变绿。

用户确认的成功点保持不变：有效 completed + 实际上游 DONE 后，客户端取消不撤销成功费用。**成功事实早于耐久快照写入的 intent-only 缺口仍存在**；这不是对未知请求按预留额收费、自动释放预留或重新调用模型的授权。用户展示、最长待核实期限及调整/争议政策仍需在对应决策与工作包中完成。

## 验证与收尾

新增会话接线测试 15 项，组合回归 **1,415/1,415**，失败/取消/跳过均为 0；其中一项使用真正的本机 HTTP SSE 与 AbortSignal，其余时钟/tail 案例为明确标注的本地合同夹具。Node 24.14.1 实测；新增 Node 22/24 CI 声明但未远程运行，Node 22 未验证。没有重跑 Worker 类型检查，也没有修改冻结 Worker 或新部署。

原执行器已完成双入口/Access、token/tail 收尾和原子数据清理，源码完整性复核也通过；但最后查询控制端 Access 应用的 GET 返回 HTTP 503 和非 JSON 错误体，因此原报告保留 **FAIL / cleanupPassed=false**。没有重跑推理、恢复提交或删除事务。随后单独执行 29 个只读管理请求，重新核验四个 staging Worker 设置/部署/关闭入口/无路由及 cron、三个生产设置指纹、双 Access deny-all、token/tail 不存在，以及 D1 56 表 / 295 schema 项基线，结果 PASS。最终观测时间为 **2026-09-08T11:23:20.520Z**。矩阵通过与最终只读补核通过分别记载，不能表述为原整轮无故障通过。

本次两条原生 warning 分别晚于 D1 原生取消 **30.004 / 30.002 秒**，单调 tail 收件分别晚于客户端 abort **32.109 / 31.977 秒**。两条 tail 共 9,127 字节，firstFailure=null；客户端取消后的读取终结耗时为 1 / 0 毫秒（整数毫秒精度，不代表零物理耗时）。两请求的单调顺序都通过，新矩阵不依赖 UTC 排序。

准确调用计数：主实验管理请求 141 次、只读补核 29 次，合计 170 次；测试 HTTP 新增 10 次，首轮累计 **366 次**。管理 API 返回 D1 rows_read 合计 2,471、rows_written 171；最后补核 rows_written=0。没有新部署、生产写入、真实模型或 KMS 调用。合成夹具删除是受范围约束的测试收尾，不是客户退款；删除前的完整财务/探针事实已保存在原实验报告中。

本轮沿用首轮累计 US$2 上限，不重置，不新增订阅。管理 API 返回的 D1 rows_read/rows_written 不包含 Worker binding 内的查询；预算预留不是实付费用，最终增量账单仍未核验。

完整源码、实验、原失败与只读补核报告的 SHA-256 记录见 [v1.103 结果清单](./C02-images-sse-monotonic-staging-results.json)。后续继续客户 unknown/幂等、完整 SSE 生命周期与跨消费者工作集/容量验收；C02.G 与 C03–C20 保持开放。
