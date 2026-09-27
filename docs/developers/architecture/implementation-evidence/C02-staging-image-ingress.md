# C02.B2.2：真实 Workers Images 入站边界

2026-09-07。**21 项检查通过，含入口就绪时一次 404 共 22 次 HTTP 请求。** 沿用同一独立 staging、同一 Worker 版本和首轮累计 US$2 授权；没有重新部署或修改业务代码。这里仅验收 Images 入站子集，C02.G 仍未通过，生产容量池不启用。

## 1. 环境与证据

- Worker：`cinatoken-proxy-staging`，版本 `eaff1578-8e3c-43a7-bb25-67d282a87675`，100% 部署；入口为真实 `packages/proxy/src/index.ts`。
- D1：`cinatoken-staging` / `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`，沿用 68 份迁移后的空业务库。
- 通过批次：01:08:53–01:12:09 UTC；HTTP 请求发生在 01:09:19–01:11:39 UTC。
- [脱敏结果](./C02-staging-image-ingress-results.json) 包含两次纯预检失败、全部请求结果、版本、表计数与生产设置摘要。不包含 Access Client Secret、Gateway Key 明文或请求正文。
- [合成数据及流式输入生成器](../../../../scripts/deploy/staging-image-ingress-fixture.mjs) 与 [本地测试](../../../../scripts/deploy/staging-image-ingress-fixture.test.mjs) 已加入仓库文件；临时云端编排脚本摘要为 `b0d3e7f3a2cd2f08c9cf36415076ed38f8ec049d6aaa90f9a5eaa178c483ef7a`。编排脚本是忽略目录中的单次工具，不是已交付的通用 CI runner。

只插入本次随机 ID 的 user、personal workspace、Gateway Key 三条记录。Key 明文仅在本地进程内存中使用，D1 存 `sha256:` 查找哈希及 `hashref:` 占位，预览不含真实片段。用户预算和 Key limit 均为 **0**，Key 设置一小时有效期并在结束时显式撤销、删除；不依赖到期代替回收。

未创建 model、provider、route 或上游凭据。因此合法输入的预期结果是 **404 + `gateway.model_not_found`**：表示完成入站解析后进入模型查找，而非图片推理成功。模拟上游尚未接入；按 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#use-service-bindings-for-worker-to-worker-communication)，后续独立测试 Worker 应优先通过私有 service binding 连接，不直接复用未核验的旧 mock Worker。

## 2. 真实边界结果

所有 Images 错误均检查 JSON error 存在及实际的 `X-OctaFuse-Error-Code`，修正了前轮探针读取错误头名称的问题。未据此宣称完整 OpenRouter 错误协议通过。

| 输入 / 条件 | 结果 | 证明范围 |
| --- | --- | --- |
| 有效 Access + D1 哈希 Gateway Key，`GET /v1/models` | 200，空列表 | 真实 Key 鉴权与目录读库 |
| 小合法 JSON；`model` 256 字符；属性名 256 字符 | 各 404 / `gateway.model_not_found` | 对应边界可通过入站检查 |
| `model` 257 字符，`size` 65 字符 | 各 400 / `gateway.invalid_request` | 限额及具体错误消息生效 |
| 属性名 257 字符 | 413 / `gateway.payload_too_large` | 属性名预算生效 |
| `provider` 紧凑 JSON 为 16,385 字节 | 400 / `gateway.invalid_request` | 16 KiB 原生控制值上限生效 |
| `/v1/images`、`/api/v1/images/generations` 的 model 超限 | 各 400 / `gateway.invalid_request` | 所测别名没有绕过控制上限 |
| JSON 总请求恰好 52,428,800 字节（50 MiB） | 404 / `gateway.model_not_found` | 完整大包可解析至模型查找 |
| JSON 总请求 50 MiB + 1，客户端未声明 Content-Length | 413 / `gateway.payload_too_large` | 所测流式发送方式下总包超限拒绝 |
| JSON 总请求 50 MiB + 1，客户端声明 Content-Length | 413 / `gateway.payload_too_large` | 声明长度超限结果正确 |
| multipart 单文件恰好 20 MiB | 404 / `gateway.model_not_found` | 文件边界可进入模型查找 |
| multipart 单文件 20 MiB + 1 | **400** / `gateway.invalid_request` | 保留既有单文件错误合同，非 413 |
| multipart 总请求恰好 50 MiB（含字段/边界开销，三个文件均 ≤20 MiB） | 404 / `gateway.model_not_found` | 总包与文件边界组合可解析 |
| multipart 总请求 50 MiB + 1，客户端未声明 Content-Length | 413 / `gateway.payload_too_large` | 总包上限生效 |
| 大包测试后再发小合法 JSON | 404 / `gateway.model_not_found` | 服务仍可响应；不证明同 isolate 恢复 |

