# C02.B2.2 — 分段解析图片 JSON 与剩余表示扩张

日期：2026-09-06。状态：**普通图片分段解析子集 LOCAL_PASS；C02 DOING；剩余字符串峰值、生成入口缓存、整个实例容量与真实运行时未验收**。执行/本地自检：Codex；独立 Reviewer 待指定。接续 [按需输出编码](./C02-image-json-encoding.md)，保留前轮原始样本与历史快照。

## 1. 已实现的路径与合同

[公共有界读取器](../../../../packages/proxy/src/services/egress/bounded-response-body.ts)拆出同步文本消费回调：按实际上游字节限制读取，不信任 Content-Length；单次解码最多 64 KiB，即使 transport 提供一整个大块。既有小正文消费者继续使用原来的聚合文本接口。取消不等待 transport ACK，读锁/监听器在终态释放。

[新增分段解析器](../../../../packages/proxy/src/services/egress/segmented-json-response.ts)接入 [Images driver](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)的普通 generations/edits 响应：

1. 每个文本块先经过现有 64 层 / 65,536 节点预算，重复属性与未知字段仍计数。
2. 提取字符串/其它标量，记录短引用组成的结构文本。大字符串以最多 8,192 个 UTF-16 code units 加一段完整转义处理，转义与标量值由原生 JSON.parse 判定，不生成整份原始 JSON 文本。
3. EOF 后，原生 JSON.parse 校验紧凑结构，再按出现顺序还原属性和值。以数据属性定义真实键，避免 `__proto__` setter；重复键最后覆盖、整数属性顺序、null/布尔值、数字舍入/溢出、孤立代理项、Unicode、metadata 等按既有语义保留。
4. 仍要完成全部读取、语法及业务校验，才能交接上一轮的按需输出。不给出可消费的部分对象，不提前发布图片，不重放结果未知的生成请求。

这不是另写一套数字转换算法，也不是对任意 JS 对象执行代码。**一个特别长的未加引号标量仍要完整交给原生解析**，以保留数字精度、溢出及非法格式拒绝；其长度由原有字节限制约束。解码后的大字符串、短引用表、结构文本/对象图和还原结果仍占内存，不能声称整个解析工作集已经有严格峰值保证。

畸形 JSON 若在中途已经识别，只保留既有的前 500 个字符错误预览，释放已解析材料；继续受字节/结构预算和取消/总时限约束并等 EOF，保持原有 material/error 处理顺序。空正文沿用 `{body:null,jsonValid:true}` 的中间结果，业务层仍拒绝无图片的 2xx；纯空白仍为无效 JSON。替换解码的 UTF-8/BOM 行为没有改成新的严格拒绝政策。

普通上游 JSON **读取上限仍为 32 MiB 原始字节**，不是规范化后的客户端输出上限。替换解码、转义和 usage/media_type 规范化原本就可能扩大输出；第 3 节给出新实测。20 MiB 文件、50 MiB 入口与原 SSE 事件容量不变，没有删除字段、只允许 URL 或降低大响应容量。生成请求原生 JSON 缓存、SSE 事件解析/输出以及其它模态尚未使用此分段解析器。

## 2. 验证与新增 61 项测试

Windows / Node.js v24.14.1，使用合成响应/身份和既有本地账务替身，无真实模型/资金调用。

| 范围 | 断言 |
| --- | --- |
| [分段解析专项](../../../../packages/proxy/src/services/egress/segmented-json-response.test.ts)：53 项 | 七种分块宽度下合法/非法 JSON 与原生解析差分；250 个固定种子混合树及 250 个变异输入；20 个长键/值转义边界；UTF-8 替换/BOM；长数字；深度/节点精确边界；完整 32 MiB 大字符串/空白；巨大 transport 块的有界解码；超限块在任何原生值解析前拒绝；未读/挂起/部分内容取消；畸形预览/EOF 与后续资源限制 |
| [公开链路](../../../../packages/proxy/src/routes/v1/image-request-lifecycle.test.ts)：8 项 | 两个前缀 × generations/edits 的完整 32 MiB 响应，Unicode/重复属性/特殊属性名/usage 保留、没有整份图片 JSON 进入解析、一次 dispatch/用量批写、上传页释放；两种 operation × 正常/截断尾部不提前交付、无重复发送 |

