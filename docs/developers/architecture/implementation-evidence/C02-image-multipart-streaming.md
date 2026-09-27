# C02.B2.2 — Images multipart 分页存储与流式出站

日期：2026-09-06。状态：**本页分块解析/出站子集 LOCAL_PASS；C02 为 DOING；响应副本、并发内存与真实 Workers 门禁未完成**。执行/本地自检：Codex；独立 Reviewer 待指定。接续 [读取时资源检查](./C02-image-multipart-resources.md)，不覆盖其历史证据或快照。

## 1. 本轮实际交付

公开 `POST /v1/images/edits` 与 `/api/v1/images/edits` 不再将完整上传交给原生 `formData()` 或 Hono bodyCache。保留原始请求体 50 MiB、单文件原始部分 20 MiB、最多五文件及前轮字段/头部/数量限制；不是通过缩小业务容量获得测试通过。

| 阶段 | 当前实现与所有权 |
| --- | --- |
| 入口 | [中间件](../../../../packages/proxy/src/middleware/text-request-lifecycle.ts)保留鉴权优先、入口绝对时限、50 MiB 字节限制及未读上传取消；不再另外实例化 multipart scanner |
| 解析 | [Inspector](../../../../packages/proxy/src/services/multipart-body-inspector.ts)在计量后同步发出借用正文片段；[分页解析器](../../../../packages/proxy/src/services/streaming-multipart-body.ts)立即复制进请求所有的 64 KiB 页，不持有网络大 chunk 或拼成整文件 Blob |
| 元数据 | 原生解析只处理有界头部与七字节合成正文 `BOM + QUJD`，不接触实际文件内容；探测文件名、类型、本运行时的 base64/BOM 语义；等待仍受入口 owner 约束 |
| 普通字段 | 使用有界字段缓冲，保留重复字段、数组字段、Unicode；结果用无原型对象，避免 `__proto__`/`constructor` 改变对象原型 |
| 出站 | [流式编码器](../../../../packages/proxy/src/services/egress/multipart-upload-body.ts)逐页拉取，单次输出不超过 64 KiB；边界、长度、字段换行与文件名转义显式处理，不生成完整出站 FormData 正文 |
| 重试 | [Images driver](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)使用流式正文、手动重定向策略及既有发送预算；明确拒绝后的合法下一候选重新读请求文件页，消费方不能修改保留页；unknown 不新增重放 |
| 收尾 | 编码器在结束/取消/到期/不再需要时释放 reader、监听器及自身引用；[公开路由](../../../../packages/proxy/src/routes/v1/images.ts)在所有终态 `finally` 释放全部已解析文件页，包括未知字段文件；不等待永不确认的 cancel ACK |

`MultipartFile` 是请求级页存储，不是 Blob/File 子类。出站交出最多一页的副本以保护重试原件，已隔离的页不再二次复制；这不是零拷贝。内部仅传 bytes/Blob 的既有 driver 调用者仍走原生 FormData 兼容路径，不声称所有模态或所有内部上传已改造。

文件页当前保留到整个 edits 处理返回，包括响应读取、规范化与结算收尾；因此**上传与输出仍可能同时占用内存**。不能在收到上游 2xx 头部时贸然释放：上传流可能尚未完成，而且是否还能合法重试必须由调度结果共同决定。释放引用不等于物理擦除、即时 GC 或归还 RSS。

## 2. 兼容与资源边界

