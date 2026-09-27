# C02.B2.2 — 图片响应长字符串保留分段

日期：2026-09-06。状态：**长字符串分段子集 LOCAL_PASS；C02 DOING，非整个实例容量验收**。执行与本地自检：Codex；独立 Reviewer 待指定。接续 [分段解析](./C02-image-json-parsing.md)，保留历史样本与快照。

## 1. 本轮交付与不变合同

- 新增 [JsonStringPages](../../../../packages/proxy/src/services/egress/json-string-pages.ts)，用于请求内部的不可变字符串片段，不是对外 JSON 类型，也不进入存储、队列或 RPC。误用原生 stringify/隐式字符串转换会明确报错，避免静默变成 `{}` 或泄漏正文。
- [解析器](../../../../packages/proxy/src/services/egress/segmented-json-response.ts)显式开启分段值模式后，普通 Images 的长字符串值不再整体 `join`。保留约 8 KiB 的解码片段；默认调用模式仍返回普通 JS 字符串。对象属性名仍需还原成原生字符串；特别长的数字仍整体交给原生解析以保留精度和语法。
- [Images driver](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)的计数、非空判断和有限格式识别直接消费片段。长的 `data` 条目或 `usage` 字符串不会被误当对象；未知字段、显式 media_type、重复键和特殊属性名保持原语义。
- [输出编码器](../../../../packages/proxy/src/services/egress/stream-json-body.ts)跨片段只保留一个待配对的高代理项，保留原生 JSON 对合法代理对、孤立代理项、控制字符的转义；单次标量编码最多 8 KiB 字符，输出页最多 64 KiB。
- Core 仍以原生 JSON 字符串保存 `raw_usage`，且接受数字字符串。本轮只在此账务边界显式还原 usage 子树，不把整个响应还原，也不静默删除原始用量字段。因此巨大的 usage 仍是待治理工作集，不声称账务材料已全部流式化。

仍等待完整 EOF、语法/结构/业务验证后才交付图片。32 MiB 上游原始字节容量、20 MiB 单文件、50 MiB 入口、SSE 事件容量不变；UTF-8 替换解码不改为严格拒绝。已有成功/unknown、禁止重放、用量结算和绝对 deadline 合同不变。输出 EOF 不等于客户端网络接收确认；不新增退款或收费政策。

技能推动的实际改动：按 Workers 最佳实践区分解码、字符串表示、按需输出与整体容量，避免把一份完整图片正文复制到多个表示中。核验 [Cloudflare 官方流式建议](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)，最新 types registry 获取失败后使用本地 Workers types 5.20260829.1、TextDecoder/TextEncoder 签名及 Wrangler schema；日期、flags、bindings、依赖均不变。

## 2. 验证

[新增专项](../../../../packages/proxy/src/services/egress/json-string-pages.test.ts)共 37 项：五种 transport 宽度的原生差分；15 个 Unicode/转义片段边界；BOM/替换解码；长属性、重复属性和 opaque 值；分页 MIME/空白/图片计数；generations/edits 原始 usage 与数字字符串计费；未读/一页之后的取消、客户端中断和 deadline；意外序列化拒绝。主 suite、安全专项和专项类型配置均收集此文件。

