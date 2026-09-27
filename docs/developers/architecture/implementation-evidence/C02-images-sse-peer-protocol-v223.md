# C02.B2.2 — V3 观察协议与主响应身份校验

日期：2026-09-09；Checklist v1.122。状态：STAGING_PARTIAL。只新增 Node 操作器的协议基础层、测试和 CI 定义；没有修改或部署已冻结的 V3 Worker、生产代码或结算算法。

用户确认的收费边界保持不变：有效 completed 图片与真实上游 DONE 均已验证后，成功结算不可逆；客户端随后取消不撤销费用，仅 completed 无 DONE 保留原规则。既有[结算点修复](./C02-images-sse-settlement-window.md)和[真实取消子集](./C02-images-sse-cancel-staging.md)仍有效。本轮不是再次修改这条规则，而是为后续同实例容量验收补齐输入和消息校验。

## 新增合同

1. `captureSseCapacityPrimaryV3` 只从真实 200 SSE Response 采集有限响应头及原请求时钟回执。校验可信 generation ID、实例 UUID/epoch、V3 标识、固定 URL、no-store 和 pre-dispatch `0/0`。不读取、clone、tee 或取消正文；必须在获取原 SSE reader 之前调用，正文所有权继续留给请求操作器。
2. V3 消息解析器的首个样本必须是 sequence=1、barrier=0、requests=1。主响应中的预准入 `0/0` 与 WebSocket 首样本中的占用态分别校验，不能用 V2 的空闲 baseline 替代。
3. `mark()` 仅按 held → post-native → post-recovery 顺序消费三个标记。ACK 必须对应已消费的标记，紧随 ACK 的样本必须具有同一 barrier；旧阶段排队样本仍保留旧 barrier，不能升级成新阶段证据。等待 ACK 或其样本时不能重发、不能开始下一标记。
4. 按服务端合同限制每个完整文本消息最多 512 字节、最多 180 个样本 / 184 条消息、累计最多 94,208 字节。二进制、未知消息类型、非法 UTF-8、BOM、非规范 JSON、重复键、额外字段、错误身份、乱序及超限全部永久封闭解析器。只保留数字状态，不建立消息历史或队列。网络接收缓冲仍需未来真实 socket 的 maxPayload 约束，不能把应用层检查说成原生内存证明。
5. 完整拒绝分类器只识别精确 HTTP 409 JSON `peer_not_active_here`，要求调用方提供实际完整正文及 EOF 标记、JSON/no-store，排除 generation/upgrade/redirect 标志。认证拒绝、截断、其他拒绝原因和非规范正文不满足条件。该结果只是服务端声明，不证明推理未发生，也不授予推理重放或已建立 observer 重连权限。

解析器不发送网络请求、不持久化日志、不操作 SSE/财务/业务 lease，不产生 nativeVerified、容量释放或 C02 通过结论。`finish()` 只核验协议终止；close/EOF 不能补造 end/native。ACK 未返回时收到 deadline 可以终止协议，但不会把未确认标记变成已确认。

## 验证

新增专项 **80/80 PASS**：77 项协议/身份/拒绝/边界测试，3 项复用已冻结 V3 服务端的互通测试。互通测试直接消费服务端产生的消息字节，验证完整 180+3+1 输出以及“foreign peer”与“已消费 observer”的区别。WebSocketPair/101 仍为显式本地适配；业务 lease 由测试明确释放，不伪称 native 释放。没有真实回环 socket 或 Workers 网络测试。

联合回归 **2,018/2,018 PASS**，失败/取消/跳过均为 0；staging 类型检查 PASS。见[独立验证回执](../../../../.wrangler/staging/sse-peer-protocol-v223-verification-result.json)。既有 1,828 条摘要及新增 4 个源码/测试/CI 文件在运行前后核对。新[机器清单](./C02-images-sse-peer-protocol-v223-results.json)共 1,837 条摘要，不覆盖既有发布证据。未重新打包或生成绑定；v222 候选 bundle 及其 789 个输入摘要保持原样。

本轮使用 Cloudflare 技能区分本地适配、真实平台行为和观察请求所有权。没有引入新的平台 API、资源或配置。Node 22/24 CI 仅定义；本机 Node v24.14.1，不声称远程 CI 或 Node 22 已验。

## 下一步与未通过门禁

先实现真实 Node WebSocket 传输：与原主响应时钟绑定的有限定向 Upgrade、共享 HTTP 次数预算、发送前持久化日志、认证和升级确认、正文 EOF/超时/有界队列、关闭后迟到回调封闭。只有明确未匹配实例的完整拒绝才可在原预算内继续查找；认证失败、确认丢失及连接建立后断开均停止。解析器 `mark()` 应在发送前日志确认后、实际 send 前调用；失败后不重发命令。

随后补真实回环 socket 测试、原 primary-first 因果 oracle、同一个 SSE reader/session/native collector/D1 事实的单次执行器，以及新鲜隔离前检和受控 Workers 验收。协议层通过不代表这些部分已完成，也不保证 Cloudflare 请求实例亲和。

本轮云端 API、公开 HTTP、D1 写入、部署、真实模型/KMS 均为 0。最后实际云端观察仍为 v220，实际部署仍是 V2；公开 HTTP 累计 390，真实模型/KMS 0/0，首轮 US$2 累计上限不重置，最终增量账单未核实。物理/跨消费者容量、unknown/幂等、C02.G、C01 和 C03–C20 继续开放。
