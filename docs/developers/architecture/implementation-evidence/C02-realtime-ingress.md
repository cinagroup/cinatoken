# C02.B2.2 — Node Realtime 公开 Upgrade 入口

日期：2026-09-05。状态：**本页所列 Node 入口子集 LOCAL_PASS；C02 仍为 DOING。** Owner / 本地自检：Codex（当前任务）；独立 Reviewer 待指定。

接续 [Realtime 建连/桥接证据](./C02-realtime-connection.md)。Google Cloud KMS 与 project `cinatoken` 沿用 [C01 已确认记录](./C01-google-cloud-kms-selection.md)。本轮只读取现有记录及本机 CLI 路径；PATH 中的 gcloud 调用未能启动，没有再次访问云账号、启用 API、创建 key 或修改 IAM。不能把历史项目核验或本机 CLI 可执行文件存在当成应用 KMS 已就绪。

## 1. 实现范围

1. 将 Node HTTP Upgrade 所有权抽到 [独立入口](../../../../packages/proxy/src/runtime/node-realtime-upgrade.ts)，由 [Node 启动入口](../../../../packages/proxy/src/runtime/node.ts)调用。共享 Hono app 只执行一次；不预先调用 `ws.handleUpgrade`，直到已经鉴权并通过路由内前置检查的调用链进入 Node dispatch callback，才接受客户端。
2. Hono 和 Node 均接通 `/v1/dashscope/realtime`、`/api/v1/dashscope/realtime` 两个规范路径；浏览器 subprotocol Key 提取与预算入口豁免使用同一精确路径判断。尾斜杠、附加子路径、相似前缀不会在 Node 被接纳；没有为其他产品表面新增别名。
3. 鉴权/前置校验失败仍处于 HTTP 阶段：保留共享 app 的状态、错误正文和少量允许的响应头，不先返回 101。普通 HTTP 缺少 Upgrade 的公开状态是既有错误规范化后的 **400**，不是路由调用处写出的 426；本轮未修改这一全局规范。
4. Node 从收到 Upgrade 事件开始拥有 **30 秒绝对建连时限**与 TCP close/end/error 取消信号。绝对起点继续传给实际 Node adapter；忙碌事件循环尚未执行 timer 时也先检查时间，不能迟到返回 101。成功桥接并返回 app 响应后撤销建连 timer；原始 socket 取消信号仍保持到关闭，不能把建连上限当成会话上限。
5. 不以竞速丢弃 `app.fetch` 或已开始的准入写入。超时可以先返回 HTTP 504 / 关闭 WebSocket，仍观察 app 完成；迟到进入 Node dispatch 会被拒绝。这**不证明数据库写入本身在 30 秒内结束，也不证明全部准备步骤已及时取消**。
6. 在握手前持续读取以观察 FIN，同时把提前发送的原始帧限制在 **64 KiB**，含 Upgrade head 与后续 chunk；超限返回 413。接受时按顺序一次性交给 ws，随后移除临时读取者。正常客户端在收到 101 后发送，不受这一握手前限制；已有会话/单帧限制未修改。
7. HTTP 拒绝正文读取上限 **8 KiB**，不 clone；读取挂起受同一时限约束，超限或读取失败使用固定说明。不转发 Authorization、Set-Cookie、Location 等任意响应头；允许头单项最多 512 字节。此处是入口本地错误防护，不声称实现所有 OpenRouter 错误/重试合同。
8. 已接纳后的失败使用固定短 ASCII close reason，不把上游正文、原始异常或多字节长消息塞进关闭帧。关闭出错继续尝试 terminate；不确定是否已写出握手字节的异常直接关闭物理连接，不追加第二个 HTTP 响应。

**101 的含义仍只是接受客户端连接**：OAuth、耐久预算准入及上游握手发生在其后，仍可能失败。没有声称在所有上游/资金检查通过之后才发出 101。

## 2. 新增验证

[新增测试](../../../../packages/proxy/src/runtime/node-realtime-upgrade.test.ts) **32 项**，已接入主测试和 dispatch-safety 收集及专项类型检查：

- 10 项真实共享 app + Node HTTP 入口拒绝：两个前缀下缺 Key、无效 Bearer、有效 Bearer/浏览器协议但缺 model、无效 Bearer 不回退到有效 subprotocol。证明拒绝前没有调用 ws 接受接口；使用合成 Key 行，不访问真实数据库。
- 2 项直接共享 app 验证普通 HTTP 缺 Upgrade / 非法 operation。其他 30 项均使用 127.0.0.1 临时端口，包括路径、方法、错误正文/头、提前 FIN、超时与准入迟到等；不能将“使用本机 TCP”称为完整应用集成。
- 3 项建立真实本机上游 WebSocket：两个规范前缀各一次桥接，以及 Upgrade head + 后续握手前帧顺序交接。验证上游使用合成 provider Key、没有透传客户端认证协议，模型正确改写，只有一次客户端 Upgrade 与预期上游连接。成功会话不被已清除的建连 timer 终止，客户端断开仍取消请求。
- 这些成功桥接用显式的 app callback fixture 调用真实 Node adapter，**不包含真实 Realtime route 的全部选路、Guardrail、BYOK/共享池、预算 SQL 或资金结算**。公开 app 的已测部分是拒绝入口；不能拼接两个独立 fixture 来声称端到端账务已通过。
- 覆盖超时先结束传输但等待原 app/准入完成、timer 尚未被调度时的绝对时间检查、无效 WebSocket 握手不进入准入、超量/挂起拒绝正文、脱敏关闭及提前帧有界交接。mock timer 只用于时间推进，测试结束清理本机服务器与连接。

