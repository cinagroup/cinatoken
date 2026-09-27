# C02.B2.2：真实 Workers 大包转发与交付子集

2026-09-07。**本批 10/10 项检查通过：6 个 Images 请求与 4 项 Access / 健康 / 鉴权目录检查。** 补上实际转发的大 JSON 和完整 50 MiB multipart 输入 / 大响应组合，仍是串行合成子集。**C02.G 未通过，生产容量池未启用。** 首轮累计 US$2 不重置。

## 1. 环境与验证方法

- Gateway 保持版本 `61a59281-5b1e-47ec-9b34-7f30a3a75d92`，本批没有重新发布 Gateway 或生产。
- 仅更新关闭入口的 `cinatoken-staging-images-upstream`：版本 `e705ae7c-53f3-4a65-bce9-5c1766bb749d`，部署 `bb9879e2-2f22-49e4-870b-8d1514159d93`，02:18:21 UTC，100%。它无公网 / 预览、路由、Cron 或数据绑定，CPU 配置仍为 1,000 ms；没有外网、付费模型或 KMS 调用。
- 仍使用独立 D1 `cinatoken-staging` / `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`，没有生产数据或秘密副本。完整编排 02:20:01–02:24:07 UTC，HTTP 检查 02:20:52–02:22:36 UTC。
- [脱敏结果、部署、预检与源码摘要](./C02-staging-image-large-results.json) 保留完整检查结果和收尾证据；[上一批证据](./C02-staging-image-chain.md) 的源码散列是历史快照，不改写为本批版本。

[私有模拟上游](../../../../packages/proxy/scripts/staging/images-upstream.ts) 在增量读取请求时计算 SHA-256，返回有界 request-id 回执；multipart 仅额外返回已知格式的非秘密 boundary。回执经真实驱动进入 D1，由客户端 `X-Generation-Id` 唯一关联。这里使用 [Workers 支持的 Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)，没有为计算散列缓存完整正文，也不回显任意请求头。

[独立 wire 生成与预期工具](../../../../scripts/deploy/staging-image-large-wire.mjs) 使用最大 64 KiB 块，不依赖业务序列化器计算预期值。JSON 使用确实转发的 `image` 字段；multipart 使用三份不同填充值的文件，依据回执中的实际随机 boundary 重建完整预期。检查的不只是 Content-Length，而是**上游完整实收字节数和 SHA-256**。完整响应也逐块散列；取消用例只记录已读取前缀，不冒充完整响应散列。

## 2. 通过结果

字节数包含各自 JSON / multipart 封装，MiB = 1,048,576 字节。

| 用例 | 客户端入站字节 | 上游实收字节，散列匹配 | 客户端结果 |
| --- | ---: | ---: | --- |
| 参考图小包基线 | 4,096 | 4,049 | 200；1,082 字节，完整响应散列匹配 |
| 50 MiB 参考图 JSON + 32 MiB 上游响应 | 52,428,800 | 52,428,753 | 200；33,554,490 字节，完整散列匹配 |
| 50 MiB 参考图 JSON + 32 MiB 替换膨胀响应 | 52,428,800 | 52,428,747 | 200；100,663,176 字节，完整散列匹配 |
| 完整 50 MiB、三文件 multipart + 32 MiB 上游响应 | 52,428,800 | 52,429,046 | 200；33,554,490 字节，完整散列匹配 |
| 客户端分段暂停读取 32 MiB 响应 | 4,096 | 4,049 | 200；32 次各 200 ms 暂停，完整字节 / 散列匹配 |
| 读取响应 1 MiB 后取消 | 4,096 | 4,049 | 200 头部已到达，读取 1,048,576 字节后取消 body；D1 仍记录上游成功 |

JSON 上游字节数略少，是公开 model 被替换为 `private-model` 等规范化结果，不是参考图被丢弃。multipart 三个文件分别为 20,971,520 / 20,971,520 / 10,485,168 字节；总请求恰好 50 MiB，重新封装后增加 246 字节。没有降低公开的 50 / 20 / 32 MiB 合同。

另外四项均通过：无 Access 凭据在测试前后各返回 401；获准身份健康检查 200；哈希 Gateway Key 读取 `models?kind=image` 返回本轮六个合成模型。无重定向跟随，没有绕过 Access 的测试地址。本批没有失败重试；首次受限环境中的只读网络预检 fetch 失败，没有云端写入，随后获准联网的预检通过。

