# C02.B2.2 — V3 原请求、同池、native 与账务联合验收

日期：2026-09-09；Checklist v1.124。状态：STAGING_PARTIAL。新增 V3 纯校验器和本地完整事实测试；未接入云端一次性执行器，未部署或修改结算规则。

## 联合校验合同

先核验已封存、无失败、无日志未确认的 V3 客户端报告。原主响应身份/时钟必须一致，所有 Upgrade 消费记录必须齐全；前序只能是完整明确的实例不匹配，最后一次必须是确认的 101 + open + 占用态首样本。核对 8 次/20 秒总窗口、5 秒握手、1 秒拒绝 EOF、3 次标记和解析计数上限。未封存、仅有成功布尔值或缺少实际发送/确认记录均拒绝。

V3 的 pre-dispatch `0/0`、首个 watch 样本 `requests=1` 分别核验，不转换成 V2 baseline。三个阶段必须使用同一 peer/epoch、原单调时钟和递增样本序号；发送确认、ACK 和 ACK 后样本均不可缺失，旧阶段样本不能代替新事实。

随后联合校验一条原始 after-hold 请求：

1. 主响应回执等于原 session 的 headers 时刻，watch 在它之后建立。
2. held DB 事实在 baseline 后取得，held 标记绑定该回执且早于原客户端取消。有效 completed / 上游 DONE 的探针事件必须有序且属于同一请求。
3. 原 native invocation/warning、取消行、快照逐字节关联、部署版本及原 tail 接收时钟都通过既有 native V3 契约。native 时的 held 快照、上游终态、pending job 和空日志集合必须与先前事实相同，不能抹去已经发生的提交。
4. post-native 标记绑定这次原始 native 观察回执；其完成后才允许验收两条不同 runId、顺序执行且完整确认的恢复结果：第一次提交 1，第二次提交 0，无 uncertain/blocked 等异常计数。
5. 恢复与去重后的完整六表事实一致，snapshot/cancel 行仍是原字节；复用冻结的完整财务 oracle 核对身份、payload/digest、租约/回执、日志、费用和预算终态。不是只比较费用总额。

校验器无网络、SQL 执行、删除、退款、推理或恢复调用；不会返回财务 oracle 内部构造的清理语句。只有逻辑样本、原生契约和完整财务事实全部满足，才返回单请求的 `AFTER_HOLD_PEER_V3_EVIDENCE_PASS`。native 或账务事实通过不覆盖 `INCONCLUSIVE_HELD`、`OCCUPIED_AFTER_NATIVE_MARKER`、`OCCUPIED_AFTER_RECOVERY_MARKER`。所有结果均保持 `c02GatePassed=false`、`isolateEvictionProven=false`、`cleanupExecuted=false`。

纯校验器不能凭 JSON 自证远端来源或日志已落盘。未来 live 执行器必须先持久化原 session、原 collector 和原 DB 读取，以及已封存客户端报告，才能调用它；历史失败记录不能靠补写时钟升级为成功。

## 本地真实链与明确模拟

新增 107 项检查：4 个直接/先明确拒绝 × 释放/仍占用组合，101 个独立证据篡改子测试，以及篡改组父测试和容量结论测试。篡改覆盖主请求、时钟、发现/握手记录、消息序号、日志确认、native 原始字段、取消/快照、两次恢复以及同时伪造费用/缺失完整财务行；验证期间 SQLite total_changes 不增加，完整账务不变。

fixture 使用实际共同 Images handler、V3 观察服务端、原 Request.signal、实际读取未完成 SSE 的 reader、完整 SQLite 迁移、实际持久化与实际恢复/去重。主请求通过实际 app.fetch 本地调用，观察通道经过真实 Node HTTP/WebSocket。上游探针在合成上游真正 enqueue completed / DONE 时写入，而不是在验收时补造事件；没有模型调用。V3 帧来自实际服务端，不改名或重写占用计数。

**仍明确模拟的部分**是 WebSocketPair/101 适配、native host-stop / tail envelope 和单调时钟的经过时间。空闲场景拒绝测试中的 held ACK，并临时令原任务确认读取失败，待实际旧 owner 收尾后再恢复独立恢复消费者的读取；仍占用场景保留原 ACK pending 到测试收尾。因此本地输入满足 native 契约时的返回值只表示契约校验通过，不代表采集了真实 Workers 事件；本轮机器清单仍登记 nativeVerified=false。

初次 4 项测试中 2 项失败：故障注入比较了未归一化的多行 SQL，未命中确认读，原任务实际提前提交了 job/log，严格 pending 状态检查因此拒绝。保留[原 fixture](../../../../.wrangler/staging/peer-v225-initial/fixture.mjs)和[失败观察](../../../../.wrangler/staging/peer-v225-initial/observation.json)。修正为完整已知 SQL 形状的空白归一化，并断言确实命中；没有用伪造 pending 行、重写金额或放宽验收解决测试失败。

专项最终 107/107 PASS；联合回归 **2,171/2,171 PASS**，失败/取消/跳过均为 0，staging 类型检查 PASS。见[独立回执](../../../../.wrangler/staging/sse-peer-acceptance-v225-verification-result.json)与[机器清单](./C02-images-sse-peer-acceptance-v225-results.json)。既有 1,848 条摘要及新增 4 个源码/测试/CI 文件在运行前后校验；新清单合计 1,859 条摘要。本轮使用 Cloudflare 技能区分原请求所有权、平台证据和本地模拟；本机 Node v24.14.1，Node 22/24 CI 仅定义，未执行远程 CI。

## 下一步及边界

接入 V3 primary-first 协调器/一次性读体窗口与外层执行器：保持唯一主请求、原 SSE reader、原取消时钟和 collector；在阶段切换前校验原证据，在调用联合验收前持久化封存报告。复用独立关闭/撤销/原子清理边界，不因新协议重放不确定请求、RPC 或升级历史记录。然后进行新鲜隔离/账单前检、封闭候选部署及受控 Workers 验收。

本轮 staging 云端 API/公开 HTTP、远端 D1 写入、部署、模型/KMS 调用均为 0，只有本地回环网络。最后实际云端观察仍 v220、部署仍 V2，v222 候选及 789 个 bundle 输入未变，未重新打包或生成绑定。公开 HTTP 累计 390、模型/KMS 0/0、首轮累计 US$2 上限不重置，最终增量账单未核实。物理/跨消费者容量、unknown/幂等、C02.G、C01 及 C03–C20 仍开放。
