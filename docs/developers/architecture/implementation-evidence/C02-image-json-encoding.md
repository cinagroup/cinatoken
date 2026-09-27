# C02.B2.2 — 图片 JSON 按需编码与交付期所有权

日期：2026-09-06。状态：**按需输出编码子集 LOCAL_PASS；C02 DOING；完整输入表示、统一并发内存与真实运行时未验收**。执行/本地自检：Codex；独立 Reviewer 待指定。接续 [结构准入与内存采样](./C02-image-json-structure.md)，保留历史样本与快照。

## 1. 本轮范围与明确变化

[新编码器](../../../../packages/proxy/src/services/egress/stream-json-body.ts)接入 [Images driver](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)的普通 generations/edits JSON 响应。仍先完整读取上游、执行字节/结构限制、原生解析及原有业务检查，再交付；不是把未验证的上游片段直接发给客户端。

- 已验证且规范化的请求所有对象树，按下游读取需求编码；不再构造完整输出 JSON 字符串或一整份输出字节数组。单页最多 64 KiB；单次字符串转义最多 8,192 个 UTF-16 code units，代理对跨切片边界保持完整。ReadableStream 的 highWaterMark 为 0，未读时不提前编码。
- 数字、字符串转义、整数属性名顺序、解析后的重复属性语义、`__proto__`、普通 `toJSON` 数据字段、未知 metadata 和 usage 别名保持原生 JSON 结果。该工具只接受已解析且不再修改的 JSON 树，不是任意 JavaScript 对象的通用 stringify 替代；类实例、访问器、循环、undefined、稀疏数组等在返回流前拒绝。
- 编码前的内部遍历上限为 64 层、196,624 节点，允许规范化新增 media_type 和 usage 别名；**上游准入仍是 65,536 节点**，没有放宽输入限制。20/50/32 MiB 原有文件/入口/普通响应容量不变，不丢字段来减小工作集。
- 普通 JSON 正文现持有 driver 原有绝对 deadline 的剩余时间，读完、取消、报错或到期时移除监听器、清理计时器并释放编码器拥有的对象引用。响应构造器拒绝非法 status/body 组合时也清理未读流。取消不等待上游 transport ACK。

**交付行为变化需要披露：** 普通 JSON 以前在 driver 返回前已完整编码，当前慢读/不读可能在交付中超时；已发出的 200 headers 无法改成 504，客户端会观察到正文读取错误。编码 EOF 只是应用流终点，不是网络或客户端接收确认；其他持有者、网络缓冲、运行时 GC 不受编码器单独控制。

上游已完整确认成功与客户端交付中断是两种事实。本轮不重放已完成模型请求，不将其伪装成未生成，不引入退款/额外扣费政策；公开链路沿用已确认结果的一次用量写入。测试中的零价 SQL sink **不能**证明真实金额、最终收费政策或数据库提交确认已经验收。C01/C15 财务与交付政策仍待确认。SSE framing、固定错误体及其他模态不由此完成按需编码治理。

## 2. 本地测试

Windows / Node.js v24.14.1；新增 **113 项**：

| 范围 | 新增断言 |
| --- | --- |
| [编码器专项](../../../../packages/proxy/src/services/egress/stream-json-body.test.ts)：64 项 | 标量原生字节差分；长键/长值及 Unicode、孤立代理项、控制字符边界；不提前/整对象/大字符串序列化；非法树提前拒绝；精确结构边界；未读/读一页/EOF × cancel/abort/timer/时钟已过期；监听器单次释放；Response 构造失败清理 |
| [公开完整链路](../../../../packages/proxy/src/routes/v1/image-request-lifecycle.test.ts)：48 项 | 两个前缀 × generations/edits × 未读/读一页/EOF × cancel/客户端取消/deadline/计时回调未触发但已过期；上传页释放、正文错误脱敏、单次真实 driver dispatch 与一次合成用量批写 |
| [响应内存专项](../../../../packages/proxy/src/services/egress/image-response-memory.test.ts)：1 项 | 65,535 个入站节点经 media_type 规范化扩张后仍接受；不以内部遍历限制悄悄降低合法容量 |

另更新已有 32 MiB 容量与四个公开响应测试：从“一次完整序列化”改为“不做完整序列化”，验证按页输出以及 Unicode/未知 metadata/usage 保留。新增专项纳入主 suite、安全专项及类型检查。

| 命令 | 最终结果 |
| --- | --- |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest 链通过；主 suite 2,446 tests / 135 suites；退出 0 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 含 Core 入口构建；2,071 tests / 50 suites；退出 0 |
| `npm.cmd run typecheck -w @octafuse/proxy` | 通过，无类型诊断 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 通过，无类型诊断 |
| `npm.cmd run typecheck -w @octafuse/admin` | 通过，无类型诊断；顺序执行三项检查的进程最终退出 0 |
| `node packages/proxy/scripts/measure-image-json-encoding.mjs` | 八个独立子进程完成，退出 0；见原始样本 |

上述 suite 计数重叠，不能相加。定向运行先后为 316 项、52 项公开交付子集及 1 项规范化边界，均退出 0；随后完整 suite 覆盖最终源码。未单独运行 Admin 业务或 Core 全套测试。测试只使用合成响应/身份及本地账务替身。