资源数值与错误口径见 [Image Models](../../reference/image-models.md#multipart-上传资源边界)：文件数/单文件超限保持受控 400；请求体、字段、头部、parts 等资源超限为 413；取消/到期维持既有 499/504。读取期间先按原始编码字节计量，不因 base64 解码缩小而放大允许上传量。

本地差分测试把原生解析器作为元数据/字段/文件内容参考，但不宣称整套语法完全等价。公开 edits 的 framing 现以有界 scanner 为准：分隔行允许的有限 padding、文件中非 delimiter 的相似前缀，以及大小写不敏感的外层媒体类型，可能比旧 Hono/原生组合接受更多形式。缺失闭合分隔、错误边界及前轮限制仍拒绝；尾斜杠仍严格路由 404。未知字段不获得新的业务含义，但其中的文件必须计数和释放。

Node 原生 multipart 会处理部分 Content-Transfer-Encoding；已审查的 workerd 源码行为不同。新解析器仅在本运行时探针证明会解码时启用有界 base64 解码，并按探针处理字段 BOM。特殊 Unicode/base64 组合的首轮断言曾暴露 Node UTF-16 低字节宽松解码语义，现已修正并回归。类型检查曾要求显式提供 TextDecoder `fatal` 选项，已修复。源码审查不替代实际 Workers 验证。

## 3. 新增 56 项测试与最终验证

| 范围 | 新增项数 | 实际断言 |
| --- | ---: | --- |
| [分页解析/出站专项](../../../../packages/proxy/src/services/streaming-multipart-body.test.ts) | 47 | 七种 chunk 宽度的原生差分，重复/数组/原型键，五类文件名，编码及 BOM，宽松 base64，伪 delimiter 字节保真；重用输入缓冲仍保留正确页，消费者修改不污染重试；小型探针不含大正文；部分上传取消/到期/坏尾部及迟到探针清理；流式往返、精确长度、出站取消与 reader/监听器释放 |
| [公开 Images 生命周期](../../../../packages/proxy/src/routes/v1/image-request-lifecycle.test.ts) | 9 | 七种成功/拒绝/unknown/准备取消/发送取消/读取到期终态释放；401 明确拒绝后 200 的两次字节保真发送与一次用量批写；真实 Hono bodyCache 为空且原生调用只见小型探针 |

既有公开满容量测试继续验证原始请求恰好 50 MiB（其中两个文件各 20 MiB）、超限拒绝、别名、文件元数据和发送/结算次数；出站用测试内的独立原生解析器复核序列化正文，实际路由没有回退为原生整表单解析。47 项新专项已加入 Proxy 主 suite、安全专项及安全类型检查。

环境：Windows / Node.js v24.14.1。下表记录真实执行顺序，避免把补测试后的计数嫁接到之前命令。

| 命令 | 结果 |
| --- | --- |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest 链及当时主 suite 2,186 tests / 135 suites 通过，退出 0；随后只补入一项 Hono cache 断言，业务代码未再变化 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 上述补断言前版本 1,811 tests / 50 suites，退出 0 |
| `node --import tsx --test packages/proxy/src/services/streaming-multipart-body.test.ts packages/proxy/src/services/multipart-body-inspector.test.ts packages/proxy/src/routes/v1/image-request-lifecycle.test.ts` | 最终 312 tests / 0 suites：47 新专项 + 75 inspector + 190 公开路由，退出 0 |
| `npm.cmd run test:unit --ignore-scripts -w @octafuse/proxy` | 补最后一项断言后最终主 suite 2,187 tests / 135 suites，退出 0；此命令未重复 pretest |
| `npm.cmd run test:dispatch-safety --ignore-scripts -w @octafuse/proxy` | 最终安全专项 1,812 tests / 50 suites，退出 0；此命令未重复 pretest |
| `npm.cmd run typecheck -w @octafuse/proxy` | 最终退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 最终退出 0 |
| `npm.cmd run typecheck -w @octafuse/admin` | 最终退出 0 |
| `node packages/proxy/scripts/measure-image-upload-memory.mjs` | 两个独立本地 Node 子进程均完成，退出 0；原始结果见下一节 |
| `node packages/proxy/scripts/test-oauth-workerd.mjs --runtime-smoke` | **退出 1**：最小 Worker 启动时 `0xc0000005 / ERR_RUNTIME_FAILURE`，零业务断言；不是 SKIP/PASS，也没有执行本轮 multipart 的实际 Workers 验证 |

成功测试均为 0 fail/cancelled/skipped；主 suite、安全专项、组合测试计数重叠，不能相加。未独立重跑 Core 全套或 Admin 业务 suite；已有本机 SQLite 合同测试不等于托管 DB 验收。公开路由使用合成仓储/模型响应及零价格 SQL sink，不证明实际买家资金、卖家收益或供应商协议已经验收。

本机 workerd 1.20260828.1 / Miniflare 5.20260828.0-alpha 的最小启动失败与 [既有 OAuth runtime 限制](./C02-oauth-lifecycle.md)一致。输出提示 VC++ 运行库相关可能性，但未确认根因；没有自动安装系统组件、反复重跑相同失败或以远程部署替代本地证据。Node 22、真实 Workers 与真实数据库门禁保持开放。

## 4. 50 MiB 上传的本地内存观察

[可复现实验脚本](../../../../packages/proxy/scripts/measure-image-upload-memory.mjs)分别在两个 Node 子进程对原生解析/原生出站与分页解析/流式出站采样；输入为合成三文件，原始请求恰好 52,428,800 字节。文件字节为 20,971,520 / 20,971,520 / 10,485,339，既不使用真实图片/密钥，也不调用网络或业务库。[原始样本](./C02-image-multipart-streaming-memory.json)保留字节值。

| 观察值 | 原生路径 | 分页路径 |
| --- | ---: | ---: |
| 解析完成时 arrayBuffers | 113,371,546 B（约 108.12 MiB） | 60,937,212 B（约 58.11 MiB） |
| 解析相对基线的 arrayBuffers 增量 | 约 100.02 MiB | 约 50.02 MiB |
| 已观察样本中的最大 arrayBuffers | 197,234,997 B（约 188.10 MiB） | 98,931,122 B（约 94.35 MiB） |
| 自有分页存储计数：解析后 → 释放后 | 不适用 | 52,428,800 B → 0 B |

这些是单次实验的离散观察，不是连续峰值或稳定性能保证；未覆盖完整网关、图片响应、跨模态并发、CPU/吞吐、慢消费者及操作系统调度差异。脚本加载模块后的进程 RSS 基线已经较高，不能将 Node RSS 直接与 Workers isolate 限额比较。显式释放并触发 GC 后仍可观察到内存未立即归还，因此只把分页计数归零解释为该对象不再持有页引用。原生样本的 `retainedPageBytes: 0` 是无自定义分页计数，不代表原生零占用。两个序列化器生成边界不同，出站长度差异是预期结果。

## 5. 基线、技能依据与未完成项

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`；轮初 174 个 dirty/untracked 文件，前轮 154 文件快照在本轮开始时零差异。当前修改 11 个源码/测试/脚本/测试配置路径（其中四个新文件），另更新 Image Models、Checklist、证据索引并新增本页/样本/快照。新 [159 文件 SHA-256 快照](./C02-image-multipart-streaming-snapshot.json)在前轮范围上加入四个新实现/测试/脚本文件及原始内存样本；历史证据不覆盖，其他用户改动保持。

收尾只读复核：当前 181 个 dirty/untracked 文件，相对轮初仅十个既有文件变化、七个新文件，无缺失或其他既有文件变化；符合上述实现/文档范围。159 个快照哈希零差异，四份当前文档的 74 个本地链接目标均存在，`git diff --check` 退出 0。快照不包含自身、Checklist、索引或本页，避免自引用哈希；版本化内存样本在快照内。

Workers 最佳实践技能实质影响了实现：没有采用整文件 Blob 拼接作为“零拷贝”，改用请求级页存储、受控拉取与取消所有权。依据官方 [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 和 [内存限制](https://developers.cloudflare.com/workers/platform/limits/#memory)，128 MB 是 isolate 共享限制，不是每个请求独享。还审查了公开 [workerd Blob 实现](https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/api/blob.c%2B%2B) 的多部分复制路径与 [FormData 实现](https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/api/form-data.c%2B%2B) 的编码语义；main 分支源码不是已安装二进制的实测证明。最新 workers-types registry 访问失败，按技能 fallback 检查已安装 5.20260829.1 与 Wrangler schema；没有新 binding/配置或依赖，不生成新 Env。

**唯一下步：继续 C02.B2.2 的 Images JSON 响应重复序列化、输入/输出重叠，以及 isolate 总工作集准入与释放。** `readJsonResponse`、driver 规范化、路由收尾仍可能重复字符串化/构造 Response；大 base64 媒体探测也仍可能产生额外字符串。不以仅给 Images 增加一个计数器就宣称所有模态并发满足限额；不能在上传流还需读取时提早释放输入；不降低原有 20/50 MiB 容量代替治理。补真实运行时/并发内存证据后，才判断本门禁能否升级。

其后继续 HTTP Audio/Admin 完整入口、headers/有效 TTFT/idle、物理数据库超时及确认恢复。保留 Realtime marker 未出站却被 expiry 保守消费预算、Guardrail 零更新计数恢复、共享音频卖家收益、Qwen TTS 格式与全池读取/解密等既有缺口；对应 C04/C05/C12/C15/C17 与 C07/C09 门禁不变。

Google Cloud KMS / project `cinatoken` 已确认，本轮未修改该决定，也未新增 location/保护级别/服务身份/IAM 授权。没有访问云账号、真实 KMS/OAuth/模型、业务库、支付、远程 CI 或部署；没有安装系统组件。C02.1–C02.7/C02.G 均不勾选，C01 与 C03–C20 不升级。未新增生产开关或切流；出现回归时停止相关新增流量并保留已接纳请求的结算/恢复，不通过移除已有字节、次数或取消限制回退。
