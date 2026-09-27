# C02.B2.2 — 图片生成入口直读与分块出站

日期：2026-09-06。状态：**入口/出站表示子集 LOCAL_PASS；C02 DOING，整个实例容量未通过**。执行与自检：Codex；独立 Reviewer 待指定。接续 [响应长字符串分段](./C02-image-json-string-pages.md)，不覆盖历史证据。

## 1. 本轮交付

- [生成入口](../../../../packages/proxy/src/routes/v1/images.ts)直接消费受限请求流，经[分段解析适配器](../../../../packages/proxy/src/services/image-json-request.ts)返回原生字段值，不再调用 Hono `json()` 留下完整文本缓存。`/v1`、`/api/v1` 的 Images 根路径与 generations 均覆盖；原有尾斜杠严格路由规则不变。
- 结构预算迁入认证后的解析器，在构造值之前检查；[入口生命周期](../../../../packages/proxy/src/middleware/text-request-lifecycle.ts)继续负责原始字节、取消和绝对时限，避免重复扫描。完整 EOF/语法/对象校验后才进入策略、选路和出站。超量仍为 413，格式错误仍为 400。
- [请求编码器](../../../../packages/proxy/src/services/egress/json-upload-body.ts)在耐久发送准入前固定合并后的字段值。容器复制、原生字符串共享；保留可选 undefined 的省略、数组 null、数值、键顺序、特殊属性、内部 typed array、已覆盖的 boxed primitive/getter/toJSON 行为。它不是对任意跨 realm/proxy JavaScript 对象的通用序列化承诺；公开请求和存储默认参数仍为 JSON 数据。
- [共享编码器](../../../../packages/proxy/src/services/egress/stream-json-body.ts)用最多 8 KiB 字符的标量片段计算准确 UTF-8 Content-Length，复用一个 64 KiB 暂存区；发送按需产生最多 64 KiB 字节页。不再构造完整出站 JSON 文本及应用侧完整编码数组。测量长度仍是一次完整遍历，随后发送时再编码，有 CPU/临时字符串代价。
- [Images driver](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)将编码器归属到一次发送。即使传输层锁住 reader，终止也能停止后续编码；普通 JSON 等上游正文读完才终止残余上传，不能收到早期 headers 就截断上传。SSE 的 EOF/取消/错误/总时限接管收尾；明确 401 后的合法候选重试重新编码完整原请求。

