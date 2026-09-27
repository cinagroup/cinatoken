# C02.B2.2 — 图片生成入口长值保持分段

日期：2026-09-06。状态：**入口长值表示子集 LOCAL_PASS；C02 DOING，整个实例容量未通过**。执行/自检：Codex；独立 Reviewer 待指定。接续 [入口直读与分块出站](./C02-image-json-ingress.md)，不覆盖历史证据。

## 1. 本轮交付与兼容边界

- [分段解析器](../../../../packages/proxy/src/services/egress/segmented-json-response.ts)新增仅对根字段生效的原生子树选择。通用解析器默认行为、响应长值分段模式、完整 EOF/语法验证与重复键语义不变。
- [Images 入口适配器](../../../../packages/proxy/src/services/image-json-request.ts)保留参考图、透传选项及未知字段中的长字符串片段。`model/prompt/n/size/quality/background/response_format/output_format/sequential_image_generation/stream/watermark/provider/service_tier/speed/session_id` 的完整子树仍还原原生字符串；现有校验、路由策略和 Guardrail 投影不扩大。新增业务语义消费者必须支持片段或显式加入原生边界，不能对内部值直接原生 stringify、跨存储/RPC 传递。
- [长值 helper](../../../../packages/proxy/src/services/egress/json-string-pages.ts)增加逐页原生等价 trim，保留空白、Unicode 和代理对边界语义，不拼接整幅参考图，也不修改不可变源页。[参考计数/透传](../../../../packages/proxy/src/services/image-generation-extras.ts)接受字符串或片段，仍忽略无效/空白图片，单张有效数组仍按原规则折叠。字符串形式的 options 即使内部变为对象实例，也不会被误认为选项记录。
- [默认参数合并](../../../../packages/proxy/src/services/route-default-params.ts)把片段视为标量覆盖而非对象合并；[上传快照](../../../../packages/proxy/src/services/egress/json-upload-body.ts)共享不可变片段，不调用其拒绝普通序列化的 toJSON。精确 Content-Length、64 KiB 发送页、取消、提前响应和合法重试的所有权不变。[公开路由](../../../../packages/proxy/src/routes/v1/images.ts)的类型摘要仍显示 string，不把内部片段显示成 object。
- 根 JSON 是长字符串时，即使内部表示为片段对象也必须拒绝；补充 8,191/8,192/8,193/65,536 字符边界测试。不能让表示优化改变“请求必须是对象”的语义。

原始请求 50 MiB、文件 20 MiB、普通上游 JSON 32 MiB 与入口 64 层/65,536 节点保持不变；不新增 Content-Type 限制或严格 UTF-8 拒绝，不改变 BOM/替换解码、原有业务值、未知结果禁止重放和结算规则。长属性名、数值精确解析、原生控制和 raw_usage 仍有整体值分配；不是全部 JSON 值都成为小内存对象。

Workers 最佳实践技能实际推动了分段表示贯穿入口和发送、复核请求所有权及防止片段越过普通序列化边界。依据 [Cloudflare 官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)；最新 types registry 获取失败，使用已安装 Workers types 5.20260829.1 和 Wrangler schema。没有改依赖、兼容日期、flags、bindings 或云资源。

## 2. 验证

新增 **37 项测试**：[入口/合并/编码合同](../../../../packages/proxy/src/services/image-paged-ingress.test.ts)31 项；[公开路由](../../../../packages/proxy/src/routes/v1/image-request-lifecycle.test.ts)6 项。后者包括新增两种完整 50 MiB 参考图输入和四条 canonical/legacy 根路径、generations 路径的长图片/选项验证；原有 ASCII 完整容量用例也强化为独立预期出站 SHA-256。模拟 materialize 抛错，确保参考图/透传值未整体拼接；逐页核验、Content-Length、一次 dispatch/usage batch、Hono 空缓存均覆盖。原有明确 401 后的完整重试测试继续通过。

| 最终验证 | 结果 |
| --- | --- |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest 链；主 suite 2,615 tests / 135 suites，退出 0 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 2,240 tests / 50 suites，退出 0 |
| Proxy、dispatch-safety、Admin 三项类型检查 | 按有失败即停止的顺序执行，全部退出 0 |
| `node packages/proxy/scripts/measure-image-json-ingress.mjs` | 最终 24 个独立子进程，长度/hash/表示断言通过，退出 0 |

测试集合重叠，不相加；最终无失败、取消或跳过。初始四个 helper 差分断言直接比较内部片段与原生字符串，已改为同时断言片段类型和显式还原后的原生等价值，未删语义断言。首次类型检查发现新测试的路由 fixture 不完整，补齐真实接口字段后重跑完整 suites 和三项类型检查，不使用双重强制转换绕过检查。

公开路由使用合成 SQL sink/零价配置，不能证明真实账务/付费政策或供应商兼容。既有本机 loopback HTTP 测试在本轮 suite 中重跑，验证 Node fetch 和完整上传长度/内容，不访问外网。没有运行远程 CI。

## 3. 内存对照：改善与没有改善的部分

