# C02.B2.2 — Realtime 建连认证预算与连接生命周期

日期：2026-09-05。状态：**已列本地子集 LOCAL_PASS；C02 仍为 DOING。** Owner / 本地自检：Codex（当前任务）；独立 Reviewer 待指定。

接续 [TTS 证据](./C02-tts-auxiliary-auth.md)。Google Cloud KMS / project `cinatoken` 已登记，本轮只复核现有记录；未再次访问云账号、启用 API、修改 IAM 或配置真实密钥。location / SOFTWARE-HSM / 服务身份仍待确认。

## 1. 本次实现

1. Realtime proxy 将共享辅助认证预算传到 Workers driver 与真实 Node adapter 的两个 OAuth 调用点。认证 exchange 与上游建连许可各受既有每请求最多 3 次约束；32 候选和复用预算的多次调用不会重置认证许可。普通 Key / 有效缓存不消耗新认证许可。统计的是建连/dispatch，不宣称一条 WebSocket 等于恰好一次可计费模型任务。
2. 建连 owner 从 OAuth 之前开始，覆盖认证、准入前准备和出站 Upgrade 等待。沿用既有 **30 秒建连上限**；调用方绝对时限可收紧。proxy 使用共享 dispatch budget 的创建时间（没有共享预算时为 proxy 开始时间），跨候选及复用预算的 proxy 调用不能刷新。
3. 准入写入不使用取消竞速丢弃：等待完成/失败，再检查停止状态。持久化失败原样上抛；取消期间晚完成的准入不能启动连接。本轮不证明挂起数据库写入会在 30 秒内返回。
4. 出站 URL 协议/语法、凭据 Header 与返回 subprotocol Header 在发送前验证。异常描述不带入真实 Header 值。Workers 使用 `redirect: manual`；Node `ws` 显式设置 `followRedirects: false`。这不是完整 Target allowlist / SSRF 验收。
5. 已观察到明确 300–599 非 101 拒绝时丢弃正文，不再无界读取/排空；仅保留用于重试的 Retry-After 和独立提取的有界 request id。Node destroy HTTP response 并终止未打开的 ws；Workers 不等待正文 cancel 的确认。
6. 无效 2xx、无 socket 的 101、发送后传输失败/取消/时限及已接受后的连接设置失败，保持 unknown / 禁止重放。发送前停止返回可信 499/504 与 pre-dispatch 标志；认证许可用尽保留原错误类型。取消之后才到达的拒绝/Upgrade 不改写已经返回的 unknown；迟到的 Workers Upgrade 会 accept 后 close，而不是被交给新请求。
7. Node 客户端在 OAuth、准入或建连中关闭，会中止当前连接 owner，丢弃未转发队列，不能迟到开连接或刷新发送。新增 close-before-open 处理；`ws.terminate()` 引发的异步 error 有独立所有者直到 close，避免删除监听器后产生未处理 error。已接受客户端在路由准备及候选间也保留 error 所有者。
8. 桥接完成只结算一次 usage，先移除转发监听器/清理计时器，再关闭两端，防止同步 close 事件改变最初失败原因。父请求取消、会话上限、输入/输出限制与传输错误都会停止继续转发；Workers 的 half-open 两端均完成 close。close code 过滤保留码，reason 按 123 个 UTF-8 字节截断；close 异常不阻断另一端和计量清理。
9. 建连成功即释放建连时限，连接后的生命周期仍由会话及父请求管理。既有公开入口 10 分钟会话上限、PCM / 费用上界和实时 TTS 禁用门禁未修改；没有注入 sessionLimits 的内部直接调用，不据此获得默认会话时限。

主要文件：[建连 owner](../../../../packages/proxy/src/services/egress/realtime-connection-lifecycle.ts)、[Workers driver](../../../../packages/proxy/src/services/egress/dashscope-realtime-driver.ts)、[Node adapter](../../../../packages/proxy/src/runtime/node-realtime.ts)、[Realtime proxy](../../../../packages/proxy/src/services/proxy.ts)。

没有把通用 HTTP deadline wrapper 直接用于 101：其错误正文 materialization 会破坏 Workers Upgrade Response。当前 Realtime 仅在实际 driver 建连边界执行共享绝对时限；完整入口 / 路由与数据库准备期间的及时取消仍需另做。

## 2. 新增测试与实际证据范围

新增 **149 项**，收集在 [生命周期测试](../../../../packages/proxy/src/services/egress/realtime-connection-lifecycle.test.ts)：

- Node / Workers 两种路径 × 四种原生 operation：共享认证许可、缓存/普通 Key、发送前停止、OAuth 挂起、准入取消与持久化失败、发送后停止、明确拒绝、无效 2xx、Upgrade 后取消与不再转发。
- 额外覆盖关闭码/UTF-8 reason、Node 客户端早关、close-before-open、脱敏错误、跨候选及跨 proxy 调用的 deadline、不把建连时限延长成会话时限。
- 4 项使用安装的真实 `ws@8.21.0` 与本机 127.0.0.1 随机端口：建连取消、建连超时、无限等待正文的 503、带 Location 的 302。均只观察到一次 HTTP Upgrade；返回预期状态、服务器观察到 TCP FIN 并确认关闭，没有未处理异步错误。测试结束清理本地服务器；不是公网模型请求，也不证明远端已撤销费用。

