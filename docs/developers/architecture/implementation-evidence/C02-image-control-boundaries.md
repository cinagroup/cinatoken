# C02.B2.2 — 图片生成控制字段的显式原生边界

日期：2026-09-06。状态：**控制字段表示子集 LOCAL_PASS；C02 DOING，整个实例容量未通过**。执行/自检：Codex；独立 Reviewer 待指定。接续 [入口长值分段](./C02-image-paged-ingress.md)，不覆盖历史证据。

## 1. 本轮交付与兼容边界

入口完整 EOF、JSON 语法、重复键最后值优先和结构预算均先完成，再执行业务校验。不是遇到超长提示词就提前截断正文或跳过余下语法。长值仍由已有分段解析器处理，本轮没有改解析器本身。

| 根字段 | 当前消费方式 | 保留的公开语义 |
| --- | --- | --- |
| `prompt` | [生成入口专用适配器](../../../../packages/proxy/src/services/image-generation-params.ts)逐页去首尾空白，确认不超过 4,000 个 UTF-16 字符后才还原原生字符串 | 保留原生 trim、必填、长度与错误优先级；大量空白包围的短提示词仍可合法，不另设原始 prompt 字节限制 |
| `response_format`、`sequential_image_generation` | 支持字符串和内部片段；逐页 trim，空白值仍忽略 | 不新增枚举或长度限制；有值时保持原有透传值 |
| `output_format` | 字符串或内部片段直接透传 | 保留原有不 trim 的行为 |
| `stream`、`watermark`、`session_id` | 分别继续类型判断、布尔判断、存在性判断；长值无需拼接 | 非布尔 stream 拒绝；非布尔 watermark 不透传；session_id 一经提供仍拒绝 |
| `speed` | 长值可保留片段，Images 类型化路由仍忽略 text speed | 不新增 speed 拒绝规则；它原本就不进入图片上游构造 |
| `model`、`n`、`size`、`quality`、`background`、`provider`、`service_tier` | **完整子树仍为原生值** | 现有选路、定价、Number 转换及 provider 解析不变；这些值的整体分配尚未消除 |

[Images 入口](../../../../packages/proxy/src/services/image-json-request.ts)的原生根字段白名单由 15 项收窄为上述 7 项，其余 8 项各有显式消费者边界。参考图、未知值、选项和默认参数合并继续沿用前轮分段支持。[公开路由](../../../../packages/proxy/src/routes/v1/images.ts)在提示词和 stream 校验通过后、等待 Guardrail 前，将请求自有的 `body.prompt` 换成已经验证的短字符串，避免保留原始空白填充；诊断长度同时支持内部片段。Guardrail 只接收既有原生 model/prompt/n/size/quality/background 投影，不扩张审查字段。

[共享图片校验器](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)本轮未改；新适配器仅用于 generations 入口，后续 Guardrail 校验及 edits 仍复用原有原生校验器。[额外参数适配](../../../../packages/proxy/src/services/image-generation-extras.ts)继续遵守数组计数与无效类型规则。没有将内部片段跨存储/RPC 传递或直接原生 stringify。

原始入口 50 MiB、文件 20 MiB、普通上游 JSON 32 MiB、64 层/65,536 节点、BOM 与 UTF-8 替换解码不变。没有收紧未限定长度的 size/quality/background、透传选项或 n 的原生数值转换合同；没有改变 unknown 禁止重放、计费或退款规则。

Workers 最佳实践技能实际推动了“先按消费语义验证，再在必要边界还原原生值”和等待异步策略前释放原始持有者，而不是仅修改发送页大小。依据 [Cloudflare 官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)；最新 types registry 获取失败，采用已安装 Workers types 5.20260829.1 与 Wrangler schema。依赖、兼容日期、flags、bindings 和云资源均未变更。

## 2. 验证

新增 **62 项测试**：

