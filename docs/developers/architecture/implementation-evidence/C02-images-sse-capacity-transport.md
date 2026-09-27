# C02 — 有界容量探针与推理前窗口中止

2026-09-08；Checklist v1.107，状态 **STAGING_PARTIAL**。本地容量探针完成，1,546/1,546 合并回归通过。线上窗口在鉴权检查阶段失败，**未发送推理、未执行恢复 RPC、未采集容量样本**；原始失败保留，独立补充清理已通过。不得把本轮记为原生容量验收成功。

## 已实现与验证

新增 `scripts/deploy/staging-sse-capacity-sampler.mjs`，仅用于 Node 操作端，未修改或部署 Worker 运行时代码：

- 固定 staging census URL、GET、禁止自动重定向；只接受两项 Access 凭据头，不将凭据、原始响应或异常消息写入证据。
- baseline / held / post-cancel / post-recovery 分别最多 1 / 1 / 3 / 1 次。先消耗共享 HTTP 预算并持久化 PENDING，再发送请求；结果不明也消耗次数，不自动重试。
- 5 秒网络超时，单调时钟标记，实际响应累计最多 2 KiB；校验 JSON 类型、no-store、六字段数值合同及 header/body 身份一致。
- held 后固定原请求池身份，不允许替换成另一个空闲池。保留 occupied / idle / different-instance 分类；后者不能证明原池已释放。
- 持久化或预算回调失败后禁止继续；拒绝并行调用与阶段倒序。超时会中断 fetch 并取消响应读取，不把返回超时等同于底层资源已回收。

新增 25 项测试，包含超时前无 headers、body 停滞、过大/损坏响应、身份不匹配、预算/日志失败、并发与禁止更换关联池。首轮 24 项通过后补充身份固定测试；最终使用受控并发 2 重跑历史全集加新增测试，**1,546 tests / 1,546 pass / 0 fail / 0 cancelled / 0 skipped**，本机 Node v24.14.1。新 CI 声明 Node 22/24，但远程 CI 与 Node 22 未执行。Worker 类型检查与 dry-run 沿用 v1.106/v1.105，不冒称本轮重跑。

## 本轮云端事实与失败

新操作脚本 `.wrangler/staging/sse-capacity-v207-run.mjs` 先冻结并核对代码、版本和累计预算，再在同一进程完成全新只读预检：四个 staging Worker、三个生产设置指纹、双 Access、D1 UUID/名称、295 schema 项和 56 表计数、恢复控制行、旧凭据/tail、延迟费用记录。仅在预检通过后建立临时 Access 窗口。测试 fixture 已延后到鉴权和 baseline census 通过后才写入。

实际只发生一次未认证的 gateway census GET：HTTP **404**，Content-Type 为 HTML。操作脚本误将合法 census JSON 的 **2 KiB** 上限也用于鉴权阶段的 HTML 错误页；有界读取触发断言中止，未存储页面正文。404 本身不是鉴权通过证据，也不能据此判断应用业务失败。

首次清理向两个 staging 入口发送关闭请求，管理 API 均返回 200，但即时读取未通过关闭断言；清理器按 fail-closed 规则停止后续 token/policy 修改。该次原始报告因此保留 **FAIL / cleanupPassed=false**。稍后的同次最终检查已读到四个入口关闭，但 Access 尚是 non_identity，因此仍失败。原报告没有保存失败读取的完整值，不将具体传播延迟原因写成已证实结论。

随后运行独立的 `.wrangler/staging/sse-capacity-v207-close.mjs --close-owned`：重新读取当前状态后，仅停用/删除本轮唯一 token、恢复双 Access 的 redirect-off 与 deny-all，最后完整复核隔离。结束于 **2026-09-08T12:35:41.631Z**，结果 **PASS**：

- 四个 staging Worker 入口/预览关闭，无 custom domain / Cron，设置及版本未变。
- 双 Access 应用及策略身份匹配，deny-all，临时 token 不存在，gateway tail 为空。
- 三个生产设置指纹未变；staging D1 schema/56 表计数恢复检查与原基线完全相同，恢复控制行不存在。

原执行报告、操作脚本和补充清理报告分别保留，不覆盖失败为成功。未 seed fixture、未发送推理，所以没有在途推理的 350 秒数据删除等待，也没有测试数据删除、财务写入或退款操作。本轮实际删除的是临时 Access token 与 tail；再次测试需新建临时凭据，不能恢复或重用已删除 token。

## 计数与当前门禁

| 项目 | 实际结果 |
| --- | --- |
| 管理 API | 原窗口 76 + 补充清理 50 = 126 次 |
| 公共测试 HTTP | 新增 1，首轮累计 **367** |
| D1 管理计数 | rows_read 674 + 674 = 1,348；rows_written **0** |
| 新推理 / 恢复 RPC / 容量样本 | **0 / 0 / 0** |
| 真实模型 / KMS 累计 | **0 / 0** |
| 部署 / 生产写入 | **0 / 0** |
| 预算 | 首轮累计 **US$2，不重置**；预检 192 条延迟费用记录不等于最终增量账单 |

Worker 仍为 v1.106 部署的 `448e313a-7fef-4712-bde0-412173954b65`。本轮未重新下载云端模块；继承 v1.106 的模块字节核验，新增的是版本/配置/隔离的当前复核。详见 [v1.107 清单](./C02-images-sse-capacity-transport-results.json)。

本轮使用 Workers 最佳实践技能，影响了有界响应读取、请求取消、禁止浮动 I/O 和本地证据与原生平台证据的区分；参考 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。2 KiB JSON 限额仍保留；鉴权错误页需要独立处理，而不是放宽业务响应上限。

## 下一项（有限顺序）

1. 在新版本操作端修复并测试鉴权错误页处理：非成功/HTML 响应不应按 census JSON 读取，保留状态与安全元数据，及时取消正文；不得把 404 视为鉴权成功。
2. 为关闭入口后的状态读取接入有次数和总时限的复核；只重读状态，结果不明时不盲目重复写入。保留失败与后续确认的独立事实。
3. 冻结新的脚本和测试，按累计 HTTP 367 与原 US$2 上限重新预检；再决定开启单条 after-hold 原生实验。**不得重跑 v203/v207 旧脚本。**

不可逆成功点仍是有效 completed 图片 + 实际上游 DONE，后续客户端取消不撤销费用；completed-only 与未知结果不虚构成功。原生同池容量、完整物理工作集、unknown/幂等政策、其他消费者、C02.G、Node 22/远程 CI、C01 剩余决定及 C03–C20 均未通过。
