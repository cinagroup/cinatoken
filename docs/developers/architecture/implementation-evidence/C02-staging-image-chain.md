# C02.B2.2：真实 Workers Images 私有上游链路

2026-09-07。**最后一批 11 项检查通过：7 项 Images 请求与 4 项 Access / 健康 / 鉴权目录检查。** 本阶段四次尝试合计 20 次 HTTP；保留三个失败尝试及完整收尾记录。沿用首轮累计 US$2，不是新增预算。这里是独立 staging 的串行合成链路子集，**C02.G 未通过，生产容量池仍关闭**。

## 1. 环境、代码和证据

- Gateway：`cinatoken-proxy-staging`，版本 `61a59281-5b1e-47ec-9b34-7f30a3a75d92`，部署 `b89ec149-0715-449d-9f93-efef73545d1e`，100%。
- 私有上游：新建 `cinatoken-staging-images-upstream`，版本 `1a31fd9c-0a63-4b06-8b98-9ce8f07471cb`，部署 `10a6c21b-a952-448a-b811-d3c58e0d9589`。没有公网 / 预览 URL、路由、Cron 或存储绑定；不发起外网、模型或 KMS 请求。
- D1：原独立 `cinatoken-staging` / `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`，68 份迁移，不复用生产数据或密钥。
- 成功尝试：01:52:50–01:55:48 UTC；HTTP 检查为 01:53:35–01:54:36 UTC。
- [脱敏结果与源码摘要](./C02-staging-image-chain-results.json) 包含四次尝试、两次部署、请求字节 / SHA-256、D1 用量日志、表计数、令牌回收及生产设置前后指纹；不包含 Access Client Secret、Gateway Key 明文、供应商密文或完整正文。忽略目录中的编排脚本是单次工具，不是通用云端 CI runner。

[staging 专用入口](../../../../packages/proxy/scripts/staging/images-gateway.ts) 通过 [共同 handler 工厂](../../../../packages/proxy/src/runtime/worker-handler.ts) 复用完整应用、维护模式、鉴权、真实加密仓库、规划 / 驱动 / 记账及 scheduled / queue 实现；只显式注入 Images HTTP 传输。它不是上一批 `src/index.ts` 的同一个发布包，也不是简化网关。普通生产入口仍采用缺省原生 fetch，且未部署生产。没有 monkeypatch 全局 fetch，没有让请求正文选择传输，也没有注入容量池。