Workers 最佳实践技能实际推动了“受限直读、按需发送、请求所有的取消/收尾”三个改动。参考 [Cloudflare 官方建议](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。最新 types registry 获取失败，使用已安装 Workers types 5.20260829.1 及 Wrangler schema 核对；依赖、运行日期、flags、bindings 没有更改。

## 2. 不变合同及明确限制

保留原始请求 50 MiB、文件 20 MiB、普通上游图片 JSON 32 MiB 与既有 64 层/65,536 节点入口预算。不增加 Content-Type 强制拒绝，不把 UTF-8 替换解码改成严格拒绝；BOM、Unicode、重复属性、未知数据的解析语义不变。Guardrail 仍只接收原有投影字段，计费/路由仍接收原生字符串；没有将内部响应分段类型传播到这些合同中。

入口节点预算不能直接套到合并后的出站树：路由默认参数可能增加深度和节点。编码器没有另设一个更小的接受上限来暗中缩容；默认参数、multipart provider JSON 等仍需独立容量治理。本轮没有解决默认参数的无界配置，也没有解决整个实例的容量准入。

保留发送次数预算、OAuth 辅助预算、绝对时限、unknown 不重放和原有结算规则；编码 EOF 不等于买家网络接收确认，不增加退款/收费政策。没有更改 edits 的上传格式或 SSE 事件解析合同。

## 3. 验证

新增 **34 项测试**：入口适配器 14 项、上传编码/driver/本地 HTTP 15 项、公开路由 5 项。另强化原有 50 MiB 测试，实际透传完整参考图，断言 Hono 缓存为空、无整对象序列化、每页上限和精确 Content-Length。主 suite、安全专项及专项类型配置均收集新增测试。

| 最终验证 | 结果 |
| --- | --- |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest 链及主 suite 2,578 tests / 135 suites，退出 0 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 2,203 tests / 50 suites，退出 0 |
| Proxy、dispatch-safety、Admin 三项类型检查 | 按有失败即停止的顺序执行，全部退出 0 |
| `node packages/proxy/scripts/measure-image-json-ingress.mjs` | 12 个独立子进程，字节/hash/容量核验通过，退出 0 |

测试数重叠，不相加；没有失败、取消或跳过。第一次专项暴露内部 Uint8Array 兼容问题，修正后重新验证；没有通过删减既有用例规避回归。本机 127.0.0.1 随机端口 HTTP 测试确实运行 Node fetch，核验 Content-Length、原始内容及一次发送，关闭连接和服务器；它不是供应商/Workers 的联调。公开完整路由使用合成 SQL sink/零价配置，不证明真实账务数据库或付费政策通过。

## 4. 内存对照与未通过门禁

[脚本](../../../../packages/proxy/scripts/measure-image-json-ingress.mjs)比较当前 Hono 原生缓存+原生出站 Request 与入口直读+实际分块上传 helper：3 种内容 × 取消/完整读取 × 2 种实现，共 12 组。均为完整 50 MiB 合成 JSON，不是有效图片文件；没有网络。Node v24.14.1 / Windows，每组独立进程，显式 GC 阶段及离散采样，不是连续峰值或完整网关测量。[原始结果](./C02-image-json-ingress-memory.json)记录各阶段、输出长度和核验。

以下是完整读取组的 heapUsed 基线增量，单位 MiB：

| 内容 | 出站准备完成且 GC 后：原生缓存 → 直读/分块 | 离散观察最大：原生缓存 → 直读/分块 | 实际出站 |
| --- | ---: | ---: | ---: |
| ASCII | 101.83 → 52.38 | 102.28 → 109.88 | 50 MiB |
| 同一大字符串 ASCII + Unicode | 201.83 → 102.38 | 202.28 → 159.81 | 50 MiB |
| 非法 UTF-8 替换 | 301.83 → 102.38 | 302.28 → 221.40 | 157,286,294 字节，接近 150 MiB |

**持有量减少不等于峰值全面改善**：ASCII 完整读取的离散堆观察值反而高于原生控制；独立取消组还观察到约 144.49 MiB 堆增量。入口仍会将长字段拼接成原生字符串，解析临时片段和原生值会重叠。长度预计算后未读组的 ArrayBuffer 观察增量约 0.065 MiB，但持续发送组仍累计观察到约 50–67 MiB，单页上限不是总分配/GC 保证。

同步 dispose 后立刻在同一任务内 GC，取消组仍可观察到约 52/102 MiB；允许流错误/Promise 清理完成一个本地事件循环轮次，再释放测量持有者并 GC，堆增量约 2.4–2.5 MiB。脚本保留两个阶段，不将异步运行时回收宣称为同步物理擦除，也没有把 GC 或等待加入应用逻辑。

**Workers 128 MB、Node 22、完整网关持续峰值、真实上游、大并发和真实 DB 容量仍未验收**。仅准备一次 50 MiB 的异常字符请求就能形成接近 150 MiB 出站；原生字段、属性名/长数字/raw_usage、路由默认参数、SSE framing、请求与响应重叠、其它模态和网络/存储持有期都必须纳入整个实例容量模型。

## 5. 下一步、范围与目标审计

唯一下一实施项仍为 **C02.B2.2 — 治理入口原生大值和解析临时值峰值，接整个实例统一容量准入**。本轮移除的是完整原始请求缓存与完整出站序列化，不是所有大字符串或内存峰值。不能靠暗降 50/32 MiB、丢字段、提前交付未验证图片或 Images 独立并发计数宣称通过。

C02 其余门禁不变：HTTP Audio/Admin 完整入口、headers/有效 TTFT/idle、物理数据库提交确认/恢复、Realtime marker 与 Guardrail 零更新、共享音频收益、Qwen 格式、全池读取/解密及真实运行时。C00 LOCAL_PASS；C01/C02 DOING；C03–C20 TODO；C02.1–C02.7/C02.G 不勾选。本轮有源码/测试/测量进展，不是整个目标完成，也不存在阻断安全本地工作的条件；目标保持 active。

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`；轮初 208 个 dirty/untracked 文件，前轮 176 个哈希全部匹配。[本轮快照](./C02-image-json-ingress-snapshot.json)固定受测源码和最终样本。保留既有及用户更改；当前索引/Checklist/本证据不做自引用哈希。

收尾复核：相对轮初 11 个既有文件变化、8 个新增文件，合计 216 个 dirty/untracked 文件；没有轮初文件缺失或其他内容变化。182 个快照哈希全部匹配，6 份当前文档的 87 个本地链接目标存在，`git diff --check` 退出 0。最终测试和内存样本后只补充文档与快照，没有再改变应用逻辑。所有本轮测试/测量进程已经结束。

没有云端写入、真实 KMS/OAuth/模型调用、业务库访问、迁移、部署、支付、远程 CI、依赖或系统安装。GCP `cinatoken` 和 KMS API 已启用沿用 [C01 v1.2 已有只读证据](./C01-google-cloud-kms-selection.md)，本轮没有重复云端核验；区域/保护级别/身份/IAM 仍待授权。回退仅针对本轮入口/发送表示，不能撤销已有字节/结构预算、取消、unknown/禁止重放或删除账务事实，不能整体还原工作树。
