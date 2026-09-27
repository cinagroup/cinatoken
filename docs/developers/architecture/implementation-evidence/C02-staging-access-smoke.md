# C02.B2.2：受保护 staging 基础冒烟通过

2026-09-06。用户补齐 Cloudflare 权限后，复用既有 staging Worker/D1，在累计新增费用 **US$2** 授权内完成基础 HTTP 冒烟。**8 项检查通过，连同首次 404 共 9 次 HTTP 请求；测试后入口关闭、临时令牌删除。** C02 仍为 DOING，不能据此标记整个 C02.G 或完整 staging 验收通过。

## 环境与原始证据

- Worker：`cinatoken-proxy-staging`，版本仍为 `eaff1578-8e3c-43a7-bb25-67d282a87675`，未重新部署或修改业务代码。
- D1：`cinatoken-staging`，`6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`；沿用 [前轮已验收的迁移与空库初始化](./C02-staging-first-cloud.md)，本次不重复迁移。
- Access：仅保护 `cinatoken-proxy-staging.cinagroup.workers.dev`；应用 `ed5fd912-d6f1-4662-9575-02e0d6877af4`，策略 `fe10cfee-e285-491e-88ee-f0aecee1c1cd`。未改变全账号或生产 Access 策略。
- 通过批次：12:33:50–12:34:36 UTC；最终只读收尾核验：12:36:31 UTC。
- [脱敏请求结果与前后对照](./C02-staging-access-smoke-results.json) 保留首次未通过尝试、8 项通过结果、资源 ID、版本和生产配置摘要；不包含服务令牌 Client Secret、供应商 Key 或业务正文。

## 检查结果

| 条件 | 路径 | 实测 | 判定 |
| --- | --- | --- | --- |
| 无 Access 凭据 | `/health` | 401 / HTML | 拒绝通过 |
| 错误 Access 凭据 | `/health` | 401 / HTML | 拒绝通过 |
| 有效短期 Access 凭据 | `/health` | 200，精确健康 JSON | 放行通过 |
| Access 有效，无 Gateway Key | `/v1/models` | 401，JSON error 外壳 | 鉴权通过 |
| Access 有效，故意无效 Gateway Key | `/v1/models` | 401，JSON error 外壳 | 鉴权通过 |
| Access 有效 | `/catalog/models` | 200，`object=list`、`data=[]` | 空目录通过 |
| Access 有效 | `/catalog/providers` | 200，`object=list`、`data=[]` | 空目录通过 |
| 已访问目录后，再去掉 Access 凭据 | `/catalog/models` | 401 / HTML | 未因目录缓存绕过 Access |

健康检查不做 DB 读写探测；目录请求覆盖实际 Worker 的 D1 读取路径，前轮合成记录写入是单独的 D1 API 验证。上述结果不是有效买家 Key、推理、扣费/收益或账务恢复验收。探针误读取了 `x-gateway-error-code`，因此结果中的 `gatewayError=null` **不能证明**服务端缺少实际的 `X-OctaFuse-Error-Code`；兼容错误头不计入本轮通过项，也未为补采该非必需字段增加请求。

## 首次失败及测试脚本修正

1. 第一次开放入口后的无凭据请求得到 404，脚本立即停止并关闭入口。后续相同 Worker 版本通过；与短暂路由/Access 生效窗口一致，但未定位首次 404 的更细原因，不把 404 当成保护通过或业务漏洞。
2. 临时令牌直接删除被 400 / 12139 拒绝；先禁用，再解除本次策略引用后删除成功。策略从 Service Auth 转为 deny 时，Cloudflare 要求先将应用的 `service_auth_401_redirect` 关闭（400 / 12130），已按该顺序处理。
3. 第二次准备曾把 API 省略的可选 false 字段误判为失败，没有发出 HTTP 测试请求或创建新令牌。仅修正临时测试脚本的判断、按尝试计数及清理顺序，并保留证据；未修改 Worker 应用。
4. 后续重试最多允许累计 12 次 HTTP；仅对 404 设置有限等待。实际通过批次首次就返回预期 401，未使用该等待重试，最终累计 9 次。没有无界重试或压力流量。

## 收尾与费用

按 Cloudflare/Workers 最佳实践，本轮采用先核验确切主机名 Service Auth、再短暂开放的顺序。成功后再次核验：

- `workers.dev enabled=false`、`previews_enabled=false`；Access 应用保留为 **deny-all**。
- 两把本轮创建的短期令牌均已删除，列表中不存在；没有保留可用临时凭据。
- 生产 Proxy/Admin/Chain 的修改时间及完整设置响应 SHA-256 与本轮开始前相同；staging 仍为原版本 100% 部署。
- Worker/D1 保留，不删除或重建；本机系统、生产业务数据和既有代码均未更改，没有提交、套餐升级、自动充值或远程 CI。

真实模型/KMS 调用均为 **0**。Cloudflare 最终新增账单尚未核验，不能写成实际总费用 US$0；后续仍共享本轮累计 US$2 上限。客户端单次耗时仅用于排查，不充当 CPU 成本、服务目标或性能百分位证据。

下一实施项：为真实 Workers 的 Images / OAuth / 取消 / 后台持有及 50 / 20 / 32 MiB 边界建立隔离测试输入和模拟上游，再逐项补容量、并发和恢复证据。未启用生产容量策略，KMS 服务身份和真实付费模型测试仍按原有独立门禁推进。

依据：[Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)、[服务令牌与撤销](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)。