私有传输只接受固定 `.invalid` origin、规定 case / Images 路径、POST 和手动重定向模式。[模拟上游](../../../../packages/proxy/scripts/staging/images-upstream.ts) 按需产生最大 64 KiB 的块，并逐块统计请求体、核对出站 Content-Length；其非秘密 marker 只用于 fixture 断言，不是认证机制。实际访问能力来自私有 service binding。该接入遵循 [Cloudflare Worker 间调用建议](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#use-service-bindings-for-worker-to-worker-communication)。

## 2. 通过结果及边界

成功响应检查状态、完整接收字节数和 SHA-256；客户端逐块散列，不把近 96 MiB 响应拼成全文。超限响应检查 502 和 JSON error。模型 / 上游均为合成数据，不是真实图像推理质量测试。

| 用例 | 实际结果 | 证明范围 |
| --- | --- | --- |
| 无 Access 凭据，测试前后 | 各 401 | 所测入口拒绝未授权请求 |
| 有效 Access 健康检查、哈希 Key 的 `models?kind=image` | 各 200，目录 5 个合成模型 | 真实 Worker / D1 鉴权与图片目录 |
| 小包 generations / edits | 各 200，1,082 字节，SHA-256 相同且符合预期 | 完整普通生成 / 编辑合成成功链路 |
| 上游普通 JSON 恰好 32 MiB | 200，客户端 33,554,490 字节 | 保留 32 MiB 上游合同；规范化 usage 增加 58 字节 |
| 上游 JSON 32 MiB + 1 字节 | 502，`upstream.server_error` | 超限不作为成功图片返回；不证明多候选禁止重放 |
| 上游 32 MiB、长 metadata 内含无效 UTF-8 字节 | 200，客户端 **100,663,176 字节**，SHA-256 符合替换解码结果 | 接近三倍输出扩张的串行成功交付，不是内存峰值测量 |
| JSON 入站恰好 50 MiB | 200，客户端 1,082 字节 | 大包入站后可成功处理；**不是 50 MiB JSON 出站** |
| multipart 单文件恰好 20 MiB | 200；入站 20,971,897 字节，上游实收 20,972,067 字节 | 文件经真实解析、重新封装和私有传输完整到达上游 |

JSON 大值是 `padding`，现有显式字段转发规则将其丢弃。该用例的上游 request-id 为 `c02-small-61`，证明实收只有 61 字节；没有把它误计为大 JSON 序列化出站。后续还需使用实际转发的 reference image 等字段，以及组合最大输入 / 输出。multipart 文件仅是标注 PNG MIME 的合成字节，响应的 `AQID` 也不是可渲染图片；大响应主体是 metadata，不是完整真实 Base64 图像工作集。

成功尝试客户端共生成 73,401,579 字节。所列 3.44 / 13.81 / 22.80 / 9.16 秒左右耗时分别对应 32 MiB 响应、替换膨胀、50 MiB 入站、20 MiB 文件，包含网络 / 上传 / 下载及执行，不能作为 CPU、内存上界、TTFT 或发行 SLO。各请求可能落在不同 isolate；没有慢读、并发或同实例恢复证明。

## 3. D1 和后台工作

[合成 fixture](../../../../scripts/deploy/staging-image-success-fixture.mjs) 每次创建 27 条受控记录：用户 / Workspace / Key 共 3 条、4 个 provider、5 个 model、5 个 route、5 个 endpoint 和 5 条 subject-fingerprint 绑定。endpoint 明确标为合成 standard，价格为零；这不验收管理端证据审批流程。

- Gateway Key 仅在进程内存保留明文，D1 使用 hashref / SHA-256，用户预算和 Key limit 都为 0。
- 使用非秘密供应商 marker，不取回 staging 加密密钥。真实仓库读取路径将 4 个 marker 升级为 `enc:v2:`，仅查询前缀确认；不是 Google KMS / Credential Vault 集成验收。
- 7 个 Images 请求均产生实际 D1 请求日志和各 1 条 provider-attempt 记录，6 success / 1 error；成功记录 output_image_count=1，超限错误为 0。
- `charged_cost`、`metered_cost`、`standard_cost`、`budget_charged_micros` 全为 0；合成用户已花费和预留均为 0。没有买家充值、付费扣减、卖家收益或真实资金验证。
- `request_body` / `upstream_request_body` 均为 NULL。成功 raw_usage 为 94 字符，所测 pricing_audit 为 689–3,015 字符，没有把大 metadata 写入账务日志。

这是后台任务**最终落入真实 D1**的证据，不是刻意延迟提交确认后的 lease 保持、平台终止恢复、付费 unknown 对账或可靠队列证据。原厂 handler 没有启用容量池，因此不能把零余额或日志到达视为容量归还验收。

额外观察：上游 200 的超限响应最终对客户端为 502，但对应 provider-attempt 仍为 `available / accepted / 200`。它记录到上游 HTTP 接受，不等同于最终可交付成功率。后续 C07 健康与观测验收必须区分二者；本轮没有修改健康策略，也没有据此判定上游可用性门禁通过。

## 4. 失败尝试、本地验证和收尾

前三次均停止后完整清理，再人工审阅原因后重试，未无限重放业务请求：

1. 首次无凭据响应为 302，未达到 401/403 门槛，未发送 Images。后续增加控制面 `service_auth_401_redirect=true` 回读断言，并对 302/404 做有界就绪等待；它们仍不是保护通过。单次观察不足以确定 302 的根因。
2. 默认 `/v1/models` 正常过滤图片模型；修正测试为 `?kind=image`，未修改目录接口。
3. 合成 endpoint 缺少 standard 分类，被默认选路正常拒绝 400；补正 fixture 并增加真实仓库 / SQLite 完整链路回归，未放宽业务规则。

本地验证：调度安全 **2,678/2,678**；专项 **14/14**（含既有维护模式检查，不是声称新增 14 项）。三套类型检查通过：Proxy、dispatch-safety、staging scripts。两个 Worker dry-run 通过。Wrangler 4.127.1、Node 24.14.1；已取回并核对最新 Workers 类型 5.20260906.1，项目仍用 5.20260829.1，未升级依赖。[专项测试脚本](../../../../packages/proxy/package.json) 和 CI 已加入此子集；CI 云端实际执行未在本轮验收。

所有尝试收尾均验证：Gateway 公网 / 预览关闭；短期 Access Token 禁用、解除策略引用并删除，应用恢复 deny-all；撤销 Key，有 Images 请求时等待后台期限，再按本轮 ID / ownership 精确清理；52 张非内部表计数恢复、外键无违规、`quick_check=ok`。生产 Proxy / Admin / Chain 远端设置指纹与测试前一致。保留两个关闭入口的 staging Worker、空业务 D1 和原 staging 专用加密密钥，不删除正常运维日志或 D1 历史恢复数据。

## 5. 费用与下一门禁

本阶段 20 次 HTTP，加此前已记录 31 次，累计 **51 次测试尝试**，不是账号总请求或账单请求数。本阶段四份编排合计 D1 API 5,915 行读、560 行写，含清理 / 索引影响；不包括 Worker 内部查询、部署及额外只读诊断。仍为首轮累计 **US$2**，付费模型 / KMS 调用为 0；没有套餐升级或充值，最终 Cloudflare 增量账单未核验，不报告“实际 US$0”或“完整剩余 US$2”。按限次 / 并发 1 管控，并留有收尾余量；[Workers](https://developers.cloudflare.com/workers/platform/pricing/) 和 [D1](https://developers.cloudflare.com/d1/platform/pricing/) 的含量不能当作已经核验的剩余额度。

下一步保持 **C02.B2.2**：实际转发的大 JSON / 最大 multipart 组合、慢上传 / 慢读与客户端取消、后台延迟 / 提交确认丢失、完整工作集和并发 / 混合消费者；另补 OAuth/KMS 专用身份及真实服务小样本。只能依据选定运行配置和测量余量计算容量，再讨论启用。**不以本次串行合成成功替代整个实例容量、故障恢复或真实付费结算门禁。**