- [生成参数差分](../../../../packages/proxy/src/services/image-generation-params.test.ts)25 项，以未改的共享校验器为原生 oracle，覆盖合法/非法参数组合、空白、4,000/4,001 边界、Unicode/孤立代理项、非字符串以及分块转义；断言还原的提示词不超过 4,000 字符。
- [公开路由](../../../../packages/proxy/src/routes/v1/image-request-lifecycle.test.ts)37 项：四条 canonical/legacy 根路径与 generations 路径各 7 种验证场景共 28 项；四条路径的超长 format/sequential 透传及明确 401 后重试共 4 项；5 项完整 50 MiB 提示词正文，包括合法填充、超限、非法 UTF-8 替换、错误对象类型、重复键最后小值覆盖。覆盖 Guardrail 阻断、原生提示词投影、一次 dispatch/usage batch、拒绝不出站及 EOF/reader 解锁。
- 原有 [入口表示合同](../../../../packages/proxy/src/services/image-paged-ingress.test.ts)31 项保留，其中 15 个根字段的表示预期随白名单变化更新；仍同时核验内部类型、显式还原值和精确发送字节，不删除原有语义断言。

| 最终验证 | 结果 |
| --- | --- |
| 四份入口/参数/公开生命周期专项测试 | 396 tests，全通过，退出 0 |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest 链；主 suite 2,677 tests / 135 suites，退出 0 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 2,302 tests / 50 suites，退出 0 |
| Proxy、dispatch-safety、Admin 三项类型检查 | 按有失败即停止的顺序执行，全部退出 0 |
| `node packages/proxy/scripts/measure-image-control-ingress.mjs` | 18 个独立子进程，完整输入/校验/长度/hash/释放断言通过，退出 0 |
| `node packages/proxy/scripts/measure-image-json-ingress.mjs` | 原有 24 组序列化对照重新运行，表示/长度/hash 断言通过，退出 0 |

测试集相互重叠，不相加；最终无失败、取消或跳过。首次专项 396 项中四个 Guardrail 阻断用例因替换 fixture 策略时漏记调用记录而失败，实际 403 已符合预期；补齐观察记录后原断言保留，396 项、完整 suites 和类型检查均重跑通过。没有通过放宽生产校验或删除断言掩盖失败。

公开路由使用合成策略、零价配置和模拟 SQL sink；不证明真实供应商、支付策略或数据库事务。既有本机 loopback HTTP 测试在完整 suite 中重跑，不访问外网。没有运行远程 CI、Workers 或 Node 22。

## 3. 内存对照与残留风险

[新测量脚本](../../../../packages/proxy/scripts/measure-image-control-ingress.mjs)比较同一个当前解析器的 v1.29 原生 15 字段配置与当前延迟还原配置，分别接原生校验器/新生成适配器。6 种完整 50 MiB 内容：3 种有效值各执行取消和完整发送，3 种无效值执行拒绝；两种实现共 18 组。[原始结果](./C02-image-control-boundaries-memory.json)保存全部离散阶段。

为隔离表示与复制成本，**两个测量分支都会在校验后替换 parsed.prompt 为标准化短值**；原生控制不是 v1.29 完整历史路由的逐字复刻，不能把持有期改善全归到两组差值。两个分支先加载同一批模块，再记录基线；有效发送使用独立预期字节数/SHA-256，不调用真实供应商。format/size 的发送正文为 52,428,806 字节，合法填充提示词发送正文仅 50 字节。

以下是 heapUsed 相对各进程基线增量，单位 MiB；不是整个进程内存。有效值取完整发送组，无效值取拒绝组：

| 完整 50 MiB 输入 | 解析后 GC：原生 → 当前 | 离散观察最大：原生 → 当前 | 当前观察到的最大整值还原（字符） |
| --- | ---: | ---: | ---: |
| 大量空白 + 短 Unicode 提示词 | 102.23 → 52.39 | 182.81 → 82.72 | 10 |
| 长混合 Unicode response_format | 102.23 → 52.40 | 182.66 → 107.73 | 0 |
| **仍未适配的长 size** | 102.23 → 102.26 | 182.82 → 182.82 | 52,428,747 |
| 超过 4,000 字符的提示词 | 102.23 → 52.39 | 182.63 → 82.74 | 0 |
| 非法 UTF-8 替换提示词 | 101.20 → 102.37 | 217.92 → 135.94 | 0 |
| 错误对象类型提示词 | 52.23 → 52.38 | 132.68 → 82.47 | 0 |

