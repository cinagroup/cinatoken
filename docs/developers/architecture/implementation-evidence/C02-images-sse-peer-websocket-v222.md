# C02.B2.2 — Primary-first WebSocket 同池观察服务端

日期：2026-09-09；Checklist v1.121。新增 staging-only V3 服务端及封闭候选配置，未部署、未切换执行器，整体 STAGING_PARTIAL。

## 为什么改变观察协议

V2 先建立 watch，再要求推理与三个独立 HTTP marker 命中同一实例。代码可验证该匹配条件，但平台不会保证后续请求一定进入那个实例。v219 的 409 原始正文缺失，不能追认其一定是异实例拒绝。[Cloudflare 执行模型](https://developers.cloudflare.com/workers/reference/how-workers-works/)说明请求可进入多个 isolate；单纯保持一个 watch 连接不等于给后续 HTTP 请求提供实例亲和性。

V3 将观察顺序调整为：一次推理 → 从真实响应取得实例/epoch → 定向连接观察 WebSocket → 沿同一连接发送 held、post-native、post-recovery 标记。这样建立观察连接后，标记不再依赖新 HTTP 请求的实例分配。**定向连接仍可能无法到达目标实例**；没有实现或承诺可强制亲和，也不允许为了连接成功而重发推理。

## 已实现的服务端合同

新入口 `images-sse-capacity-peer-gateway-v3.ts` 复用实际 Images handler、HTTP 逻辑容量池、持久化/取消及 host-expiry 探针。没有改变成功结算点、财务算法、恢复算法、上游调用或实际容量 lease 的释放条件。

| 阶段 | 输入 / 输出 | 约束 |
| --- | --- | --- |
| 推理 | 固定 `/v1/images/generations` POST，`x-c02-capacity-primary: v3` | 不能携带 peer/watch/baseline/Upgrade/HTTP barrier；保留原 Request 传入取消观察层 |
| 同步准入前观察 | 检查同一个 pool 的 requests/reservedBytes 均为 0 | 准备中的另一个 primary、存活 observer 或已占用 pool 均先拒绝；记录数字 epoch 后才进入异步业务准备 |
| 真实响应 | `x-c02-capacity-peer: <instance UUID>:<primary epoch>`、`x-c02-capacity-before: 0/0` | 包装响应头，不读取、tee 或复制 SSE 正文；仅 HTTP 200 且请求未取消才允许后续观察 |
| 定向 Upgrade | GET `/__staging/sse-capacity/watch-v3`，Upgrade websocket、watch v3、上述 peer | 只在本实例、最新 eligible epoch、pool 仍占用 1 时升级；外国/旧 epoch 不创建 socket，也不触及业务/DB |
| 同连接标记 | canonical JSON `{profile,kind:"mark",barrier,stage}` | 仅三个顺序阶段；每次同步递增 barrier，先 ACK 再采样，没有独立 HTTP marker 请求 |
| 收尾 | deadline、样本上限、客户端关闭、取消、协议错、发送错 | 仅关闭 observer、清理该请求的 timer/listener；绝不调用业务 lease.release 或 reset |

同一个 primary epoch 只允许一次匹配升级，结束后不重连。一次失败的升级初始化也消费该 epoch；不能假设丢失 ACK 意味着没有升级。跨请求只保存 pool、实例 UUID 和数字 epoch/排他状态；不共享 primary Request、Response、Promise、socket 或后台执行上下文。socket、监听器和 timer 都归创建它的 upgrade 请求所有。

输出上限是 **180 个 sample + 3 个 ACK + 1 个 end**，每条最多 **512 字节**，理论发送字节上界 **94,208**。采样间隔 1 秒、最长观察 180 秒；即使客户端不读，应用不会继续无限发送。输入只接受不超过 **128 字符**且精确匹配的 ASCII canonical 命令；二进制、重复/乱序/额外命令立即关闭。此限制是在消息到达应用后实施，不等于证明平台接收巨大 WebSocket 帧的原生内存占用已受该值限制。

V3 的首个 socket sample 已是 **占用态 1**，不能伪装成 V2 的空闲 baseline 0。pre-dispatch 0/0 来自原推理调用前的同步 pool 检查；后续验收器必须同时验证真实主响应身份、D1 held 事实、socket 身份与顺序、原始取消时钟/native 证据和账务事实。不得把 V3 帧改名或改数字后塞进旧 V2 classifier。

## 验证及打包

新增 **41 项本地测试**：39 项服务器合同/限制/隔离/并发/时钟/配置测试；2 项真实 SQLite 的 before-hold、after-hold 集成链。后两项通过实际业务 handler 发一次合成上游调用，核对取消观察、持有容量、恢复收益/日志及最终清理；host ACK 仍为人为控制，WebSocketPair 与 101 升级通过显式本地适配器模拟，**不属于真实 Workers 或原生 host 验收**。

专项 41/41 PASS，最终联合回归 **1,938/1,938 PASS**，失败/取消/跳过均为 0，staging 类型检查 PASS。见[最终独立回执](../../../../.wrangler/staging/sse-capacity-peer-v222-verification-result.json)。验证前后既有 1,799 条摘要与新增 8 个源码/测试/CI 文件一致。Node v24.14.1 本地运行；Node 22/24 CI 仅定义，未执行远程 CI。

Wrangler 4.127.1 的 dry-run 和绑定类型生成退出码均为 0，Cloudflare 凭证从子进程移除，metrics 关闭，自动配置/资源创建关闭。生成的 Env 绑定块与现有 ImagesStagingEnv 完全一致，只改变入口模块；配置仍为封闭 staging、原 D1 与 IMAGE_UPSTREAM、CPU 1000 ms，不引入生产资源或新订阅。

保留两次归档脚本失败：第一份模板误将目录命名为 v314 且遗留 V2 内容断言；第二份的 Env 提取正则过度转义。两者的实际 dry-run 都成功，第二份类型生成也成功；未覆盖失败回执。独立[产物核验](../../../../.wrangler/staging/sse-capacity-peer-v222-artifact-verification-result.json)只读复核已经生成的文件，核对 **789 个 bundle 输入**、元数据字节数、V3 标识、WebSocketPair、封闭配置和类型绑定后 PASS，未重新执行 CLI 或云端请求。最终入口 SHA-256：`2eb7b4674960421df41fb85a70b3f4d90b8b33a35d16b0781ee07712aefdb77d`。

本次依照 Cloudflare/Workers 技能检查了[当前 WebSocketPair/101 升级 API](https://developers.cloudflare.com/workers/runtime-apis/websockets/)、请求所有权和有界输出；按 Wrangler 技能做离线打包及类型生成。最新类型包的网页检索失败，类型检查采用本地 `@cloudflare/workers-types` 5.20260829.1，没有声称已更新依赖或验证最新类型。

## 尚待实现与验收

1. 新 Node WebSocket 客户端：使用原主响应的 peer，完整计入每次 Upgrade 尝试；仅明确“未匹配实例”的响应可在严格次数/总时限预算内继续查找。认证失败、升级确认丢失或建立后断开必须停止；不重发推理，不重连已建立的 observer。
2. 新因果验收器与一次性执行器：先持有原 SSE reader，再建立观察通道；接上 v221 有界拒绝留证、原 session 单调时钟、原 native collector、D1 held/取消/恢复事实及 finalizer。未知请求不因更换协议变成可清理或可退款。
3. 重新进行只读云端 preflight、预算检查、封闭候选部署与受控窗口，验证真实 Access WebSocket 升级、原生 host 持有及同池阶段样本。所有阶段仍必须通过独立账务/native oracle。

WebSocket observer 本身可能影响实例驻留和工作集，故不能将“同池仍可观察”当成 isolate eviction 或物理内存释放证明。完整物理/跨消费者容量、unknown/幂等、C02.G、C01 及 C03–C20 仍开放。

本轮云端管理/公开 staging HTTP、D1 写入、部署及真实模型/KMS 均为 0。最新实际云端状态仍来自 v220，不冒充本轮新复核；公开 HTTP 累计 390，真实模型/KMS 0/0，US$2 累计上限不重置，最终增量账单未核实。