Workers 101 / WebSocketPair 使用明确的 Node fixture；只验证应用逻辑，不冒充 workerd / Cloudflare 真机。原 Node 测试的 3 项失败已修正：过期状态改为断言 504 与元数据，另两项改为等待实际建连结果，不假设固定一个微任务。补齐旧 fixture 的必要类型与 terminate 行为。新收集既有 26 项 Node / Workers driver 测试到专项；它们不算本轮新增。

四项 loopback 的初轮断言失败来自测试服务器在 Upgrade 后未消费 FIN、未完成自己的半关闭；补入服务器 end / resume 后，最终分别验证 peer FIN 和关闭。没有通过取消物理关闭断言来掩盖失败。

## 3. 最终验证

环境：Windows / Node.js **v24.14.1**。仓库 `.nvmrc` 为 22，本轮未运行 Node 22。

| 命令 | 最终结果 |
| --- | --- |
| `npm.cmd test -w @octafuse/proxy` | 退出 0；全部 pretest 链完成；最后主 suite **1,625 tests / 135 suites**，0 fail/cancelled/skipped |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 退出 0；**1,250 tests / 50 suites**，0 fail/cancelled/skipped |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0；包含新增生命周期及修改后的 Node 测试 |
| 本轮修改范围 `git diff --check` | 退出 0 |

主 suite 与专项大量重叠，不相加为唯一测试数。Core 完整主套件本轮未单独重跑，专项包含既有 GCP OAuth / 认证预算测试。首次完整回归为 1,623 / 1,248；复核补上共享预算起点的两项测试后，重新执行上述最终完整命令，最终结果替代初轮结果。

应用 OAuth 调用点静态核对：17 处中的 **16 处**已接入辅助认证预算，剩余 **1 处 Admin playground**。排除 Core 函数定义及合成 workerd fixture。调用点接线不等于全部公开入口 / Workers / 生产验收。

## 4. 基线、快照与非目标

HEAD：`7eb59008f7d8e156e81fd18a57658fdef2553264`。开始时工作树已有 **130 个 dirty/untracked 文件**；保留既有用户修改。本轮 8 个源码/测试/收集配置文件发生改变，另更新本证据、快照、索引与 Checklist。

[SHA-256 快照](./C02-realtime-connection-snapshot.json)登记 **32 个文件**：8 个受改动文件及 24 个相关受保护文件。最终测试前保存受改动源码哈希，测试后及文档写入后复核；不覆盖历史 TTS/ASR/Images 快照。

Core、共享 failover dispatcher、BYOK/shared key pool、HTTP ASR/TTS/Images driver、Realtime 路由/账务 helper、Node HTTP upgrade 入口、Admin、Wrangler 配置、依赖及 V2.1 原方案均未修改。proxy 仅修改 Realtime 段及对应 import；package.json / tsconfig 仅补测试收集。本轮没有迁移、部署、资金操作、真实 OAuth/KMS/模型调用、远程 CI 或额外 agent。

依据 Workers 最佳实践技能核对请求局部状态、half-open、accept 前 binaryType、取消清理和不读取无界正文。公开参考：[Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)、[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。最新 types registry 查询失败，使用技能允许的已安装 **5.20260829.1** fallback，并读取本机 Wrangler schema；不称最新版本已核验。

## 5. 未完成与下一步

- **C02.B2.2 下一步：Realtime 公开入口与账务集成证据**。覆盖公开路由及两个前缀、BYOK / 共享池实际链、有限 Ordinary / Guardrail 预留、明确拒绝与 unknown 的结算意图、Upgrade 之前/之后的断开和身份生命周期。当前仅 proxy / driver 元数据及 bridge usage 断言，不是新 API/数据库事务验收。
- 继续检查 Node upgrade 先于鉴权的入口合同、候选失败时已排队客户端帧的处置，以及正常会话 / close-ack / 会话超时的真实网络覆盖；不把本轮 4 项建连 loopback 推广到所有场景。
- 随后处理独立 Admin playground，再统一入口全过程、数据库、TTFT / idle / 分阶段时限。既有 30 秒 connect / 10 分钟 session 不代替正式 C01 SLO。
- Workers 真机、Node 22、真实数据库角色/事务与 KMS 都未验收；不重复已知环境阻塞检查，不启用未通过能力。
- C02.1–C02.7 复合条目及 C02.G 保持未勾选，C03–C20 不因本子集通过而启动生产依赖。Qwen HTTP TTS 格式缺口仍留 C17 / C15；Realtime TTS 的公开禁用门禁不改变。

回退：限制/关闭对应未验收能力；不退回无界认证/建连、已接受后重放或删改账务事实。