| 命令 | 最终结果 |
| --- | --- |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest 链通过；主 suite 2,507 tests / 135 suites；退出 0 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 含 Core 入口构建；2,132 tests / 50 suites；退出 0 |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 通过，无类型诊断；随后 Admin 检查同一顺序进程退出 0，命令有失败即停止检查 |
| `npm.cmd run typecheck -w @octafuse/admin` | 退出 0 |
| `node packages/proxy/scripts/measure-image-json-parsing.mjs` | 最终 20 个独立子进程完成，退出 0 |

最终 suite 均无失败、取消或跳过；各表计数重叠，不能相加。新增专项纳入主 suite、安全专项和类型检查。之前的 385 项既有定向回归、52 项首轮新专项及 8 项新公开链路分别通过；最终 suite 另包含补上的“分配前预算”测试。没有单独运行 Core 全套或 Admin 业务 suite。SQL sink 和零价 fixture 不证明真实资金账本、业务数据库提交或收费政策已验收。

## 3. 20 组对照样本及负面证据

[测量脚本](../../../../packages/proxy/scripts/measure-image-json-parsing.mjs)对照“完整输入文本 + 原生解析”和“分段输入”，两组都使用实际 Images 规范化与上一轮按需输出；每种输入另分未读取消/完整读取。每组独立 Node 进程，旧生代上限 512 MiB，禁止 fetch；上游按页生成，不先构造整份参考正文。采样在读取、原生解析调用及阶段边界进行，GC 仅用于测量基线/持有状态，不进入应用代码。[原始结果](./C02-image-json-parsing-memory.json)保留全部阶段、字节数和最大单次原生解析长度。

所有输入为 32 MiB，完整读取组核对输出 hash。正常 UTF-8 按原始字节核对；异常输入使用独立预构造的替换字符字节页核对，不生成完整参考字符串。下表取完整读取组，相对各自基线的 heapUsed 增量，单位 MiB：

| 输入 | 未读时（GC 后）：完整 → 分段 | 离散最大：完整 → 分段 | 实际下游 JSON 字节 |
| --- | ---: | ---: | ---: |
| 大段 ASCII | 66.02 → 34.14 | 108.87 → 81.03 | 33,554,432 |
| ASCII + 一个独立 Unicode metadata 字符 | 98.03 → 34.14 | 140.92 → 81.05 | 33,554,432 |
| 大段合法双字节 Unicode | 66.03 → 34.14 | 109.11 → 81.77 | 33,554,432 |
| 同一个大字符串中，ASCII + 一个 Unicode 字符 | 130.02 → 66.14 | 173.12 → 112.80 | 33,554,432 |
| 大段非法 UTF-8 字节，沿用替换解码 | 130.02 → 66.14 | 194.35 → 137.44 | **100,663,244，接近 96 MiB** |

分段组最大单次 JSON.parse 输入 8,194 个字符；完整组最多 33,554,432 个字符。分段组取消/读完并去掉测试持有者、GC 后，heapUsed 增量约 2.1 MiB。持续读取仍有 ArrayBuffer 分配累积：正常组观察到约 32.07 MiB，替换解码组约 66.07 MiB，不能用单页 64 KiB 推断总内存。这里测试合成 JSON 字符串；Unicode/替换字符并非有效 Base64 图片，不宣称实际图片文件或供应商验收。