| 最终命令 | 结果 |
| --- | --- |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest 链通过；主 suite 2,544 tests / 135 suites，退出 0 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 2,169 tests / 50 suites，退出 0 |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck -w @octafuse/admin` | 退出 0；三项类型检查在有失败即停止的顺序进程执行 |
| `node packages/proxy/scripts/measure-image-json-parsing.mjs` | 最终 30 个独立 Node 子进程，退出 0 |

计数重叠，不相加；最终 suite 无失败、取消或跳过。既有公开入口测试覆盖两个前缀 × generations/edits 的完整 32 MiB 内容、一次 dispatch/usage 批写、截断尾部不提前交付、不重放、上传释放以及晚取消。SQL sink/零价 fixture 不证明真实财务数据库或收费政策通过。没有运行 Admin 业务全套或 Core 全套。

## 3. 30 组内存对照及剩余风险

[脚本](../../../../packages/proxy/scripts/measure-image-json-parsing.mjs)在当前代码下比较完整输入、分段后合并字符串、保留字符串片段三种模式；五种内容 × 取消/完整读取 = 30 组。共同使用当前 Images 规范化和流式输出，不把控制组声称为上一版本的原封不动回放。[最终原始结果](./C02-image-json-string-pages-memory.json)记录完整阶段、字节数和 hash 核验。每组独立 Node v24.14.1 / Windows 进程，禁止网络；所有输入为 32 MiB 合成 JSON，不代表有效图片文件或供应商接口。

下表为完整读取组的 heapUsed 基线增量，单位 MiB；仅离散采样，不是连续峰值：

| 内容 | 未读且 GC 后：合并 → 保留片段 | 观察最大：合并 → 保留片段 | 下游字节 |
| --- | ---: | ---: | ---: |
| ASCII | 34.18 → 34.28 | 80.83 → 69.73 | 33,554,432 |
| ASCII + 独立 Unicode metadata | 34.18 → 34.28 | 81.08 → 69.76 | 33,554,432 |
| 合法双字节 Unicode | 34.17 → 34.23 | 81.82 → 68.53 | 33,554,432 |
| 同一字符串 ASCII + Unicode | 66.18 → 34.28 | 112.84 → 69.77 | 33,554,432 |
| 非法 UTF-8 字节的替换解码 | 66.18 → 66.28 | 150.71 → 116.45 | **100,663,244** |

普通内容仍需要约 34 MiB 的活跃堆增量，替换字符约 66 MiB；这不是将正文占用变成 O(1)。终止并解除测量持有者、GC 后，分段值组堆增量约 2.2 MiB。持续读取的 ArrayBuffer 观察增量仍约 32–66 MiB，不能用单页上限推断总分配或相加不同时间的最大值。基线包含 Node/tsx/Core 加载，不等于 Workers 基线。

实现中先试过延迟展开的拼接链，以及额外合并为 64 KiB 的解码页；样本暴露输出期或解析期额外分配，最终改为贴近原生解析的 8 KiB 片段。另避免 MIME 前缀检测的 RegExp 静态记录保留指向完整原生正文的子串。最终控制组和分段组都重新测量；没有把 GC、采样器或进程参数加入应用逻辑，也没有改写历史已发布样本。

**没有通过 Workers 128 MB、真实 HTTP、Node 22、并发容量、持续峰值或生产 SLO 门禁。** 32 MiB 的异常 UTF-8 仍能产生接近 96 MiB 输出；大属性名、长数字和原始 usage、生成入口缓存、传输/GC 延迟、其他模态共享实例仍需纳入容量模型。

## 4. 下一步与目标审计

继续 C02.B2.2：处理生成入口 50 MiB 原生缓存/出站完整序列化，将属性名、原始 usage、输出扩张及其他模态的占用一起纳入整个实例的统一容量准入；保留并验证现有输入/输出合同，不能仅添加图片并发计数或悄悄缩容来通过门禁。

C02 其余未完成项保持：HTTP Audio/Admin 完整入口、headers/有效 TTFT/idle、数据库提交确认与恢复、Realtime marker/Guardrail 零更新、共享音频收益、Qwen 格式、全池读取/解密及真实运行时。C00 LOCAL_PASS；C01/C02 DOING；C03–C20 TODO；C02.1–C02.7/C02.G 不勾选。

上一目标轮为进展：只读确认 KMS API 从历史未启用变为已启用，已补入 [C01 v1.2](./C01-google-cloud-kms-selection.md)。本轮源码、测试和内存证据构成进一步进展；未证明整个平台完成，亦无真正阻塞，目标保持 active。

## 5. 变更范围与授权

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`；轮初 203 个 dirty/untracked 文件，前轮 173 个文件哈希全部匹配。[本轮快照](./C02-image-json-string-pages-snapshot.json)固定受测文件及最终样本；保留所有历史与用户更改。当前 Checklist、索引与本证据页不做自引用哈希。

收尾复核：相对轮初 11 个既有文件变化、5 个新增文件，无轮初文件缺失或其他内容变化；176 个快照哈希全部匹配，6 份当前文档的 82 个本地链接目标存在，`git diff --check` 退出 0。最终测试后只补充解析器使用边界注释、文档和样本，没有再修改运行逻辑。

本轮没有云端写入、真实 KMS/OAuth/模型调用、业务库访问、迁移、部署、支付、远程 CI、依赖或系统安装。KMS 的区域/保护级别/身份/IAM 仍待授权和验收。回退只能针对本轮分段表示路径，继续保留字节/结构预算、取消、unknown 和禁止重放；不得整体还原工作树或删除账务事实。
