# C02.B2.2 — Images 入口时限、准备取消与文件复用

日期：2026-09-06。状态：**本页列明子集 LOCAL_PASS；C02 为 DOING；multipart 整体内存门禁未完成**。执行/本地自检：Codex；独立 Reviewer 待指定。接续 [向量入口](./C02-vector-ingress-lifecycle.md)及 [Images 调度/认证](./C02-image-auxiliary-auth.md)，历史证据不覆盖。

## 1. 实际实现

1. [入口生命周期](../../../../packages/proxy/src/middleware/text-request-lifecycle.ts)精确接入 POST Images 根路径、generations、edits，以及 /api/v1 和尾斜杠形式。catalog、Batch、GET 和其他子路径不接入。内部继续沿用 textRequestLifecycle 名称，不新建第二套 owner。
2. [Images 路由](../../../../packages/proxy/src/routes/v1/images.ts)从同一入口 dispatchBudget.createdAtMs 起算时限与定价/预算快照。上传、存储/鉴权耗时从后续 OAuth/driver 的 300 秒本地硬上限扣除；该上限不是获批生产 SLO。
3. 请求源沿用 pull-based 50 MiB 总上限（包括 multipart framing），不再经过 Hono 全局 bodyLimit 的预缓冲分支。JSON/formData 等待可被取消；取消/超时/实际超限保留 499/504/413，非对象 JSON 返回受控 400。已经开始的存储初始化或兼容鉴权仍等待确认后停止，不遗弃其潜在副作用。
4. guardrail、模型/路由/endpoint/policy、定价时区等准备读取使用同一取消边界；定价估算使用固定的 pricingContext。[输入与输出审计](../../../../packages/proxy/src/services/request-guardrails.ts)的摘要计算可停止，已开始的审计写入由 owner 等待确认。
5. [failover](../../../../packages/proxy/src/services/failover-dispatch.ts)新增可选 preparationControl，Images 用它约束共享/BYOK 池及 [sticky](../../../../packages/proxy/src/services/provider-sticky-routing.ts) 的 hash/查询。停止后的 hash 不再触发下一次数据库读；取消不退化成普通 sticky 查询失败后继续路由。sticky GC 和清除 CAS 也登记已开始写入的所有权。文本 deadline 路径仍通过返回的 stickyMutationPromise 将清理移交既有后台 owner；不强制改成 Images 的响应前 drain。
6. preparationControl **不 race Images driver 或替换响应流 owner**。driver 保留自己的 abort reason、unknown 和图片非计费取消规则；SSE 在入口 owner 清理之后仍按原始绝对时限停止，并触发既有结算。没有重写 Ordinary/Guardrail 的资金合同或开放新的收费模式。
7. multipart 解析后直接保留不可变 File/Blob，按 size/type/count 验证；[driver](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)直接将 Blob 放入出站 FormData，不再经过 File.arrayBuffer → Uint8Array → 新 Blob 的两次显式全文件复制。旧字节数组调用方保持兼容。单文件 20 MiB、最多 5 张及公开入口总计 50 MiB 未放宽；driver 的 5×20 MiB 内部参考上限不是公开 API 可上传 100 MiB 的承诺。
8. [新测试](../../../../packages/proxy/src/routes/v1/image-request-lifecycle.test.ts)加入 Proxy 主 suite、安全专项和专项类型检查，现有 CI 入口会收集。无依赖/锁文件、schema、迁移、Core/Admin 业务代码或云配置修改。

这是有界上传和显式复制消除，**不是常数内存流式 multipart 解析器，也不是零拷贝保证**。原生 formData 仍可能缓冲完整请求和大量字段对象，Hono 缓存、运行时序列化、输入/输出并存及并发请求峰值仍待下一子项处理。

## 2. 新增 165 项本地测试

真实 createProxyApp → Hono → auth/guardrail/planner/driver/用量记录；仓储行、SQL sink 和网络响应为合成材料。测试不建立真实 HTTP socket，不证明数据库事务或资金持久性。

| 范围 | 项数 | 实际断言 |
| --- | ---: | --- |
| 精确路径选择 | 1 | 根路径/两个别名/尾斜杠接入，其他方法/子路径不接入 |
| 文件复用与限制 | 10 | 五种既有字段形式；禁用 Blob.arrayBuffer 后仍能转交 5 个原生文件；空文件/类型/第六文件/20 MiB+1 拒绝，恰好 20 MiB 可通过 |
| JSON 输入 | 4 | null、数组、数字和坏 JSON 为 400，不开始 guardrail |
| SSE handoff | 2 | 鉴权已消耗 299,980ms 后，未继续读取的 SSE 也在剩余时限到期，取消源并结算一次 |
| 公开路径 × 上传/正常/剩余时限 | 48 | 六条路径，静默上传的客户端取消/超时、有无声明长度，早期缺 Key 不读源，声明超限在 storage 前拒绝，成功一次发送/一次用量批写，OAuth 不续期 |
| 准备读 | 48 | 两 operation × 两停止原因 × guardrail、Key/Workspace 限额、model/surface/routes/provider/endpoint/policy、pricing、BYOK pool/suppress 十二个等待点；迟到结果不继续 |
| 共享与 sticky 读 | 12 | 共享池、sticky hash/lookup 三处取消；晚到 hash 不再访问 binding |
| sticky 写入所有权 | 8 | GC/clear 已开始时保留确认责任；取消后不新增模型发送 |
| 输入/输出审计 | 16 | hash 停止不写库，已开始 insert 等待确认；图片 output guardrail 继续 fail closed |
| 兼容加密回写 | 4 | 实际 Web Crypto/加密包装层首个 enc:v2 回写等待确认，第二个不启动；数据库确认是合成屏障 |
| storage/auth 确认 | 8 | 取消或到期不能遗弃已开始的初始化/兼容鉴权 |
| 实际超限/监听器清理 | 4 | 实际 50 MiB+1 仍为 413，cancel ACK 永久挂起不阻塞；handoff 清除入口监听器 |