合法填充提示词经业务边界后，两个分支的 GC 堆增量均降至约 2.2 MiB。替换解码的持有工作集没有同步改善，当前离散堆峰值仍约 136 MiB；未适配 size 仍约 183 MiB。发送大字段时 ArrayBuffer 观察增量仍可约 50 MiB。当前分支释放所有测量持有者、经过一个事件循环再 GC 后，堆增量约 2.19–2.33 MiB；同任务和下一轮回收分别记录，不声称同步物理擦除。

[重跑的序列化对照](./C02-image-control-boundaries-serialization-memory.json)另外保存 24 组，不执行公开提示词预检。其中 `control-mixed` 的 prompt 现已分段，不能再标作“当前原生控制”。当前完整发送组的参考图 ASCII/混合 Unicode 堆观察峰值约 108 MiB；UTF-8 替换参考图仍约 153 MiB，出站 157,286,294 字节、接近 150 MiB，ArrayBuffer 观察增量约 66 MiB。这里只验证编码行为，**不表示公开路由会接受或发送 50 MiB 的有效提示词**。前轮原生提示词约 161/195 MiB 的历史结果仍保留，但不能混作本轮相同场景的配对结果。

环境为 Node v24.14.1 / Windows，每组独立子进程、显式 GC 与离散采样；18 组在本轮完整 suites 前完成，24 组重跑时有独立测试进程运行。不是连续峰值、完整网关、真实 Workers 128 MB、Node 22 或并发容量证据；heapUsed 增量不能当成运行时总内存或硬上限。**整个实例容量仍不通过。**

## 4. 下一步与目标审计

唯一下一实施项仍为 **C02.B2.2 — 剩余原生控制与解析工作集治理，接整个实例统一容量准入**。先处理剩余七个原生字段的实际消费者和长键/数字/raw_usage、替换解码临时工作集，再覆盖默认参数、SSE framing、上传/响应重叠、其他模态及网络/存储持有期。未实施全实例 owner registry 或统一 admission；不能以 Images 独立并发计数替代，不暗降 50/32 MiB 容量。若新增字段长度、UTF-8 或输出拒绝规则，需要明确兼容变更。

C02 其他门禁：HTTP Audio/Admin 完整入口、headers/有效 TTFT/idle、数据库提交确认与恢复、Realtime marker/Guardrail 零更新、共享音频收益、Qwen 格式；全池读取/解密留 C07/C09。C00 LOCAL_PASS；C01/C02 DOING；C03–C20 TODO；C02.1–C02.7/C02.G 不勾选。

本轮有源码、测试与测量进展，整体目标未完成；可继续安全本地工作，没有触发 blocked 条件，目标保持 active。没有云端写入、真实 KMS/OAuth/模型调用、业务库访问、迁移、部署、支付、远程 CI 或安装。GCP 项目 `cinatoken`、CLI 登录和 KMS API 已启用沿用 [C01 v1.2 只读证据](./C01-google-cloud-kms-selection.md)，本轮不重复云端检查；区域、保护级别、运行身份和 IAM 尚未批准配置。

## 5. 基线与回退

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`；轮初 223 个 dirty/untracked 文件，前轮 187 个快照哈希全部匹配。[本轮快照](./C02-image-control-boundaries-snapshot.json)扩展保留受测源码、当前 API 边界及两份新测量原始结果；当前证据、索引和 Checklist 不做自引用哈希。保留既有与用户变更，不覆盖历史证据。

回退仅限本轮原生消费边界、对应测试和测量器；不得撤销此前字节/结构预算、时限、取消清理、unknown 禁止重放或账务事实，不整体还原工作树。最终完整测试后仅写文档/证据，未再改应用逻辑。

收尾复核：相对轮初 12 个既有文件变化、7 个新增文件，共 230 个 dirty/untracked 文件；没有轮初文件缺失或其他内容变化。192 个快照哈希全部匹配，6 份当前文档的 94 个本地链接目标存在，`git diff --check` 退出 0。本轮全部测试、类型检查与测量进程均已终止。Git 提示无法读取用户级 ignore 文件，但项目路径枚举与内容哈希复核完成；没有修改该用户配置。