初轮测试曾因 fixture 将 capability endpoint 放错层级导致两个桥接超时，并因忽略既有错误规范化而把 400 误断言为 426；均按实际接口纠正，未放宽成功桥接断言。专项类型检查发现新测试 Buffer callback 缺参数类型，补齐后重新执行最终完整主套件与专项。

## 3. 最终验证

环境：Windows / Node.js **v24.14.1**；仓库 Node 22 未运行。

| 命令 | 最终结果 |
| --- | --- |
| `npm.cmd test -w @octafuse/proxy` | 退出 0；pretest 链全部完成，主套件 **1,657 tests / 135 suites**，0 fail/cancelled/skipped |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 退出 0；**1,282 tests / 50 suites**，0 fail/cancelled/skipped |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0，包含新增入口测试 |
| `git diff --check` | 退出 0 |

最后两次完整测试命令通过 PowerShell `2>&1 | Select-Object -Last ...; exit $LASTEXITCODE` 展示末尾摘要，保留 npm 退出码；没有跳过 pretest 或失败用例。两套测试高度重叠，不相加成唯一数量。Core 完整主套件未单独重跑；Workers 真机、Node 22、真实数据库和云环境均未验收。

## 4. 基线与保护范围

HEAD：`7eb59008f7d8e156e81fd18a57658fdef2553264`。开始时 **137 个 dirty/untracked 文件**。本轮只改变 8 个源码/测试/收集配置文件：app、auth、Node 启动入口、新 Upgrade handler、新路径 helper、新测试、Proxy package.json 和专项 tsconfig。保留其他既有变更。

[快照](./C02-realtime-ingress-snapshot.json)登记 **37 个文件**，包含这 8 个文件与相关保护文件；最终测试前记录受改动文件哈希，测试后及文档写入后复核。不改写上一轮建连/桥接快照。

Realtime route/账务 helper、实际 Node/Workers adapter、共享 dispatcher、Core、Admin、Wrangler、依赖锁与原 V2.1 方案未修改。没有启动真实配置的 Node 应用、生产迁移、部署、资金操作、真实 OAuth/模型/KMS 调用或远程 CI，也没有新建 agent。

Workers 最佳实践技能影响了实现：只使用请求局部状态、不无界读取/clone 错误正文、观察异步清理、区分连接与会话所有权。依据 [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)和本机类型/schema；最新 registry 获取失败，按技能 fallback 使用已安装 workers-types **5.20260829.1**，未声称最新版或 workerd 验证通过。未增加 binding 或更改 compatibility 配置。

## 5. 剩余工作与唯一下一步

**继续 C02.B2.2 Realtime 公开路由与账务集成**，尚不能进入 C02.G：

1. 覆盖两个 ASR operation 的完整公开成功/失败路径、已验证定价、有限 Ordinary/Guardrail 预留，以及实际/明确拒绝/unknown 的结算；明确区分 SQL 意图和真实事务证据。
2. 注入清理写失败，验证 Guardrail 与 Ordinary 都被独立尝试终结；检查当前 route 的顺序 cleanup 不会因第一个异常跳过第二个。
3. 验证 BYOK / 共享池实际候选链、拒绝后重试时已排队但未发送客户端帧的处置。**本轮只保证握手前 prefix 交接，不保证跨上游拒绝候选保留帧。**
4. 完整入口/数据库准备的及时取消仍需实现；当前原始 signal 会阻止迟到 dispatch，但旧准备逻辑可能继续读库或完成已拥有的写入。Workers 入口没有获得本轮 Node 原始 Upgrade timer；不据此宣称两个 runtime 全阶段时限一致。
5. 随后处理 Admin playground，再推进 TTFT / idle / 分阶段与真实 runtime 验收。Node 会话 close-ack、生产可用性与费用证明仍不齐备；实时 TTS 继续禁用，Qwen HTTP TTS 格式门禁保留 C17/C15。

C02.1–C02.7、C02.G 保持未勾选；C01 KMS location/保护级别/IAM 仍待定，C03–C20 不据本子集宣称通过。回退只能关闭/收紧未验收能力，不恢复未鉴权先接受、无界读取、取消后迟到发送或删改账务事实。