文件测试检查应用层不调用 arrayBuffer 和上游收到的名称/大小/类型，不是原生 parser/serializer 的内存分配计数或 Workers 峰值测量。成功 fixture 为零价，不能据此声称买家资金或卖家收益验收。

初轮失败记录：Images 的 generic planner 不读取第二次时区，fixture 最初虚构了第二个配置等待点，现按真实定价读取验证；Node v24 的懒构造出站 FormData 在鉴权前取消时出现 enqueue-after-close，入口测试改为真实入站字节表示（保留取消断言），不是声称修好了 Undici。手工 wire fixture 的过短 boundary 被本机 parser 拒绝，换为完整 boundary 后恢复。此外，全量复核发现将文本 sticky CAS 改为响应前 drain 会与既有交接合同冲突；已主动中止两条确认等待中的测试进程，恢复文本背景 owner，保留 Images drain，再用 Images 165 项 + 原 deadline-dispatch 26 项（合计 191）确认修复。最终所有场景均执行，无跳过/删取消断言；实际 Node socket/Worker 入口兼容仍待验收。

## 3. 最终验证

Windows / Node.js v24.14.1；完整 Proxy 回归中既有 SQLite 测试使用本机内存库，非托管数据库。Node 22、真实 Workers、托管 D1/PostgreSQL/MySQL 和远程 CI 未运行。

| 命令 | 最终结果 |
| --- | --- |
| `node --import tsx --test packages/proxy/src/routes/v1/image-request-lifecycle.test.ts` | 退出 0；新增 165 tests，0 fail/cancelled/skipped |
| 上述 Images 文件 + `packages/proxy/src/services/request-deadline-dispatch.test.ts` 联合执行 | 退出 0；191 tests，含原 26 项；验证文本 CAS 交接修复 |
| `npm.cmd test -w @octafuse/proxy` | 退出 0；完整 pretest 链通过；主 suite 2,040 tests / 135 suites，0 fail/cancelled/skipped |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 退出 0；1,665 tests / 50 suites，0 fail/cancelled/skipped |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck -w @octafuse/admin` | 退出 0 |
| `git diff --check`、151 文件 SHA-256 复核 | 退出 0；零哈希差异；文档写入后再复核 |

145 项阶段的 2,020/1,645 历史运行不作为最终结果；之后 sticky 追加测试和文本交接修复完成，最终两个完整 suite 均重新运行并正常退出。

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`；本轮开始 165 个 dirty/untracked 文件，上一份 147 文件快照核对零差异。文档写入前只有 9 个源码/测试配置路径相对轮初改变；其余用户/历史修改保留。[151 文件 SHA-256 快照](./C02-image-ingress-lifecycle-snapshot.json)记录最终受测版本，保护文件包括既有 KMS 决定和迁移；不覆盖历史快照。测试计数重叠，不能相加。没有单独执行 Core 全套或 Admin 业务测试。

## 4. 未完成项与下一步

Workers 最佳实践技能促使本轮区分准备读取、已开始写入和图片响应 owner，并移除显式整文件复制。公开依据：[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[内存限制](https://developers.cloudflare.com/workers/platform/limits/#memory)。最新 registry 获取失败，使用技能 fallback 检查已安装 workers-types 5.20260829.1 和 Wrangler schema；绑定未变，未生成或变更配置。

**唯一下一项：C02.B2.2 — Images multipart 解析期间的资源约束与并发内存边界。** 应在读取时限制 header/field/file 数量与字节，消除不必要的原生全量缓存，验证输入/输出缓冲重叠及并发准入/释放；保留已承诺的上传容量与字段兼容，不以悄悄降低单请求上限代替实现。官方内存限制按 isolate 而非单请求计算，当前 50 MiB 计数不能证明安全。随后继续 HTTP Audio/Admin 完整入口、headers/有效 TTFT/idle 和物理数据库确认恢复。

继续保留以下门禁：

- 到期后的写入确认、SQL 物理超时、崩溃/跨进程恢复没有完成。sticky post-response bind/touch、共享失败标记及其他调用链的所有后台副作用仍需全局审计；本页不声明全仓写入均可恢复。
- [Realtime 提交确认丢失](./C02-realtime-fallback-recovery.md)导致零模型出站却被 expiry 保守消费预算、Guardrail 零更新计数恢复缺口未改；unknown 不是确定费用。
- 共享音频卖家按秒收益缺口、Qwen HTTP TTS 格式等 C04/C12/C17/C15 商业门禁未改；全池读取/解密仍留 C07/C09。
- Google Cloud KMS / project cinatoken 决定不变；location/保护级别/身份/IAM 仍待授权与验收。没有真实云账号访问、OAuth/KMS/模型调用、业务库迁移、部署、支付或远程 CI。

C02.1–C02.7/C02.G 不勾选，C01 与 C03–C20 不升级。未通过时限制对应能力的新准入，保留已接纳工作的结算与恢复；不靠删除预算事实、重放模型 POST 或回退明文掩盖失败。本轮未新增生产开关或执行切流。
