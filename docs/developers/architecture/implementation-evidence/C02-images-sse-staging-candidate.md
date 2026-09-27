# C02 — Images SSE 独立 staging 候选

2026-09-08；Checklist v1.85。状态：LOCAL_PASS，本地候选已冻结，尚未部署；C02.B2.2 / C02.G 保持开放。

## 实现与范围

新增 `images-sse-gateway.ts` 和 `images-sse-upstream.ts` 两个 staging 入口。网关复用同一个 Worker handler、Images 路由及生产 driver，没有改动生产源码、金额政策、实际请求 deadline 或普通响应恢复算法；普通响应沿用 30 秒 settlement lease，不加载旧 staging 的存储故障 facade。

网关仅允许私有 origin 上的既有 Images 路径与新增 `/sse/v1/images/generations`，只允许 POST/manual redirect；不回退到公网 fetch。上游入口对既有普通 Images 路径直接委托原处理器，不克隆或提前读取其大请求体。新 SSE 路径仅接受固定 JSON、非秘密 fixture marker、精确 Content-Length，实际读取最多 4 KiB、上传读取期限固定 10 秒。

`c02-sse:<runId>:<probeId>:<mode>` 必须匹配独立 D1 中精确 owner、value 和 armed 状态。每次最多三次 CAS 记录 started / body-prefix / terminal；已使用、未授权、错 owner 或中途改写的探针拒绝，不覆盖其它配置。初始响应 Promise 和终态写入均有明确的 waitUntil 所有者；单次终止清理计时器和 abort listener。

`body-prefix` CAS 在尝试 enqueue **之前**完成。因此它只证明处理进度，不证明字节已经排入，更不能证明买家收妥。terminal 同样不是账务提交或客户端确认的替代物。

| 固定模式 | 合成上游行为 | 本地网关/账务预期 |
| --- | --- | --- |
| success | 小图片、权威 usage、DONE | 成功日志，合成用户扣 0.1 USD |
| provider-error | 图片输出前明确拒绝 | 单个错误与 DONE；省略 outcome_unknown，retry_safe=false；零名义费/预算消费 |
| partial-provider-error | partial 后明确拒绝 | outcome_unknown=true；零名义费/预算消费 |
| invalid-json / early-eof | 错误 JSON / 缺失 DONE | outcome_unknown=true；零名义费/预算消费 |
| usage-limit / property-limit | usage 超 64 KiB / 属性名 257 字符 | 零名义费，保守消费 100000 micros 预留 |
| hold | partial 后保持，固定 315 秒封顶 | 用于取消及真实五分钟 deadline 验收，不允许客户端自定时长 |

上述 0.1 USD 是隔离测试用户的**合成定价与账本断言**，不是支付、真实模型或 KMS 花费。所有响应 fixture 小于 67,000 字节；不需要真实模型密钥。SSE provider 独立于原普通 Images provider，种子重算对应 route fingerprint，清理包含新 provider，避免破坏既有 edits 路由。

## 本地验证与边界

新增 32 项探针专项与 9 项完整 staging 网关 → 私有上游 → 本地 SQLite 测试，41/41 通过。覆盖所有固定模式、重放/所有权、超限与谎报长度、上传停滞、取消早于读取/竞争 D1 acknowledgement、错误元数据防伪、一次出站/日志、金额与预算释放，以及精确清理。

网关 reader 取消首先中止上游请求，因此完整链的探针记录 request_abort；直接取消上游 reader 的专项仍分别记录 response_cancel。取消来源和终态原因不能混为一谈。公开错误中的 request_id 必须等于网关生成 ID，供应商和客户端伪造值不透传。

开发中保留三类失败事实：初始 TextDecoder options 缺少类型要求的 ignoreBOM，显式补 false；9 项集成初测因合成加密配置短于既有 32 字符要求返回 500，修正测试配置；之后 1 项取消 oracle 把完整链预期写成 response_cancel，核对 driver 的 abort-before-cancel 顺序后改为 request_abort。没有为使测试通过而改动生产运行时。

