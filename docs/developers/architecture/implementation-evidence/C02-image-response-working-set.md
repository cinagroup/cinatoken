# C02.B2.2 — 图片响应副本与已接受上传的提前释放

日期：2026-09-06。状态：**本页子集 LOCAL_PASS；C02 为 DOING；JSON 对象工作集、统一并发准入/释放及真实平台门禁未完成**。执行/本地自检：Codex；独立 Reviewer 待指定。接续 [multipart 分块处理](./C02-image-multipart-streaming.md)，不覆盖其历史结果和内存样本。

## 1. 实际改动

| 环节 | 本轮实现 | 保留的边界 |
| --- | --- | --- |
| 有界响应读取 | [公共读取器](../../../../packages/proxy/src/services/egress/bounded-response-body.ts)逐块 UTF-8 解码，原始字节先计量；取消仍释放 reader/监听器、不等待 cancel ACK。不再保存所有二进制块后另分配整份 Uint8Array | 最终仍产生完整文本，之后 JSON.parse 仍构造完整对象；64 KiB 文本分组控制的是条目数量，不是运行时源 chunk 或总内存硬上限 |
| 图片 JSON | [Images driver](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)读取函数只返回解析结果，规范化后编码一次；[公开路由](../../../../packages/proxy/src/routes/v1/images.ts)直接交接该 response.body，不再重新 stringify 或 clone().text() | 常规成功响应完整图片 JSON 从三次序列化降为一次；这是序列化次数断言，不是零拷贝或峰值降幅证明 |
| 被丢弃的输出 | generation 要求权威 usage 而缺失时，不先编码大图片再丢弃；公开路由丢弃无图片/缺少必要 usage 的响应时取消其正文。计数和成本取出后删除 meta 中的 parsedBody 引用 | 仍按既有规则判断有效结果、unknown、收费与是否允许回退；没有降低要求或改为流式先交付再验证 |
| Base64 探测 | 类型推断只提取 684 个非空白字符，data URL 类型提示只查看首个非空白位置后的 1,024 字符；不再对整份 Base64 做 trim/replace。有效内容判断与 SSE 对应空白判断改为扫描 | 超长 MIME 提示不自动补 media_type，原始 b64_json 与显式 metadata 保留；普通 PNG/JPEG/WebP/SVG/短 data URL 仍有回归。跳过大量空白仍有扫描 CPU 成本 |
| 上传提前释放 | [出站编码器](../../../../packages/proxy/src/services/egress/multipart-upload-body.ts)结束后通知 driver；公开 edits 的请求 owner 仅在“观察到 2xx”且“上传已 EOF/取消/停止，reader 已释放”同时成立时清空全部文件页 | 2xx 单独成立不能截断上传，EOF 单独成立不能取消后续合法重试。非 2xx 拒绝保留页到下一候选；路由 finally 仍是所有终态的兜底 |

公共响应读取器被文本、向量、音频、图片及错误规范化等调用，所以本轮运行完整 Proxy 回归，而不是只验证 Images。跨块 BOM、多字节 UTF-8、非法尾字节与一次性 TextDecoder 保持一致；立即解码也避免传输实现复用同一底层字节数组时破坏先前内容。

上传“结束”仅证明本地编码器不再访问请求页，不证明远端已持久化/计费；输出/unknown/账务规则没有据此改写。2xx 后即使 JSON 无效或读取失败，也不重新开放模型重放。提前释放回调仅由公开路由的请求 owner 注入，不接受客户端输入；内部旧 bytes/Blob 调用者不被擅自转移资源所有权。

## 2. 新增 41 项测试

| 测试 | 新增 | 关键证明 |
| --- | ---: | --- |
| [响应资源专项](../../../../packages/proxy/src/services/egress/image-response-memory.test.ts) | 30 | 15 个 UTF-8/BOM/非法编码/空内容 × 分块差分；复用输入缓冲保真；恰好 32 MiB 逐块解码且没有整份二进制 decode；声明/实际超限在解码前拒绝；三个取消时点不等待 ACK；有界媒体探测；32 MiB 有效 Images JSON 一次序列化；缺权威 usage 时不序列化大图片 |
| [公开路由新增](../../../../packages/proxy/src/routes/v1/image-request-lifecycle.test.ts) | 11 | generations/edits × 两个路径前缀的 1 MiB 图片一次序列化与正文/usage/header 合同；上传先结束、2xx 先到、传输停止 × 正常/无图片结果，断言响应被暂停期间所有页（含未知文件字段）已在正确时点释放；早到 401 停止部分上传后下一候选仍收到完整原始文件 |

保留前轮 50 MiB 原始上传、20 MiB 单文件、五文件、字段/头部/数量限制及重试/取消测试。Images JSON 响应硬容量仍为 32 MiB，没有以缩减上传/响应容量完成优化。30 项专项已进入主 suite、安全专项及其类型检查。

新增 fixture 全部为合成材料；公开路由使用真实 Hono/auth/planner/driver 与合成仓储/模型响应、零价格 SQL sink。延迟/交错测试是受控本地 ReadableStream，不是实网 HTTP 双工或真实供应商证据；一次用量批写不证明真实资金或卖家收益验收。