另外：无 Access 凭据在测试前后均返回 401；有效 Access 健康检查为 200。最初一次就绪请求为 404，等待 5 秒后的下一次为 401，之后才发送有效凭据。仅就绪 404 有有界重试，Images 业务请求未重试。共 17 项 Images 请求 + 4 项保护/健康/鉴权检查通过，另保留 1 次就绪 404。

客户端按最多 64 KiB 分块生成大包，共生成 **304,106,390 字节**；没有本地整包文件。JSON 大值放在合成 padding 字段，multipart 是标注 PNG MIME 的合成字节，不是已解码/渲染的真实图像。客户端未声明 Content-Length 不代表 Cloudflare 内部也保留 chunked；没有观测边缘缓冲或 Worker 实际消费字节，不能据此断言网络层提前拒绝或零上传。三项恰好上限请求的客户端总耗时约 17.85 / 10.22 / 29.19 秒，包含上传、网络和执行，**不是 CPU 时间、SLO 或内存测量**。

## 3. 预检修正与本地验证

前两次均停在 D1 只读表计数预检，未创建数据、令牌或开放入口，HTTP 测试请求为 0。D1 对 52 项及 10 项 `UNION ALL` 均返回 `too many terms in compound SELECT`；本机 SQLite 的默认行为不能替代远端。随后先只读验证单个 SELECT 内的标量计数子查询，再继续第三次尝试，成功取得全部 52 张非内部表的计数。未修改迁移、数据库 schema 或应用来适配测试。

本地执行 `node --test scripts/deploy/staging-image-ingress-fixture.test.mjs scripts/deploy/prepare-proxy-staging.test.mjs scripts/deploy/staging-d1-bootstrap.test.mjs`：**7/7 通过，其中新增 2 项**。覆盖完整历史迁移下的合成数据、只存哈希/零额度、精确清理不影响另一组数据、清理幂等、大包生成字节数及有界分块；未重跑完整业务 suite，未把本地 SQLite 当作 Workers 性能证据。

## 4. 收尾、费用和剩余门禁

- `workers.dev enabled=false`、`previews_enabled=false`；Access 恢复 deny-all。
- 临时令牌 `5ea0d36a-7f90-4954-9527-09a93f9dbccf` 先禁用、解除策略引用，再删除，列表验证不存在。
- 合成 Key 撤销后，精确删除本次 Key、Workspace、User。全部 52 张表计数恢复到前值，外键检查无违规，`quick_check=ok`；测试结束前合成账户已消费及预留均为 0，未出现推理请求日志、账务预留或供应商记录。正常运维日志和 D1 历史恢复数据不属于本次精确删除范围。
- 生产 Proxy/Admin/Chain 完整设置响应摘要与执行前一致，修改时间仍为 2026-09-05 的既有值；staging 部署版本不变。关闭入口会更新 staging 元数据修改时间，不代表重新发布业务版本。
- 本次 Images 阶段记录 22 次 HTTP，前轮基础冒烟记录 9 次，两个已记录阶段共 **31 次**；这是测试记录，不是账号总请求量或账单。最后一次编排记录 D1 API 1,694 行读、29 行写（含索引影响），不包含 Worker 内查询及额外只读诊断。
- 继续沿用首轮累计 **US$2**，没有追加预算、套餐升级或充值。付费模型/KMS 调用均为 0；最终 Cloudflare 增量账单尚未核验，不能报告实际费用 US$0 或“仍完整剩余 US$2”。计费口径见 [Workers](https://developers.cloudflare.com/workers/platform/pricing/) 与 [D1](https://developers.cloudflare.com/d1/platform/pricing/)。

仍未验收：32 MiB 上游响应、替换解码/输出膨胀、OAuth/KMS、真实模型、成功推理与后台结算、客户端取消传播、慢读、并发及混合消费者、同实例内存和故障恢复。成功后的小请求可能落在不同 isolate，不构成容量/回收证明。**下一步仍为 C02.B2.2：私有隔离模拟上游、真实网关成功链路、后台持有/取消，再做完整工作集和恢复矩阵；不能跳过这些要求启用生产容量。**