## 3. 对照采样：改善不等于整个工作集有界

[新测量脚本](../../../../packages/proxy/scripts/measure-image-json-encoding.mjs)每种情况用独立 Node 子进程，输入按页生成，执行真实有界读取器、结构预算、原生解析和 Images 规范化；对照完整编码与新按需编码。每种分别测未读取消/完整读取；完整读取不累积输出页，核对原始输入与输出 SHA-256 相同。脚本禁止 fetch；GC 仅用于测量基线/持有状态，不进入应用实现。[八组原始样本](./C02-image-json-encoding-memory.json)保留所有阶段。

所有输入均 32 MiB；“Unicode”只比 ASCII 多一个 `label: "Ā"` 元数据字段，总字节数相同。以下选完整读取组，相对各自基线的增量，单位 MiB：

| 输出方式 / 输入 | 未读正文持有时 heapUsed（GC 后） | 离散样本最大 heapUsed | 离散样本最大 ArrayBuffer | 最大输出块 |
| --- | ---: | ---: | ---: | ---: |
| 完整编码 / ASCII | 65.76 | 98.39 | 32.00 | 32 MiB |
| 按需编码 / ASCII | 65.97 | 101.40 | 32.07 | 64 KiB |
| 完整编码 / Unicode | 129.78 | 162.32 | 32.00 | 32 MiB |
| 按需编码 / Unicode | 97.97 | 133.39 | 32.07 | 64 KiB |

按需编码的未读取消组没有生成输出页；其离散最大 ArrayBuffer 增量约 0.003 MiB，取消并 GC 后 heapUsed 相对基线约 1.94 MiB。完整读取后按需组约 2.01 MiB。这里只观察去引用后的运行时行为，不声称可验证物理清零。

结论：消除了应用显式的完整输出字符串和整块输出缓冲，Unicode 场景下降；**ASCII 的总 heapUsed 没有改善，持续读取时 ArrayBuffer 观察值仍可累积到约 32 MiB**。逐页所有权与 GC 回收时机是不同问题，不能用单页大小冒充总分配量上限。完整输入文本、解析树及运行时字符串保留仍需治理。

这不是连续峰值、统计压测、CPU/SLO、真实 HTTP 或 Workers/isolate 数据；不同列最大值未必同时发生。Node/tsx/Core 加载也占基线，不能把绝对 RSS 与 Workers 限制直接比较。没有降低输入容量来制造改善，也没有据此勾选并发内存门禁。

## 4. 唯一下步与剩余门禁

继续 **C02.B2.2：治理输入完整 JSON 文本/解析字符串的并存与保留，验证包括未读输出在内的单请求工作集，再接整个实例的统一并发容量控制。** 按需输出的对象所有权已接 deadline，但实际网络缓冲/业务存储持有期、其他模态、生成请求原生缓存、SSE framing、早到响应与未完上传重叠仍待测；不能直接以 Images 独立计数替代整个实例准入。

HTTP Audio/Admin 完整入口、headers/有效 TTFT/idle、真实数据库提交/恢复、Realtime marker/Guardrail 零更新、共享音频卖家收益、Qwen 格式、全池读取/解密等既有门禁不变。Node 22、真实 Workers、HTTP 负载与生产 IAM/KMS 均未验收。C00 LOCAL_PASS；C01/C02 DOING；C03–C20 TODO；C02.1–C02.7/C02.G 不勾选。

## 5. 变更与授权边界

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`；轮初 191 个 dirty/untracked 文件，前轮 165 文件快照全部匹配。此次业务源码仅增加编码器及修改 Images driver；另更新三组测试、测试入口/专项类型配置、测量脚本、API/资源说明、Checklist 和当前证据。保留全部历史证据与用户工作树，不改写历史内存样本。

收尾相对轮初九个既有文件变化、六个新增文件（含本轮快照），没有轮初文件缺失或其他内容变化。169 个受测文件/样本哈希全部匹配，五份当前文档的 83 个本地链接目标存在，`git diff --check` 退出 0。快照不包含自身、当前 Checklist、索引和本证据页，避免自引用；历史快照未改写。

Workers 最佳实践技能促使本轮采用按需流式输出并延长资源所有权至正文终态，同时区分每块上限与整个实例内存。[官方流式响应建议](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)与 [isolate 内存边界](https://developers.cloudflare.com/workers/platform/limits/#memory)已核验；最新 types registry 获取失败，按技能回退检查本地 5.20260829.1、encodeInto 签名和 Wrangler schema。没有修改 compatibility date/flags/bindings。

没有新依赖、云资源、KMS/OAuth/模型请求、数据库迁移、部署、远程 CI、支付或系统安装。Google Cloud KMS / project `cinatoken` 已确认且未重新配置；区域、保护级别、身份/IAM 等真实接入仍待授权验收。新增本地实现尚未部署。受测文件/原始样本见 [本轮快照](./C02-image-json-encoding-snapshot.json)，不包含自引用文档；回退应限定本轮编码器变更，不还原整个工作树或删除账务事实。