## 3. 账务、慢读与取消的边界

本批 [fixture](../../../../scripts/deploy/staging-image-success-fixture.mjs) 显式启用 limit-edits，创建 31 条合成种子记录、六个模型、四个 provider。默认 fixture 仍为 27 条 / 五模型，旧用例不变。

- 六条真实 D1 用量日志与六条 provider-attempt 到达；每条一次上游尝试，output_image_count=1，参考图 input_image_count=1、multipart=3。
- charged / metered / standard / budget_charged_micros 全为零；用户预算、已花费、预留也为零。不构成充值、付费扣减或卖家结算验收。
- request_body / upstream_request_body 均为 NULL；raw_usage 为 94 字符，pricing_audit 为 2,889–3,015 字符，没有把 50 MiB 参考图写入账务审计。
- 实际使用的三个 provider marker 经真实仓库升级为 `enc:v2:`；未使用的 over provider 不要求触发读取升级。不是 Google KMS / Credential Vault 集成证明。

慢读只证明客户端按指定暂停读取后仍能完整接收；没有观测 host 反压、isolate 峰值或同实例复用。取消发生在普通 JSON 上游已读取 / 解析、客户端已收到头部之后，因此上游成功记录与一次调用并不矛盾。**它不证明在途上游取消传播、供应商停止生成、取消后的付费退款或容量 lease 释放。** 当前 Gateway 未注入容量池；后台记录到达也不是延迟提交 / 确认丢失恢复验收。

本轮 reference 是合成 data URL 字符串，文件只是带 PNG MIME 的合成字节，响应图片字段为 `AQID`，大响应工作集主要在 metadata。没有真实图片解码、可渲染图像、真实大 Base64 图片工作集或模型质量证明。单次串行成功不是全负载、混合并发或整个实例内存安全；客户端耗时包含网络与上传 / 下载，不能作为 CPU 或发行 SLO。

## 4. 本地回归与收尾

新增四项本地测试（wire 工具三项、真实 SQL 完整大包链路一项）。专项 **18/18**、调度安全 **2,678/2,678** 通过；Proxy、dispatch-safety、staging 三套类型检查通过；模拟上游 dry-run 通过。测试使用真实 SQLite 迁移 / 仓库、真实鉴权 / 选路 / 驱动 / 零价记账，不用仓库 mock；本地全局外网 fetch 被禁止。它们是 Node 24.14.1 回归，不代替上述真实 Workers 结果。Wrangler 4.127.1，未升级依赖；日志路径改到工作区后 dry-run 无权限警告。

最终验证：Gateway 公网 / 预览关闭；Access Token 禁用、解除策略引用并删除，恢复 deny-all；Key 撤销。等待后台窗口后按本轮精确 ID / ownership 清理 31 条种子及关联测试记录，52 张非内部表计数恢复、外键无违规、quick_check=ok。合成数据可由 fixture 重建；正常运维日志与 D1 历史恢复数据保留。私有模拟上游仍关闭且版本不变；生产 Proxy / Admin / Chain 设置指纹及 Gateway 版本与测试前一致。

## 5. 费用与下一步

本批 10 次 HTTP，累计已记录测试尝试 **61 次**，不是账号总请求或账单请求数。客户端合成上传共 157,298,688 字节。本批编排 D1 API 1,889 行读 / 171 行写，另两次成功预检各 82 行读 / 0 写；这些数字不含 Worker 内部查询与 Wrangler 内部请求。付费模型 / KMS 调用仍为 0，没有套餐升级或充值，最终 Cloudflare 增量账单未核验，不报告实际 US$0 或完整剩余 US$2。

继续唯一工作包 **C02.B2.2**，有限顺序为：

1. 慢上传、上游请求 / 响应仍在途时的取消、超时和恢复探针；区分客户端停止读取与服务端实际终止。
2. 后台延迟、提交确认丢失、平台取消 / 重启后的持久化恢复，禁止重复推理补账。
3. 完整图像工作集、同配置重复测量、并发及混合消费者，覆盖 host / DB / GC 余量。
4. 结合 C01.9 / C01.10 冻结的发行配置计算容量，满足门禁后再讨论启用；OAuth/KMS / 真实模型另做专用身份的小样本。

没有把本次样本升级为 C02.G、真实付费结算、KMS 或生产发布验收。
