# C02.B2.2 — Images 用量审计的中间副本治理

日期：2026-09-06。状态：**用量投影 / 直接审计序列化子集 LOCAL_PASS；C02 DOING，整个实例容量未通过**。执行 / 自检：Codex；独立 Reviewer 待指定。接续 [紧凑字符串页](./C02-json-page-storage.md)，保留历史证据。

## 1. 范围与行为

本轮移除普通 Images `usage` 的“先将所有长值合并为原生字符串树，再整体序列化”中间层。**完整 `raw_usage` 字符串仍然存在**，不截断、不删除未知字段、不改账务存储格式，也不新增用量字段长度限制。

- [image-response-usage.ts](../../../../packages/proxy/src/services/egress/image-response-usage.ts)：只把计量需要的固定数字字段投影到小对象，继续调用 Core 的 `parseOpenAiImageUsage`。合计别名、details 存在性、向下取整、缓存字段的 nullish 优先级和全零返回规则保持；Core 及费用公式未修改。
- 原始审计内容从原有不可变解码页直接生成。保留未知字段、嵌套内容、整数键顺序、`__proto__` / `toJSON` 数据键和旧别名覆盖规则。数值投影不会替代审计原文，也不会替代对客户端返回的原始 usage。
- [json-string-number.ts](../../../../packages/proxy/src/services/egress/json-string-number.ts)：长用量数字字符串不整值合并；去空白后最多 1,024 单元的值走原生 Number，其余十进制复用有界有效位 / 指数 / sticky 状态，二/八/十六进制按位保留 53 位与舍入状态。始终检查尾部合法性，溢出不跳过语法。数字字符串允许的前导零、正号、前/后小数点、指数、空白、负零和非十进制语法保持；裸 JSON 的严格语法没有放宽。
- [stream-json-body.ts](../../../../packages/proxy/src/services/egress/stream-json-body.ts) 新增显式原生边界 `materializeJsonBodyText`，复用最多 8 KiB 的转义片段，保留所有片段引用后**一次 join 为完整 JSON 字符串**；不是流式数据库写入。无需先构造每个大字符串，也不在此分配完整 UTF-8 数组。使用既有结构预算的规范化内部余量，不新增 wire 限额。
- [openai-images-driver.ts](../../../../packages/proxy/src/services/egress/openai-images-driver.ts) 的普通 generations / edits 在转换数字、生成审计及最后 join 后检查原请求停止状态。2xx 后取消/超时保持未知结果、禁止重放与既有 499/504 合同，不伪造零计量成功。SSE 共用用量辅助函数，但 framing / 事件原生解析 / 结算时机没有改造。
- 普通响应的根 usage 继续保留未紧凑化的解码页，避免最终收集全部转义片段时同时持有紧凑字节与解码文本。函数不是任意 JavaScript 对象的序列化替代：只接收已经验证的 JSON；拒绝类、getter、undefined、循环和稀疏数组，不吞掉取消异常。

