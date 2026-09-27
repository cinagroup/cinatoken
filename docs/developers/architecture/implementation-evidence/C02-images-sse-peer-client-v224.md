# C02.B2.2 — V3 有界 WebSocket 客户端与真实回环

日期：2026-09-09；Checklist v1.123。状态：STAGING_PARTIAL。新增 Node 操作器观察客户端、真实本地 HTTP/WebSocket 测试和 CI 定义；未修改 Worker、结算算法、现有执行器或部署。

## 已实现的观察通道

客户端只接受原主响应的 V3 身份/回执 DTO，使用同一个 operator 单调时钟；原 Response 的来源仍须由后续联合 oracle 与原 session 核对。客户端不持有原 SSE reader、不发送推理/恢复请求、不修改 D1，也没有业务 lease 的释放权限。

定向观察固定为 `wss://cinatoken-proxy-staging.cinagroup.workers.dev/__staging/sse-capacity/watch-v3`。最多 8 次 Upgrade，全部共享从原主响应回执起算的 20 秒窗口；每次先消费共享 HTTP 次数预算，再确认持久化尝试日志，之后才构造 socket。日志失败可能保守消费预算，但不能因此发送或重试。原客户端只准调用一次 open。

只有真实 HTTP 409、完整 EOF 和精确 `peer_not_active_here` 正文，经过 v223 校验并持久化结果后，才允许下一个定向 GET。拒绝正文限 512 字节 / 64 块 / 1 秒，记录状态、时刻、字节数和完整正文 SHA-256，不保存原文。认证错误、重定向、其他拒绝、截断/超限、握手确认丢失全部停止；观察已建立后绝不重连，不会为了命中实例重发推理。定向查找仍不保证实例亲和。

握手及首样本共最多 5 秒，且受原 20 秒总窗口限制。101 必须核验实例/peer、V3、no-store 及无重定向标志，再等真实 ws open 和首个占用态样本。重复响应头不得静默覆盖。实际 ws 设置 maxPayload=512、maxFragments=512、maxBufferedChunks=512、HTTP 响应头上限 16 KiB，关闭压缩和重定向；不自动回复 ping，意外控制消息停止此固定诊断协议。核对了 [ws 官方 API 文档](https://github.com/websockets/ws/blob/master/doc/ws.md)与本地 ws 8.21.0 实现，未升级依赖。

held → post-native → post-recovery 三个标记仅沿同一 socket 发送。每个标记先验证原时钟上的前置事实，再确认发送前日志，消费一次标记后发送；5 秒内必须同时取得 send 回调确认、对应 ACK 和 ACK 后首样本。ACK/样本不是发送确认的替代。旧阶段样本不升级为新事实，没有命令重发。只保存一个当前阶段的 ACK/样本及最多四条阶段记录，不建立持续消息历史。

客户端总寿命至多为原主响应后 180 秒；每次日志确认最多 1 秒。停止时关闭自有 socket/拒绝正文、清理自有监听器和计时器，封存报告。正在写日志或执行阶段时停止，必须标记失败/日志未确认；已经发起的持久化不能撤回，但迟到回调不能追加记录、发送命令或改变封存结果。终态报告的外层持久化仍由未来执行器负责，本模块不把“内存中封存”冒充最终日志已落盘。

## 验证与明确边界

新增 46 项测试：44 项客户端回环/故障/预算/日志/时钟测试；2 项使用已冻结 V3 服务端产生实际消息、经过真实 Node HTTP/WebSocket 传输的互通测试，其中一项先命中另一实例的明确拒绝，再连接原实例。断言只有一次合成主调用、仅一个匹配 observer、阶段身份与顺序、没有凭据/原拒绝正文进入报告。

真实网络部分为 `127.0.0.1` 上的 Node socket；WebSocketPair/101 仍有显式本地适配，业务 owner 的释放由测试控制。180 秒总寿命测试也显式使用模拟计时器。它们均不是 Workers 原生 host、Access、D1 财务或物理内存证据。

最终联合回归 **2,064/2,064 PASS**，失败/取消/跳过均为 0；staging 类型检查 PASS。见[独立验证回执](../../../../.wrangler/staging/sse-peer-client-v224-verification-result.json)。既有 1,837 条摘要及新增 4 个源码/测试/CI 文件在运行前后核对；新[机器清单](./C02-images-sse-peer-client-v224-results.json)共 1,848 条摘要，保留全部既有证据。新增 46 项均包含在最终回归中。

保留初始测试清理问题：44 项断言通过且最终退出码 0，但测试在启用模拟计时器后才关闭旧客户端，旧真实计时器令进程耗时 192,445.3086 ms。原进程完成后才修正测试为“先安装计时器模型，再创建唯一客户端”；保留初始源码和[观察记录](../../../../.wrangler/staging/peer-v224-initial/observation.json)，不将该慢退出运行冒充最终回归。未重启或覆盖仍运行的进程。

本轮使用 Cloudflare 技能保持原推理与观察请求所有权分离，并明确真实回环与 Workers 平台验收的区别。本机 Node v24.14.1、ws 8.21.0；Node 22/24 CI 仅定义，远程 CI 未执行。v222 Worker 候选及已冻结输入未改，未重做 dry-run/绑定生成。

## 下一步

实现 V3 原生/D1 联合因果 oracle，并将本客户端接入 primary-first 一次性执行器：原 SSE reader、session、拒绝留证、native collector、held/取消/两次去重恢复事实和 finalizer 必须来自同一个真实请求及原时钟。不能把 V3 占用态首样本转换成 V2 空闲 baseline，也不能把观察报告的成功当作 host/native/账务成功。

之后才能重新做新鲜只读云端前检、原累计预算核验、封闭候选部署和受控 Workers 验收。没有把本地 transport PASS 升级为 C02.G 通过；物理/跨消费者容量、unknown/幂等、C01 和 C03–C20 仍开放。

本轮无 staging 云端 API/公开 HTTP、D1 写入、部署、真实模型或 KMS 调用；仅文档检索和本地回环网络。最后实际云端观察仍为 v220，部署仍为 V2；公开 HTTP 累计 390，模型/KMS 0/0，首轮 US$2 累计上限不重置，最终增量账单未核实。
