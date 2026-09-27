# C02.B2.2 — Images multipart 解析前置资源检查

日期：2026-09-06。状态：**本页子集 LOCAL_PASS；C02 为 DOING；原生缓冲与并发内存门禁仍未完成**。执行/本地自检：Codex；独立 Reviewer 待指定。接续 [Images 入口时限与文件复用](./C02-image-ingress-lifecycle.md)，不覆盖其历史快照。

## 1. 实际变化与边界

[新 inspector](../../../../packages/proxy/src/services/multipart-body-inspector.ts)在上传 chunk 交给原生 formData 之前扫描 multipart framing；[上传 owner](../../../../packages/proxy/src/services/bounded-request-body.ts)负责等待检查、传播错误、取消源和释放探针状态。[入口中间件](../../../../packages/proxy/src/middleware/text-request-lifecycle.ts)只为 Images edits 接入检查，其他文本/向量/图片生成维持原路径。

| 对象 | 当前硬限制与行为 |
| --- | --- |
| 原始请求体 | 保留 50 MiB，包含 framing；声明与实际字节检查均保留 |
| 每个文件部分 | 保留 20 MiB；按原始上传字节计数，不解码后放大接收量 |
| 文件数量 | 最多 5 个；未知字段下的文件也计数，不能靠不同字段名绕过资源检查 |
| 所有表单部分 | 最多 64 个；重复、未知、空部分也计数 |
| 普通字段 | 单项 64 KiB；累计 128 KiB；按字节而非 JavaScript 字符数计数，原业务参数验证另行执行 |
| 部分头部 | 16 KiB，不含四字节结束标记；超过即停止，不等待完整表单 |
| Content-Type / boundary | 外层最多 1,024 字符；boundary 为 1–70 个有效 ASCII 字符；重复 boundary 参数拒绝 |
| 附加 framing | preamble、epilogue、已识别 delimiter padding 合计最多 16 KiB；未完成 padding 也有上限 |

检查器使用有界分隔状态及固定头部缓冲，不保存文件内容或普通字段值；存在少量边界待判定字节，不把尚未判定的 delimiter 前缀误算为文件。文件分类由**同一运行时的原生解析器**处理一个不含原始正文、最多约 16 KiB 头部的零字节文件/字段探针，避免自行重写 Content-Disposition/filename 语义。探针不进入 Hono bodyCache，不增加新网络调用、全文件 arrayBuffer 或出站副本。

探针等待沿用入口 deadline；取消/到期时释放读取权并观察迟到结果，迟到探针不能继续解析或发送下一 chunk。错误消息固定且脱敏，不含文件名、头部值或正文。文件数量/单文件超限维持原有 400；资源 envelope 超限为 413；取消/到期继续 499/504。原生解析及业务层仍可拒绝格式/参数，扫描器通过不等于请求被接受。

**本轮没有移除原生 formData 的整表单缓冲，也没有新建并发准入器。** 原始 source chunk 由运行时分配，本检查不承诺其分配前已受控；固定扫描状态也不等于整个请求常数内存或 isolate 峰值低于 128 MB。输入/输出并存、Hono 缓存、原生 File/JSON 序列化及并发工作集仍待处理。

## 2. 新增 91 项测试

| 范围 | 项数 | 实际断言 |
| --- | ---: | --- |
| [Inspector 专项](../../../../packages/proxy/src/services/multipart-body-inspector.test.ts) | 75 | 六种边界、每个两块切分点、重复极小分片、Unicode/二进制/伪 delimiter、固定种子 fuzz；头部/字段/数量精确上限与超限；歧义/未闭合格式；preamble/padding；原生文件分类及字节保真；取消探针与不等待 cancel ACK |
| [公开 Images 路径新增](../../../../packages/proxy/src/routes/v1/image-request-lifecycle.test.ts) | 12 | /v1 与 /api/v1 × 文件数量、文件大小、字段大小、字段总量、头部大小、parts 数量六种资源拒绝；只读取第一块即停止， withheld tail 不读；不进 guardrail/选路、零模型发送与零用量批写 |
| 严格路由 | 2 | 带尾斜杠的 edits 当前返回 404，取消未读上传；没有新增路由支持 |
| 容量保留 | 2 | 三文件实际上传合计含 framing 恰好 50 MiB 可一次发送/一次用量批写；50 MiB+1 为 413、零发送；其中前两文件各为 20 MiB |