用户批准的 [公开控制字段上限](../../api/user.md#生成-json-控制字段长度上限) 已核对：model 256；字符串 n 32；size/quality/background/service_tier 各 64 个去空白前 UTF-16 单元；provider 最终紧凑 JSON 16 KiB。仅限公开生成 JSON 入口及别名，不自动扩大到其它接口。50 MiB 入口、20 MiB 单文件、32 MiB 普通上游、prompt 去空白后 4,000 字符合同不变。

Cloudflare Workers 最佳实践技能用于核对分段处理、完整序列化边界与生命周期，不把局部优化等同于容量通过。参考 [Cloudflare 官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 和 [ECMAScript StringToNumber](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-stringtonumber)。最新 types registry 读取失败，使用已安装 Workers types 5.20260829.1 / Wrangler schema 核对；配置和依赖未改。

## 2. 验证

新增 **37 项测试**，并扩展既有序列化测试的断言：

- [json-string-number.test.ts](../../../../packages/proxy/src/services/egress/json-string-number.test.ts)：16 项；1/7/8191/8192/65536 字符分片，原生 trim 空白、非法字符、长前导零、指数、溢出与晚到非法尾部。三个进制覆盖 1–1025 个二进制指数、每档六个舍入边界，共 18,450 个长文本用例，分别比较原生 / 分段输入；另有 1,500 个固定种子十进制组合、正常/次正规中点、MiB 级无完整合并断言。取消异常即使本身是 SyntaxError 也传播，JSON 默认语法仍严格。
- [image-response-usage.test.ts](../../../../packages/proxy/src/services/egress/image-response-usage.test.ts)：17 项；与旧别名构造 + 原生 Core 独立对照，覆盖错误类型、details、cache/nullish、特殊键、长未知数据和 500 个固定种子字段组合。实际 generations / edits 驱动在数字扫描、审计遍历、最终 join 三阶段，各测取消和绝对时间到期；完整上游已读取、只发送一次、禁止重放、reader/listener 清理与私密取消原因不回显。
- [stream-json-body.test.ts](../../../../packages/proxy/src/services/egress/stream-json-body.test.ts)：4 项新增，并扩展全部 65,536 UTF-16 单元、分片/代理对/空页、属性顺序、结构超限及不支持值的既有断言。禁止完整原生对象/大标量序列化、禁止 UTF-8 编码和大字符串 materialize；最终 join 后仍检查停止状态。
- [json-string-pages.test.ts](../../../../packages/proxy/src/services/egress/json-string-pages.test.ts)：两处驱动断言从预期三次大字符串 materialize 更新为仅 1 个字符的已 trim 数值；完整 raw_usage 与下游 JSON 精确一致的断言保留。

最终本地结果：

| 验证 | 结果 |
| --- | --- |
| `npm test -w @octafuse/proxy`，完整 pretest 链 + 主 suite | 退出 0；主 suite 2,907 tests / 135 suites |
| `npm run test:dispatch-safety -w @octafuse/proxy` | 退出 0；2,532 tests / 50 suites |
| Proxy、dispatch-safety、Admin 类型检查 | 三项均退出 0 |
| 前后同脚本真实驱动合成用量测量 | 前 10 + 最终后 10 个独立进程，均退出 0 |

测试集有重叠，不相加；最终无失败、取消或跳过。较早六文件联合 281 项通过，此后新增 12 个实际驱动停止测试，单文件 17 项及最终全量再次覆盖。早期两项旧物化断言失败和测试框架不接受 Array.prototype mock 的问题均已修正；后者改为 try/finally 恢复测试钩子。没有用跳过断言换取通过。

## 3. 同脚本前后内存对照

[原始结果与源码摘要](./C02-image-usage-working-set-memory.json) / [测量脚本](../../../../packages/proxy/scripts/measure-image-usage-memory.mjs)。修改生产源码前先运行 10 个基线进程；之后使用相同脚本与相同 32 MiB 原始响应，对 generations / edits 各测 ASCII、无效 FF 替换解码、转义/孤立代理、空白填充数字、前导零数字五种形状。真实驱动 + 注入合成 fetch；全局网络禁止。独立构造并核对完整 raw_usage 长度 / SHA-256、规范化下游 JSON SHA-256 和最多 64 KiB 输出页；不连接模型或数据库。

第一轮改后验证亦全部退出 0，但初始工具输出截断；已重新完成 10 个进程并保存完整结果作为最终对照。两轮之间生产源码/脚本未变，后续只补测试。未把丢失数据补成测量值。

以下为**各进程基线以上的 heapUsed + external 同时刻增量**，单位 MiB。arrayBuffers 已包含在 external 中，不二次相加。最后一列为离散采样最大值，包含独立审计哈希产生的临时编码和客户端输出缓冲，不是纯网关持续峰值。

| 场景 | 驱动返回时：前 → 后 | GC 后仍持有结果：前 → 后 | 全流程离散最大：前 → 后 |
| --- | --- | --- | --- |
| generations / ASCII | 130.62 → 98.94 | 75.03 → 75.04 | 133.66 → 133.62 |
| generations / 替换字符 | 194.93 → 178.25 | 129.54 → 130.69 | 201.05 → 202.70 |
| edits / 替换字符 | 194.42 → 131.08 | 129.52 → 129.54 | 202.27 → 202.20 |
| generations / 转义 | 100.58 → 95.19 | 57.52 → 51.52 | 149.98 → 149.97 |
| generations / 空白数字 | 130.58 → 98.95 | 75.03 → 75.05 | 133.62 → 133.63 |
| generations / 前导零数字 | 130.61 → 99.40 | 75.04 → 75.08 | 133.65 → 133.64 |

可支持的结论是**减少审计构造时的中间副本**，不是“所有阶段内存下降”。ASCII / 两类数字驱动返回时约少 31 MiB，但长期持有量与全流程观察最大值基本不变。替换字符的前后 GC 时机差异明显，不把 generations 与 edits 的差异当作算法收益；全流程结果也包含略高的样本，不能选择性忽略。

CPU 同样不是普遍改善：generations 前导零数字的驱动耗时约 508 → 602 ms，edits 约 505 → 600 ms；转义场景约 1,151 → 877 ms / 1,083 → 893 ms。单次 Node v24.14.1 / Windows 测量，不是吞吐基准或 Workers CPU 证明。最后的 `releasedExceptAuditStringAfterGc` **刻意仍持有完整审计字符串**，不能用来证明全部释放或物理清零。

## 4. 未完成与唯一下一项

**C02.B2.2 — 长属性名原生构造与完整 raw_usage 持有期核算，再接整个实例容量准入。** 本轮已去掉用量树中间副本，不再重复把该副本列为未做；仍需计算必须保留的完整字符串、解析长键、调用方 / 存储的持有期及重叠分配。未获授权的新字段/长键限制不能以内部优化名义偷加。

整个实例必须覆盖所有入口/模态、在途上传与响应、SSE 原生 framing/JSON、multipart 内嵌 JSON、默认参数、Admin、网络/存储缓冲；不能用 Images 独立并发数冒充统一容量保护。HTTP Audio/Admin 入口、headers/有效 TTFT/idle、数据库提交确认与恢复、Realtime marker/Guardrail 零更新、共享音频收益、Qwen 格式以及 Node 22/真实 Workers/数据库门禁保持。全池读取/解密留 C07/C09。

C00 LOCAL_PASS，C01/C02 DOING，C03–C20 TODO；C02.1–C02.7/C02.G 不勾选。整体共享平台目标未完成，本轮有源码/测试与同脚本实测变化，属于 progress，不是 blocked。

## 5. 基线、回退与外部动作

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`；轮初 250 个 dirty / untracked 文件及哈希已保存，不覆盖用户已有变更。[最终快照](./C02-image-usage-working-set-snapshot.json)覆盖受测实现、回归入口与测量/公开文档。回退只针对本轮用量投影、直接序列化及配套测试；不得整体恢复脏工作树，不撤销既有大小/结构/控制字段/deadline 或未知结果禁止重放合同，不删除账务事实。

收尾核对：212 个最终快照哈希全部匹配；前轮 206 个路径中仅本轮 10 个预期目标变化。相对轮初 12 个既有文件变化、8 个新增文件，共 258 个 dirty / untracked 文件，无轮初文件缺失或无关改动。测量后的生产源码哈希与最终受测源码一致，五份当前文档的 83 个本地链接目标存在，git diff --check 退出 0。全部测试、类型检查和测量进程均已正常结束，无未处理运行句柄。

无云写入、真实 KMS/OAuth/模型、业务库、迁移、部署、支付、远程 CI 或依赖安装。Google Cloud KMS / 项目 cinatoken 沿用现有只读证据，不重复操作；区域、保护级别、运行身份和 IAM 仍待相应决策。没有提交 git commit 或发布线上版本。
