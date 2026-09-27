# C02.B2.2 — 图片 JSON 构造前的结构准入与工作集采样

日期：2026-09-06。状态：**结构准入子集 LOCAL_PASS；C02 为 DOING；完整字符串工作集、统一并发/交付期内存及真实运行时未验收**。执行/本地自检：Codex；独立 Reviewer 待指定。接续 [响应副本与上传释放](./C02-image-response-working-set.md)，不覆盖前轮证据或样本。

## 1. 本轮实际实现与兼容合同

新增 [JSON 结构预算](../../../../packages/proxy/src/services/json-structure-budget.ts)：在原生 JSON 解析分配对象图前，逐块计算 **64 层容器深度、65,536 个结构节点**。节点包含每个对象/数组、每个标量值和每个属性名；重复属性也逐次计算，不能通过最后一个值覆盖前面的值绕过预算。例如 `{"a":[0]}` 为四个节点、两层容器。

扫描器只持有计数、字符串/反斜杠/标量状态，不建立 token 数组、对象树、字符串副本或递归栈；跨块引号、反斜杠、Unicode 转义和多字节 UTF-8 都有测试。它不是新 JSON 解析器：值、重复属性、数字、Unicode 和语法仍由原生解析决定。对语法本就错误且资源超限的输入，可能先返回资源错误，而不是原来的语法错误。

| 接入点 | 实现 / 错误边界 |
| --- | --- |
| Images 生成请求 | [入口生命周期](../../../../packages/proxy/src/middleware/text-request-lifecycle.ts)给 `/v1/images`、`/v1/images/generations` 及 `/api/v1` 对应路径接入 inspector；读到超限就取消上传、不等待 cancel ACK，在 Guardrail、选路、预算准入及模型出站前返回 413 `gateway.payload_too_large`。鉴权仍在读取正文前执行 |
| Images 非 SSE 响应，包括错误响应 | [有界读取器](../../../../packages/proxy/src/services/egress/bounded-response-body.ts)支持逐块文本检查；[Images driver](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)在保存已解码文本、JSON.parse 前执行预算，超限不再读取尾部。2xx 后仍为 unknown、禁止重放；明确 401 拒绝仍可按原规则切候选 |
| Images SSE 事件 | 每个事件独立检查，再调用 JSON.parse；超限走既有 error / DONE 终态并取消源，不发出伪造的 completed，不重新发送模型请求 |

**这是新增的结构复杂度限制，不是“所有旧输入完全兼容”。** 以前字节数未超限的极深/极密 JSON 会尝试解析，现在明确拒绝。未知字段与重复属性也受限，允许范围内仍保持原值语义。64/65,536 是当前本地保护合同，不代表供应商官方容量、生产 SLO 或平台总内存预算已经冻结。

原有单文件 20 MiB、请求体 50 MiB、非 SSE 图片响应 32 MiB 及 SSE 事件既有容量常量均未降低；Base64 不按字符逐个计为节点。请求 inspector 对单个巨大传输块按最多 64 KiB 解码检查，避免它自己额外复制整份请求文本；原生请求 JSON 消费者仍可能保留完整正文。

覆盖边界明确限于上述入口：其他模态、Admin、路由默认参数的 JSON、multipart 内受 16,384 字符限制的 provider JSON 不因此获得统一结构预算。字节预算、节点预算、内存容量、业务授权和金额预算不是同一个概念。本轮没有修改收费、unknown、取消、预算恢复或错误重试政策。

## 2. 验证与新增测试

Windows / Node.js v24.14.1。新增 **105 项**：

- [结构预算专项](../../../../packages/proxy/src/services/json-structure-budget.test.ts)84 项：60 个值/分块组合；200 个固定种子混合树的独立计数与原值差分；重复/转义/特殊属性名；恰好及超一的深度/节点数；非法或被修改的配置；保留原生语法拒绝；五种 UTF-8/BOM 分块；未到 EOF 取消；单块 50 MiB 字符串且 inspector 解码块不超过 64 KiB。
- [公开链路新增](../../../../packages/proxy/src/routes/v1/image-request-lifecycle.test.ts)21 项：四个生成入口 × 深度/密集数组/重复属性的 withheld-tail 拒绝；恰好结构边界及 50 MiB JSON 请求成功；generations/edits × 2xx/401 的不可重放/合法重试、取消源、文件页释放及单次用量批写；两个 SSE 结构超限终态。响应专项断言超限内容未进入 JSON.parse。