[脚本](../../../../packages/proxy/scripts/measure-image-json-ingress.mjs)使用相同当前源码中的三种控制：Hono 原生缓存+原生出站 Request、分段解析后拼成原生长值+分页出站、当前 Images 片段值+分页出站。4 种 50 MiB 内容 × 取消/完整读取 × 3 种实现，共 24 组；最后一种把大值放入仍需原生表示的 prompt，防止用参考图收益推断所有入口字段获益。合成正文不是有效图片，测量 helper 不做网关 prompt 长度预检；prompt 样本反映该预检之前的入口分配风险，不表示公开路由会发送如此长的提示词。

Node v24.14.1 / Windows，每组独立进程，显式 GC 阶段及离散采样。最终测量时前一轮测试已结束；不是完整网关、连续峰值、Workers、Node 22 或并发压力证据。[最终原始结果](./C02-image-paged-ingress-memory.json)保留全部 24 组。

以下为完整读取组的 heapUsed 基线增量（MiB）。为显示本轮增量，主要比较原生长值分段解析控制 → 当前片段值，不只与最早的全量缓存比较：

| 50 MiB 内容 | 出站准备且 GC 后 | 离散观察最大 | 实际出站 |
| --- | ---: | ---: | ---: |
| ASCII 参考图 | 52.41 → 52.58 | 109.96 → 107.89 | 50 MiB |
| 同一参考图 ASCII + Unicode | 102.39 → 52.57 | 160.01 → 107.89 | 50 MiB |
| 非法 UTF-8 替换参考图 | 102.41 → 102.58 | 218.68 → 153.40 | 157,286,294 字节，接近 150 MiB |
| 原生 prompt 控制 ASCII + Unicode | 102.40 → 102.42 | 160.01 → 160.74 | 50 MiB（helper 测量） |

混合 Unicode 参考图不再因为单个末尾字符将整条长原生字符串扩为双字节存储；替换字符本身仍需要较大的解码工作集。ASCII 持有量无同等收益，原生控制字段的完整拼接仍在，当前样本观察峰值甚至略高。**不能据此宣称整体峰值已受控。** 当前分页发送组 ArrayBuffer 观察增量仍约 50–67 MiB；每页 64 KiB 不是累计分配或 GC 上限。

[预备 24 组样本](./C02-image-paged-ingress-memory-preliminary.json)也保留：当时 joined-segmented 测量分支额外持有包含 body 的结果 wrapper，释放阶段因此不具可比性。移除测量器自身的持有者后完整重跑，应用逻辑不变。该预备样本中当前原生控制取消组曾观察约 **194.85 MiB** 堆增量；不因最终一次样本较低就抹去这项观察或把约 161 MiB 宣称成硬上限。

最终取消/读取的两个分段实现释放持有者并完成一个本地事件循环轮次后，GC 堆增量约 2.46–2.58 MiB。保留同任务与事件循环后两个阶段，不把异步回收描述为同步物理擦除，也不把测量中的 GC/等待加入应用逻辑。

## 4. 下一步与目标审计

唯一下一实施项仍为 **C02.B2.2 — 压低保留原生控制字段及解析临时值峰值，接整个实例统一容量准入**。不能只完成参考图分段就跳过原生控制、长键/数字/raw_usage、默认参数、SSE framing、上传/响应重叠、其他模态及网络/存储持有期。需保留 50/32 MiB 合同；若要新增字段/输出/UTF-8 拒绝规则，必须明确兼容变化，不能暗中缩容或用 Images 独立并发计数代替全实例治理。

Workers 128 MB、Node 22、完整网关持续峰值、真实上游/账务数据库和大并发仍未验收。C02 其他门禁：HTTP Audio/Admin 完整入口、headers/有效 TTFT/idle、数据库提交确认/恢复、Realtime marker/Guardrail 零更新、共享音频收益、Qwen 格式；全池读取/解密仍留 C07/C09。C00 LOCAL_PASS；C01/C02 DOING；C03–C20 TODO；C02.1–C02.7/C02.G 不勾选。

本轮有源码、测试和测量进展，整个目标未完成；安全本地工作仍可继续，没有触发 blocked 条件，目标保持 active。没有云端写入、真实 KMS/OAuth/模型调用、业务库访问、迁移、部署、支付、远程 CI 或安装。GCP project `cinatoken` 和 API 已启用沿用 [C01 v1.2 只读证据](./C01-google-cloud-kms-selection.md)，本轮未重复云端核验；区域/保护级别/身份/IAM 仍待授权。

## 5. 基线与回退

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`；轮初 216 个 dirty/untracked 文件，前轮 182 个快照哈希全部匹配。[本轮快照](./C02-image-paged-ingress-snapshot.json)固定受测源码、当前 API 边界和最终/预备内存样本；当前证据、索引和 Checklist 不做自引用哈希。保留全部既有与用户变更。

回退只针对本轮入口长值表示及相关消费者；不能撤销之前的字节/结构预算、绝对时限、取消清理、unknown 禁止重放或删除账务事实，不得整体还原工作树。最终测试和测量后仅更新文档/证据，没有再改变应用逻辑。

收尾复核：相对轮初 16 个既有文件变化（其中参考计数和默认合并两个文件由干净变为 dirty）、5 个新增文件，共 223 个 dirty/untracked 文件；没有轮初文件缺失或其他内容变化。187 个快照哈希全部匹配，6 份当前文档的 92 个本地链接目标存在，`git diff --check` 退出 0。本轮所有测试、类型检查与测量进程均已终止。
