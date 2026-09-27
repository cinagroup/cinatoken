# C02 — SSE 持久化期间真实客户端取消

2026-09-08；Checklist v1.97。状态：STAGING_PARTIAL。本次两类真实取消及独立恢复/去重矩阵 PASS；本地 1,046/1,046 通过。固定安全窗口后的原子清理及最终隔离复核全部 PASS，不等于 C02.G 已通过。完整记录见 [机器证据](C02-images-sse-cancel-staging-results.json)。

## 观测与修复边界

保留用户确认的不可逆成功点：有效 completed 图片与真实上游 DONE 均已验证后，客户端取消不能撤销成功费用。仅 completed、无上游 DONE 的情况不改变原规则。本轮不修改生产结算算法，新增的是独立 staging 的原生取消观测与测试。

新观测器监听**原始入站 Request.signal**，不人工 abort Worker 请求、不消费或改写响应正文、不记录取消原因及请求头。只有专用版本头、已通过原有请求/API-key 校验的 SSE 200 和可信 generation ID 才注册。独立 system_config 观察行记录原生 abort 事件以及当时自有快照探针的有界值；不修改财务表或原快照探针。

按 Workers 最佳实践立即登记 waitUntil，观察窗口固定 20 秒；这个附加观察任务不替代财务任务，也不能延长平台自身的断连后时限。enable_request_signal 已存在于 staging 配置，本轮没有新增兼容标志或更改生产配置。[Cloudflare 原生取消说明](https://developers.cloudflare.com/changelog/post/2025-05-22-handle-request-cancellation/)、[Request.signal](https://developers.cloudflare.com/workers/runtime-apis/request/)。

## 真实 Workers 证据

本轮仅部署 gateway 版本 366a21b4-eaf2-4e2e-8a62-9e0d95f59d9d；云端入口 SHA-256 与冻结候选一致：27d64e4faea4978fb4bbe72ec6f23b329b65dcaf3d88aa4998f7bc475566be83。settings 指纹不变，其余三个 staging Worker 未部署。

操作器先收到唯一有效 completed 帧，确认尚未收到 DONE、HTTP 正文读取仍未结束，再用真实客户端 AbortController 中断网络请求；两次未完成的 read 均返回 AbortError。随后必须从 D1 读到 signalAborted=true 且快照仍为对应 held 阶段，才允许释放暂停。不会用客户端取消动作本身代替服务器已观测取消的证明。

| 取消位置 | 取消时的数据库事实 | 后续事实 |
| --- | --- | --- |
| held-before-insert | 已有出站意图和预留；尚无 snapshot/job/log；原生取消观察中保留 held-before-insert | 观察确认后释放暂停，成功事实继续持久化，产生唯一回执和 0.1 合成日志 |
| held-after-insert | snapshot/job 原生提交，changes=2、rowsWritten=9；任务 pending、日志尚无；原生观察仍为 held-after-insert | 生产者尚未释放时，独立消费者扫描/认领/提交各 1；随后释放生产者，仍只有一份回执和日志 |

第二次恢复调用扫描/认领/提交均 0。独立消费者恢复后、生产者释放后、再次对账后，六组完整财务行逐字段一致。最终两条日志都是 success、output_image_count=1、upstream_attempt_count=1；intent/snapshot/job/receipt/log/reservation 各 2 条。每个请求只派发一次合成推理，未重新发送生成请求。客户端没有收到成功 DONE 也不会因此撤销上述成功费用。

首次缺失 Access 凭证探测返回传播期 404，按既有有界规则重查后为 401；错误凭证也被拒绝。有效网关凭证为 200，控制入口有效凭证但缺 command header 为 400，不触发恢复；两次真正的恢复均使用独立 command 与原生 Access 授权。该传播期观察保留，未重放推理。

## 本地与清理合同

28 项新增（16 项观测器及验证边界、12 项完整网关/SQLite/取消/恢复/清理）加既有 1,018 项，共 1,046/1,046，零失败、取消、跳过。包括释放和不释放暂停、取消后独立恢复、重复结算防护、原生观察缺失/超限/写失败、虚假 held 身份拒绝，以及保存失败、观察行变化、晚到额外行、删除回滚、删除 ACK 丢失。

新清理模块复用既有完整财务 oracle，仅将独立取消观察行的数量、所有字段守卫和删除追加到**同一原子清理 batch**。先持久化观察证据，不改写原始 phase，不拆事务。未观察到取消的 armed 行可在失败测试收尾中精确删除，但绝不能据此声称取消测试通过。

Node 24.14.1 实跑；staging tsc、Wrangler 4.127.1、绑定生成与检查、离线构建均通过。新增 CI 声明 Node 22/24，远程 CI 与 Node 22 未运行。仅新增 staging 代码、测试及操作器，生产账务、数据库 schema 和真实密钥未变。

## 收尾、费用与下一步

操作器已正常退出（exit 0），cleanupPassed=true。固定安全窗口后，原子删除本轮两组已结算的合成夹具及独立取消观察行；删除前的完整财务与观察证据已保存，可用于复核，但未提供业务数据恢复操作。56 张表行数与 295 项 schema 基线复原，两个 Access 入口均关闭并 deny-all，临时服务令牌已移除。四个 staging Worker 的最终状态符合冻结候选，其余生产资源未变；源文件完整性复核 PASS。

本轮新增 11 次公开测试 HTTP（7 次 Access 检查、2 次合成 SSE、2 次恢复 RPC），累计 333 次。预检、部署复核与操作器合计 216 次已计数管理 API 调用；返回的管理 D1 元数据合计读取 2,527 行、写入 180 行。仅部署一次 staging gateway。

首轮累计新增费用上限仍为 US$2，不重置；真实模型/KMS 累计调用为 0。操作预算预留不是实际支出，管理 D1 计数不包含 Worker 绑定查询或 Wrangler 内部请求，最终 Cloudflare 项目增量账单未核验。

下一步是 SSE 持久化期间的**原生 Workers 终止与独立恢复**。本轮两个已释放暂停的取消样本，不证明平台终止、不释放暂停的线上取消、完整实例容量或客户 intent-only 对账已完成。C02.G、Node 22/host、完整物理容量与 C03–C20 仍开放。