最终完整版本化 staging 本地链 **795/795**（既有 754 + 新增 41）、另行 driver / 生命周期 / 错误物化回归 **508/508** 通过，完整 Proxy 与 staging 类型检查退出码均为 0。所有最终测试组失败/取消/跳过均为零。

[机器结果](./C02-images-sse-staging-candidate-results.json)记录 147 个源码/配置、211 个操作 artifact 和 17 个历史证据依赖，共 375 项主清单摘要；旧 v1.84 的 334 项全部按当前字节核验，未修改既有锁定源码。另记录两个 bundle 的 779 个去重输入摘要，供部署前复核。source map 中 407 个网关、6 个上游可对应的本地文件与当前源码文本一致；183 个第三方原始 TS 来源未随依赖发布，不能当作本地可读文件，其实际编译输入另以 metafile 路径锁定。输入摘要冻结不等于独立生产签核。

本地 deadline 测试注入受信停止信号，探针 expiry 使用 mock clock；这不是实际 Workers 五分钟计时、网络取消、远端 D1 或物理内存验收。SSE intent / settlement snapshot / recovery job 数量显式断言为零，尚未接入普通响应耐久恢复，也没有解决成功 DONE 与旧结算边界之间的所有问题。

## 离线候选

依据 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)采用有界流、服务绑定和明确 Promise 所有权。当前查询的 Workers 类型版本为 5.20260908.1；未升级项目依赖。Wrangler 4.127.1 已分别生成并检查两份候选绑定类型，与既有生成的接口主体一致；两次 [dry-run](https://developers.cloudflare.com/workers/wrangler/commands/workers/)和 staging 类型检查通过，禁用自动创建资源与自动配置。

候选位于 `.wrangler/staging/images-sse-v185/`，gateway.jsonc / upstream.jsonc、生成类型、bundle、source map、metafile 和日志均保留。两份配置设置 CPU 1000 ms，关闭 workers.dev、预览、路由与 cron；仅绑定已核验的 staging D1 `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`，上游不绑定真实模型或 KMS。CPU 限制不是美元硬停开关。

准备记录：`.wrangler/staging/images-sse-v185-prepare-result.json`；完整回归记录：`.wrangler/staging/images-sse-v185-verification.json`。这些版本化操作脚本拒绝覆盖已有候选/结果；不要直接重跑覆盖历史证据，先核查现有结果，确需重建时使用新版本输出路径。

## 云端状态与唯一下一顺序

前一轮 19 项只读检查均返回 200：四个 staging Worker 的 D1/服务绑定保持隔离，workers.dev / preview / custom domains / cron 均关闭，两项 Access 为 denyEveryone。默认沙箱 EACCES 与获批后成功的检查分别留档；这是读取权限与状态证明，不是写权限验证。

本轮未部署、未迁移、未写云端资源，未调用真实模型或 KMS。最近远端功能证据仍为 v1.77；累计公开测试 HTTP **263**，模型/KMS **0**；首轮累计新增 **US$2** 上限不重置，最终增量云账单尚未核验。

下一顺序为：

1. 验证冻结源码/配置/bundle 摘要；重新核对云端部署、隔离、D1 schema/空探针/无在途任务、Access、实际费用与本轮保守预算。不能从旧基线或共享免费额度推定当前余量。
2. 仅发布两份 staging 候选，保持入口关闭；核对实际上传版本与绑定。不要重新执行已应用的 ALTER，不修改生产或独立恢复消费者/控制器。
3. 准备唯一 runId 的合成种子和单次探针，使用受保护的短时测试入口，逐例验证原始 SSE wire、取消、实际五分钟 deadline，以及独立查询的 D1 日志、金额、预算与上游终态；限定请求数量和清理余量。超时结果不明时先对账，不重放推理。
4. 关闭入口、撤销临时身份、恢复 deny-all；确认无在途执行后按精确 owner 清理测试数据，复核原 schema、资源绑定及生产指纹。

以上云端步骤尚未执行。C02 的 SSE 耐久恢复、完整并发/物理容量、其它模态/host 及后续平台工作包仍未完成，不能据本地候选关闭整体门禁。