| 命令 | 最终结果 |
| --- | --- |
| `node --import tsx --test packages/proxy/src/services/json-structure-budget.test.ts packages/proxy/src/routes/v1/image-request-lifecycle.test.ts packages/proxy/src/services/egress/image-response-memory.test.ts` | 336 tests / 0 suites；退出 0 |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest 链通过；主 suite 2,333 tests / 135 suites；退出 0 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 含 Core 入口构建；1,958 tests / 50 suites；退出 0 |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck -w @octafuse/admin` | 退出 0 |
| `node packages/proxy/scripts/measure-image-json-memory.mjs` | 四个独立本地子进程完成，最终退出 0；见下节原始样本 |

最终 tests 均 0 fail/cancelled/skipped；上表各 suite 计数重叠，不相加。新的专项已纳入主 suite、安全专项及其类型检查。未独立运行 Core 全套或 Admin 业务 suite。合成路由/模型响应、零价格 SQL sink 与既有本机 SQLite 测试不是实际业务数据库、支付或卖家收益验收。

测量脚本首轮曾在合成源关闭后才 enqueue 尾块，导致脚本失败；已修正为先 enqueue 再 close，并重跑四个子进程通过。该失败不是生产实现错误，也没有改变生产代码或测试结果。

## 3. 内存证据改变了下一步，而不是证明门禁通过

[可重现脚本](../../../../packages/proxy/scripts/measure-image-json-memory.mjs)使用有界读取器、原生解析、实际 Images 规范化和一次序列化/Response 构造；[原始样本](./C02-image-json-structure-memory.json)包含阶段内存与读字节数。每种情况启动独立 Node 进程、限制旧生代 512 MiB，禁止 fetch。输入按小块生成，不预先创建整份大 JSON。强制 GC 仅用于建立基线及观察去引用后的持有情况，不用于生产代码。

| 合成输入 | 实际读取 | 是否构造对象图 | 观察到的最大 heapUsed 相对基线增量 |
| --- | ---: | --- | ---: |
| 2 MiB 密集空对象，无结构检查（仅对照） | 2,097,152 B | 是 | 52.18 MiB |
| 相同输入，有结构检查 | 196,645 B 后取消 | 否 | 3.03 MiB |
| 32 MiB 简单 ASCII 图片 JSON | 33,554,432 B | 是 | 98.34 MiB |
| 同为 32 MiB，另带一个 Unicode metadata 字符 | 33,554,432 B | 是 | 162.31 MiB |

两种 32 MiB 响应还各观察到约 32.00 MiB 的 ArrayBuffer 增量。不同列最大值不保证在同一时点；这些是离散阶段/读取采样，**不是连续峰值、定量性能承诺或 Workers 内存测量**。Node/tsx/Core 加载基线约 40 MiB heapUsed，绝对 RSS 含工具链，不应直接与 Workers 限制比较。单样本也不构成统计压测、CPU SLO、实际 HTTP 传输或完整公开网关的容量证明。

样本证明结构预算能阻止小体积密集对象的膨胀，但对大字符串表示副本无能为力；未读 Response 即使清理 metadata 并强制 GC，仍持有显著字符串/字节材料。因此，**不能直接用当前实现加一个 Images 并发计数器，就宣称支持 32 MiB 响应且满足整个 isolate 的内存门禁**。

## 4. 唯一下步与未完成范围

继续 **C02.B2.2：先减少完整 JSON 文本与完整编码字符串的并存，建立包含 Unicode 与未读响应的可验证单请求工作集；再接统一并发准入与交付期释放。** 应保留真实字段/usage、未知结果禁止重放、原有 20/50/32 MiB 容量，不以全拒绝大响应、只允许 URL、丢弃 metadata 或先交付未验证 JSON 获得表面通过。

还需覆盖生成请求原生缓存、早到响应与未完上传重叠、SSE framing 及其他模态同时执行；multipart provider/路由默认字段的结构路径需按原合同接续。统一容量必须覆盖整个运行实例，而不是 Images 独立计数；释放要覆盖慢读/不读/取消以及业务存储确认持有期。Node 22、实际 HTTP、真实 Workers 和目标 QPS/CPU/恢复仍未验收；本轮未重复运行历史上最小启动即失败的 Workers smoke，也未确认其系统根因。

后续 HTTP Audio/Admin 完整入口、分阶段时限、物理数据库确认恢复，及 Realtime marker/Guardrail 零更新、共享音频卖家收益、Qwen 格式、全池读取/解密等 C03–C20 既有门禁不变。C00 LOCAL_PASS，C01/C02 DOING，C03–C20 TODO；C02.1–C02.7/C02.G 均不勾选。

## 5. 变更与授权边界

基线 HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`；轮初 184 个 dirty/untracked 文件，前轮 160 文件快照零差异。源码/测试/配置变化限于新增结构预算/专项/采样脚本，以及有界读取器、入口生命周期、Images driver、公开链路测试、Proxy package scripts/专项类型配置；公开 API、Image Models、Checklist 和证据索引同步说明新限制。受测代码与原始样本见 [本轮快照](./C02-image-json-structure-snapshot.json)，不改写历史快照。

收尾只读核对：191 个 dirty/untracked 文件；相对轮初九个已脏文件变化，另一个原本干净的 API 文档变脏，以及六个新增文件，无缺失或其他轮初文件变化。165 文件快照哈希全部匹配，五份当前文档的 93 个本地链接目标存在，`git diff --check` 退出 0。快照不包括自身、Checklist、索引及本证据页，以免自引用。

Workers 最佳实践技能实质推动了“读取时先限制、分配前准入”和本次针对完整表示副本的验证。已核验官方 [请求/响应最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)及 [isolate 内存限制](https://developers.cloudflare.com/workers/platform/limits/#memory)；最新 types registry 获取失败，按技能 fallback 检查已安装 5.20260829.1 与本地 Wrangler schema。现有 compatibility date/flags 保持不变，无绑定变化。

没有新增依赖、Core 业务源码或 schema 变化；没有云账号/KMS/OAuth/模型调用、远端业务库、迁移、支付、部署、远程 CI、系统组件安装。KMS 仍为已确认的 Google Cloud KMS / `cinatoken`，不重复配置。新增本地限制尚未部署；回退必须保留字节限制、有限出站、unknown 和资源所有权，不整体还原用户工作树。