## 3. 最终验证

Windows / Node.js v24.14.1。以下命令最终均退出 0：

| 命令 | 结果 |
| --- | --- |
| `node --import tsx --test packages/proxy/src/services/egress/image-response-memory.test.ts packages/proxy/src/routes/v1/image-request-lifecycle.test.ts packages/proxy/src/services/streaming-multipart-body.test.ts packages/proxy/src/services/egress/openai-images-driver.test.ts` | 303 tests / 8 suites；最终类型修正后再次通过 |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest 链通过；主 suite 2,228 tests / 135 suites |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 含 Core 入口构建；1,853 tests / 50 suites |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck -w @octafuse/admin` | 退出 0 |

最终 tests 均 0 fail/cancelled/skipped；组合/主 suite/安全专项计数重叠，不相加。首轮安全类型检查发现测试错误借用了 DOM 的 TextDecoder 类型名，并漏填 RouteResult 的必填字段；改为从本项目 TextDecoder 推导参数类型、补全合成路由后，重跑通过。未独立重跑 Core 全套或 Admin 业务 suite。既有本机 SQLite 合同测试随完整回归通过，不能升级成托管 DB 证明。

本轮没有运行内存峰值实验；“一次序列化”“输入页及时归零”“解码不拼整份二进制”由行为断言证明，不把 [前轮上传样本](./C02-image-multipart-streaming-memory.json)挪用为本轮响应/并发性能结果。没有再次重跑已在最小启动阶段失败的 Workers smoke：上轮 `0xc0000005 / ERR_RUNTIME_FAILURE` 仅是历史未验收依据，本轮没有新的 Workers 运行证据，也未确认其系统根因、安装系统组件或触发远程替代测试。

## 4. 变更边界与技能依据

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`。轮初 181 个 dirty/untracked 文件，前轮 159 文件快照零差异。本轮八个源码/测试配置路径变化（含一个新专项文件），另更新 Image Models、Checklist/索引并新增本页及 [160 文件快照](./C02-image-response-working-set-snapshot.json)。不改 Core 业务源码、依赖/锁文件、绑定、数据库 schema、KMS 选择或其他用户文件。新快照保留前轮范围及原始样本，再加入本轮专项，不覆盖历史摘要。

收尾只读复核：当前 184 个 dirty/untracked 文件，相对轮初仅十个既有文件变化、三个新文件，无缺失或其他既有文件变化；符合上述范围。160 个文件哈希零差异，四份当前文档的 72 个本地链接目标均存在；`git diff --check` 退出 0。快照排除自身、Checklist、索引与本页，避免自引用。

Workers 最佳实践技能实质推动了逐块读取、复用响应正文和显式请求资源所有权。官方 [best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 与 [内存限制](https://developers.cloudflare.com/workers/platform/limits/#memory)要求将 isolate 的 128 MB 视为并发请求共享的整体约束，不能凭单请求大小上限推断安全。最新 workers-types registry 检索失败，按技能 fallback 使用已安装 5.20260829.1，并检查 Wrangler schema 与现有配置；本轮无 binding/config 变化，不生成新 Env。

## 5. 唯一下步与保留门禁

**继续 C02.B2.2：先建立 JSON 解析工作集上界，再实现覆盖并发请求与响应交付期的总容量准入/释放，并补真实运行时证据。** 当前减少了无必要的表示副本，但以下条件仍未证明：

- 完整文本、JSON 对象（尤其大量节点/嵌套数据）、规范化对象与一次编码的总峰值；生成请求自身的 JSON/Base64 工作集也尚未统一治理。
- 早到 2xx 而上传尚未结束时的输入/输出并存，以及同时运行的其他模态/请求；不得用 Images 独立计数器冒充 isolate 总门禁。
- 成功响应交付后的慢读/不读/取消与存储确认等待占用；当前仍物化非 SSE JSON，没有提供常数内存或交付期自动释放时限保证。
- Workers/Node 22、实际 HTTP 传输、目标 QPS 与 CPU/峰值；不得降低原有容量或绕开 unknown/结算边界来获得通过。

之后继续 HTTP Audio/Admin 完整入口、headers/有效 TTFT/idle、物理数据库超时及确认恢复。Realtime marker 零出站却被 expiry 保守消费预算、Guardrail 零更新计数恢复、共享音频卖家收益、Qwen TTS 格式与全池读取/解密等既有缺口及 C04/C05/C07/C09/C12/C15/C17 门禁不变。

C00 维持 LOCAL_PASS；C01/C02 为 DOING；C03–C20 为 TODO；C02.1–C02.7/C02.G 不勾选。Google Cloud KMS 项目仍为用户确认的 `cinatoken`，本轮没有云账号/KMS/OAuth/模型调用、远端业务库、迁移、支付、部署、远程 CI 或系统组件安装。未新增生产开关/切流；回退须保留字节限制、有限发送和取消/结算所有权，不整体还原用户工作树。