第一次释放采样中，测量脚本本身的局部 `material` 仍引用解析结果，释放后保留约 32 MiB；明确解除脚本持有者并重跑后恢复上述值。这不是观察到的生产泄漏，也不能把修正前的值归因于编码器。最终发布的是修正并扩展至 20 组的原始结果，历史已发布样本不改写。

**这些数据支持减少完整表示副本，但反驳“单请求峰值已经解决”。** 独立 Unicode metadata、同一大字符串里的混合字符和非法 UTF-8 必须分开：混合合法字符仍使未读结果持有约 66 MiB 堆增量；保持既有替换解码时，32 MiB 上游更可能形成近 96 MiB 输出。没有为了通过测试悄悄拒绝这些输入。旧生代/GC/异步传输和对象图开销也尚无整实例上界。

采样不是连续峰值、统计压测、真实 HTTP、Workers/isolate 或生产 SLO；不同列最大值未必同时出现。Node/tsx/Core 约数十 MiB 加载基线不应直接与 Workers 限制比较。本轮没有重复未通过的真实 Workers 启动检查，也没有修改系统环境。

## 4. 唯一下步与完成审计

继续 **C02.B2.2：先治理长字符串拼接与 UTF-8 替换/输出扩张的剩余单请求工作集，并覆盖生成入口 50 MiB 原生缓存，再接整个实例的统一容量准入。** 不能仅加 Images 并发计数，不能将输出按页等同于总内存有界；任何新的语法/UTF-8/输出容量限制须明确作为兼容政策变更披露，不能悄悄缩小当前支持范围来勾选门禁。

其它保留项：特别长数字的原生解析、SSE framing/表示、早到响应与未完上传重叠、网络缓冲/慢读/存储持有期、其它模态同时运行；HTTP Audio/Admin 完整入口、headers/有效 TTFT/idle、真实数据库提交/恢复；Realtime marker/Guardrail 零更新、共享音频收益、Qwen 格式与全池读取/解密。Node 22、真实 Workers/HTTP 与生产数据库/KMS 都未验收。

上一轮属于进展；本轮有源码、测试及改变下一步的扩张证据，但这不能证明完整 V2.1/OpenRouter 型平台完成。C00 LOCAL_PASS，C01/C02 DOING，C03–C20 TODO；C02.1–C02.7/C02.G 不勾选。没有满足完整目标或真正阻塞的条件，目标继续保持 active。

## 5. 基线、变更和授权范围

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`；轮初 197 个 dirty/untracked 文件，前轮 169 文件快照全部匹配。业务源码变化限于公共响应文本消费者、Images driver、新分段解析器；另新增专项/测量脚本，更新公开链路测试、测试入口/专项类型配置和当前文档。受测文件/最终样本见 [本轮快照](./C02-image-json-parsing-snapshot.json)；保留所有历史文件和用户更改。

收尾相对轮初九个既有文件变化、六个新增文件（含快照），无轮初文件缺失或其他内容变化。173 个受测文件/样本哈希全部匹配，五份当前文档的 83 个本地链接目标存在，`git diff --check` 退出 0。快照不包含自身、当前 Checklist、索引与本证据页，避免自引用；最终功能测试后仅补充上游字节上限的注释及文档/样本，没有再修改运行逻辑。

Workers 最佳实践技能推动了单块有界消费、避免完整文本聚合，以及将残余分配与整个实例容量分开验证。[官方响应建议](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)与 [ECMAScript JSON 语义](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse)已核验；最新 types registry 获取失败后检查本地 Workers types 5.20260829.1、TextDecoder 签名和 Wrangler schema。配置日期、flags/bindings 不变。

没有新增依赖、云端配置/KMS/OAuth/模型请求、真实业务库访问、迁移、部署、远程 CI、支付或系统安装。Google Cloud KMS / project `cinatoken` 已确认，未重新配置。新增实现尚未部署；回退限定本轮解析路径，仍须保留字节/结构预算、取消、unknown 和禁止重放，不整体还原工作树或删账务事实。