两块切分/fuzz 的循环次数不另增测试项数。公开 fixture 使用真实 Hono/auth/planner/driver，但仓储、SQL sink、模型响应为合成材料；成功为零价格，不证明实际资金或卖家收益已验收。没有新增真实 HTTP socket/Workers/托管 DB 测试。

初轮测试纠正：类型检查发现错误分类字面值及同步 inspector 回调需用 Promise 包装，已修复。测试最初把生命周期 allowlist 的尾斜杠误当成实际路由支持，真实返回 404；现在独立断言保留严格路由与未读取消，没有改生产路由来迎合测试。审查 Node 原生解析源码后补入无 CRLF preamble 的第一文件计数，避免检查器和原生解析器对首部分的范围不同。未使用已下载审查的第三方 parser；未新增依赖/锁文件，临时公开 npm 缓存已清理，可重新下载。

## 3. 最终验证与快照

Windows / Node.js v24.14.1；完整回归中的既有 SQLite 测试为本机内存库，非托管数据库。所有以下最终命令退出 0；中间 2,122/2,129 项主 suite 不是最终受测版本。

| 命令 | 最终结果 |
| --- | --- |
| node --import tsx --test：inspector + route image-request-lifecycle + bounded-request-body + request-deadline-dispatch 四文件 | 288 tests / 0 suites；包含原 165 + 6 + 26 项，新增 91 |
| npm.cmd test -w @octafuse/proxy | 完整 pretest 链通过；主 suite 2,131 tests / 135 suites |
| npm.cmd run test:dispatch-safety -w @octafuse/proxy | 1,756 tests / 50 suites |
| npm.cmd run typecheck -w @octafuse/proxy | 退出 0 |
| npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy | 退出 0 |
| npm.cmd run typecheck -w @octafuse/admin | 退出 0 |

最终 tests 均 0 fail/cancelled/skipped。主 suite/安全专项/组合测试计数重叠，不能相加；没有独立重跑 Core 全套或 Admin 业务 suite。新增 inspector 专项进入主 suite、安全专项及其类型检查；远程 CI 没有触发。

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`。轮初 169 个 dirty/untracked 文件，上一轮 151 文件快照零差异。当前仅七个源码/测试配置路径变化，另补 [Image Models 上传限制](../../reference/image-models.md)、本页/新快照/索引/Checklist；其余用户与历史修改保留。[154 文件 SHA-256 快照](./C02-image-multipart-resources-snapshot.json)纳入新 inspector、测试及接口参考文档，保留原 KMS 决定、配置和迁移保护范围。文档写完后执行 diff 空白检查、链接及哈希复核，不覆盖旧快照。

## 4. 未完成项与唯一下步

**下一步仍为 C02.B2.2：消除 Images 原生全量缓存与不必要副本，建立输入/输出工作集及并发准入/释放边界，做真实运行时内存验证。** 本轮只完成其“解析期间资源约束”子集；不要再把这一子集列为完全未实现，也不要把它升级成并发内存已验收。其后继续 HTTP Audio/Admin 完整入口、headers/有效 TTFT/idle、物理数据库超时与确认恢复。

Workers 最佳实践技能要求在原生 materialization 前控制读取、保留取消所有权、不把请求正文放入全局状态。官方 [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 与 [内存限制](https://developers.cloudflare.com/workers/platform/limits/#memory)区分 isolate 总内存和单请求大小；[RFC 2046 §5.1.1](https://www.rfc-editor.org/rfc/rfc2046#section-5.1.1)用于核对 framing。最新 workers-types registry 访问失败，按技能 fallback 检查已安装 5.20260829.1 与 Wrangler schema；没有绑定或配置变化，不生成新 Env。原生 parser 的跨运行时差异及实际 CPU/峰值仍未验收。

继续保留物理 DB 确认/崩溃恢复、Realtime marker 未出站却被 expiry 保守消费预算、Guardrail 零更新计数恢复、共享音频卖家收益、Qwen TTS 格式、全池读取/解密等既有门禁。Google Cloud KMS / project cinatoken 已确认，location/保护级别/身份/IAM 未获本轮新授权；本轮没有云账号、真实 KMS/OAuth/模型、业务库、支付、部署或远程 CI 操作，仅公开文档/公开 npm 检索及本地实现验证。

C02.1–C02.7/C02.G 仍不勾选；C01 与 C03–C20 不升级。未新增生产开关或切流；回退不得移除已验收的字节/次数/取消限制，必要时停止对应新增流量并保留已接纳请求的结算与恢复。
